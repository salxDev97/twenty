import { type WorkspaceAuthContext } from 'src/engine/core-modules/auth/types/workspace-auth-context.type';
import { buildTestTableShapeRegistry } from 'src/engine/onema-access/__tests__/utils/build-test-table-shape.util';
import { type OnemaAccessScope } from 'src/engine/onema-access/utils/resolve-onema-access.util';
import { type WorkspaceInternalContext } from 'src/engine/twenty-orm/interfaces/workspace-internal-context.interface';
import { type WorkspaceTableShape } from 'src/engine/twenty-orm/table-shape/types/workspace-table-shape.type';

export const SALES_ROLE_ID = '00000000-0000-4000-8000-000000000005';
export const SALES_ROLE_UNIVERSAL_IDENTIFIER = 'onema-sales';
export const CEO_ROLE_ID = '00000000-0000-4000-8000-000000000001';
export const CEO_ROLE_UNIVERSAL_IDENTIFIER = 'onema-ceo';
export const APPLICATION_UNIVERSAL_IDENTIFIER = 'onema-application';
export const WORKSPACE_MEMBER_ID = '11111111-1111-4111-8111-111111111111';
export const USER_WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';
export const CEO_USER_WORKSPACE_ID = '33333333-3333-4333-8333-333333333333';
export const API_KEY_ID = '44444444-4444-4444-8444-444444444444';
export const CEO_API_KEY_ID = '55555555-5555-4555-8555-555555555555';

export const salesAuthContext = {
  type: 'user',
  workspaceMemberId: WORKSPACE_MEMBER_ID,
  userWorkspaceId: USER_WORKSPACE_ID,
} as unknown as WorkspaceAuthContext;

export const ceoAuthContext = {
  type: 'user',
  workspaceMemberId: WORKSPACE_MEMBER_ID,
  userWorkspaceId: CEO_USER_WORKSPACE_ID,
} as unknown as WorkspaceAuthContext;

export const apiKeyAuthContext = {
  type: 'apiKey',
  apiKey: { id: API_KEY_ID },
} as unknown as WorkspaceAuthContext;

export const ceoApiKeyAuthContext = {
  type: 'apiKey',
  apiKey: { id: CEO_API_KEY_ID },
} as unknown as WorkspaceAuthContext;

// What a worker or a scheduled job carries: no user, no role, and nothing the
// rules can read as "$me"
export const systemAuthContext = {
  type: 'system',
} as unknown as WorkspaceAuthContext;

export const applicationAuthContext = {
  type: 'application',
  application: { universalIdentifier: APPLICATION_UNIVERSAL_IDENTIFIER },
} as unknown as WorkspaceAuthContext;

export const otherApplicationAuthContext = {
  type: 'application',
  application: { universalIdentifier: 'somebody-elses-application' },
} as unknown as WorkspaceAuthContext;

export const buildTestAccessScope = ({
  tableShape,
  tableShapes = [tableShape],
  authContext = salesAuthContext,
  shouldBypassPermissionChecks = false,
}: {
  tableShape: WorkspaceTableShape;
  tableShapes?: WorkspaceTableShape[];
  authContext?: WorkspaceAuthContext;
  shouldBypassPermissionChecks?: boolean;
}): OnemaAccessScope => {
  const { objectIdByNameSingular, tableShapeByObjectMetadataId } =
    buildTestTableShapeRegistry(tableShapes);

  return {
    tableShape,
    authContext,
    shouldBypassPermissionChecks,
    tableShapeByObjectMetadataId,
    internalContext: {
      objectIdByNameSingular,
      flatObjectMetadataMaps: {},
      userWorkspaceRoleMap: {
        [USER_WORKSPACE_ID]: SALES_ROLE_ID,
        [CEO_USER_WORKSPACE_ID]: CEO_ROLE_ID,
      },
      apiKeyRoleMap: {
        [API_KEY_ID]: SALES_ROLE_ID,
        [CEO_API_KEY_ID]: CEO_ROLE_ID,
      },
      flatRoleMaps: {
        byUniversalIdentifier: {
          [SALES_ROLE_UNIVERSAL_IDENTIFIER]: { id: SALES_ROLE_ID },
          [CEO_ROLE_UNIVERSAL_IDENTIFIER]: { id: CEO_ROLE_ID },
        },
        universalIdentifierById: {
          [SALES_ROLE_ID]: SALES_ROLE_UNIVERSAL_IDENTIFIER,
          [CEO_ROLE_ID]: CEO_ROLE_UNIVERSAL_IDENTIFIER,
        },
        universalIdentifiersByApplicationId: {},
      },
    } as unknown as WorkspaceInternalContext,
  };
};
