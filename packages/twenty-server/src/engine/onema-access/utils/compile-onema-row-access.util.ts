import { isDefined } from 'twenty-shared/utils';

import {
  ONEMA_MAX_RULE_DEPTH,
  ONEMA_PARAMETER_PREFIX,
} from 'src/engine/onema-access/constants/onema-access.constants';
import {
  OnemaAccessException,
  OnemaAccessExceptionCode,
} from 'src/engine/onema-access/exceptions/onema-access.exception';
import {
  type OnemaAccessRules,
  type OnemaAccessSubject,
  type OnemaCondition,
  type OnemaConditionValue,
  type OnemaRowAccess,
} from 'src/engine/onema-access/types/onema-access-rules.type';
import { type SqlCondition } from 'src/engine/twenty-orm/types/row-access-policy.type';
import { type WorkspaceTableShape } from 'src/engine/twenty-orm/table-shape/types/workspace-table-shape.type';
import { escapeIdentifier } from 'src/engine/workspace-manager/workspace-migration/utils/remove-sql-injection.util';

const CURRENT_MEMBER_TOKEN = '$me';

export type OnemaCompilationContext = {
  rules: OnemaAccessRules;
  subject: OnemaAccessSubject;
  roleKeys: string[];
  objectIdByNameSingular: Record<string, string>;
  tableShapeByObjectMetadataId: (
    objectMetadataId: string,
  ) => WorkspaceTableShape;
};

type CompilationState = {
  context: OnemaCompilationContext;
  namePrefix: string;
  nextIndex: number;
};

export const buildOnemaCompilationContext = ({
  rules,
  subject,
  objectIdByNameSingular,
  tableShapeByObjectMetadataId,
}: Omit<OnemaCompilationContext, 'roleKeys'>): OnemaCompilationContext => ({
  rules,
  subject,
  roleKeys: Object.entries(rules.roles)
    .filter(([, roleId]) => subject.roleIds.includes(roleId))
    .map(([roleKey]) => roleKey),
  objectIdByNameSingular,
  tableShapeByObjectMetadataId,
});

export const compileOnemaRowAccess = ({
  tableShape,
  tableAlias,
  context,
}: {
  tableShape: WorkspaceTableShape;
  tableAlias: string;
  context: OnemaCompilationContext;
}): OnemaRowAccess =>
  compileObjectAccess({
    tableShape,
    tableAlias,
    objectPath: [tableShape.nameSingular],
    state: {
      context,
      namePrefix: `${ONEMA_PARAMETER_PREFIX}_${sanitizeNamePart(tableAlias)}`,
      nextIndex: 0,
    },
  });

// An object listed in the rules is closed to every role the rules do not name;
// an object absent from the rules keeps upstream object and field permissions
const compileObjectAccess = ({
  tableShape,
  tableAlias,
  objectPath,
  state,
}: {
  tableShape: WorkspaceTableShape;
  tableAlias: string;
  objectPath: string[];
  state: CompilationState;
}): OnemaRowAccess => {
  const conditionByRoleKey =
    state.context.rules.objects[tableShape.nameSingular];

  if (!isDefined(conditionByRoleKey)) {
    return { kind: 'open' };
  }

  const conditions = state.context.roleKeys
    .map((roleKey) => conditionByRoleKey[roleKey])
    .filter(isDefined);

  if (conditions.length === 0) {
    return { kind: 'denied' };
  }

  return combineRowAccess(
    conditions.map((condition) =>
      compileCondition({
        condition,
        tableShape,
        tableAlias,
        objectPath,
        state,
      }),
    ),
    'OR',
  );
};

const compileCondition = ({
  condition,
  tableShape,
  tableAlias,
  objectPath,
  state,
}: {
  condition: OnemaCondition;
  tableShape: WorkspaceTableShape;
  tableAlias: string;
  objectPath: string[];
  state: CompilationState;
}): OnemaRowAccess => {
  if ('all' in condition) {
    return { kind: 'open' };
  }

  if ('and' in condition || 'or' in condition) {
    const operands = 'and' in condition ? condition.and : condition.or;

    return combineRowAccess(
      operands.map((operand) =>
        compileCondition({
          condition: operand,
          tableShape,
          tableAlias,
          objectPath,
          state,
        }),
      ),
      'and' in condition ? 'AND' : 'OR',
    );
  }

  if ('eq' in condition) {
    return compileEquality({ condition, tableShape, tableAlias, state });
  }

  if ('exists' in condition) {
    return compileExists({
      condition,
      tableAlias,
      objectPath,
      state,
    });
  }

  return compileParent({
    condition,
    tableShape,
    tableAlias,
    objectPath,
    state,
  });
};

