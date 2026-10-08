import { isDefined } from 'twenty-shared/utils';

import {
  ONEMA_MAX_CONDITIONS_PER_RULE,
  ONEMA_MAX_RULE_DEPTH,
} from 'src/engine/onema-access/constants/onema-access.constants';
import {
  OnemaAccessException,
  OnemaAccessExceptionCode,
} from 'src/engine/onema-access/exceptions/onema-access.exception';
import {
  type OnemaAccessRules,
  type OnemaCondition,
} from 'src/engine/onema-access/types/onema-access-rules.type';
import { onemaAccessRulesSchema } from 'src/engine/onema-access/utils/onema-access-rules.schema';

// A rules file that does not parse must stop the server, never degrade to a
// permissive default (ADR-003: closed by default)
export const parseOnemaAccessRules = (rawRules: unknown): OnemaAccessRules => {
  const parsedRules = onemaAccessRulesSchema.safeParse(rawRules);

  if (!parsedRules.success) {
    throw new OnemaAccessException(
      `Onema access rules do not match the schema: ${JSON.stringify(
        parsedRules.error.issues,
      )}`,
      OnemaAccessExceptionCode.INVALID_RULES,
    );
  }

  const rules = parsedRules.data as OnemaAccessRules;

  validateRoleIdentifiersAreUnique(rules);
  validateRoleKeysAreDeclared(rules);
  validateObjectChains(rules);

  return rules;
};

// Two role keys pointing at one role would hand the holder the union of both
// sets of conditions — the widest wins, which is the opposite of closed by
// default (a single `{ all: true }` would open everything for the other key)
const validateRoleIdentifiersAreUnique = (rules: OnemaAccessRules): void => {
  const roleKeysByUniversalIdentifier = new Map<string, string[]>();

  for (const [roleKey, universalIdentifier] of Object.entries(rules.roles)) {
    roleKeysByUniversalIdentifier.set(universalIdentifier, [
      ...(roleKeysByUniversalIdentifier.get(universalIdentifier) ?? []),
      roleKey,
    ]);
  }

  for (const [
    universalIdentifier,
    roleKeys,
  ] of roleKeysByUniversalIdentifier.entries()) {
    if (roleKeys.length > 1) {
      throw new OnemaAccessException(
        `Onema access rules give one role "${universalIdentifier}" to several keys: ${roleKeys.join(
          ', ',
        )}`,
        OnemaAccessExceptionCode.INVALID_RULES,
      );
    }
  }
};

const validateRoleKeysAreDeclared = (rules: OnemaAccessRules): void => {
  for (const [objectName, conditionByRoleKey] of Object.entries(
    rules.objects,
  )) {
    for (const roleKey of Object.keys(conditionByRoleKey)) {
      if (!isDefined(rules.roles[roleKey])) {
        throw new OnemaAccessException(
          `Onema access rules use role "${roleKey}" on object "${objectName}" without declaring its role id`,
          OnemaAccessExceptionCode.INVALID_RULES,
        );
      }
    }
  }
};

// Every object chain of the file is walked statically: each rule becomes one
// correlated subquery per hop, so an unbounded chain is a way to make the
// database do unbounded work on every row of every query
const validateObjectChains = (rules: OnemaAccessRules): void => {
  for (const [objectName, conditionByRoleKey] of Object.entries(
    rules.objects,
  )) {
    for (const [roleKey, condition] of Object.entries(conditionByRoleKey)) {
      if (!isDefined(condition)) {
        continue;
      }

      walkCondition({
        condition,
        roleKey,
        rules,
        objectPath: [objectName],
        budget: { remainingConditions: ONEMA_MAX_CONDITIONS_PER_RULE },
        describeRule: `"${objectName}" and role "${roleKey}"`,
      });
    }
  }
};

type ConditionBudget = { remainingConditions: number };

const walkCondition = ({
  condition,
  roleKey,
  rules,
  objectPath,
  budget,
  describeRule,
}: {
  condition: OnemaCondition;
  roleKey: string;
  rules: OnemaAccessRules;
  objectPath: string[];
  budget: ConditionBudget;
  describeRule: string;
}): void => {
  budget.remainingConditions -= 1;

  if (budget.remainingConditions < 0) {
    throw new OnemaAccessException(
      `Onema access rules use more than ${ONEMA_MAX_CONDITIONS_PER_RULE} conditions for object ${describeRule}`,
      OnemaAccessExceptionCode.INVALID_RULES,
    );
  }

  if ('and' in condition || 'or' in condition) {
    const operands = 'and' in condition ? condition.and : condition.or;

    for (const operand of operands) {
      walkCondition({
        condition: operand,
        roleKey,
        rules,
        objectPath,
        budget,
        describeRule,
      });
    }

    return;
  }

  // The target of an exists is one more object on the chain, like the target of
  // a parent: a chain of nested exists, or a mixed exists → parent → exists one,
  // has to answer to the same depth and cycle limits
  if ('exists' in condition) {
    const nextObjectPath = enterObject({
      objectName: condition.exists.object,
      roleKey,
      objectPath,
    });

    if (isDefined(condition.exists.where)) {
      walkCondition({
        condition: condition.exists.where,
        roleKey,
        rules,
        objectPath: nextObjectPath,
        budget,
        describeRule,
      });
    }

    return;
  }

  if ('parent' in condition) {
    const parentObjectName = condition.parent.object;
    const nextObjectPath = enterObject({
      objectName: parentObjectName,
      roleKey,
      objectPath,
    });
    const parentCondition = rules.objects[parentObjectName]?.[roleKey];

    if (!isDefined(parentCondition)) {
      return;
    }

    walkCondition({
      condition: parentCondition,
      roleKey,
      rules,
      objectPath: nextObjectPath,
      budget,
      describeRule,
    });
  }
};

const enterObject = ({
  objectName,
  roleKey,
  objectPath,
}: {
  objectName: string;
  roleKey: string;
  objectPath: string[];
}): string[] => {
  if (objectPath.includes(objectName)) {
    throw new OnemaAccessException(
      `Onema access rules form a cycle for role "${roleKey}": ${[
        ...objectPath,
        objectName,
      ].join(' -> ')}`,
      OnemaAccessExceptionCode.INVALID_RULES,
    );
  }

  const nextObjectPath = [...objectPath, objectName];

  if (nextObjectPath.length > ONEMA_MAX_RULE_DEPTH) {
    throw new OnemaAccessException(
      `Onema access rules nest deeper than ${ONEMA_MAX_RULE_DEPTH} objects for role "${roleKey}": ${nextObjectPath.join(
        ' -> ',
      )}`,
      OnemaAccessExceptionCode.INVALID_RULES,
    );
  }

  return nextObjectPath;
};
