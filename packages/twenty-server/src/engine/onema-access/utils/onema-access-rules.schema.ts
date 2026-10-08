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

export const onemaAccessRulesSchema = z.strictObject({
  roles: z.record(z.string().min(1), z.uuid()),
  objects: z.record(
    z.string().min(1),
    z.record(z.string().min(1), onemaConditionSchema),
  ),
});
