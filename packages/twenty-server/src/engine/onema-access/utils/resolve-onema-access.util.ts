import { type WorkspaceAuthContext } from 'src/engine/core-modules/auth/types/workspace-auth-context.type';
import {
  type OnemaAccessRules,
  type OnemaAccessSubject,
} from 'src/engine/onema-access/types/onema-access-rules.type';
import {
  buildOnemaCompilationContext,
  type OnemaCompilationContext,
} from 'src/engine/onema-access/utils/compile-onema-row-access.util';
import {
  getOnemaAccessRulesState,
  isOnemaAccessEnforced,
} from 'src/engine/onema-access/utils/load-onema-access-rules.util';
import { resolveOnemaAccessSubject } from 'src/engine/onema-access/utils/resolve-onema-access-subject.util';
import { validateOnemaAccessRulesAgainstMetadata } from 'src/engine/onema-access/utils/validate-onema-access-rules-against-metadata.util';
import { type WorkspaceInternalContext } from 'src/engine/twenty-orm/interfaces/workspace-internal-context.interface';
import { type WorkspaceTableShape } from 'src/engine/twenty-orm/table-shape/types/workspace-table-shape.type';

// Everything the rules need from the repository, gathered once so each hook in
// the core stays a single call
export type OnemaAccessScope = {
  tableShape: WorkspaceTableShape;
  authContext: WorkspaceAuthContext;
  internalContext: WorkspaceInternalContext;
  tableShapeByObjectMetadataId: (
    objectMetadataId: string,
  ) => WorkspaceTableShape;
  shouldBypassPermissionChecks: boolean;
};

// `refused` carries no condition to apply: a rules file that stopped parsing, or
// that does not match this workspace, closes reads and writes alike rather than
// falling back to upstream permissions (ADR-003: closed by default)
export type OnemaAccessResolution =
  | { kind: 'inactive' }
  | { kind: 'refused'; reason: string }
  | {
      kind: 'active';
      rules: OnemaAccessRules;
      subject: OnemaAccessSubject;
      compilationContext: OnemaCompilationContext;
    };

// Whether anything could be enforced at all, without touching workspace
// metadata: the core decides whether a write needs a transaction before it has
// a row to check, and that decision must not cost a validation pass
export const isOnemaAccessPossiblyActive = (): boolean => {
  const rulesState = getOnemaAccessRulesState();

  if (rulesState.kind === 'absent') {
    return false;
  }

  return rulesState.isTestingOverride || isOnemaAccessEnforced();
};

export const resolveOnemaAccess = (
  scope: OnemaAccessScope,
): OnemaAccessResolution => {
  if (scope.shouldBypassPermissionChecks) {
    return { kind: 'inactive' };
  }

  const rulesState = getOnemaAccessRulesState();

  if (rulesState.kind === 'absent') {
    return { kind: 'inactive' };
  }

  // Release gate (ADR-003): rules are read and validated whether or not they are
  // applied, so a stand can load the real file long before enforcement is safe.
  // The testing bridge carries its own enforcement, since the app under
  // integration test does not see the environment the test sets.
  if (!rulesState.isTestingOverride && !isOnemaAccessEnforced()) {
    return { kind: 'inactive' };
  }

  if (rulesState.kind === 'failed') {
    return { kind: 'refused', reason: rulesState.reason };
  }

  const { rules } = rulesState;
  const validation = validateOnemaAccessRulesAgainstMetadata({
    rules,
    rulesVersion: rulesState.contentHash,
    flatObjectMetadataMaps: scope.internalContext.flatObjectMetadataMaps,
    metadata: {
      objectIdByNameSingular: scope.internalContext.objectIdByNameSingular,
      tableShapeByObjectMetadataId: scope.tableShapeByObjectMetadataId,
      flatRoleMaps: scope.internalContext.flatRoleMaps,
    },
  });

  if (validation.kind === 'invalid') {
    return {
      kind: 'refused',
      reason: `Onema access rules do not match this workspace: ${validation.problems.join('; ')}`,
    };
  }

  const subject = resolveOnemaAccessSubject({
    authContext: scope.authContext,
    userWorkspaceRoleMap: scope.internalContext.userWorkspaceRoleMap,
    apiKeyRoleMap: scope.internalContext.apiKeyRoleMap,
    flatRoleMaps: scope.internalContext.flatRoleMaps,
  });

  return {
    kind: 'active',
    rules,
    subject,
    compilationContext: buildOnemaCompilationContext({
      rules,
      subject,
      objectIdByNameSingular: scope.internalContext.objectIdByNameSingular,
      tableShapeByObjectMetadataId: scope.tableShapeByObjectMetadataId,
    }),
  };
};
