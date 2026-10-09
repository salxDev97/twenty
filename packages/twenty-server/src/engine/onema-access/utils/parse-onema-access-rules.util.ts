import { isDefined } from 'twenty-shared/utils';

import {
  ONEMA_MAX_CONDITIONS_PER_RULE,
  ONEMA_MAX_RULE_DEPTH,
  ONEMA_MAX_RULE_DEPTH_THROUGH_POLYMORPHIC_TARGET,
} from 'src/engine/onema-access/constants/onema-access.constants';
import {
  OnemaAccessException,
  OnemaAccessExceptionCode,
} from 'src/engine/onema-access/exceptions/onema-access.exception';
import {
  type OnemaAccessRules,
  type OnemaCondition,
} from 'src/engine/onema-access/types/onema-access-rules.type';
import { closesOnemaRuleCycle } from 'src/engine/onema-access/utils/closes-onema-rule-cycle.util';
import { isOnemaPolymorphicParentSet } from 'src/engine/onema-access/utils/compile-onema-row-access.util';
import { onemaAccessRulesSchema } from 'src/engine/onema-access/utils/onema-access-rules.schema';

const CURRENT_MEMBER_TOKEN = '$me';

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
  validatePolymorphicTargetsHaveRules(rules);
  validateObjectChains(rules);
  validateWriteParentChains(rules);
  validateWriteProtectedFields(rules);
  validateFreezeRules(rules);
  validateOwnerDefaults(rules);

  return rules;
};

// rls-design §3.3 point №5. A default is only ever useful where the rule reads
// that very field as "mine": filling anything else hands out ownership no rule
// looks at, and filling a field the role does not need leaves the record
// visible to it for a reason the file never stated.
const validateOwnerDefaults = (rules: OnemaAccessRules): void => {
  for (const [objectName, fieldNameByRoleKey] of Object.entries(
    rules.ownerDefaults ?? {},
  )) {
    for (const [roleKey, fieldName] of Object.entries(fieldNameByRoleKey)) {
      if (!isDefined(rules.roles[roleKey])) {
        throw new OnemaAccessException(
          `Onema access rules fill the owner of "${objectName}" for role "${roleKey}" without declaring its role id`,
          OnemaAccessExceptionCode.INVALID_RULES,
        );
      }

      const condition = rules.objects[objectName]?.[roleKey];

      if (
        !isDefined(condition) ||
        !('eq' in condition) ||
        condition.eq[0] !== fieldName ||
        condition.eq[1] !== CURRENT_MEMBER_TOKEN
      ) {
        throw new OnemaAccessException(
          `Onema access rules fill "${objectName}.${fieldName}" for role "${roleKey}", whose rule is not "${fieldName} is $me"`,
          OnemaAccessExceptionCode.INVALID_RULES,
        );
      }
    }
  }
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

      // The latch already freezes the condition field, so naming it again is
      // the same slip as any other repetition
      if (
        freezeRule.isIrreversible &&
        freezeRule.fields.includes(freezeRule.field)
      ) {
        throw new OnemaAccessException(
          `Onema access rules freeze the condition field "${objectName}.${freezeRule.field}" twice: "isIrreversible" already does it`,
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

// A plain `parent` to an object the rules never name adds no restriction and
// that is on purpose (README, "Умолчания"). Inside `anyParent` and `linked` the
// same silence is a hole: the branches are alternatives joined by OR, so one
// target without a rule of its own makes every record that happens to hang off
// that target visible to everyone the object permission admits. Naming a target
// is therefore a promise that the target itself is ruled.
const validatePolymorphicTargetsHaveRules = (rules: OnemaAccessRules): void => {
  for (const [objectName, conditionByRoleKey] of Object.entries(
    rules.objects,
  )) {
    for (const [roleKey, condition] of Object.entries(conditionByRoleKey)) {
      if (!isDefined(condition)) {
        continue;
      }

      for (const targetObjectName of collectPolymorphicTargets(condition)) {
        if (!isDefined(rules.objects[targetObjectName])) {
          throw new OnemaAccessException(
            `Onema access rules reach "${targetObjectName}" through a polymorphic target of "${objectName}" and role "${roleKey}", but declare no rule for it: every record pointing there would be open`,
            OnemaAccessExceptionCode.INVALID_RULES,
          );
        }
      }
    }
  }
};

const collectPolymorphicTargets = (condition: OnemaCondition): string[] => {
  if ('and' in condition || 'or' in condition) {
    return ('and' in condition ? condition.and : condition.or).flatMap(
      collectPolymorphicTargets,
    );
  }

  if ('anyParent' in condition) {
    return condition.anyParent.parents.map((parent) => parent.object);
  }

  if ('linked' in condition) {
    return condition.linked.objects;
  }

  if ('exists' in condition && isDefined(condition.exists.where)) {
    return collectPolymorphicTargets(condition.exists.where);
  }

  return [];
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
        chain: {
          objectPath: [objectName],
          maxObjectDepth: ONEMA_MAX_RULE_DEPTH,
        },
        budget: { remainingConditions: ONEMA_MAX_CONDITIONS_PER_RULE },
        describeRule: `"${objectName}" and role "${roleKey}"`,
      });
    }
  }
};

