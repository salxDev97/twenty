import { Logger } from '@nestjs/common';

import {
  ONEMA_ACCESS_LOGGER_CONTEXT,
  ONEMA_PARAMETER_PREFIX,
  ONEMA_RECORD_ID_BATCH_SIZE,
} from 'src/engine/onema-access/constants/onema-access.constants';
import { type OnemaRowAccess } from 'src/engine/onema-access/types/onema-access-rules.type';
import { type OnemaRawQueryExecutor } from 'src/engine/onema-access/utils/assert-onema-written-records-are-accessible.util';
import { chunkOnemaRecordIds } from 'src/engine/onema-access/utils/chunk-onema-record-ids.util';
import { compileOnemaRowAccess } from 'src/engine/onema-access/utils/compile-onema-row-access.util';
import {
  type OnemaAccessScope,
  resolveOnemaAccess,
} from 'src/engine/onema-access/utils/resolve-onema-access.util';
import { escapeIdentifier } from 'src/engine/workspace-manager/workspace-migration/utils/remove-sql-injection.util';

const CANDIDATE_RECORD_IDS_PARAMETER = `${ONEMA_PARAMETER_PREFIX}CandidateRecordIds`;

const logger = new Logger(ONEMA_ACCESS_LOGGER_CONTEXT);

// rls-design §4, point №3. Asks the rules about records nobody is querying: the
// realtime publisher has ids in hand and needs to know which of them the subject
// may see. `undefined` means "the rules say nothing here" — not "all of them" —
// so a caller must keep its own answer rather than open the list.
export const resolveOnemaVisibleRecordIds = async ({
  scope,
  recordIds,
  executeRaw,
}: {
  scope: OnemaAccessScope;
  recordIds: string[];
  executeRaw: OnemaRawQueryExecutor;
}): Promise<Set<string> | undefined> => {
  const resolution = resolveOnemaAccess({
    scope,
    purpose: 'record-visibility',
  });

  if (resolution.kind === 'inactive') {
    return undefined;
  }

  // Unlike a write, there is no caller to tell: an event the rules cannot decide
  // about is an event that does not go out, and the reason goes to the log
  if (resolution.kind === 'refused') {
    logger.error(
      `Onema access rules refuse to decide visibility of "${scope.tableShape.nameSingular}" records: ${resolution.reason}`,
    );

    return new Set();
  }

  let rowAccess: OnemaRowAccess;

  try {
    rowAccess = compileOnemaRowAccess({
      tableShape: scope.tableShape,
      tableAlias: scope.tableShape.nameSingular,
      context: resolution.compilationContext,
    });
  } catch (error) {
    logger.error(
      `Onema access rules failed to compile for "${scope.tableShape.nameSingular}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    return new Set();
  }

  if (rowAccess.kind === 'open') {
    return undefined;
  }

  if (rowAccess.kind === 'denied') {
    return new Set();
  }

  if (recordIds.length === 0) {
    return new Set();
  }

  const tableAlias = scope.tableShape.nameSingular;
  const visibleRecordIds = new Set<string>();

  // Batched for the same reason the check after a write is (С3): the caller's
  // list is bounded by an event batch, not by anything we choose
  for (const recordIdBatch of chunkOnemaRecordIds(
    recordIds,
    ONEMA_RECORD_ID_BATCH_SIZE,
  )) {
    const visibleRows = await executeRaw(
      `SELECT ${escapeIdentifier(tableAlias)}."id" FROM ${escapeIdentifier(
        scope.tableShape.schemaName,
      )}.${escapeIdentifier(scope.tableShape.tableName)} AS ${escapeIdentifier(
        tableAlias,
      )} WHERE ${escapeIdentifier(tableAlias)}."id" IN (:...${CANDIDATE_RECORD_IDS_PARAMETER}) AND (${rowAccess.condition.sql})`,
      {
        ...rowAccess.condition.parameters,
        [CANDIDATE_RECORD_IDS_PARAMETER]: recordIdBatch,
      },
    );

    for (const visibleRow of visibleRows) {
      visibleRecordIds.add(String(visibleRow.id));
    }
  }

  return visibleRecordIds;
};
