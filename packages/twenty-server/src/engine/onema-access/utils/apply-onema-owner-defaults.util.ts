import { isDefined } from 'twenty-shared/utils';

import { type OnemaRoleKey } from 'src/engine/onema-access/types/onema-access-rules.type';
import { onemaWriteDenied } from 'src/engine/onema-access/utils/onema-write-denied.util';
import { resolveOnemaFieldColumnNames } from 'src/engine/onema-access/utils/resolve-onema-field-columns.util';
import {
  type OnemaAccessScope,
  resolveOnemaAccess,
} from 'src/engine/onema-access/utils/resolve-onema-access.util';

// rls-design §3.3, point №5. A sales role may read its own lead but not write
// the owner field, so a lead it creates would be born with an empty owner and
// become invisible to its own author — and the check after the write would
// refuse the creation outright. Which field that is, is read from the explicit
// `ownerDefaults` key, so the rules file stays the single place that says who
// owns what, and no field becomes an owner by looking like one.
//
// Returns undefined when nothing was substituted, which lets the caller keep the
// rows it has already built instead of building them twice.
export const applyOnemaOwnerDefaults = <
  TRecord extends Record<string, unknown>,
>({
  scope,
  records,
}: {
  scope: OnemaAccessScope;
  records: TRecord[];
}): TRecord[] | undefined => {
  // The default exists to keep a record visible to its author, so it answers to
  // the same bypass as visibility itself: a system actor has no "$me" to write
  const resolution = resolveOnemaAccess({
    scope,
    purpose: 'record-visibility',
  });

  if (resolution.kind === 'inactive') {
    return undefined;
  }

  if (resolution.kind === 'refused') {
    throw onemaWriteDenied(resolution.reason);
  }

  const { workspaceMemberId } = resolution.subject;

  if (!isDefined(workspaceMemberId)) {
    return undefined;
  }

  const ownerFieldName = resolveOwnerFieldName({
    fieldNameByRoleKey:
      resolution.rules.ownerDefaults?.[scope.tableShape.nameSingular] ?? {},
    roleKeys: resolution.compilationContext.roleKeys,
  });

  if (!isDefined(ownerFieldName)) {
    return undefined;
  }

  const columnNames = resolveOnemaFieldColumnNames({
    tableShape: scope.tableShape,
    fieldName: ownerFieldName,
  });

  if (columnNames.length !== 1) {
    return undefined;
  }

  const [ownerColumnName] = columnNames;
  let hasSubstituted = false;

  const recordsWithOwner = records.map((record) => {
    // Both spellings count as "the caller said who owns this": the ORM accepts
    // the field name and the join column alike
    if (
      isDefined(record[ownerFieldName]) ||
      isDefined(record[ownerColumnName])
    ) {
      return record;
    }

    hasSubstituted = true;

    return { ...record, [ownerColumnName]: workspaceMemberId };
  });

  return hasSubstituted ? recordsWithOwner : undefined;
};

// A role the file says nothing about contributes nothing: holding `all` on top
// of a sales role no longer makes the default disappear, because only the roles
// the file names for this object are read at all. Two named roles pointing at
// two different owner fields still have no single answer, and silence is the
// safe one — the check after the write then refuses the creation loudly.
const resolveOwnerFieldName = ({
  fieldNameByRoleKey,
  roleKeys,
}: {
  fieldNameByRoleKey: Record<OnemaRoleKey, string>;
  roleKeys: string[];
}): string | undefined => {
  const ownerFieldNames = new Set(
    roleKeys.map((roleKey) => fieldNameByRoleKey[roleKey]).filter(isDefined),
  );

  if (ownerFieldNames.size !== 1) {
    return undefined;
  }

  const [ownerFieldName] = [...ownerFieldNames];

  return ownerFieldName;
};
