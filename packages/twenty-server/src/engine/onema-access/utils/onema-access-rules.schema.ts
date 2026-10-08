import { z } from 'zod';

import { type OnemaCondition } from 'src/engine/onema-access/types/onema-access-rules.type';

const onemaConditionValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

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
      parent: z.strictObject({
        foreignKey: z.string().min(1),
        object: z.string().min(1),
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
});
