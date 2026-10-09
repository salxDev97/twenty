import { isDefined } from 'twenty-shared/utils';

import {
  ONEMA_PARAMETER_PREFIX,
  ONEMA_RECORD_ID_BATCH_SIZE,
} from 'src/engine/onema-access/constants/onema-access.constants';
import { type OnemaRawQueryExecutor } from 'src/engine/onema-access/utils/assert-onema-written-records-are-accessible.util';
import { chunkOnemaRecordIds } from 'src/engine/onema-access/utils/chunk-onema-record-ids.util';
import { onemaWriteDenied } from 'src/engine/onema-access/utils/onema-write-denied.util';
import {
  type OnemaAccessScope,
  resolveOnemaAccess,
} from 'src/engine/onema-access/utils/resolve-onema-access.util';
import { escapeIdentifier } from 'src/engine/workspace-manager/workspace-migration/utils/remove-sql-injection.util';

const LOCKED_RECORD_IDS_PARAMETER = `${ONEMA_PARAMETER_PREFIX}LockedRecordIds`;

// rls-design §12а Т-2, the race the freeze has on its own. The comparison runs
// in the application: it reads the row, decides, and only then writes. Two
// transactions that both read a lead still in "Предложение" both decide the
// company is free to change — one of them moves the lead to "Сделка", the other
// swaps the company under it, and neither ever saw a frozen record.
//
// So the rows about to be updated are locked first, in the transaction that is
// about to write them, and the state the freeze compares is the state read under
// that lock. A concurrent writer either commits before the lock — and is then
// visible to the comparison — or waits for it and finds the row as we left it.
//
// Returns undefined when the object carries no freeze rule: a lock that protects
// no comparison is only contention.
export const lockOnemaFrozenRecordsForUpdate = async ({
  scope,
  recordIds,
  executeRaw,
}: {
  scope: OnemaAccessScope;
  recordIds: string[];
  executeRaw: OnemaRawQueryExecutor;
}): Promise<Map<string, Record<string, unknown>> | undefined> => {
  const resolution = resolveOnemaAccess({ scope, purpose: 'write-invariant' });

  if (resolution.kind === 'inactive') {
    return undefined;
  }

  if (resolution.kind === 'refused') {
    throw onemaWriteDenied(resolution.reason);
  }

  const freezeRules =
    resolution.rules.freezeWhen?.[scope.tableShape.nameSingular];

  if (!isDefined(freezeRules) || recordIds.length === 0) {
    return undefined;
  }

  const lockedRecordsById = new Map<string, Record<string, unknown>>();

  for (const recordIdBatch of chunkOnemaRecordIds(
    recordIds,
    ONEMA_RECORD_ID_BATCH_SIZE,
  )) {
    const lockedRows = await executeRaw(
      `SELECT * FROM ${escapeIdentifier(
        scope.tableShape.schemaName,
      )}.${escapeIdentifier(
        scope.tableShape.tableName,
      )} WHERE "id" IN (:...${LOCKED_RECORD_IDS_PARAMETER}) FOR UPDATE`,
      { [LOCKED_RECORD_IDS_PARAMETER]: recordIdBatch },
    );

    for (const lockedRow of lockedRows) {
      lockedRecordsById.set(String(lockedRow.id), lockedRow);
    }
  }

  return lockedRecordsById;
};
