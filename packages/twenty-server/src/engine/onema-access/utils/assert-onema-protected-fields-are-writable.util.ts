import { isDefined } from 'twenty-shared/utils';

import { isOnemaApplicationActor } from 'src/engine/onema-access/utils/is-onema-application-actor.util';
import { onemaWriteDenied } from 'src/engine/onema-access/utils/onema-write-denied.util';
import { resolveOnemaFieldColumnNames } from 'src/engine/onema-access/utils/resolve-onema-field-columns.util';
import {
  type OnemaAccessScope,
  resolveOnemaAccess,
} from 'src/engine/onema-access/utils/resolve-onema-access.util';
import { type WorkspaceTableShape } from 'src/engine/twenty-orm/table-shape/types/workspace-table-shape.type';

// rls-design §12а Т-1: fields the product logic rests on — the approval mirrors,
// the decision, and the fields the right to decide is read from. `isUIEditable:
// false` hides them from the interface but not from the API, and one PATCH under
// a sales role was enough to walk through the acceptance scenarios. Only our
// application's logic functions write them; people and API keys are refused,
// whatever object or field permission they hold.
//
// Called from validateWriteIsPermitted, so it covers every write path of the
// repository at once — insert, batch update and update by criteria.
export const assertOnemaProtectedFieldsAreWritable = ({
  scope,
  updatedColumns,
}: {
  scope: OnemaAccessScope;
  updatedColumns: string[];
}): void => {
  const resolution = resolveOnemaAccess({ scope, purpose: 'write-invariant' });

  if (resolution.kind === 'inactive') {
    return;
  }

  // Unlike a read, which degrades to an empty result, a write under unusable
  // rules has no safe outcome but refusal: nothing here knows what the file
  // meant to protect
  if (resolution.kind === 'refused') {
    throw onemaWriteDenied(resolution.reason);
  }

  const roleKeysByFieldName =
    resolution.rules.writeProtectedFields?.[scope.tableShape.nameSingular];

  if (!isDefined(roleKeysByFieldName) || updatedColumns.length === 0) {
    return;
  }

  const writtenColumnNames = new Set(updatedColumns);
  const isApplicationActor = isOnemaApplicationActor({
    authContext: scope.authContext,
    rules: resolution.rules,
  });

  for (const [fieldName, roleKeys] of Object.entries(roleKeysByFieldName)) {
    const columnNames = resolveProtectedColumnNames({
      tableShape: scope.tableShape,
      fieldName,
    });
    const touchedColumnName = columnNames.find((columnName) =>
      writtenColumnNames.has(columnName),
    );

    if (!isDefined(touchedColumnName)) {
      continue;
    }

    if (isApplicationActor) {
      continue;
    }

    // Only a person holds a role for this purpose. An API key carries the role
    // of whoever created it, so a key made under a CEO or admin role would
    // otherwise be a standing way to PATCH the field the product rule rests on
    // with nobody accountable for it — and a key outlives the person.
    if (
      scope.authContext.type === 'user' &&
      roleKeys.some((roleKey) =>
        resolution.compilationContext.roleKeys.includes(roleKey),
      )
    ) {
      continue;
    }

    throw onemaWriteDenied(
      `"${scope.tableShape.nameSingular}.${fieldName}" is written by the application only`,
    );
  }
};

// A protected field whose columns cannot be resolved is refused rather than
// skipped: an unknown field name would otherwise protect nothing at all. The
// metadata check already refuses such a file, so this is the backstop for the
// window before it runs.
const resolveProtectedColumnNames = ({
  tableShape,
  fieldName,
}: {
  tableShape: WorkspaceTableShape;
  fieldName: string;
}): string[] => {
  const columnNames = resolveOnemaFieldColumnNames({ tableShape, fieldName });

  if (columnNames.length === 0) {
    throw onemaWriteDenied(
      `protected field "${tableShape.nameSingular}.${fieldName}" is no field of this workspace`,
    );
  }

  return columnNames;
};
