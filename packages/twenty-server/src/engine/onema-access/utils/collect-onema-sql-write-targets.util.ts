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

// `SELECT … FOR UPDATE` and `FOR SHARE` take a lock; they write nothing. The
// freeze of rls-design §12а reads the row it compares exactly that way.
const LOCK_CLAUSE =
  /\bFOR\s+(?:NO\s+KEY\s+)?UPDATE\b|\bFOR\s+(?:KEY\s+)?SHARE\b/gi;

// The row this touches is the one the INSERT already names, so removing it
// loses no target — and leaving it in would read "UPDATE SET" as a table name
const ON_CONFLICT_ACTION =
  /\bON\s+CONFLICT\b[\s\S]*?\bDO\s+(?:NOTHING|UPDATE)\b/gi;

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
  const masked = maskLiteralsAndComments(sql);

  if (masked.kind === 'opaque') {
    return masked;
  }

  const statement = masked.statement
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

type MaskedStatement =
  | { kind: 'masked'; statement: string }
  | { kind: 'opaque'; construct: string };

const IDENTIFIER_CHARACTER = /[A-Za-z0-9_$]/;

// Dollar quoting opens a body this check cannot read, and `$1` is a parameter
// rather than an opening: the closing `$` is what tells the two apart
const DOLLAR_QUOTE_OPENING = /\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/y;

// Comments and string literals each hide the other's opening, so neither may be
// cut out before the other. Removing comments first read
// `SELECT '/*'; UPDATE …; SELECT '*/'` as one harmless SELECT, because the
// `/*` inside the first literal was taken for the start of a comment that ran
// across the UPDATE. The statement is walked once instead: whichever construct
// opens first is the one that closes, exactly as Postgres reads it.
//
// Quoted identifiers are kept as written — they are the table names the patterns
// below have to read — while literals and comments become a space.
const maskLiteralsAndComments = (sql: string): MaskedStatement => {
  let statement = '';
  let index = 0;

  while (index < sql.length) {
    const character = sql[index];

    if (character === '-' && sql[index + 1] === '-') {
      const lineEnd = sql.indexOf('\n', index);

      index = lineEnd === -1 ? sql.length : lineEnd;
      statement += ' ';
      continue;
    }

    if (character === '/' && sql[index + 1] === '*') {
      const commentEnd = skipBlockComment(sql, index);

      if (commentEnd === undefined) {
        return { kind: 'opaque', construct: 'an unterminated block comment' };
      }

      index = commentEnd;
      statement += ' ';
      continue;
    }

    if (character === "'") {
      const literalEnd = skipSingleQuoted(sql, index);

      if (literalEnd === undefined) {
        return { kind: 'opaque', construct: 'an unterminated string literal' };
      }

      index = literalEnd;
      statement += ' ';
      continue;
    }

    if (character === '"') {
      const identifierEnd = skipDoubleQuoted(sql, index);

      if (identifierEnd === undefined) {
        return {
          kind: 'opaque',
          construct: 'an unterminated quoted identifier',
        };
      }

      statement += sql.slice(index, identifierEnd);
      index = identifierEnd;
      continue;
    }

    if (character === '$') {
      DOLLAR_QUOTE_OPENING.lastIndex = index;

      if (DOLLAR_QUOTE_OPENING.test(sql)) {
        return { kind: 'opaque', construct: 'a dollar-quoted body' };
      }
    }

    statement += character;
    index += 1;
  }

  return { kind: 'masked', statement };
};

// Postgres nests block comments, so the first `*/` of
// `/* /* UPDATE … */ */` closes the inner one and the statement continues
const skipBlockComment = (
  sql: string,
  openIndex: number,
): number | undefined => {
  let depth = 0;
  let index = openIndex;

  while (index < sql.length - 1) {
    if (sql[index] === '/' && sql[index + 1] === '*') {
      depth += 1;
      index += 2;
      continue;
    }

    if (sql[index] === '*' && sql[index + 1] === '/') {
      depth -= 1;
      index += 2;

      if (depth === 0) {
        return index;
      }

      continue;
    }

    index += 1;
  }

  return undefined;
};

const skipSingleQuoted = (
  sql: string,
  openIndex: number,
): number | undefined => {
  const allowsBackslashEscape = isEscapeStringLiteralAt(sql, openIndex);
  let index = openIndex + 1;

  while (index < sql.length) {
    const character = sql[index];

    if (allowsBackslashEscape && character === '\\') {
      index += 2;
      continue;
    }

    if (character === "'") {
      // A doubled quote is one quote of the literal, not its end
      if (sql[index + 1] === "'") {
        index += 2;
        continue;
      }

      return index + 1;
    }

    index += 1;
  }

  return undefined;
};

// `E'…'` is the one string form where a backslash escapes the quote that would
// otherwise close the literal; everywhere else a backslash is an ordinary
// character and reading it as an escape would run the literal past its end
const isEscapeStringLiteralAt = (sql: string, quoteIndex: number): boolean =>
  quoteIndex > 0 &&
  (sql[quoteIndex - 1] === 'E' || sql[quoteIndex - 1] === 'e') &&
  (quoteIndex === 1 || !IDENTIFIER_CHARACTER.test(sql[quoteIndex - 2]));

const skipDoubleQuoted = (
  sql: string,
  openIndex: number,
): number | undefined => {
  let index = openIndex + 1;

  while (index < sql.length) {
    if (sql[index] === '"') {
      if (sql[index + 1] === '"') {
        index += 2;
        continue;
      }

      return index + 1;
    }

    index += 1;
  }

  return undefined;
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
