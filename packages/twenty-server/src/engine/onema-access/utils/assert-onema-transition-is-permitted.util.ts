import { isDefined } from 'twenty-shared/utils';

import {
  type OnemaObjectTransitionRules,
  type OnemaTransitionRule,
  type OnemaTransitionTarget,
} from 'src/engine/onema-access/types/onema-access-rules.type';
import { isOnemaApplicationActor } from 'src/engine/onema-access/utils/is-onema-application-actor.util';
import { isOnemaSameWrittenValue } from 'src/engine/onema-access/utils/is-onema-same-written-value.util';
import { onemaWriteDenied } from 'src/engine/onema-access/utils/onema-write-denied.util';
import {
  readOnemaTransitionTargetRoleKeys,
  readOnemaTransitionTargetValue,
} from 'src/engine/onema-access/utils/read-onema-transition-target.util';
import { resolveOnemaFieldColumnNames } from 'src/engine/onema-access/utils/resolve-onema-field-columns.util';
import {
  type OnemaAccessScope,
  resolveOnemaAccess,
} from 'src/engine/onema-access/utils/resolve-onema-access.util';
import { type WorkspaceTableShape } from 'src/engine/twenty-orm/table-shape/types/workspace-table-shape.type';

export type OnemaTransitionUpdate = {
  // `undefined` for the insert path, where there is no row before the write —
  // the graph's own `from: null` edges are what a record is allowed to be
  // born into (hardening.md п. 3: REST must not create a record already in a
  // state the graph only reaches by a transition)
  rawRecordBefore: Record<string, unknown> | undefined;
  setColumns: Record<string, unknown>;
};

// hardening.md п. 3, rls-design §12а Т-3/Т-7: an estimate's status moves only
// along DRAFT → IN_REVIEW → CEO_APPROVED → SENT → ACCEPTED, and a validation
// rule that only ever sees the state *after* the write cannot refuse the
// single PATCH that jumps straight from DRAFT to ACCEPTED — it looks at the
// row once the jump has already happened and the destination state is as
// valid as any other. The comparison lives here, next to the freeze (Т-2),
// because the repository is the one place holding the row before the write
// and the columns about to replace it at the same time, under the same row
// lock that closes the race between a recalculation and the CEO's decision
// (hardening.md п. 4–5).
export const assertOnemaTransitionIsPermitted = ({
  scope,
  updates,
}: {
  scope: OnemaAccessScope;
  updates: OnemaTransitionUpdate[];
}): void => {
  const resolution = resolveOnemaAccess({ scope, purpose: 'write-invariant' });

  if (resolution.kind === 'inactive') {
    return;
  }

  if (resolution.kind === 'refused') {
    throw onemaWriteDenied(resolution.reason);
  }

  const transitionRules =
    resolution.rules.transitions?.[scope.tableShape.nameSingular];

  if (!isDefined(transitionRules) || updates.length === 0) {
    return;
  }

  const isApplicationActor = isOnemaApplicationActor({
    authContext: scope.authContext,
    rules: resolution.rules,
  });

  for (const update of updates) {
    assertTransitionIsPermitted({
      transitionRules,
      update,
      tableShape: scope.tableShape,
      isApplicationActor,
      // Only a person is let through by a role named on an edge, the same
      // restriction assertOnemaProtectedFieldsAreWritable makes for Т-1: an
      // API key carries the role of whoever created it, and a key minted
      // under a CEO role would otherwise be a standing way to drive the
      // status field with nobody accountable for the write.
      actorRoleKeys:
        scope.authContext.type === 'user'
          ? resolution.compilationContext.roleKeys
          : [],
    });
  }
};

const assertTransitionIsPermitted = ({
  transitionRules,
  update,
  tableShape,
  isApplicationActor,
  actorRoleKeys,
}: {
  transitionRules: OnemaObjectTransitionRules;
  update: OnemaTransitionUpdate;
  tableShape: WorkspaceTableShape;
  isApplicationActor: boolean;
  actorRoleKeys: string[];
}): void => {
  const columnNames = resolveOnemaFieldColumnNames({
    tableShape,
    fieldName: transitionRules.field,
  });

  // A condition reading several columns at once has no single value to
  // compare against the graph, so the write cannot be allowed either — the
  // metadata check already refuses such a file, this is the backstop for the
  // window before it runs (same posture as the freeze and protected fields)
  if (columnNames.length !== 1) {
    throw onemaWriteDenied(
      `transition field "${tableShape.nameSingular}.${transitionRules.field}" is not a single column`,
    );
  }

  const [columnName] = columnNames;

  if (!(columnName in update.setColumns)) {
    return;
  }

  const fromValue = isDefined(update.rawRecordBefore)
    ? (update.rawRecordBefore[columnName] ?? null)
    : null;
  const toValue = update.setColumns[columnName] ?? null;

  // Writing back the value the field already holds is not a transition at
  // all — the same forgiveness the freeze gives a client that resends a whole
  // record
  if (isOnemaSameWrittenValue(fromValue, toValue)) {
    return;
  }

  const edge = transitionRules.rules.find((rule) =>
    isOnemaSameWrittenValue(rule.from, fromValue),
  );

  // No edge starts at this value: the graph has nothing to say about leaving
  // it, and silence here is the same fail-closed posture as an object missing
  // from `objects` — a typo in `from` must not quietly open every move out of
  // the state it meant to name
  if (!isDefined(edge)) {
    throw onemaWriteDenied(
      `"${tableShape.nameSingular}.${transitionRules.field}" has no transition starting from "${describeValue(fromValue)}"`,
    );
  }

  // By index, not by value: `null` is a destination like any other, and a
  // `find` would report the edge that allows it as no edge at all
  const targetIndex = edge.to.findIndex((candidate) =>
    isOnemaSameWrittenValue(readOnemaTransitionTargetValue(candidate), toValue),
  );

  if (targetIndex === -1) {
    throw onemaWriteDenied(
      `"${tableShape.nameSingular}.${transitionRules.field}" may not move from "${describeValue(
        fromValue,
      )}" to "${describeValue(toValue)}"`,
    );
  }

  assertActorMayCrossEdge({
    edge,
    target: edge.to[targetIndex],
    tableShape,
    transitionField: transitionRules.field,
    isApplicationActor,
    actorRoleKeys,
  });
};

// ONE-203: the roles are read off the target the write actually moves to, and
// only fall back to the edge when that target names nobody — a contractor may
// send a task to review along the same edge the staff roles use to close it.
const assertActorMayCrossEdge = ({
  edge,
  target,
  tableShape,
  transitionField,
  isApplicationActor,
  actorRoleKeys,
}: {
  edge: OnemaTransitionRule;
  target: OnemaTransitionTarget;
  tableShape: WorkspaceTableShape;
  transitionField: string;
  isApplicationActor: boolean;
  actorRoleKeys: string[];
}): void => {
  if (isApplicationActor) {
    return;
  }

  const roleKeys = readOnemaTransitionTargetRoleKeys({ target, edge });

  if (roleKeys.some((roleKey) => actorRoleKeys.includes(roleKey))) {
    return;
  }

  const move = `"${tableShape.nameSingular}.${transitionField}" from "${describeValue(
    edge.from,
  )}" to "${describeValue(readOnemaTransitionTargetValue(target))}"`;

  throw onemaWriteDenied(
    roleKeys.length === 0
      ? `${move} is driven by the application only`
      : `${move} is driven only by roles ${roleKeys.join(', ')} or the application`,
  );
};

const describeValue = (value: unknown): string =>
  value === null ? 'null' : String(value);
