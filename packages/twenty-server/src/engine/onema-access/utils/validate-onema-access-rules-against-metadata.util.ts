import { Logger } from '@nestjs/common';
import { isDefined } from 'twenty-shared/utils';

import { type FlatRoleMaps } from 'src/engine/metadata-modules/flat-role/types/flat-role-maps.type';
import { ONEMA_ACCESS_LOGGER_CONTEXT } from 'src/engine/onema-access/constants/onema-access.constants';
import {
  type OnemaAccessRules,
  type OnemaCondition,
} from 'src/engine/onema-access/types/onema-access-rules.type';
import { resolveOnemaFieldColumnNames } from 'src/engine/onema-access/utils/resolve-onema-field-columns.util';
import { type WorkspaceTableShape } from 'src/engine/twenty-orm/table-shape/types/workspace-table-shape.type';

const logger = new Logger(ONEMA_ACCESS_LOGGER_CONTEXT);

const WORKSPACE_MEMBER_OBJECT_NAME = 'workspaceMember';

export type OnemaRulesValidation =
  | { kind: 'valid' }
  | { kind: 'invalid'; problems: string[] };

type MetadataView = {
  objectIdByNameSingular: Record<string, string>;
  tableShapeByObjectMetadataId: (
    objectMetadataId: string,
  ) => WorkspaceTableShape;
  flatRoleMaps: FlatRoleMaps;
};

// Keyed by the identity of the workspace metadata and role caches, then by the
// hash of the rules file: all three are replaced wholesale when they change, so
// a stale entry is unreachable rather than wrong
const validationByFlatObjectMetadataMaps = new WeakMap<
  object,
  WeakMap<object, Map<string, OnemaRulesValidation>>
>();

// A rules file that names something this workspace does not have is a typo, and
// a typo is invisible the dangerous way: `opportuntiy` leaves the real
// `opportunity` with no rule at all, which reads as "upstream permissions only".
// Nothing here can guess what was meant, so the whole file stops being usable
// and every object closes until a human fixes it.
export const validateOnemaAccessRulesAgainstMetadata = ({
  rules,
  rulesVersion,
  flatObjectMetadataMaps,
  metadata,
}: {
  rules: OnemaAccessRules;
  rulesVersion: string;
  flatObjectMetadataMaps: object;
  metadata: MetadataView;
}): OnemaRulesValidation => {
  const byFlatRoleMaps =
    validationByFlatObjectMetadataMaps.get(flatObjectMetadataMaps) ??
    new WeakMap<object, Map<string, OnemaRulesValidation>>();

  validationByFlatObjectMetadataMaps.set(
    flatObjectMetadataMaps,
    byFlatRoleMaps,
  );

  const byRulesVersion =
    byFlatRoleMaps.get(metadata.flatRoleMaps) ??
    new Map<string, OnemaRulesValidation>();

  byFlatRoleMaps.set(metadata.flatRoleMaps, byRulesVersion);

  const cachedValidation = byRulesVersion.get(rulesVersion);

  if (isDefined(cachedValidation)) {
    return cachedValidation;
  }

  const problems = collectProblems({ rules, metadata });
  const validation: OnemaRulesValidation =
    problems.length === 0 ? { kind: 'valid' } : { kind: 'invalid', problems };

  byRulesVersion.set(rulesVersion, validation);

  if (validation.kind === 'invalid') {
    logger.error(
      `Onema access rules (version ${rulesVersion.slice(
        0,
        12,
      )}) do not match this workspace, so every record is hidden until they do: ${problems.join(
        '; ',
      )}`,
    );
  }

  return validation;
};

const collectProblems = ({
  rules,
  metadata,
}: {
  rules: OnemaAccessRules;
  metadata: MetadataView;
}): string[] => {
  const problems: string[] = [];

  for (const [roleKey, universalIdentifier] of Object.entries(rules.roles)) {
    if (
      !isDefined(
        metadata.flatRoleMaps.byUniversalIdentifier[universalIdentifier],
      )
    ) {
      problems.push(
        `role "${roleKey}" names no role of this workspace ("${universalIdentifier}")`,
      );
    }
  }

  for (const [objectName, conditionByRoleKey] of Object.entries(
    rules.objects,
  )) {
    const tableShape = resolveTableShape({ objectName, metadata });

    if (!isDefined(tableShape)) {
      problems.push(
        `object "${objectName}" is not an object of this workspace`,
      );

      continue;
    }

    for (const [roleKey, condition] of Object.entries(conditionByRoleKey)) {
      if (!isDefined(condition)) {
        continue;
      }

      collectConditionProblems({
        condition,
        tableShape,
        metadata,
        describe: (problem) => `${objectName}.${roleKey}: ${problem}`,
        problems,
      });
    }
  }

  collectWriteProtectedFieldProblems({ rules, metadata, problems });
  collectFreezeRuleProblems({ rules, metadata, problems });
  collectOwnerDefaultProblems({ rules, metadata, problems });
  collectWriteParentProblems({ rules, metadata, problems });

  return problems;
};

