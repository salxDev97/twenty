// rls-design §4, В3. Which tables a raw statement writes, read from the
// statement itself. The first version of this check asked the repository the
// statement came from instead, which answered a different question: the
// campaign-delivery repository running `UPDATE "workspace_x"."_opportunity"` is
// a write on a governed object by an ungoverned repository, and it passed.
//
// Anything this parser cannot attribute is reported as such, so the caller can
// refuse it rather than guess — including the bodies it is not allowed to read.

export type OnemaSqlTableReference = {
  schemaName?: string;
  tableName: string;
};

export type OnemaSqlWriteTargets =
  | { kind: 'none' }
  | { kind: 'opaque'; construct: string }
  | { kind: 'unreadable'; keyword: string }
  | { kind: 'tables'; keyword: string; tables: OnemaSqlTableReference[] };

const COMMENTS = /--[^\n]*|\/\*[\s\S]*?\*\//g;

// A keyword inside a string literal is text, not a statement, and a note
// mentioning "delete" must not close the query
const SINGLE_QUOTED_LITERAL = /'(?:[^']|'')*'/g;

// `SELECT … FOR UPDATE` and `FOR SHARE` take a lock; they write nothing. The
// freeze of rls-design §12а reads the row it compares exactly that way.
const LOCK_CLAUSE =
  /\bFOR\s+(?:NO\s+KEY\s+)?UPDATE\b|\bFOR\s+(?:KEY\s+)?SHARE\b/gi;

// The row this touches is the one the INSERT already names, so removing it
// loses no target — and leaving it in would read "UPDATE SET" as a table name
const ON_CONFLICT_ACTION =
  /\bON\s+CONFLICT\b[\s\S]*?\bDO\s+(?:NOTHING|UPDATE)\b/gi;

// Dollar quoting is a body this check cannot read. `DO $$ BEGIN UPDATE … END $$`
// used to be cut out as a literal, which is precisely how a write hid from it.
const DOLLAR_QUOTED_BODY = /\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/;

// `DO` outside the two `ON CONFLICT` actions is a procedural block
const PROCEDURAL_BLOCK = /\bDO\b/i;

// A procedure may write anything, and nothing here can see what
const PROCEDURE_CALL = /\bCALL\s+["A-Za-z_]/i;

// A prepared statement's text was supplied somewhere this check never looked
const PREPARED_EXECUTE = /\bEXECUTE\s+["A-Za-z_]/i;

const WRITING_KEYWORD = /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE)\b/i;

// `COPY … TO` reads; only `COPY … FROM` writes
const COPY_READ = /\bCOPY\b[\s\S]*?\bTO\b/i;
const COPY_KEYWORD = /\bCOPY\b/i;

const NAME = '(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)';
const QUALIFIED_NAME = `${NAME}(?:\\s*\\.\\s*${NAME})?`;
const ONLY = '(?:ONLY\\s+)?';

const TARGET_PATTERN_BY_KEYWORD: { keyword: string; pattern: RegExp }[] = [
  {
    keyword: 'INSERT',
    pattern: new RegExp(
      `\\bINSERT\\s+INTO\\s+${ONLY}(${QUALIFIED_NAME})`,
      'gi',
    ),
  },
  {
    keyword: 'UPDATE',
    pattern: new RegExp(`\\bUPDATE\\s+${ONLY}(${QUALIFIED_NAME})`, 'gi'),
  },
  {
    keyword: 'DELETE',
    pattern: new RegExp(
      `\\bDELETE\\s+FROM\\s+${ONLY}(${QUALIFIED_NAME})`,
      'gi',
    ),
  },
  {
    keyword: 'MERGE',
    pattern: new RegExp(`\\bMERGE\\s+INTO\\s+${ONLY}(${QUALIFIED_NAME})`, 'gi'),
  },
  {
    keyword: 'TRUNCATE',
    pattern: new RegExp(
      `\\bTRUNCATE\\s+(?:TABLE\\s+)?${ONLY}(${QUALIFIED_NAME}(?:\\s*,\\s*${ONLY}${QUALIFIED_NAME})*)`,
      'gi',
    ),
  },
  {
    keyword: 'COPY',
    pattern: new RegExp(
      `\\bCOPY\\s+${ONLY}(${QUALIFIED_NAME})(?:\\s*\\([^)]*\\))?\\s+FROM\\b`,
      'gi',
    ),
  },
];

export const collectOnemaSqlWriteTargets = (
  sql: string,
): OnemaSqlWriteTargets => {
  const withoutLiterals = sql
    .replace(COMMENTS, ' ')
    .replace(SINGLE_QUOTED_LITERAL, ' ');

  if (DOLLAR_QUOTED_BODY.test(withoutLiterals)) {
    return { kind: 'opaque', construct: 'a dollar-quoted body' };
  }

  const statement = withoutLiterals
    .replace(LOCK_CLAUSE, ' ')
    .replace(ON_CONFLICT_ACTION, ' ');

  if (PROCEDURAL_BLOCK.test(statement)) {
    return { kind: 'opaque', construct: 'a DO block' };
  }

  if (PROCEDURE_CALL.test(statement)) {
    return { kind: 'opaque', construct: 'a CALL' };
  }

  if (PREPARED_EXECUTE.test(statement)) {
    return { kind: 'opaque', construct: 'an EXECUTE' };
  }

  const tables: OnemaSqlTableReference[] = [];
  let keyword: string | undefined;

  for (const {
    keyword: patternKeyword,
    pattern,
  } of TARGET_PATTERN_BY_KEYWORD) {
    for (const match of statement.matchAll(pattern)) {
      keyword ??= patternKeyword;
      tables.push(...parseTableList(match[1]));
    }
  }

  if (tables.length > 0) {
    return { kind: 'tables', keyword: keyword ?? 'write', tables };
  }

  const unmatchedKeyword = statement.match(WRITING_KEYWORD);

  if (unmatchedKeyword !== null) {
    return { kind: 'unreadable', keyword: unmatchedKeyword[1].toUpperCase() };
  }

  // A `COPY` that is not the writing form has to be the reading one before it
  // may pass: anything else is a write whose target was not read
  if (COPY_KEYWORD.test(statement) && !COPY_READ.test(statement)) {
    return { kind: 'unreadable', keyword: 'COPY' };
  }

  return { kind: 'none' };
};

// Postgres folds an unquoted identifier to lower case and keeps a quoted one as
// written, so the two forms name different tables and are normalized apart
export const normalizeOnemaSqlIdentifier = (identifier: string): string =>
  identifier.startsWith('"')
    ? identifier.slice(1, -1)
    : identifier.toLowerCase();

const parseTableList = (rawList: string): OnemaSqlTableReference[] =>
  rawList.split(',').map((rawName) => {
    const [schemaPart, tablePart] = rawName
      .replace(/\bONLY\b/gi, '')
      .trim()
      .split(/\s*\.\s*/);

    return tablePart === undefined
      ? { tableName: normalizeOnemaSqlIdentifier(schemaPart) }
      : {
          schemaName: normalizeOnemaSqlIdentifier(schemaPart),
          tableName: normalizeOnemaSqlIdentifier(tablePart),
        };
  });