const compileEquality = ({
  condition,
  tableShape,
  tableAlias,
  state,
}: {
  condition: { eq: [string, OnemaConditionValue] };
  tableShape: WorkspaceTableShape;
  tableAlias: string;
  state: CompilationState;
}): OnemaRowAccess => {
  const [fieldName, rawValue] = condition.eq;
  const columnName = resolveColumnName({ tableShape, fieldName });

  if (rawValue === CURRENT_MEMBER_TOKEN) {
    const { workspaceMemberId } = state.context.subject;

    if (!isDefined(workspaceMemberId)) {
      return { kind: 'denied' };
    }

    return gated(quoteColumn(tableAlias, columnName), workspaceMemberId, state);
  }

  if (rawValue === null) {
    return {
      kind: 'gated',
      condition: {
        sql: `${quoteColumn(tableAlias, columnName)} IS NULL`,
        parameters: {},
      },
    };
  }

  return gated(quoteColumn(tableAlias, columnName), rawValue, state);
};

const compileExists = ({
  condition,
  tableAlias,
  objectPath,
  state,
}: {
  condition: {
    exists: { object: string; backForeignKey: string; where?: OnemaCondition };
  };
  tableAlias: string;
  objectPath: string[];
  state: CompilationState;
}): OnemaRowAccess => {
  const { object, backForeignKey, where } = condition.exists;
  const targetTableShape = resolveTableShape({
    objectName: object,
    context: state.context,
  });
  const backColumnName = resolveColumnName({
    tableShape: targetTableShape,
    fieldName: backForeignKey,
  });
  const targetAlias = nextName(state, 't');
  const predicates = [
    `${quoteColumn(targetAlias, backColumnName)} = ${quoteColumn(tableAlias, 'id')}`,
  ];
  let parameters = {};

  if (targetTableShape.hasDeletedAtColumn) {
    predicates.push(`${quoteColumn(targetAlias, 'deletedAt')} IS NULL`);
  }

  if (isDefined(where)) {
    const innerAccess = compileCondition({
      condition: where,
      tableShape: targetTableShape,
      tableAlias: targetAlias,
      objectPath,
      state,
    });

    if (innerAccess.kind === 'denied') {
      return { kind: 'denied' };
    }

    if (innerAccess.kind === 'gated') {
      predicates.push(`(${innerAccess.condition.sql})`);
      parameters = innerAccess.condition.parameters;
    }
  }

  return {
    kind: 'gated',
    condition: {
      sql: buildExistsSql({
        tableShape: targetTableShape,
        alias: targetAlias,
        predicates,
      }),
      parameters,
    },
  };
};

// The parent must be visible to the same role, so an orphan row (empty foreign
// key) stays hidden from everyone but the roles allowed to see all records
const compileParent = ({
  condition,
  tableShape,
  tableAlias,
  objectPath,
  state,
}: {
  condition: { parent: { foreignKey: string; object: string } };
  tableShape: WorkspaceTableShape;
  tableAlias: string;
  objectPath: string[];
  state: CompilationState;
}): OnemaRowAccess => {
  const { foreignKey, object } = condition.parent;
  const foreignKeyColumnName = resolveColumnName({
    tableShape,
    fieldName: foreignKey,
  });
  const parentTableShape = resolveTableShape({
    objectName: object,
    context: state.context,
  });
  const nextObjectPath = [...objectPath, parentTableShape.nameSingular];

  if (
    objectPath.includes(parentTableShape.nameSingular) ||
    nextObjectPath.length > ONEMA_MAX_RULE_DEPTH
  ) {
    return { kind: 'denied' };
  }

  const parentAlias = nextName(state, 't');
  const parentAccess = compileObjectAccess({
    tableShape: parentTableShape,
    tableAlias: parentAlias,
    objectPath: nextObjectPath,
    state,
  });

  if (parentAccess.kind === 'denied') {
    return { kind: 'denied' };
  }

  const predicates = [
    `${quoteColumn(parentAlias, 'id')} = ${quoteColumn(tableAlias, foreignKeyColumnName)}`,
  ];

  if (parentTableShape.hasDeletedAtColumn) {
    predicates.push(`${quoteColumn(parentAlias, 'deletedAt')} IS NULL`);
  }

  if (parentAccess.kind === 'gated') {
    predicates.push(`(${parentAccess.condition.sql})`);
  }

  return {
    kind: 'gated',
    condition: {
      sql: buildExistsSql({
        tableShape: parentTableShape,
        alias: parentAlias,
        predicates,
      }),
      parameters:
        parentAccess.kind === 'gated' ? parentAccess.condition.parameters : {},
    },
  };
};

