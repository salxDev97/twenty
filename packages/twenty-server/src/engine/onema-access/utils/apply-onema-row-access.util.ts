import { isDefined } from 'twenty-shared/utils';

import { type WorkspaceAuthContext } from 'src/engine/core-modules/auth/types/workspace-auth-context.type';
import {
  ONEMA_ALWAYS_FALSE_CONDITION,
  ONEMA_ROW_ACCESS_MARK_PREFIX,
} from 'src/engine/onema-access/constants/onema-access.constants';
import {
  buildOnemaCompilationContext,
  compileOnemaRowAccess,
  type OnemaCompilationContext,
} from 'src/engine/onema-access/utils/compile-onema-row-access.util';
import { loadOnemaAccessRules } from 'src/engine/onema-access/utils/load-onema-access-rules.util';
import { resolveOnemaAccessSubject } from 'src/engine/onema-access/utils/resolve-onema-access-subject.util';
import { type WorkspaceInternalContext } from 'src/engine/twenty-orm/interfaces/workspace-internal-context.interface';
import { type WorkspaceSelectQueryBuilder } from 'src/engine/twenty-orm/query-builder/workspace-select-query-builder';
import { type WorkspaceTableShape } from 'src/engine/twenty-orm/table-shape/types/workspace-table-shape.type';

// Single entry point of the Onema record-level rules into the ORM: it runs for
// every alias the query touches, so reads, joins, exists filters, group-by and
// the criteria of updates and deletes are all narrowed by the same predicate
export const applyOnemaRowAccess = ({
  queryBuilder,
  tableShape,
  authContext,
  internalContext,
  tableShapeByObjectMetadataId,
}: {
  queryBuilder: WorkspaceSelectQueryBuilder;
  tableShape: WorkspaceTableShape;
  authContext: WorkspaceAuthContext;
  internalContext: WorkspaceInternalContext;
  tableShapeByObjectMetadataId: (
    objectMetadataId: string,
  ) => WorkspaceTableShape;
}): void => {
  const rules = loadOnemaAccessRules();

  if (!isDefined(rules)) {
    return;
  }

  const subject = resolveOnemaAccessSubject({
    authContext,
    userWorkspaceRoleMap: internalContext.userWorkspaceRoleMap,
    apiKeyRoleMap: internalContext.apiKeyRoleMap,
  });

  if (!isDefined(subject)) {
    return;
  }

  const context = buildOnemaCompilationContext({
    rules,
    subject,
    objectIdByNameSingular: internalContext.objectIdByNameSingular,
    tableShapeByObjectMetadataId,
  });

  applyForAlias({
    queryBuilder,
    alias: queryBuilder.alias,
    tableShape,
    context,
  });

  for (const joinAlias of queryBuilder.getJoinAliases()) {
    const joinedTableShape = queryBuilder.getJoinedTableShape(joinAlias.name);

    if (!isDefined(joinedTableShape)) {
      continue;
    }

    applyForAlias({
      queryBuilder,
      alias: joinAlias.name,
      tableShape: joinedTableShape,
      context,
    });
  }
};

const applyForAlias = ({
  queryBuilder,
  alias,
  tableShape,
  context,
}: {
  queryBuilder: WorkspaceSelectQueryBuilder;
  alias: string;
  tableShape: WorkspaceTableShape;
  context: OnemaCompilationContext;
}): void => {
  if (
    !queryBuilder.markRowLevelPermissionApplied(
      `${ONEMA_ROW_ACCESS_MARK_PREFIX}${alias}`,
    )
  ) {
    return;
  }

  const rowAccess = compileOnemaRowAccess({
    tableShape,
    tableAlias: alias,
    context,
  });

  if (rowAccess.kind === 'open') {
    return;
  }

  // Denial is "no such record", not "permission denied": a role that may read
  // the object still gets an empty result instead of an error
  const condition =
    rowAccess.kind === 'denied'
      ? { sql: ONEMA_ALWAYS_FALSE_CONDITION, parameters: {} }
      : rowAccess.condition;

  if (alias === queryBuilder.alias) {
    queryBuilder.addRowAccessCondition(condition.sql, condition.parameters);

    return;
  }

  queryBuilder.addJoinCondition(alias, condition.sql);
  queryBuilder.setParameters(condition.parameters);
};
