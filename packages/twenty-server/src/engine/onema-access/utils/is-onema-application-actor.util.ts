import { isDefined } from 'twenty-shared/utils';

import { type WorkspaceAuthContext } from 'src/engine/core-modules/auth/types/workspace-auth-context.type';
import { type OnemaAccessRules } from 'src/engine/onema-access/types/onema-access-rules.type';

// Only the application's own context counts, never a person acting through it:
// rls-design §12а is explicit that a record written under an application token
// has no human actor, and that is exactly what makes the field trustworthy
export const isOnemaApplicationActor = ({
  authContext,
  rules,
}: {
  authContext: WorkspaceAuthContext;
  rules: OnemaAccessRules;
}): boolean =>
  authContext.type === 'application' &&
  isDefined(rules.application) &&
  authContext.application.universalIdentifier === rules.application;
