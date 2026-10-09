import { isDefined } from 'twenty-shared/utils';

import { isUserAuthContext } from 'src/engine/core-modules/auth/guards/is-user-auth-context.guard';
import { type WorkspaceAuthContext } from 'src/engine/core-modules/auth/types/workspace-auth-context.type';
import { type FlatRoleMaps } from 'src/engine/metadata-modules/flat-role/types/flat-role-maps.type';
import { type UserWorkspaceRoleMap } from 'src/engine/metadata-modules/role-target/types/user-workspace-role-map.type';
import { type OnemaAccessSubject } from 'src/engine/onema-access/types/onema-access-rules.type';
import { getRoleIdsFromRolePermissionConfig } from 'src/engine/twenty-orm/utils/get-role-ids-from-role-permission-config.util';
import { resolveRolePermissionConfig } from 'src/engine/twenty-orm/utils/resolve-role-permission-config.util';

// rls-design §4: roles come from the RolePermissionConfig of the repository, not
// from the auth context directly, and the rules file names them by the stable
// universalIdentifier — a role id is recreated on reinstall and a label is
// renamed in the UI, so neither identifies a role across deployments.
//
// There is deliberately no bypass here for `authContext.type === 'system'`:
// buildSystemAuthContext is reachable from workflow actions, AI tools, timeline
// and messaging code. The one trusted bypass is the explicit
// `shouldBypassPermissionChecks` a caller asks for when building the repository,
// and upstream already returns before this hook in that case. A system context
// that does reach here holds no role, so every object under a rule closes.
export const resolveOnemaAccessSubject = ({
  authContext,
  userWorkspaceRoleMap,
  apiKeyRoleMap,
  flatRoleMaps,
}: {
  authContext: WorkspaceAuthContext;
  userWorkspaceRoleMap: UserWorkspaceRoleMap;
  apiKeyRoleMap: Record<string, string>;
  flatRoleMaps: FlatRoleMaps;
}): OnemaAccessSubject => {
  const rolePermissionConfig = resolveRolePermissionConfig({
    authContext,
    userWorkspaceRoleMap,
    apiKeyRoleMap,
  });
  const roleIds = isDefined(rolePermissionConfig)
    ? getRoleIdsFromRolePermissionConfig(rolePermissionConfig)
    : [];

  return buildOnemaAccessSubject({
    roleIds,
    workspaceMemberId: isUserAuthContext(authContext)
      ? authContext.workspaceMemberId
      : undefined,
    flatRoleMaps,
  });
};

// The realtime publisher (rls-design §4, point №3) already holds the roles of
// the stream's subscriber and cannot reach them through an auth context: the
// stream stores ids, and the actor of the surrounding request is whoever wrote
// the record, not whoever is subscribed to it
export const buildOnemaAccessSubject = ({
  roleIds,
  workspaceMemberId,
  flatRoleMaps,
}: {
  roleIds: string[];
  workspaceMemberId: string | undefined;
  flatRoleMaps: FlatRoleMaps;
}): OnemaAccessSubject => ({
  workspaceMemberId,
  roleUniversalIdentifiers: roleIds
    .map((roleId) => flatRoleMaps.universalIdentifierById[roleId])
    .filter(isDefined),
});
