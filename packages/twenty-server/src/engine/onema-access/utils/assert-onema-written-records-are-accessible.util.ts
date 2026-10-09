import { isNonEmptyString } from '@sniptt/guards';

import { ONEMA_PARAMETER_PREFIX } from 'src/engine/onema-access/constants/onema-access.constants';
import { compileOnemaRowAccess } from 'src/engine/onema-access/utils/compile-onema-row-access.util';
import { onemaWriteDenied } from 'src/engine/onema-access/utils/onema-write-denied.util';
import {
  type OnemaAccessScope,
  resolveOnemaAccess,
} from 'src/engine/onema-access/utils/resolve-onema-access.util';
import { escapeIdentifier } from 'src/engine/workspace-manager/workspace-migration/utils/remove-sql-injection.util';

const WRITTEN_RECORD_IDS_PARAMETER = `${ONEMA_PARAMETER_PREFIX}WrittenRecordIds`;

export type OnemaRawQueryExecutor = (
  sql: string,
  parameters: Record<string, unknown>,
) => Promise<Record<string, unknown>[]>;

// rls-design §3.2, point №4. The predicate of point №1 narrows an update by the
// state the row had *before* it; nothing stops the write itself from moving the
// row out of what the role may see. That is how a project manager re-parents a
// task into somebody else's project, and how a contractor creates a data-room
// item under a project that is not theirs: the foreign key has to be writable,
// so field permissions cannot close it.
//
// So the rows the write left behind are read back under the same compiled rule,
// inside the same transaction. A row that does not come back never legitimately
// existed, and the transaction is rolled back by throwing.
export const assertOnemaWrittenRecordsAreAccessible = async ({
  scope,
  writtenRecords,
  executeRaw,
}: {
  scope: OnemaAccessScope;
  writtenRecords: Record<string, unknown>[];
  executeRaw: OnemaRawQueryExecutor;
}): Promise<void> => {
  const resolution = resolveOnemaAccess({
    scope,
    purpose: 'record-visibility',
  });

  if (resolution.kind === 'inactive' || writtenRecords.length === 0) {
    return;
  }

  if (resolution.kind === 'refused') {
    throw onemaWriteDenied(resolution.reason);
  }

  const recordIds = writtenRecords
    .map((writtenRecord) => writtenRecord.id)
    .filter(isNonEmptyString);

  // A write whose returned rows carry no id cannot be checked at all, and an
  // unverifiable write is refused rather than waved through
  if (recordIds.length !== writtenRecords.length) {
    throw onemaWriteDenied(
      `${writtenRecords.length - recordIds.length} written record(s) of "${scope.tableShape.nameSingular}" came back without an id`,
    );
  }

  const tableAlias = scope.tableShape.nameSingular;
  const rowAccess = compileOnemaRowAccess({
    tableShape: scope.tableShape,
    tableAlias,
    context: resolution.compilationContext,
  });

  if (rowAccess.kind === 'open') {
    return;
  }

  if (rowAccess.kind === 'denied') {
    throw onemaWriteDenied(
      `the role may see no record of "${scope.tableShape.nameSingular}"`,
    );
  }

  const admittedRows = await executeRaw(
    `SELECT ${escapeIdentifier(tableAlias)}."id" FROM ${escapeIdentifier(
      scope.tableShape.schemaName,
    )}.${escapeIdentifier(scope.tableShape.tableName)} AS ${escapeIdentifier(
      tableAlias,
    )} WHERE ${escapeIdentifier(tableAlias)}."id" IN (:...${WRITTEN_RECORD_IDS_PARAMETER}) AND (${rowAccess.condition.sql})`,
    {
      ...rowAccess.condition.parameters,
      [WRITTEN_RECORD_IDS_PARAMETER]: recordIds,
    },
  );

  const admittedRecordIds = new Set(
    admittedRows.map((admittedRow) => String(admittedRow.id)),
  );
  const refusedRecordIds = recordIds.filter(
    (recordId) => !admittedRecordIds.has(recordId),
  );

  if (refusedRecordIds.length > 0) {
    throw onemaWriteDenied(
      `the written "${scope.tableShape.nameSingular}" record(s) ${refusedRecordIds.join(
        ', ',
      )} would not be visible to their author`,
    );
  }
};
