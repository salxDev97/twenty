import { isDefined } from 'twenty-shared/utils';

import {
  ONEMA_MAX_RULE_DEPTH,
  ONEMA_MAX_RULE_DEPTH_THROUGH_POLYMORPHIC_TARGET,
  ONEMA_PARAMETER_PREFIX,
} from 'src/engine/onema-access/constants/onema-access.constants';
import {
  OnemaAccessException,
  OnemaAccessExceptionCode,
} from 'src/engine/onema-access/exceptions/onema-access.exception';
import { closesOnemaRuleCycle } from 'src/engine/onema-access/utils/closes-onema-rule-cycle.util';
import {
  type OnemaAccessRules,
  type OnemaAccessSubject,
  type OnemaAnyParentCondition,
  type OnemaCondition,
  type OnemaConditionValue,
  type OnemaLinkedCondition,
  type OnemaParentCondition,
  type OnemaRowAccess,
} from 'src/engine/onema-access/types/onema-access-rules.type';
import { type SqlCondition } from 'src/engine/twenty-orm/types/row-access-policy.type';
import { type WorkspaceTableShape } from 'src/engine/twenty-orm/table-shape/types/workspace-table-shape.type';
import { escapeIdentifier } from 'src/engine/workspace-manager/workspace-migration/utils/remove-sql-injection.util';

const CURRENT_MEMBER_TOKEN = '$me';

// Two aliases can sanitize to one name ("task-owner" and "task_owner" both give
// "task_owner"), and a query builder merges parameters from clones and from
// copyWhereFrom, so the alias alone cannot keep parameter names apart. An
// ordinal that never repeats in this process can.
let nextParameterNamespace = 0;

export const resetOnemaParameterNamespaceForTesting = (): void => {
  nextParameterNamespace = 0;
};

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
  // A write-parent chain starts at the row being written, which is not a rule of
  // anything: when the parent's own rule reaches that object again it reads
  // *other* rows of it, under their own rule, and stops there. Treating that as
  // a cycle dropped the one rule that mattered — `projectMember -> project ->
  // projectMember` is how a contractor sees the project at all, so the check
  // refused them the membership they were entitled to create. Depth still bounds
  // the walk, so nothing here can run away.
  cycleExemptObjectName?: string;
};

// The objects already on the path, and how many the path may still hold: a
// polymorphic hop raises the budget once (see the constant), so the two travel
// together rather than the depth limit being read from a constant at each hop
type ObjectChain = {
  objectPath: string[];
  maxObjectDepth: number;
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
    .filter(([, universalIdentifier]) =>
      subject.roleUniversalIdentifiers.includes(universalIdentifier),
    )
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
}): OnemaRowAccess => {
  const parameterNamespace = nextParameterNamespace;

  nextParameterNamespace += 1;

  return compileObjectAccess({
    tableShape,
    tableAlias,
    chain: {
      objectPath: [tableShape.nameSingular],
      maxObjectDepth: ONEMA_MAX_RULE_DEPTH,
    },
    state: {
      context,
      namePrefix: `${ONEMA_PARAMETER_PREFIX}_${parameterNamespace}_${sanitizeNamePart(
        tableAlias,
      )}`,
      nextIndex: 0,
    },
  });
};

