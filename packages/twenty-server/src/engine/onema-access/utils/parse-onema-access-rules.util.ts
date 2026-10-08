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
  validateRequiredObjectsHaveRules(rules);
  validateObjectChains(rules);
  validateWriteProtectedFields(rules);
  validateFreezeRules(rules);

  return rules;
};

// rls-design §12а Т-1: a protected field is one only our application writes, so
// a file that names such a field without naming the application has described a
// rule nothing can ever satisfy — and would quietly freeze the field for good
const validateWriteProtectedFields = (rules: OnemaAccessRules): void => {
  const fieldsByObjectName = Object.entries(rules.writeProtectedFields ?? {});

  if (fieldsByObjectName.length > 0 && !isDefined(rules.application)) {
    throw new OnemaAccessException(
      'Onema access rules protect fields but declare no "application": nothing would ever be allowed to write them',
      OnemaAccessExceptionCode.INVALID_RULES,
    );
  }

  for (const [objectName, roleKeysByFieldName] of fieldsByObjectName) {
    for (const [fieldName, roleKeys] of Object.entries(roleKeysByFieldName)) {
      for (const roleKey of roleKeys) {
        if (!isDefined(rules.roles[roleKey])) {
          throw new OnemaAccessException(
            `Onema access rules let role "${roleKey}" write protected field "${objectName}.${fieldName}" without declaring its role id`,
            OnemaAccessExceptionCode.INVALID_RULES,
          );
        }
      }
    }
  }
};

// rls-design §12а Т-2. Freezing the field the condition reads is allowed on
// purpose — that is how a stage becomes final — and two rules may freeze one
// field under two conditions; a field repeated inside one rule is a slip
const validateFreezeRules = (rules: OnemaAccessRules): void => {
  for (const [objectName, freezeRules] of Object.entries(
    rules.freezeWhen ?? {},
  )) {
    for (const freezeRule of freezeRules) {
      if (new Set(freezeRule.fields).size !== freezeRule.fields.length) {
        throw new OnemaAccessException(
          `Onema access rules freeze a field of "${objectName}" twice in one rule on "${freezeRule.field}"`,
          OnemaAccessExceptionCode.INVALID_RULES,
        );
      }
    }
  }
};

// The two ways a listed object can end up with no usable rule, both of which
// look like an unfinished edit rather than a decision: no entry in `objects`
// (upstream permissions only — the object stays open) and an entry naming no
// role at all. Either one refuses the file, so the deployment closes every
// record instead of serving half a policy.
const validateRequiredObjectsHaveRules = (rules: OnemaAccessRules): void => {
  for (const objectName of rules.requiredObjects ?? []) {
    const conditionByRoleKey = rules.objects[objectName];

    if (!isDefined(conditionByRoleKey)) {
      throw new OnemaAccessException(
        `Onema access rules list "${objectName}" as required but declare no rule for it: the object would keep upstream permissions only`,
        OnemaAccessExceptionCode.INVALID_RULES,
      );
    }

    if (Object.values(conditionByRoleKey).filter(isDefined).length === 0) {
      throw new OnemaAccessException(
        `Onema access rules list "${objectName}" as required but its rule names no role`,
        OnemaAccessExceptionCode.INVALID_RULES,
      );
    }
  }
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
        rules,
        objectPath: [objectName],
        budget: { remainingConditions: ONEMA_MAX_CONDITIONS_PER_RULE },
        describeRule: `"${objectName}" and role "${roleKey}"`,
      });
    }
  }
};

type ConditionBudget = { remainingConditions: number };

// A reached object brings in the conditions of *every* role, not of the role
// the walk started from: the compiler ORs the rules of all the roles its
// subject holds (compile-onema-row-access.util.ts), so a cycle A(role x) →
// B(role y) → A is a real cycle in the SQL even though no single role closes
// it. Walking one role at a time would let it through here and turn it into a
// silent `denied` at compile time instead of a loud refusal at load time.
const walkObject = ({
  objectName,
  rules,
  objectPath,
  budget,
  describeRule,
}: {
  objectName: string;
  rules: OnemaAccessRules;
  objectPath: string[];
  budget: ConditionBudget;
  describeRule: string;
}): void => {
  const conditionByRoleKey = rules.objects[objectName];

  if (!isDefined(conditionByRoleKey)) {
    return;
  }

  for (const condition of Object.values(conditionByRoleKey)) {
    if (!isDefined(condition)) {
      continue;
    }

    walkCondition({ condition, rules, objectPath, budget, describeRule });
  }
};

const walkCondition = ({
  condition,
  rules,
  objectPath,
  budget,
  describeRule,
}: {
  condition: OnemaCondition;
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
  // has to answer to the same depth and cycle limits — and, since the compiler
  // makes the witness row obey its own object's rule, to that rule too
  if ('exists' in condition) {
    const nextObjectPath = enterObject({
      objectName: condition.exists.object,
      objectPath,
      describeRule,
    });

    walkObject({
      objectName: condition.exists.object,
      rules,
      objectPath: nextObjectPath,
      budget,
      describeRule,
    });

    if (isDefined(condition.exists.where)) {
      walkCondition({
        condition: condition.exists.where,
        rules,
        objectPath: nextObjectPath,
        budget,
        describeRule,
      });
    }

    return;
  }

  if ('parent' in condition) {
    const nextObjectPath = enterObject({
      objectName: condition.parent.object,
      objectPath,
      describeRule,
    });

    walkObject({
      objectName: condition.parent.object,
      rules,
      objectPath: nextObjectPath,
      budget,
      describeRule,
    });
  }
};

const enterObject = ({
  objectName,
  objectPath,
  describeRule,
}: {
  objectName: string;
  objectPath: string[];
  describeRule: string;
}): string[] => {
  if (objectPath.includes(objectName)) {
    throw new OnemaAccessException(
      `Onema access rules form a cycle reachable from object ${describeRule}: ${[
        ...objectPath,
        objectName,
      ].join(' -> ')}`,
      OnemaAccessExceptionCode.INVALID_RULES,
    );
  }

  const nextObjectPath = [...objectPath, objectName];

  if (nextObjectPath.length > ONEMA_MAX_RULE_DEPTH) {
    throw new OnemaAccessException(
      `Onema access rules nest deeper than ${ONEMA_MAX_RULE_DEPTH} objects from object ${describeRule}: ${nextObjectPath.join(
        ' -> ',
      )}`,
      OnemaAccessExceptionCode.INVALID_RULES,
    );
  }

  return nextObjectPath;
};