// A mistyped foreign key here leaves the access-granting link wide open, which
// is the same silence as a mistyped protected field one level up (Б5)
const collectWriteParentProblems = ({
  rules,
  metadata,
  problems,
}: {
  rules: OnemaAccessRules;
  metadata: MetadataView;
  problems: string[];
}): void => {
  for (const [objectName, parents] of Object.entries(
    rules.writeRequiresParentAccess ?? {},
  )) {
    const tableShape = resolveTableShape({ objectName, metadata });

    if (!isDefined(tableShape)) {
      problems.push(
        `writeRequiresParentAccess names no object of this workspace ("${objectName}")`,
      );

      continue;
    }

    for (const parent of parents) {
      const parentTableShape = resolveTableShape({
        objectName: parent.object,
        metadata,
      });

      if (!isDefined(parentTableShape)) {
        problems.push(
          `writeRequiresParentAccess: "${parent.object}" is not an object of this workspace`,
        );

        continue;
      }

      collectRelationProblems({
        ownerTableShape: tableShape,
        fieldName: parent.foreignKey,
        expectedTargetTableShape: parentTableShape,
        describe: (problem) => `writeRequiresParentAccess: ${problem}`,
        problems,
      });
    }
  }
};

// The substituted value is a workspaceMember id, so a default on anything but a
// relation to workspaceMember would write an id of the wrong object into the
// column — and the rule reading it would then quietly match nothing
const collectOwnerDefaultProblems = ({
  rules,
  metadata,
  problems,
}: {
  rules: OnemaAccessRules;
  metadata: MetadataView;
  problems: string[];
}): void => {
  const workspaceMemberTableShape = resolveTableShape({
    objectName: WORKSPACE_MEMBER_OBJECT_NAME,
    metadata,
  });

  for (const [objectName, fieldNameByRoleKey] of Object.entries(
    rules.ownerDefaults ?? {},
  )) {
    const tableShape = resolveTableShape({ objectName, metadata });

    if (!isDefined(tableShape)) {
      problems.push(
        `ownerDefaults names no object of this workspace ("${objectName}")`,
      );

      continue;
    }

    if (!isDefined(workspaceMemberTableShape)) {
      problems.push(
        `ownerDefaults needs "${WORKSPACE_MEMBER_OBJECT_NAME}", which this workspace does not have`,
      );

      return;
    }

    for (const fieldName of Object.values(fieldNameByRoleKey)) {
      collectRelationProblems({
        ownerTableShape: tableShape,
        fieldName,
        expectedTargetTableShape: workspaceMemberTableShape,
        describe: (problem) => `ownerDefaults: ${problem}`,
        problems,
      });
    }
  }
};

// A protected or frozen field named with a typo protects nothing, which is the
// same silent opening as a mistyped object name — and here the field is the one
// the whole product rule rests on (rls-design §12а)
const collectWriteProtectedFieldProblems = ({
  rules,
  metadata,
  problems,
}: {
  rules: OnemaAccessRules;
  metadata: MetadataView;
  problems: string[];
}): void => {
  for (const [objectName, roleKeysByFieldName] of Object.entries(
    rules.writeProtectedFields ?? {},
  )) {
    const tableShape = resolveTableShape({ objectName, metadata });

    if (!isDefined(tableShape)) {
      problems.push(
        `writeProtectedFields names no object of this workspace ("${objectName}")`,
      );

      continue;
    }

    for (const fieldName of Object.keys(roleKeysByFieldName)) {
      if (
        resolveOnemaFieldColumnNames({ tableShape, fieldName }).length === 0
      ) {
        problems.push(
          `writeProtectedFields: "${fieldName}" is no field of "${objectName}"`,
        );
      }
    }
  }
};

const collectFreezeRuleProblems = ({
  rules,
  metadata,
  problems,
}: {
  rules: OnemaAccessRules;
  metadata: MetadataView;
  problems: string[];
}): void => {
  for (const [objectName, freezeRules] of Object.entries(
    rules.freezeWhen ?? {},
  )) {
    const tableShape = resolveTableShape({ objectName, metadata });

    if (!isDefined(tableShape)) {
      problems.push(
        `freezeWhen names no object of this workspace ("${objectName}")`,
      );

      continue;
    }

    for (const freezeRule of freezeRules) {
      // The condition is compared against one stored value, so a composite
      // field — which is several columns — cannot carry it
      if (
        resolveOnemaFieldColumnNames({
          tableShape,
          fieldName: freezeRule.field,
        }).length !== 1
      ) {
        problems.push(
          `freezeWhen: "${freezeRule.field}" is no single-column field of "${objectName}"`,
        );
      }

      for (const fieldName of freezeRule.fields) {
        if (
          resolveOnemaFieldColumnNames({ tableShape, fieldName }).length === 0
        ) {
          problems.push(
            `freezeWhen: "${fieldName}" is no field of "${objectName}"`,
          );
        }
      }
    }
  }
};

