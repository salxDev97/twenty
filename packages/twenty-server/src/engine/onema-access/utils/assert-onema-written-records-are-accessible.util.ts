import { isNonEmptyString } from '@sniptt/guards';
import { isDefined } from 'twenty-shared/utils';

import {
  ONEMA_PARAMETER_PREFIX,
  ONEMA_RECORD_ID_BATCH_SIZE,
} from 'src/engine/onema-access/constants/onema-access.constants';
import { type OnemaRowAccess } from 'src/engine/onema-access/types/onema-access-rules.type';
import { chunkOnemaRecordIds } from 'src/engine/onema-access/utils/chunk-onema-record-ids.util';
import {
  compileOnemaRowAccess,
  compileOnemaWriteParentAccess,
} from 'src/engine/onema-access/utils/compile-onema-row-access.util';
import { isOnemaApplicationActor } from 'src/engine/onema-access/utils/is-onema-application-actor.util';
import { onemaWriteDenied } from 'src/engine/onema-access/utils/onema-write-denied.util';
import {
  type OnemaAccessScope,
  resolveOnemaAccess,
} from 'src/engine/onema-access/utils/resolve-onema-access.util';
import { type MutationKind } from 'src/engine/twenty-orm/sql/utils/build-mutation-statement.util';
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
  returningColumns,
  mutationKind,
  executeRaw,
}: {
  scope: OnemaAccessScope;
  writtenRecords: Record<string, unknown>[];
  // What the write asked the database to give back. An empty result only proves
  // "no row was touched" if the statement would have named the rows it touched
  returningColumns: string[];
  mutationKind: MutationKind | 'insert';
  executeRaw: OnemaRawQueryExecutor;
}): Promise<void> => {
  // Resolved for the invariant, which is the wider of the two purposes: a bypass
  // turns the visibility pass below off and leaves the parent pass on, so the
  // rules still have to be loaded and validated for a write that bypasses
  const resolution = resolveOnemaAccess({
    scope,
    purpose: 'write-invariant',
  });

  if (resolution.kind === 'inactive') {
    return;
  }

  if (resolution.kind === 'refused') {
    throw onemaWriteDenied(resolution.reason);
  }

  const parents =
    resolution.rules.writeRequiresParentAccess?.[scope.tableShape.nameSingular];

  // Б2. "May this actor see the row" is a permission and a caller that asked for
  // permissions to be bypassed has already answered it. "May this row be hung on
  // that parent" is not: creating a membership on somebody else's project hands
  // its holder everything the project carries, under a worker exactly as under a
  // sales role, and the bypass buys no authority over it. The only actor exempt
  // is the one the rules name — our application, writing as the system itself.
  const isParentAccessRequired =
    isDefined(parents) &&
    !(
      scope.shouldBypassPermissionChecks &&
      isOnemaApplicationActor({
        authContext: scope.authContext,
        rules: resolution.rules,
      })
    );
  const isVisibilityRequired = !scope.shouldBypassPermissionChecks;

  if (!isParentAccessRequired && !isVisibilityRequired) {
    return;
  }

  // The hole Б4 names: an empty list of written records used to end the check
  // right here. A bulk update, delete or restore by filter that reports a count,
  // or returns anything but ids, changes rows all the same — and the check would
  // have declared them all fine without ever looking at one.
  if (!returningColumns.includes('id')) {
    throw onemaWriteDenied(
      `a write on "${scope.tableShape.nameSingular}" that does not return the ids it touched cannot be checked`,
    );
  }

  if (writtenRecords.length === 0) {
    return;
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

  // There is no row left to read back, and which rows were deleted was already
  // decided by the predicate of point №1 on the criteria of the delete itself
  if (mutationKind === 'delete') {
    return;
  }

  const tableAlias = scope.tableShape.nameSingular;

  if (isVisibilityRequired) {
    await assertRecordIdsAreAdmitted({
      scope,
      tableAlias,
      recordIds,
      executeRaw,
      rowAccess: compileOnemaRowAccess({
        tableShape: scope.tableShape,
        tableAlias,
        context: resolution.compilationContext,
      }),
      describeDenial: () =>
        `the role may see no record of "${scope.tableShape.nameSingular}"`,
      describeRefusal: (refusedRecordIds) =>
        `the written "${scope.tableShape.nameSingular}" record(s) ${refusedRecordIds.join(
          ', ',
        )} would not be visible to their author`,
    });
  }

  if (!isParentAccessRequired || !isDefined(parents)) {
    return;
  }

  // Б5. A second pass rather than one condition ANDed with the first: the two
  // refusals are different mistakes — "you put the record where you cannot see
  // it" and "you hung it on somebody else's record" — and the second is the one
  // nothing else in the rules can catch
  await assertRecordIdsAreAdmitted({
    scope,
    tableAlias,
    recordIds,
    executeRaw,
    rowAccess: compileOnemaWriteParentAccess({
      tableShape: scope.tableShape,
      tableAlias,
      parents,
      context: resolution.compilationContext,
    }),
    describeDenial: () =>
      `the role may attach no record of "${scope.tableShape.nameSingular}" to anything it can see`,
    describeRefusal: (refusedRecordIds) =>
      `the written "${scope.tableShape.nameSingular}" record(s) ${refusedRecordIds.join(
        ', ',
      )} hang on a record their author may not see`,
  });
};

const assertRecordIdsAreAdmitted = async ({
  scope,
  tableAlias,
  recordIds,
  rowAccess,
  executeRaw,
  describeDenial,
  describeRefusal,
}: {
  scope: OnemaAccessScope;
  tableAlias: string;
  recordIds: string[];
  rowAccess: OnemaRowAccess;
  executeRaw: OnemaRawQueryExecutor;
  describeDenial: () => string;
  describeRefusal: (refusedRecordIds: string[]) => string;
}): Promise<void> => {
  if (rowAccess.kind === 'open') {
    return;
  }

  if (rowAccess.kind === 'denied') {
    throw onemaWriteDenied(describeDenial());
  }

  const admittedRecordIds = new Set<string>();

  // One statement per batch rather than one `IN` list of every id: an update by
  // filter has no small bound on how many rows it touches, and each id is a bind
  // parameter Postgres has to plan around (С3)
  for (const recordIdBatch of chunkOnemaRecordIds(
    recordIds,
    ONEMA_RECORD_ID_BATCH_SIZE,
  )) {
    const admittedRows = await executeRaw(
      `SELECT ${escapeIdentifier(tableAlias)}."id" FROM ${escapeIdentifier(
        scope.tableShape.schemaName,
      )}.${escapeIdentifier(scope.tableShape.tableName)} AS ${escapeIdentifier(
        tableAlias,
      )} WHERE ${escapeIdentifier(tableAlias)}."id" IN (:...${WRITTEN_RECORD_IDS_PARAMETER}) AND (${rowAccess.condition.sql})`,
      {
        ...rowAccess.condition.parameters,
        [WRITTEN_RECORD_IDS_PARAMETER]: recordIdBatch,
      },
    );

    for (const admittedRow of admittedRows) {
      admittedRecordIds.add(String(admittedRow.id));
    }
  }

  const refusedRecordIds = recordIds.filter(
    (recordId) => !admittedRecordIds.has(recordId),
  );

  if (refusedRecordIds.length > 0) {
    throw onemaWriteDenied(describeRefusal(refusedRecordIds));
  }
};
