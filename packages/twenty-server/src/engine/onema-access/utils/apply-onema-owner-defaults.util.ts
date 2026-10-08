import { isDefined } from 'twenty-shared/utils';

import {
  type OnemaCondition,
  type OnemaRoleKey,
} from 'src/engine/onema-access/types/onema-access-rules.type';
import { onemaWriteDenied } from 'src/engine/onema-access/utils/onema-write-denied.util';
import { resolveOnemaFieldColumnNames } from 'src/engine/onema-access/utils/resolve-onema-field-columns.util';
import {
  type OnemaAccessScope,
  resolveOnemaAccess,
} from 'src/engine/onema-access/utils/resolve-onema-access.util';

const CURRENT_MEMBER_TOKEN = '$me';

// rls-design §3.3, point №5. A sales role may read its own lead but not write
// the owner field, so a lead it creates would be born with an empty owner and
// become invisible to its own author — and the check after the write would
// refuse the creation outright. The owner is filled in from the rule itself, so
// the rules file stays the single place that says who owns what.
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
  const resolution = resolveOnemaAccess(scope);

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
    conditionByRoleKey:
      resolution.rules.objects[scope.tableShape.nameSingular] ?? {},
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

// Only an unambiguous "mine and nothing else" earns a default. A role that may
// see every record of the object needs no owner to see what it creates, and
// substituting one would hand out ownership nobody asked for; two roles naming
// two different owner fields have no single answer at all.
const resolveOwnerFieldName = ({
  conditionByRoleKey,
  roleKeys,
}: {
  conditionByRoleKey: Partial<Record<OnemaRoleKey, OnemaCondition>>;
  roleKeys: string[];
}): string | undefined => {
  const conditions = roleKeys
    .map((roleKey) => conditionByRoleKey[roleKey])
    .filter(isDefined);

  if (conditions.length === 0) {
    return undefined;
  }

  const ownerFieldNames = new Set(
    conditions.map((condition) =>
      'eq' in condition && condition.eq[1] === CURRENT_MEMBER_TOKEN
        ? condition.eq[0]
        : undefined,
    ),
  );

  if (ownerFieldNames.size !== 1) {
    return undefined;
  }

  const [ownerFieldName] = [...ownerFieldNames];

  return ownerFieldName;
};
