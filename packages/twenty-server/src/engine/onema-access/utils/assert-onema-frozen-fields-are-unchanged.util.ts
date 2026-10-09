import { isDefined } from 'twenty-shared/utils';

import { type OnemaFreezeRule } from 'src/engine/onema-access/types/onema-access-rules.type';
import { isOnemaSameWrittenValue } from 'src/engine/onema-access/utils/is-onema-same-written-value.util';
import { onemaWriteDenied } from 'src/engine/onema-access/utils/onema-write-denied.util';
import { resolveOnemaFieldColumnNames } from 'src/engine/onema-access/utils/resolve-onema-field-columns.util';
import {
  type OnemaAccessScope,
  resolveOnemaAccess,
} from 'src/engine/onema-access/utils/resolve-onema-access.util';
import { type WorkspaceTableShape } from 'src/engine/twenty-orm/table-shape/types/workspace-table-shape.type';

export type OnemaFrozenFieldUpdate = {
  rawRecordBefore: Record<string, unknown>;
  setColumns: Record<string, unknown>;
};

// rls-design §12а Т-2: once a lead reaches "Сделка" its company and its contract
// file are settled, and swapping the file for another one while the count of
// files and the signature date stay put is invisible to a validation rule — the
// rule only ever sees the state *after* the write. The comparison lives here
// because the repository is the one place that holds the row before and the
// columns about to be written at the same time.
//
// The check runs before the write rather than after it: the two values compared
// are the same either way, and refusing early means no row is touched and no
// event is queued. There is no exception for the application — a field that may
// still be changed by something is not frozen.
export const assertOnemaFrozenFieldsAreUnchanged = ({
  scope,
  updates,
}: {
  scope: OnemaAccessScope;
  updates: OnemaFrozenFieldUpdate[];
}): void => {
  const resolution = resolveOnemaAccess({ scope, purpose: 'write-invariant' });

  if (resolution.kind === 'inactive') {
    return;
  }

  if (resolution.kind === 'refused') {
    throw onemaWriteDenied(resolution.reason);
  }

  const freezeRules =
    resolution.rules.freezeWhen?.[scope.tableShape.nameSingular];

  if (!isDefined(freezeRules) || updates.length === 0) {
    return;
  }

  for (const freezeRule of freezeRules) {
    for (const update of updates) {
      assertFreezeRuleHolds({
        freezeRule,
        update,
        tableShape: scope.tableShape,
      });
    }
  }
};

const assertFreezeRuleHolds = ({
  freezeRule,
  update,
  tableShape,
}: {
  freezeRule: OnemaFreezeRule;
  update: OnemaFrozenFieldUpdate;
  tableShape: WorkspaceTableShape;
}): void => {
  const conditionColumnNames = resolveFrozenColumnNames({
    tableShape,
    fieldName: freezeRule.field,
  });

  // A condition reading several columns at once has no single value to compare,
  // so the rule cannot be honoured and the write cannot be allowed either
  if (conditionColumnNames.length !== 1) {
    throw onemaWriteDenied(
      `freeze condition "${tableShape.nameSingular}.${freezeRule.field}" is not a single column`,
    );
  }

  // The condition is read from the state *before* the write on purpose: a lead
  // entering "Сделка" settles the company it enters with, and only the next
  // write finds it frozen
  if (
    !isOnemaSameWrittenValue(
      update.rawRecordBefore[conditionColumnNames[0]],
      freezeRule.equals,
    )
  ) {
    return;
  }

  // A latch freezes the condition field along with the rest: otherwise the
  // state it names is left on one write and re-entered on the next, and every
  // comparison in between reads a condition that no longer holds
  const frozenFieldNames = freezeRule.isIrreversible
    ? [freezeRule.field, ...freezeRule.fields]
    : freezeRule.fields;

  for (const fieldName of frozenFieldNames) {
    for (const columnName of resolveFrozenColumnNames({
      tableShape,
      fieldName,
    })) {
      if (!(columnName in update.setColumns)) {
        continue;
      }

      if (
        isOnemaSameWrittenValue(
          update.rawRecordBefore[columnName],
          update.setColumns[columnName],
        )
      ) {
        continue;
      }

      throw onemaWriteDenied(
        `"${tableShape.nameSingular}.${fieldName}" is frozen while "${freezeRule.field}" is "${String(
          freezeRule.equals,
        )}"`,
      );
    }
  }
};

const resolveFrozenColumnNames = ({
  tableShape,
  fieldName,
}: {
  tableShape: WorkspaceTableShape;
  fieldName: string;
}): string[] => {
  const columnNames = resolveOnemaFieldColumnNames({ tableShape, fieldName });

  if (columnNames.length === 0) {
    throw onemaWriteDenied(
      `frozen field "${tableShape.nameSingular}.${fieldName}" is no field of this workspace`,
    );
  }

  return columnNames;
};
