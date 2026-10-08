import { isUserAuthContext } from 'src/engine/core-modules/auth/guards/is-user-auth-context.guard';
import { type WorkspaceAuthContext } from 'src/engine/core-modules/auth/types/workspace-auth-context.type';
import { type UserWorkspaceRoleMap } from 'src/engine/metadata-modules/role-target/types/user-workspace-role-map.type';
import { type OnemaAccessSubject } from 'src/engine/onema-access/types/onema-access-rules.type';
import { resolveRoleIdsFromAuthContext } from 'src/engine/twenty-orm/utils/resolve-role-ids-from-auth-context.util';

// System work (migrations, event publisher snapshots, messaging import) runs
// without a member: rules do not apply to it, exactly as upstream predicates
export const resolveOnemaAccessSubject = ({
  authContext,
  userWorkspaceRoleMap,
  apiKeyRoleMap,
}: {
  authContext: WorkspaceAuthContext;
  userWorkspaceRoleMap: UserWorkspaceRoleMap;
  apiKeyRoleMap: Record<string, string>;
}): OnemaAccessSubject | undefined => {
  if (authContext.type === 'system') {
    return undefined;
  }

  return {
    workspaceMemberId: isUserAuthContext(authContext)
      ? authContext.workspaceMemberId
      : undefined,
    roleIds: resolveRoleIdsFromAuthContext({
      authContext,
      userWorkspaceRoleMap,
      apiKeyRoleMap,
    }),
  };
};