const combineRowAccess = (
  accesses: OnemaRowAccess[],
  operator: 'AND' | 'OR',
): OnemaRowAccess => {
  if (operator === 'OR' && accesses.some((access) => access.kind === 'open')) {
    return { kind: 'open' };
  }

  if (
    operator === 'AND' &&
    accesses.some((access) => access.kind === 'denied')
  ) {
    return { kind: 'denied' };
  }

  const conditions = accesses
    .filter((access) => access.kind === 'gated')
    .map((access) => access.condition);

  if (conditions.length === 0) {
    return operator === 'OR' ? { kind: 'denied' } : { kind: 'open' };
  }

  if (conditions.length === 1) {
    return { kind: 'gated', condition: conditions[0] };
  }

  return {
    kind: 'gated',
    condition: {
      sql: `(${conditions.map((condition) => `(${condition.sql})`).join(` ${operator} `)})`,
      parameters: Object.assign({}, ...conditions.map((c) => c.parameters)),
    },
  };
};

const gated = (
  columnExpression: string,
  value: OnemaConditionValue,
  state: CompilationState,
): OnemaRowAccess => {
  const parameterName = nextName(state, 'p');

  return {
    kind: 'gated',
    condition: {
      sql: `${columnExpression} = :${parameterName}`,
      parameters: { [parameterName]: value },
    } satisfies SqlCondition,
  };
};

const buildExistsSql = ({
  tableShape,
  alias,
  predicates,
}: {
  tableShape: WorkspaceTableShape;
  alias: string;
  predicates: string[];
}): string =>
  `EXISTS (SELECT 1 FROM ${escapeIdentifier(tableShape.schemaName)}.${escapeIdentifier(
    tableShape.tableName,
  )} AS ${escapeIdentifier(alias)} WHERE ${predicates.join(' AND ')})`;

const resolveTableShape = ({
  objectName,
  context,
}: {
  objectName: string;
  context: OnemaCompilationContext;
}): WorkspaceTableShape => {
  const objectMetadataId = context.objectIdByNameSingular[objectName];

  if (!isDefined(objectMetadataId)) {
    throw new OnemaAccessException(
      `Onema access rules reference unknown object "${objectName}"`,
      OnemaAccessExceptionCode.UNKNOWN_OBJECT,
    );
  }

  return context.tableShapeByObjectMetadataId(objectMetadataId);
};

const resolveColumnName = ({
  tableShape,
  fieldName,
}: {
  tableShape: WorkspaceTableShape;
  fieldName: string;
}): string => {
  const joinColumnName =
    tableShape.relationShapeByFieldName[fieldName]?.joinColumnName;

  if (isDefined(joinColumnName)) {
    return joinColumnName;
  }

  if (isDefined(tableShape.columnShapeByColumnName[fieldName])) {
    return fieldName;
  }

  throw new OnemaAccessException(
    `Onema access rules reference unknown field "${fieldName}" on object "${tableShape.nameSingular}"`,
    OnemaAccessExceptionCode.UNKNOWN_FIELD,
  );
};

const quoteColumn = (alias: string, columnName: string): string =>
  `${escapeIdentifier(alias)}.${escapeIdentifier(columnName)}`;

const nextName = (state: CompilationState, kind: 'p' | 't'): string => {
  const name = `${state.namePrefix}_${kind}${state.nextIndex}`;

  state.nextIndex += 1;

  return name;
};

const sanitizeNamePart = (value: string): string =>
  value.replace(/[^A-Za-z0-9_]/g, '_');