// rls-design §5, Б5. Writing a row that hangs off a parent is a write on who
// can see that parent — a membership row names a project, and creating one
// hands its holder everything the project carries. The row's own rule cannot
// catch this: `projectMember` has no rule of its own, and `eq assignee $me` is
// satisfied by the very write that grants the access.
//
// So the parent named by each declared foreign key has to be admitted by its own
// rule, for the same author, in the same transaction. A row that names no parent
// grants nobody anything and is left alone.
//
// Several declared links are a polymorphic set — `attachment` names five
// `target*` keys of which at most one is filled — so the AND here is the write
// side of `anyParent`'s OR, hop for hop, and it is given the same depth budget
// (ONE-112). Without that, `attachment → person → company → opportunity` would
// be refused one object short of the very rule it mirrors, and the refusal
// would read as "you may never attach a file to a contact".
export const compileOnemaWriteParentAccess = ({
  tableShape,
  tableAlias,
  parents,
  context,
}: {
  tableShape: WorkspaceTableShape;
  tableAlias: string;
  parents: OnemaParentCondition[];
  context: OnemaCompilationContext;
}): OnemaRowAccess => {
  const parameterNamespace = nextParameterNamespace;

  nextParameterNamespace += 1;

  const state: CompilationState = {
    context,
    namePrefix: `${ONEMA_PARAMETER_PREFIX}_${parameterNamespace}_${sanitizeNamePart(
      tableAlias,
    )}_parent`,
    nextIndex: 0,
    cycleExemptObjectName: tableShape.nameSingular,
  };
  const chain = buildWriteParentChain({ tableShape, parents });

  return combineRowAccess(
    parents.map((parent) => {
      const foreignKeyIsEmpty = `${quoteColumn(
        tableAlias,
        resolveColumnName({ tableShape, fieldName: parent.foreignKey }),
      )} IS NULL`;
      const parentAccess = compileParent({
        condition: { parent },
        tableShape,
        tableAlias,
        chain,
        state,
      });

      if (parentAccess.kind === 'open') {
        return parentAccess;
      }

      // "The role may see no parent of this kind" still leaves a row with no
      // parent at all, which grants nobody anything
      if (parentAccess.kind === 'denied') {
        return {
          kind: 'gated',
          condition: { sql: foreignKeyIsEmpty, parameters: {} },
        } satisfies OnemaRowAccess;
      }

      return {
        kind: 'gated',
        condition: {
          sql: `(${foreignKeyIsEmpty} OR (${parentAccess.condition.sql}))`,
          parameters: parentAccess.condition.parameters,
        },
      } satisfies OnemaRowAccess;
    }),
    'AND',
  );
};

export const combineOnemaRowAccess = (
  accesses: OnemaRowAccess[],
): OnemaRowAccess => combineRowAccess(accesses, 'AND');