const collectConditionProblems = ({
  condition,
  tableShape,
  metadata,
  describe,
  problems,
}: {
  condition: OnemaCondition;
  tableShape: WorkspaceTableShape;
  metadata: MetadataView;
  describe: (problem: string) => string;
  problems: string[];
}): void => {
  if ('all' in condition) {
    return;
  }

  if ('and' in condition || 'or' in condition) {
    for (const operand of 'and' in condition ? condition.and : condition.or) {
      collectConditionProblems({
        condition: operand,
        tableShape,
        metadata,
        describe,
        problems,
      });
    }

    return;
  }

  if ('eq' in condition) {
    const [fieldName] = condition.eq;

    if (!hasColumnOrRelation({ tableShape, fieldName })) {
      problems.push(
        describe(`"${fieldName}" is no field of "${tableShape.nameSingular}"`),
      );
    }

    return;
  }

  if ('exists' in condition) {
    const { object, backForeignKey, where } = condition.exists;
    const targetTableShape = resolveTableShape({
      objectName: object,
      metadata,
    });

    if (!isDefined(targetTableShape)) {
      problems.push(
        describe(`exists names no object of this workspace ("${object}")`),
      );

      return;
    }

    collectRelationProblems({
      ownerTableShape: targetTableShape,
      fieldName: backForeignKey,
      expectedTargetTableShape: tableShape,
      describe: (problem) => describe(`exists.backForeignKey ${problem}`),
      problems,
    });

    if (isDefined(where)) {
      collectConditionProblems({
        condition: where,
        tableShape: targetTableShape,
        metadata,
        describe,
        problems,
      });
    }

    return;
  }

  const { foreignKey, object } = condition.parent;
  const parentTableShape = resolveTableShape({ objectName: object, metadata });

  if (!isDefined(parentTableShape)) {
    problems.push(
      describe(`parent names no object of this workspace ("${object}")`),
    );

    return;
  }

  collectRelationProblems({
    ownerTableShape: tableShape,
    fieldName: foreignKey,
    expectedTargetTableShape: parentTableShape,
    describe: (problem) => describe(`parent.foreignKey ${problem}`),
    problems,
  });
};

// A field that merely exists is not enough: `exists.projectMember.member` can be
// a real relation that points at workspaceMember rather than back at project,
// and the rule would then compile into a comparison that means nothing
const collectRelationProblems = ({
  ownerTableShape,
  fieldName,
  expectedTargetTableShape,
  describe,
  problems,
}: {
  ownerTableShape: WorkspaceTableShape;
  fieldName: string;
  expectedTargetTableShape: WorkspaceTableShape;
  describe: (problem: string) => string;
  problems: string[];
}): void => {
  const relationShape = ownerTableShape.relationShapeByFieldName[fieldName];

  if (!isDefined(relationShape)) {
    problems.push(
      describe(
        `"${fieldName}" is no relation of "${ownerTableShape.nameSingular}"`,
      ),
    );

    return;
  }

  if (!isDefined(relationShape.joinColumnName)) {
    problems.push(
      describe(
        `"${fieldName}" of "${ownerTableShape.nameSingular}" holds no foreign key`,
      ),
    );

    return;
  }

  if (
    relationShape.targetObjectMetadataId !==
    expectedTargetTableShape.objectMetadataId
  ) {
    problems.push(
      describe(
        `"${fieldName}" of "${ownerTableShape.nameSingular}" points at another object than "${expectedTargetTableShape.nameSingular}"`,
      ),
    );
  }
};

const hasColumnOrRelation = ({
  tableShape,
  fieldName,
}: {
  tableShape: WorkspaceTableShape;
  fieldName: string;
}): boolean =>
  isDefined(tableShape.relationShapeByFieldName[fieldName]?.joinColumnName) ||
  isDefined(tableShape.columnShapeByColumnName[fieldName]);

const resolveTableShape = ({
  objectName,
  metadata,
}: {
  objectName: string;
  metadata: MetadataView;
}): WorkspaceTableShape | undefined => {
  const objectMetadataId = metadata.objectIdByNameSingular[objectName];

  if (!isDefined(objectMetadataId)) {
    return undefined;
  }

  return metadata.tableShapeByObjectMetadataId(objectMetadataId);
};
