import { isDefined } from 'twenty-shared/utils';

import { type OnemaAccessRules } from 'src/engine/onema-access/types/onema-access-rules.type';
import {
  collectOnemaSqlWriteTargets,
  type OnemaSqlTableReference,
} from 'src/engine/onema-access/utils/collect-onema-sql-write-targets.util';
import { onemaWriteDenied } from 'src/engine/onema-access/utils/onema-write-denied.util';
import {
  type OnemaAccessResolutionScope,
  resolveOnemaAccess,
} from 'src/engine/onema-access/utils/resolve-onema-access.util';

// Cheap first pass: almost every statement the repository runs is a SELECT that
// names none of these, and nothing below runs for any of them
const POSSIBLY_WRITING =
  /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|COPY|CALL|DO|EXECUTE)\b|\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/i;

// rls-design §4, В3. Every hook of this fork hangs off the repository's own
// write paths: the owner default and the protected fields before the statement,
// the freeze under a row lock, the check after it inside the transaction. A
// statement handed to the raw executor passes none of them, so raw SQL was a
// complete way around the rules.
//
// Refused for the tables the rules govern, and only for those — read from the
// statement, not from the repository it came through. Asking the repository was
// the hole the review named: `messageCampaignBatchDelivery` is governed by no
// rule, and its repository running `UPDATE "workspace_x"."_opportunity"` was a
// write on a governed object that this check waved past.
//
// Upstream writes raw SQL for its own bookkeeping — campaign delivery settles a
// claimed batch with a data-modifying CTE — and a table no rule names has no
// invariant to break. The moment its object gains a rule, its raw writes start
// failing loudly, which is exactly when somebody has to look at them.
//
// Reading stays unrestricted: whether a raw SELECT carries the predicate of
// point №1 is ONE-113's check, not this one. What this one closes is the write.
export const assertOnemaRawSqlIsPermitted = ({
  scope,
  sql,
}: {
  scope: OnemaAccessResolutionScope;
  sql: string;
}): void => {
  if (!POSSIBLY_WRITING.test(sql)) {
    return;
  }

  const resolution = resolveOnemaAccess({ scope, purpose: 'write-invariant' });

  if (resolution.kind === 'inactive') {
    return;
  }

  if (resolution.kind === 'refused') {
    throw onemaWriteDenied(resolution.reason);
  }

  const writeTargets = collectOnemaSqlWriteTargets(sql);

  if (writeTargets.kind === 'none') {
    return;
  }

  // A body, a procedure or a prepared statement can write any table of the
  // workspace, and none of them says which. There is no reading of "it probably
  // touches nothing governed" that is safe, so DML-shaped SQL this check cannot
  // see into is refused outright — the one audited write path of the repository
  // builds none of these.
  if (writeTargets.kind === 'opaque') {
    throw onemaWriteDenied(
      `raw SQL containing ${writeTargets.construct} may write any table and names none, so it cannot pass the access rules`,
    );
  }

  if (writeTargets.kind === 'unreadable') {
    throw onemaWriteDenied(
      `raw "${writeTargets.keyword}" whose target table could not be read cannot pass the access rules`,
    );
  }

  const governedTableKeys = resolveGovernedTableKeys({
    rules: resolution.rules,
    scope,
  });
  const governedTarget = writeTargets.tables.find((table) =>
    isGovernedTable({ table, governedTableKeys }),
  );

  if (isDefined(governedTarget)) {
    throw onemaWriteDenied(
      `raw "${writeTargets.keyword}" on "${governedTarget.tableName}" would write outside every hook of the access rules`,
    );
  }

  // `U&"…"` is decoded above, so a governed table spelled that way is caught by
  // its name like any other. What is left is a statement that writes an
  // ungoverned table through a lexical form no write path of this server
  // produces — and the escapes are read here by our own decoder rather than by
  // Postgres, so "this one is harmless" rests on the two agreeing. Refused.
  const unicodeEscapedTarget = writeTargets.tables.find(
    (table) => table.spelling === 'unicode-escaped',
  );

  if (isDefined(unicodeEscapedTarget)) {
    throw onemaWriteDenied(
      `raw "${writeTargets.keyword}" naming "${unicodeEscapedTarget.tableName}" as a Unicode-escaped identifier cannot be attributed with certainty, so it cannot pass the access rules`,
    );
  }
};

// A statement that names the schema has to match on the schema too; one that
// leaves it to the search path is matched on the table alone, which is the
// closed side of the question
const isGovernedTable = ({
  table,
  governedTableKeys,
}: {
  table: OnemaSqlTableReference;
  governedTableKeys: Set<string>;
}): boolean =>
  isDefined(table.schemaName)
    ? governedTableKeys.has(`${table.schemaName}.${table.tableName}`)
    : governedTableKeys.has(table.tableName);

// Every key of the file that can carry an invariant for an object. A rule of any
// of them makes a raw write on its table a way around something.
const collectGovernedObjectNames = (rules: OnemaAccessRules): Set<string> =>
  new Set([
    ...Object.keys(rules.objects),
    ...Object.keys(rules.writeProtectedFields ?? {}),
    ...Object.keys(rules.freezeWhen ?? {}),
    ...Object.keys(rules.writeRequiresParentAccess ?? {}),
    ...Object.keys(rules.ownerDefaults ?? {}),
  ]);

const resolveGovernedTableKeys = ({
  rules,
  scope,
}: {
  rules: OnemaAccessRules;
  scope: OnemaAccessResolutionScope;
}): Set<string> => {
  const governedTableKeys = new Set<string>();

  for (const objectName of collectGovernedObjectNames(rules)) {
    const objectMetadataId =
      scope.internalContext.objectIdByNameSingular[objectName];
    const tableShape = isDefined(objectMetadataId)
      ? scope.tableShapeByObjectMetadataId(objectMetadataId)
      : undefined;

    // The metadata check above already refuses a file naming an object this
    // workspace does not have, so reaching here means the table of a governed
    // object cannot be named at all — and a write that cannot be compared to it
    // cannot be let through
    if (!isDefined(tableShape)) {
      throw onemaWriteDenied(
        `the table of governed object "${objectName}" cannot be resolved, so no raw write can be checked against it`,
      );
    }

    // Both spellings: a quoted identifier keeps its case and an unquoted one is
    // folded, and either may be how the statement names the same table
    for (const tableName of [
      tableShape.tableName,
      tableShape.tableName.toLowerCase(),
    ]) {
      for (const schemaName of [
        tableShape.schemaName,
        tableShape.schemaName.toLowerCase(),
      ]) {
        governedTableKeys.add(`${schemaName}.${tableName}`);
      }

      governedTableKeys.add(tableName);
    }
  }

  return governedTableKeys;
};
