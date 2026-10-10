import { isDefined } from 'twenty-shared/utils';

import {
  ONEMA_PARAMETER_PREFIX,
  ONEMA_RECORD_ID_BATCH_SIZE,
} from 'src/engine/onema-access/constants/onema-access.constants';
import { type OnemaWriteFrozenByParentRule } from 'src/engine/onema-access/types/onema-access-rules.type';
import { type OnemaRawQueryExecutor } from 'src/engine/onema-access/utils/assert-onema-written-records-are-accessible.util';
import { chunkOnemaRecordIds } from 'src/engine/onema-access/utils/chunk-onema-record-ids.util';
import { isOnemaApplicationActor } from 'src/engine/onema-access/utils/is-onema-application-actor.util';
import { isOnemaSameWrittenValue } from 'src/engine/onema-access/utils/is-onema-same-written-value.util';
import { onemaWriteDenied } from 'src/engine/onema-access/utils/onema-write-denied.util';
import { resolveOnemaFieldColumnNames } from 'src/engine/onema-access/utils/resolve-onema-field-columns.util';
import {
  type OnemaAccessScope,
  resolveOnemaAccess,
} from 'src/engine/onema-access/utils/resolve-onema-access.util';
import { type WorkspaceTableShape } from 'src/engine/twenty-orm/table-shape/types/workspace-table-shape.type';
import { escapeIdentifier } from 'src/engine/workspace-manager/workspace-migration/utils/remove-sql-injection.util';

const LOCKED_PARENT_IDS_PARAMETER = `${ONEMA_PARAMETER_PREFIX}LockedParentIds`;

export type OnemaParentFreezeUpdate = {
  // undefined on insert: the row being created has no "before" to read, and the
  // only parent that matters is the one it is about to be created under
  rawRecordBefore: Record<string, unknown> | undefined;
  setColumns: Record<string, unknown>;
};

// ONE-115 (ADR-010 п.2): the mirror of `assertOnemaFrozenFieldsAreUnchanged`
// for a condition that lives on the parent rather than on the record itself —
// the archived data room whose materials, members and acceptances stop being
// writable even though `objects` still lets the same roles read them (a single
// condition there cannot tell a SELECT from an UPDATE criterion apart, so it
// cannot be used to close writing alone).
//
// Both the old and the new value of the foreign key are checked, not only the
// one the write is about to leave in place: a row created or kept under a
// frozen parent is refused the same as one re-parented onto a frozen parent
// out of a parent that was not. There is no "the row never had this parent"
// escape — the one case that would make is the FK being empty on both sides,
// which is nothing to check against at all.
//
// The parent row is locked (`FOR UPDATE`) before its column is read, in the
// same transaction that is about to write the child: the race this guards is
// a concurrent write that is itself archiving the parent, which has to take
// the same lock on its own row (`lockOnemaGuardedRecordsForUpdate`) before it
// may write `status`. One of the two transactions always waits for the other.
export const assertOnemaWriteIsPermittedByParentState = async ({
  scope,
  updates,
  executeRaw,
}: {
  scope: OnemaAccessScope;
  updates: OnemaParentFreezeUpdate[];
  executeRaw: OnemaRawQueryExecutor;
}): Promise<void> => {
  const resolution = resolveOnemaAccess({ scope, purpose: 'write-invariant' });

  if (resolution.kind === 'inactive') {
    return;
  }

  if (resolution.kind === 'refused') {
    throw onemaWriteDenied(resolution.reason);
  }

  const rules =
    resolution.rules.writeFrozenByParent?.[scope.tableShape.nameSingular];

  if (!isDefined(rules) || updates.length === 0) {
    return;
  }

  // The application is exempt by default, the same way it is from
  // `writeRequiresParentAccess` (Б5): our own logic functions act under a
  // token that has no `$me`, and the server-side commands that move these
  // children run exactly where the archived state is not meant to reach
  const isApplicationActor = isOnemaApplicationActor({
    authContext: scope.authContext,
    rules: resolution.rules,
  });

  for (const rule of rules) {
    if (isApplicationActor && rule.allowApplication !== false) {
      continue;
    }

    await assertParentFreezeRuleHolds({ scope, rule, updates, executeRaw });
  }
};

const assertParentFreezeRuleHolds = async ({
  scope,
  rule,
  updates,
  executeRaw,
}: {
  scope: OnemaAccessScope;
  rule: OnemaWriteFrozenByParentRule;
  updates: OnemaParentFreezeUpdate[];
  executeRaw: OnemaRawQueryExecutor;
}): Promise<void> => {
  const foreignKeyColumnNames = resolveOnemaFieldColumnNames({
    tableShape: scope.tableShape,
    fieldName: rule.foreignKey,
  });

  if (foreignKeyColumnNames.length !== 1) {
    throw onemaWriteDenied(
      `writeFrozenByParent link "${scope.tableShape.nameSingular}.${rule.foreignKey}" is not a single column`,
    );
  }

  const [foreignKeyColumnName] = foreignKeyColumnNames;

  // Both sides of the foreign key: the one the row is about to carry and the
  // one it carried before. An empty foreign key on both sides is a record this
  // rule says nothing about — same as `parent` reading an empty key as false
  const parentIds = new Set<string>();

  for (const update of updates) {
    for (const value of [
      update.setColumns[foreignKeyColumnName],
      update.rawRecordBefore?.[foreignKeyColumnName],
    ]) {
      if (typeof value === 'string' && value.length > 0) {
        parentIds.add(value);
      }
    }
  }

  if (parentIds.size === 0) {
    return;
  }

  const parentObjectMetadataId =
    scope.internalContext.objectIdByNameSingular[rule.object];

  if (!isDefined(parentObjectMetadataId)) {
    throw onemaWriteDenied(
      `writeFrozenByParent names no object of this workspace ("${rule.object}")`,
    );
  }

  const parentTableShape: WorkspaceTableShape =
    scope.tableShapeByObjectMetadataId(parentObjectMetadataId);

  const parentFieldColumnNames = resolveOnemaFieldColumnNames({
    tableShape: parentTableShape,
    fieldName: rule.field,
  });

  if (parentFieldColumnNames.length !== 1) {
    throw onemaWriteDenied(
      `writeFrozenByParent condition "${rule.object}.${rule.field}" is not a single column`,
    );
  }

  const [parentFieldColumnName] = parentFieldColumnNames;
  const parentIdList = [...parentIds];

  for (const parentIdBatch of chunkOnemaRecordIds(
    parentIdList,
    ONEMA_RECORD_ID_BATCH_SIZE,
  )) {
    const lockedParentRows = await executeRaw(
      `SELECT "id", ${escapeIdentifier(
        parentFieldColumnName,
      )} FROM ${escapeIdentifier(
        parentTableShape.schemaName,
      )}.${escapeIdentifier(
        parentTableShape.tableName,
      )} WHERE "id" IN (:...${LOCKED_PARENT_IDS_PARAMETER}) FOR UPDATE`,
      { [LOCKED_PARENT_IDS_PARAMETER]: parentIdBatch },
    );

    for (const parentRow of lockedParentRows) {
      if (
        isOnemaSameWrittenValue(
          parentRow[parentFieldColumnName],
          rule.equals,
        )
      ) {
        throw onemaWriteDenied(
          `"${scope.tableShape.nameSingular}" cannot be written while its "${rule.object}.${rule.field}" is ${JSON.stringify(rule.equals)}`,
        );
      }
    }
  }
};
