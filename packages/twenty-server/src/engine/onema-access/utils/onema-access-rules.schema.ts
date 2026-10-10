import { z } from 'zod';

import { type OnemaCondition } from 'src/engine/onema-access/types/onema-access-rules.type';

const onemaConditionValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

const onemaParentConditionSchema = z.strictObject({
  foreignKey: z.string().min(1),
  object: z.string().min(1),
});

export const onemaConditionSchema: z.ZodType<OnemaCondition> = z.lazy(() =>
  z.union([
    z.strictObject({ all: z.literal(true) }),
    z.strictObject({
      eq: z.tuple([z.string().min(1), onemaConditionValueSchema]),
    }),
    z.strictObject({
      exists: z.strictObject({
        object: z.string().min(1),
        backForeignKey: z.string().min(1),
        where: onemaConditionSchema.optional(),
      }),
    }),
    z.strictObject({
      parent: onemaParentConditionSchema,
    }),
    z.strictObject({
      anyParent: z.strictObject({
        parents: z.array(onemaParentConditionSchema).min(1),
      }),
    }),
    z.strictObject({
      linked: z.strictObject({
        objectIdField: z.string().min(1),
        recordIdField: z.string().min(1),
        objects: z.array(z.string().min(1)).min(1),
      }),
    }),
    z.strictObject({ and: z.array(onemaConditionSchema).min(1) }),
    z.strictObject({ or: z.array(onemaConditionSchema).min(1) }),
  ]),
);

const onemaFreezeRuleSchema = z.strictObject({
  field: z.string().min(1),
  equals: onemaConditionValueSchema,
  fields: z.array(z.string().min(1)).min(1),
  // Absent means "the condition may still be cleared", which is the weaker of
  // the two and has to be the one spelled out by silence
  isIrreversible: z.boolean().optional(),
});

const onemaTransitionRuleSchema = z.strictObject({
  from: onemaConditionValueSchema,
  to: z.array(onemaConditionValueSchema).min(1),
  // `[]` is the way to say "the application alone" — see the type's own
  // comment. Omitting the key entirely has no such reading, so it stays
  // mandatory the same way writeProtectedFields' role list is
  roleKeys: z.array(z.string().min(1)),
});

const onemaObjectTransitionRulesSchema = z.strictObject({
  field: z.string().min(1),
  rules: z.array(onemaTransitionRuleSchema).min(1),
});

export const onemaAccessRulesSchema = z.strictObject({
  // The value is a role universalIdentifier, which is a uuid for the roles
  // Twenty ships but a free-form string for the ones an application declares
  roles: z.record(z.string().min(1), z.string().min(1)),
  // Optional because a file may protect no field at all; demanded by
  // parse-onema-access-rules as soon as writeProtectedFields names one
  application: z.string().min(1).optional(),
  // Objects that must carry a rule. An object missing from `objects` falls back
  // to upstream object and field permissions, which is indistinguishable from
  // "nobody has written its rule yet"; naming it here turns that silence into a
  // refusal of the whole file. Mandatory, and `[]` is the way to say "none":
  // a file that simply forgets the key would be the same silence one level up.
  requiredObjects: z.array(z.string().min(1)),
  objects: z.record(
    z.string().min(1),
    z.record(z.string().min(1), onemaConditionSchema),
  ),
  // Mandatory for the same reason as requiredObjects: "we protect nothing" and
  // "we forgot the key" have to look different in the file. Both are written
  // out as `{}` when there is nothing to say.
  writeProtectedFields: z.record(
    z.string().min(1),
    z.record(z.string().min(1), z.array(z.string().min(1))),
  ),
  // An object listed with no freeze rule is an unfinished edit, not a decision
  freezeWhen: z.record(
    z.string().min(1),
    z.array(onemaFreezeRuleSchema).min(1),
  ),
  // Mandatory and `{}` for "no link grants access", for the same reason as
  // writeProtectedFields: a forgotten key leaves every one of them open
  writeRequiresParentAccess: z.record(
    z.string().min(1),
    z
      .array(
        z.strictObject({
          foreignKey: z.string().min(1),
          object: z.string().min(1),
        }),
      )
      .min(1),
  ),
  // Mandatory and `{}` for "no object is frozen by its parent", for the same
  // reason as writeRequiresParentAccess: a forgotten key would leave every
  // child writable no matter what its parent's row holds
  writeFrozenByParent: z.record(
    z.string().min(1),
    z
      .array(
        z.strictObject({
          foreignKey: z.string().min(1),
          object: z.string().min(1),
          field: z.string().min(1),
          equals: onemaConditionValueSchema,
          allowApplication: z.boolean().optional(),
        }),
      )
      .min(1),
  ),
  // Mandatory and `{}` for "no object has a guarded status field", for the
  // same reason as writeProtectedFields and writeRequiresParentAccess: a
  // forgotten key would leave every status transition open, and that has to
  // look different in the file from a deliberate decision that nothing here
  // needs a transition graph (hardening.md п. 3, rls-design §12а Т-3/Т-7)
  transitions: z.record(z.string().min(1), onemaObjectTransitionRulesSchema),
  // Object -> role key -> the relation that holds the owner. Optional, unlike
  // the keys above, because forgetting it hides nothing: a record created
  // without its owner is refused by the check after the write, loudly, where a
  // forgotten writeProtectedFields would quietly protect nothing at all
  ownerDefaults: z
    .record(z.string().min(1), z.record(z.string().min(1), z.string().min(1)))
    .optional(),
});