// Б5 links are compiled into the same joins as a rule and were walked by
// nothing: a link too deep, or one that closes a cycle, turned into a silent
// `denied` at compile time, and a silent `denied` on a write-parent check reads
// as "this foreign key must stay empty" — the author is told their row may hang
// on nothing at all. The walk makes it a refusal of the file instead.
//
// Several links on one object are a polymorphic set and get the budget their
// `anyParent` would get, exactly as the compiler gives it
// (isOnemaPolymorphicParentSet in compile-onema-row-access.util.ts).
const validateWriteParentChains = (rules: OnemaAccessRules): void => {
  for (const [objectName, parents] of Object.entries(
    rules.writeRequiresParentAccess ?? {},
  )) {
    const chain: ObjectChain = {
      objectPath: [objectName],
      maxObjectDepth: isOnemaPolymorphicParentSet(parents)
        ? ONEMA_MAX_RULE_DEPTH_THROUGH_POLYMORPHIC_TARGET
        : ONEMA_MAX_RULE_DEPTH,
      cycleExemptObjectName: objectName,
    };

    for (const parent of parents) {
      walkTarget({
        objectName: parent.object,
        rules,
        chain,
        budget: { remainingConditions: ONEMA_MAX_CONDITIONS_PER_RULE },
        describeRule: `"${objectName}" and its writeRequiresParentAccess link "${parent.foreignKey}"`,
      });
    }
  }
};

type ConditionBudget = { remainingConditions: number };

// Mirrors the compiler's chain (compile-onema-row-access.util.ts): the same
// path and the same budget, so a rule the loader accepts is a rule the compiler
// can actually build instead of silently turning into "no rows"
type ObjectChain = {
  objectPath: string[];
  maxObjectDepth: number;
  // See the compiler's state field of the same name: a write-parent walk starts
  // at the row being written, so the parent's rule reaching that object again is
  // other rows of it under their own rule, not a cycle
  cycleExemptObjectName?: string;
};

// A reached object brings in the conditions of *every* role, not of the role
// the walk started from: the compiler ORs the rules of all the roles its
// subject holds (compile-onema-row-access.util.ts), so a cycle A(role x) →
// B(role y) → A is a real cycle in the SQL even though no single role closes
// it. Walking one role at a time would let it through here and turn it into a
// silent `denied` at compile time instead of a loud refusal at load time.
const walkObject = ({
  objectName,
  rules,
  chain,
  budget,
  describeRule,
}: {
  objectName: string;
  rules: OnemaAccessRules;
  chain: ObjectChain;
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

    walkCondition({ condition, rules, chain, budget, describeRule });
  }
};

const walkCondition = ({
  condition,
  rules,
  chain,
  budget,
  describeRule,
}: {
  condition: OnemaCondition;
  rules: OnemaAccessRules;
  chain: ObjectChain;
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
        chain,
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
    const nextChain = enterObject({
      objectName: condition.exists.object,
      chain,
      describeRule,
    });

    walkObject({
      objectName: condition.exists.object,
      rules,
      chain: nextChain,
      budget,
      describeRule,
    });

    if (isDefined(condition.exists.where)) {
      walkCondition({
        condition: condition.exists.where,
        rules,
        chain: nextChain,
        budget,
        describeRule,
      });
    }

    return;
  }

  if ('parent' in condition) {
    walkTarget({
      objectName: condition.parent.object,
      rules,
      chain,
      budget,
      describeRule,
    });

    return;
  }

  if ('anyParent' in condition) {
    for (const parent of condition.anyParent.parents) {
      walkTarget({
        objectName: parent.object,
        rules,
        chain: widenChainForPolymorphicTarget(chain),
        budget,
        describeRule,
      });
    }

    return;
  }

  if ('linked' in condition) {
    for (const objectName of condition.linked.objects) {
      walkTarget({
        objectName,
        rules,
        chain: widenChainForPolymorphicTarget(chain),
        budget,
        describeRule,
      });
    }
  }
};

const walkTarget = ({
  objectName,
  rules,
  chain,
  budget,
  describeRule,
}: {
  objectName: string;
  rules: OnemaAccessRules;
  chain: ObjectChain;
  budget: ConditionBudget;
  describeRule: string;
}): void =>
  walkObject({
    objectName,
    rules,
    chain: enterObject({ objectName, chain, describeRule }),
    budget,
    describeRule,
  });

const widenChainForPolymorphicTarget = (chain: ObjectChain): ObjectChain => ({
  ...chain,
  maxObjectDepth: Math.max(
    chain.maxObjectDepth,
    ONEMA_MAX_RULE_DEPTH_THROUGH_POLYMORPHIC_TARGET,
  ),
});

const enterObject = ({
  objectName,
  chain,
  describeRule,
}: {
  objectName: string;
  chain: ObjectChain;
  describeRule: string;
}): ObjectChain => {
  if (
    closesOnemaRuleCycle({
      objectPath: chain.objectPath,
      objectName,
      cycleExemptObjectName: chain.cycleExemptObjectName,
    })
  ) {
    throw new OnemaAccessException(
      `Onema access rules form a cycle reachable from object ${describeRule}: ${[
        ...chain.objectPath,
        objectName,
      ].join(' -> ')}`,
      OnemaAccessExceptionCode.INVALID_RULES,
    );
  }

  const objectPath = [...chain.objectPath, objectName];

  if (objectPath.length > chain.maxObjectDepth) {
    throw new OnemaAccessException(
      `Onema access rules nest deeper than ${chain.maxObjectDepth} objects from object ${describeRule}: ${objectPath.join(
        ' -> ',
      )}`,
      OnemaAccessExceptionCode.INVALID_RULES,
    );
  }

  return { ...chain, objectPath };
};
