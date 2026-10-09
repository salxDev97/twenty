import { isDefined } from 'twenty-shared/utils';

import { type OnemaAccessRules } from 'src/engine/onema-access/types/onema-access-rules.type';
import { onemaWriteDenied } from 'src/engine/onema-access/utils/onema-write-denied.util';
import {
  type OnemaAccessScope,
  resolveOnemaAccess,
} from 'src/engine/onema-access/utils/resolve-onema-access.util';

// Cheap first pass: almost every statement the repository runs is a SELECT that
// names none of these, and nothing below runs for any of them
const POSSIBLY_WRITING = /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|COPY)\b/i;

const WRITING_KEYWORD = /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|COPY)\b/i;

// `SELECT … FOR UPDATE` and `FOR SHARE` take a lock; they write nothing. The
// freeze of rls-design §12а reads the row it compares exactly that way.
const LOCK_CLAUSE = /\bFOR\s+(NO\s+KEY\s+)?UPDATE\b|\bFOR\s+(KEY\s+)?SHARE\b/gi;

// rls-design §4, В3. Every hook of this fork hangs off the repository's own
// write paths: the owner default and the protected fields before the statement,
// the freeze under a row lock, the check after it inside the transaction. A
// statement handed to the raw executor passes none of them, so raw SQL was a
// complete way around the rules.
//
// Refused for the objects the rules govern, and only for those. Upstream writes
// raw SQL for its own bookkeeping — campaign delivery settles a claimed batch
// with a data-modifying CTE — and an object no rule names has no invariant to
// break. The moment such an object gains a rule, its raw writes start failing
// loudly, which is exactly when somebody has to look at them.
//
// Reading stays unrestricted: whether a raw SELECT carries the predicate of
// point №1 is ONE-113's check, not this one. What this one closes is the write.
export const assertOnemaRawSqlIsPermitted = ({
  scope,
  sql,
}: {
  scope: OnemaAccessScope;
  sql: string;
}): void => {
  if (!POSSIBLY_WRITING.test(sql)) {
    return;
  }

  const writingKeyword = stripLiteralsAndComments(sql)
    .replace(LOCK_CLAUSE, ' ')
    .match(WRITING_KEYWORD);

  if (!isDefined(writingKeyword)) {
    return;
  }

  const resolution = resolveOnemaAccess({ scope, purpose: 'write-invariant' });

  if (resolution.kind === 'inactive') {
    return;
  }

  if (resolution.kind === 'refused') {
    throw onemaWriteDenied(resolution.reason);
  }

  if (
    !isGovernedByTheRules({
      rules: resolution.rules,
      objectName: scope.tableShape.nameSingular,
    })
  ) {
    return;
  }

  throw onemaWriteDenied(
    `raw "${writingKeyword[1].toUpperCase()}" on "${scope.tableShape.nameSingular}" would write outside every hook of the access rules`,
  );
};

// Every key of the file that can carry an invariant for this object. A rule of
// any of them makes a raw write on it a way around something.
const isGovernedByTheRules = ({
  rules,
  objectName,
}: {
  rules: OnemaAccessRules;
  objectName: string;
}): boolean =>
  isDefined(rules.objects[objectName]) ||
  isDefined(rules.writeProtectedFields?.[objectName]) ||
  isDefined(rules.freezeWhen?.[objectName]) ||
  isDefined(rules.writeRequiresParentAccess?.[objectName]) ||
  isDefined(rules.ownerDefaults?.[objectName]);

// A keyword inside a string literal or a comment is text, not a statement, and
// a note mentioning "delete" must not close the query
const stripLiteralsAndComments = (sql: string): string =>
  sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\$\$[\s\S]*?\$\$/g, ' ')
    .replace(/'(?:[^']|'')*'/g, ' ');
