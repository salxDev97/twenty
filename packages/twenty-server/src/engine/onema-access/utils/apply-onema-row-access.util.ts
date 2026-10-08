import { Logger } from '@nestjs/common';
import { isDefined } from 'twenty-shared/utils';

import { type WorkspaceAuthContext } from 'src/engine/core-modules/auth/types/workspace-auth-context.type';
import {
  ONEMA_ACCESS_LOGGER_CONTEXT,
  ONEMA_ALWAYS_FALSE_CONDITION,
  ONEMA_ROW_ACCESS_MARK_PREFIX,
} from 'src/engine/onema-access/constants/onema-access.constants';
import { type OnemaRowAccess } from 'src/engine/onema-access/types/onema-access-rules.type';
import { validateOnemaAccessRulesAgainstMetadata } from 'src/engine/onema-access/utils/validate-onema-access-rules-against-metadata.util';
import {
  buildOnemaCompilationContext,
  compileOnemaRowAccess,
  type OnemaCompilationContext,
} from 'src/engine/onema-access/utils/compile-onema-row-access.util';
import {
  getOnemaAccessRulesState,
  isOnemaAccessEnforced,
} from 'src/engine/onema-access/utils/load-onema-access-rules.util';
import { resolveOnemaAccessSubject } from 'src/engine/onema-access/utils/resolve-onema-access-subject.util';
import { type WorkspaceInternalContext } from 'src/engine/twenty-orm/interfaces/workspace-internal-context.interface';
import { type WorkspaceSelectQueryBuilder } from 'src/engine/twenty-orm/query-builder/workspace-select-query-builder';
import { type WorkspaceTableShape } from 'src/engine/twenty-orm/table-shape/types/workspace-table-shape.type';

const logger = new Logger(ONEMA_ACCESS_LOGGER_CONTEXT);

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
  const rulesState = getOnemaAccessRulesState();

  if (rulesState.kind === 'absent') {
    return;
  }

  // Release gate (ADR-003): rules are read and validated whether or not they are
  // applied, so a stand can load the real file long before ONE-111…113 make
  // enforcement safe. The testing bridge carries its own enforcement, since the
  // app under integration test does not see the environment the test sets.
  if (!rulesState.isTestingOverride && !isOnemaAccessEnforced()) {
    return;
  }

  if (rulesState.kind === 'failed') {
    denyWholeQuery(queryBuilder);

    return;
  }

  const rules = rulesState.rules;
  const validation = validateOnemaAccessRulesAgainstMetadata({
    rules,
    rulesVersion: rulesState.contentHash,
    flatObjectMetadataMaps: internalContext.flatObjectMetadataMaps,
    metadata: {
      objectIdByNameSingular: internalContext.objectIdByNameSingular,
      tableShapeByObjectMetadataId,
      flatRoleMaps: internalContext.flatRoleMaps,
    },
  });

  if (validation.kind === 'invalid') {
    denyWholeQuery(queryBuilder);

    return;
  }

  const subject = resolveOnemaAccessSubject({
    authContext,
    userWorkspaceRoleMap: internalContext.userWorkspaceRoleMap,
    apiKeyRoleMap: internalContext.apiKeyRoleMap,
    flatRoleMaps: internalContext.flatRoleMaps,
  });

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

    // An alias whose table we cannot name is an alias we cannot check against
    // the rules, so the whole query goes rather than the alias being skipped
    if (!isDefined(joinedTableShape)) {
      logger.error(
        `Onema access rules cannot be applied to joined alias "${joinAlias.name}": no table shape; the query returns nothing`,
      );
      denyWholeQuery(queryBuilder);

      return;
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

  // Validation above should have caught anything the compiler can refuse, so
  // this is a backstop: a refusal here must still end as no rows, never as a
  // 500 that an unfiltered retry could follow
  let rowAccess: OnemaRowAccess;

  try {
    rowAccess = compileOnemaRowAccess({
      tableShape,
      tableAlias: alias,
      context,
    });
  } catch (error) {
    logger.error(
      `Onema access rules failed to compile for alias "${alias}" on "${tableShape.nameSingular}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    denyWholeQuery(queryBuilder);

    return;
  }

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

// The main alias carries the denial for the whole query: a join condition alone
// would still let the row through on a LEFT JOIN
const denyWholeQuery = (queryBuilder: WorkspaceSelectQueryBuilder): void => {
  queryBuilder.addRowAccessCondition(ONEMA_ALWAYS_FALSE_CONDITION, {});
};
