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

// rls-design §12а Т-2/Т-3/Т-7 (hardening.md п. 3–5), the race the freeze and
// the transition graph both have on their own. Each comparison runs in the
// application: it reads the row, decides, and only then writes. Two
// transactions that both read a lead still in "Предложение" both decide the
// company is free to change — one of them moves the lead to "Сделка", the
// other swaps the company under it, and neither ever saw a frozen record.
// The same race lets two PATCHes both read an estimate in IN_REVIEW and both
// decide CEO_APPROVED is reachable, one of them racing the CEO's decision.
//
// So the rows about to be updated are locked first, in the transaction that is
// about to write them, and both checks compare the state read under that lock
// rather than the snapshot taken before it. A concurrent writer either commits
// before the lock — and is then visible to the comparison — or waits for it
// and finds the row as we left it.
//
// Returns undefined when the object carries neither a freeze rule nor a
// transition graph: a lock that protects no comparison is only contention.
export const lockOnemaGuardedRecordsForUpdate = async ({
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
  const transitionRules =
    resolution.rules.transitions?.[scope.tableShape.nameSingular];

  if (
    (!isDefined(freezeRules) && !isDefined(transitionRules)) ||
    recordIds.length === 0
  ) {
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