// An object listed in the rules is closed to every role the rules do not name;
// an object absent from the rules keeps upstream object and field permissions
const compileObjectAccess = ({
  tableShape,
  tableAlias,
  chain,
  state,
}: {
  tableShape: WorkspaceTableShape;
  tableAlias: string;
  chain: ObjectChain;
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
        chain,
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
  chain,
  state,
}: {
  condition: OnemaCondition;
  tableShape: WorkspaceTableShape;
  tableAlias: string;
  chain: ObjectChain;
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
          chain,
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
      chain,
      state,
    });
  }

  if ('anyParent' in condition) {
    return compileAnyParent({
      condition,
      tableShape,
      tableAlias,
      chain,
      state,
    });
  }

  if ('linked' in condition) {
    return compileLinked({
      condition,
      tableShape,
      tableAlias,
      chain,
      state,
    });
  }

  return compileParent({
    condition,
    tableShape,
    tableAlias,
    chain,
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
  chain,
  state,
}: {
  condition: {
    exists: { object: string; backForeignKey: string; where?: OnemaCondition };
  };
  tableAlias: string;
  chain: ObjectChain;
  state: CompilationState;
}): OnemaRowAccess => {
  const { object, backForeignKey, where } = condition.exists;
  const targetTableShape = resolveTableShape({
    objectName: object,
    context: state.context,
  });
  // The target of an exists is one more object on the chain, exactly like the
  // target of a parent: without counting it, exists → parent → exists walks
  // past the depth limit and can revisit an object it already joined
  const nextChain = enterObject({
    chain,
    objectName: targetTableShape.nameSingular,
    state,
  });

  if (!isDefined(nextChain)) {
    return { kind: 'denied' };
  }

  const backColumnName = resolveColumnName({
    tableShape: targetTableShape,
    fieldName: backForeignKey,
  });
  const targetAlias = nextName(state, 't');
  // The witness row is a row of the target object, so it answers to that
  // object's own rule, exactly like the row a `parent` reaches: otherwise
  // `{exists: {object: "project"}}` would be a way to read through `project`
  // without ever satisfying the rule written for `project` itself
  const targetAccess = compileObjectAccess({
    tableShape: targetTableShape,
    tableAlias: targetAlias,
    chain: nextChain,
    state,
  });

  if (targetAccess.kind === 'denied') {
    return { kind: 'denied' };
  }

  const predicates = [
    `${quoteColumn(targetAlias, backColumnName)} = ${quoteColumn(tableAlias, 'id')}`,
  ];
  let parameters: SqlCondition['parameters'] = {};

  if (targetTableShape.hasDeletedAtColumn) {
    predicates.push(`${quoteColumn(targetAlias, 'deletedAt')} IS NULL`);
  }

  if (targetAccess.kind === 'gated') {
    predicates.push(`(${targetAccess.condition.sql})`);
    parameters = { ...parameters, ...targetAccess.condition.parameters };
  }

  if (isDefined(where)) {
    const innerAccess = compileCondition({
      condition: where,
      tableShape: targetTableShape,
      tableAlias: targetAlias,
      chain: nextChain,
      state,
    });

    if (innerAccess.kind === 'denied') {
      return { kind: 'denied' };
    }

    if (innerAccess.kind === 'gated') {
      predicates.push(`(${innerAccess.condition.sql})`);
      parameters = { ...parameters, ...innerAccess.condition.parameters };
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
  chain,
  state,
}: {
  condition: { parent: { foreignKey: string; object: string } };
  tableShape: WorkspaceTableShape;
  tableAlias: string;
  chain: ObjectChain;
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
  const nextChain = enterObject({
    chain,
    objectName: parentTableShape.nameSingular,
    state,
  });

  if (!isDefined(nextChain)) {
    return { kind: 'denied' };
  }

  const parentAlias = nextName(state, 't');
  const parentAccess = compileObjectAccess({
    tableShape: parentTableShape,
    tableAlias: parentAlias,
    chain: nextChain,
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

// rls-design §3.1: the record hangs off whichever target it actually has, so
// every branch is the `parent` rule of that target and the row is visible as
// soon as one of them lets it through. A row with no target filled satisfies no
// branch — an orphan attachment stays hidden from everyone but the roles that
// see all records, which is the policy, not an accident.
const compileAnyParent = ({
  condition,
  tableShape,
  tableAlias,
  chain,
  state,
}: {
  condition: { anyParent: OnemaAnyParentCondition };
  tableShape: WorkspaceTableShape;
  tableAlias: string;
  chain: ObjectChain;
  state: CompilationState;
}): OnemaRowAccess =>
  combineRowAccess(
    condition.anyParent.parents.map((parent) =>
      compileParent({
        condition: { parent },
        tableShape,
        tableAlias,
        chain: widenChainForPolymorphicTarget(chain),
        state,
      }),
    ),
    'OR',
  );

// rls-design §3.1: `timelineActivity` carries the diff of the record it is
// about, so the row has to answer to that record's own rule. The object is
// named by metadata id, which is why each branch pins the id before reaching
// for the row. An object the rules do not name has no branch at all, and
// neither has an empty `linkedObjectMetadataId`: both end closed, because the
// row's content is the content of a record we have decided nothing about.
const compileLinked = ({
  condition,
  tableShape,
  tableAlias,
  chain,
  state,
}: {
  condition: { linked: OnemaLinkedCondition };
  tableShape: WorkspaceTableShape;
  tableAlias: string;
  chain: ObjectChain;
  state: CompilationState;
}): OnemaRowAccess => {
  const { objectIdField, recordIdField, objects } = condition.linked;
  const objectIdColumnName = resolveColumnName({
    tableShape,
    fieldName: objectIdField,
  });
  const recordIdColumnName = resolveColumnName({
    tableShape,
    fieldName: recordIdField,
  });
  const widenedChain = widenChainForPolymorphicTarget(chain);

  return combineRowAccess(
    objects.map((objectName): OnemaRowAccess => {
      const targetTableShape = resolveTableShape({
        objectName,
        context: state.context,
      });
      const nextChain = enterObject({
        chain: widenedChain,
        objectName: targetTableShape.nameSingular,
        state,
      });

      if (!isDefined(nextChain)) {
        return { kind: 'denied' };
      }

      const targetAlias = nextName(state, 't');
      const targetAccess = compileObjectAccess({
        tableShape: targetTableShape,
        tableAlias: targetAlias,
        chain: nextChain,
        state,
      });

      if (targetAccess.kind === 'denied') {
        return { kind: 'denied' };
      }

      const objectIdParameterName = nextName(state, 'p');
      const predicates = [
        `${quoteColumn(targetAlias, 'id')} = ${quoteColumn(tableAlias, recordIdColumnName)}`,
      ];

      if (targetTableShape.hasDeletedAtColumn) {
        predicates.push(`${quoteColumn(targetAlias, 'deletedAt')} IS NULL`);
      }

      if (targetAccess.kind === 'gated') {
        predicates.push(`(${targetAccess.condition.sql})`);
      }

      return {
        kind: 'gated',
        condition: {
          sql: `(${quoteColumn(tableAlias, objectIdColumnName)} = :${objectIdParameterName} AND ${buildExistsSql(
            { tableShape: targetTableShape, alias: targetAlias, predicates },
          )})`,
          parameters: {
            [objectIdParameterName]: targetTableShape.objectMetadataId,
            ...(targetAccess.kind === 'gated'
              ? targetAccess.condition.parameters
              : {}),
          },
        },
      };
    }),
    'OR',
  );
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

// Undefined means the chain cannot be walked any further: either the object is
// already on the path (a cycle the exemption does not buy) or the path has spent
// its depth budget. Both end as "no rows", never as an error — the loader
// refuses a file that can do this, so reaching here means the rules changed
// under a running process.
const enterObject = ({
  chain,
  objectName,
  state,
}: {
  chain: ObjectChain;
  objectName: string;
  state: CompilationState;
}): ObjectChain | undefined => {
  if (
    closesOnemaRuleCycle({
      objectPath: chain.objectPath,
      objectName,
      cycleExemptObjectName: state.cycleExemptObjectName,
    })
  ) {
    return undefined;
  }

  const objectPath = [...chain.objectPath, objectName];

  if (objectPath.length > chain.maxObjectDepth) {
    return undefined;
  }

  return { ...chain, objectPath };
};

const widenChainForPolymorphicTarget = (chain: ObjectChain): ObjectChain => ({
  ...chain,
  maxObjectDepth: Math.max(
    chain.maxObjectDepth,
    ONEMA_MAX_RULE_DEPTH_THROUGH_POLYMORPHIC_TARGET,
  ),
});

// One declared link is a plain foreign key and keeps the plain limit; more than
// one is the polymorphic set the object's own `anyParent` walks, and gets the
// budget that rule would get. The rule is stated once here and mirrored by the
// loader (parse-onema-access-rules.util.ts), so a write-parent link the loader
// accepts is one the compiler can build.
export const isOnemaPolymorphicParentSet = (
  parents: OnemaParentCondition[],
): boolean => parents.length > 1;

const buildWriteParentChain = ({
  tableShape,
  parents,
}: {
  tableShape: WorkspaceTableShape;
  parents: OnemaParentCondition[];
}): ObjectChain => {
  const chain: ObjectChain = {
    objectPath: [tableShape.nameSingular],
    maxObjectDepth: ONEMA_MAX_RULE_DEPTH,
  };

  return isOnemaPolymorphicParentSet(parents)
    ? widenChainForPolymorphicTarget(chain)
    : chain;
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
