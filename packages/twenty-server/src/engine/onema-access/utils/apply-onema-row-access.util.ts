import { Logger } from '@nestjs/common';
import { isDefined } from 'twenty-shared/utils';

import {
  ONEMA_ACCESS_LOGGER_CONTEXT,
  ONEMA_ALWAYS_FALSE_CONDITION,
  ONEMA_ROW_ACCESS_MARK_PREFIX,
} from 'src/engine/onema-access/constants/onema-access.constants';
import { type OnemaRowAccess } from 'src/engine/onema-access/types/onema-access-rules.type';
import {
  compileOnemaRowAccess,
  type OnemaCompilationContext,
} from 'src/engine/onema-access/utils/compile-onema-row-access.util';
import {
  type OnemaAccessScope,
  resolveOnemaAccess,
} from 'src/engine/onema-access/utils/resolve-onema-access.util';
import { type WorkspaceSelectQueryBuilder } from 'src/engine/twenty-orm/query-builder/workspace-select-query-builder';
import { type WorkspaceTableShape } from 'src/engine/twenty-orm/table-shape/types/workspace-table-shape.type';

const logger = new Logger(ONEMA_ACCESS_LOGGER_CONTEXT);

// Single entry point of the Onema record-level rules into the ORM: it runs for
// every alias the query touches, so reads, joins, exists filters, group-by and
// the criteria of updates and deletes are all narrowed by the same predicate
export const applyOnemaRowAccess = ({
  queryBuilder,
  scope,
}: {
  queryBuilder: WorkspaceSelectQueryBuilder;
  scope: OnemaAccessScope;
}): void => {
  const resolution = resolveOnemaAccess(scope);

  if (resolution.kind === 'inactive') {
    return;
  }

  if (resolution.kind === 'refused') {
    denyWholeQuery(queryBuilder);

    return;
  }

  const context = resolution.compilationContext;

  applyForAlias({
    queryBuilder,
    alias: queryBuilder.alias,
    tableShape: scope.tableShape,
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
