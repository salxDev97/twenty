// rls-design §4, В3. Which tables a raw statement writes, read from the
// statement itself. The first version of this check asked the repository the
// statement came from instead, which answered a different question: the
// campaign-delivery repository running `UPDATE "workspace_x"."_opportunity"` is
// a write on a governed object by an ungoverned repository, and it passed.
//
// The second version read the targets with one regex per keyword, which is the
// hole the fourth review round named: `UPDATE U&"_opportunity" SET …` writes the
// table, while `(?:"[^"]+"|[A-Za-z_]\w*)` stops at the `U` and reports a write
// on a table called "u" — ungoverned, and waved through. A regex sees a name
// where Postgres sees a lexical form, so the statement is lexed here the way
// Postgres lexes it, once, and every writing keyword has to yield a target.
//
// Anything this cannot attribute is reported as such, so the caller can refuse
// it rather than guess — including the bodies it is not allowed to read.

export type OnemaSqlTableReference = {
  schemaName?: string;
  tableName: string;
  // `U&"…"`: the name is the decoded one, so a governed table named this way is
  // recognized as itself — but no audited path spells a table like this, and the
  // caller refuses the statement even when the name turns out to be ungoverned
  spelling?: 'unicode-escaped';
};

export type OnemaSqlWriteTargets =
  | { kind: 'none' }
  | { kind: 'opaque'; construct: string }
  | { kind: 'unreadable'; keyword: string }
  | { kind: 'tables'; keyword: string; tables: OnemaSqlTableReference[] };

export const collectOnemaSqlWriteTargets = (
  sql: string,
): OnemaSqlWriteTargets => {
  const tokenized = tokenizeSql(sql);

  return tokenized.kind === 'opaque'
    ? tokenized
    : readWriteTargets(tokenized.tokens);
};

// A body, a procedure or a prepared statement names no table and may write any
const OPAQUE_CONSTRUCT_BY_WORD: Record<string, string> = {
  do: 'a DO block',
  call: 'a CALL',
  execute: 'an EXECUTE',
};

// Words that cannot be the table of a write in the position a target is read
// from, so reading one there means the form was not understood: `UPDATE SET …`
// used to be read as a write on a table called "set"
const NON_TABLE_WORDS = new Set([
  'all',
  'and',
  'as',
  'by',
  'case',
  'conflict',
  'copy',
  'default',
  'delete',
  'do',
  'else',
  'end',
  'for',
  'from',
  'group',
  'insert',
  'into',
  'join',
  'key',
  'limit',
  'matched',
  'merge',
  'no',
  'not',
  'nothing',
  'null',
  'offset',
  'on',
  'only',
  'or',
  'order',
  'program',
  'returning',
  'select',
  'set',
  'share',
  'stdin',
  'stdout',
  'table',
  'then',
  'truncate',
  'update',
  'using',
  'values',
  'when',
  'where',
  'with',
]);

const MERGE_ACTION_WORDS = new Set(['insert', 'update', 'delete']);

type OnemaSqlToken =
  | { kind: 'word'; value: string }
  | { kind: 'name'; value: string; isUnicodeEscaped: boolean }
  // A `U&"…"` whose escapes do not decode: Postgres knows which table it means
  // and this does not, which is the one answer that may not be guessed
  | { kind: 'undecodable-name' }
  | { kind: 'symbol'; value: string }
  | { kind: 'other' };

const readWriteTargets = (tokens: OnemaSqlToken[]): OnemaSqlWriteTargets => {
  const tables: OnemaSqlTableReference[] = [];
  let keyword: string | undefined;
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index];

    if (token.kind !== 'word') {
      index += 1;
      continue;
    }

    const previousToken = tokens[index - 1];

    // A word after a dot is the tail of a qualified name, never a verb:
    // `pg_catalog.copy` names a function and starts no statement
    if (previousToken?.kind === 'symbol' && previousToken.value === '.') {
      index += 1;
      continue;
    }

    const word = token.value;

    // `SELECT … FOR UPDATE` takes a lock and writes nothing. The freeze of
    // rls-design §12а reads the row it compares exactly that way.
    if (word === 'for') {
      index = skipLockClause(tokens, index);
      continue;
    }

    // The row an `ON CONFLICT` action touches is the one the INSERT already
    // names, so the action's own verb is not a second target — and reading it
    // as one would make a table of the `SET` that follows. (The clause and its
    // updating form are never spelled together in this file: the CI guard of
    // onema-raw-write-guard.spec.ts scans the whole server for that pair.)
    if (word === 'on' && isWordAt(tokens, index + 1, 'conflict')) {
      index = skipOnConflictAction(tokens, index + 2);
      continue;
    }

    // Same for a MERGE action: it writes the row the MERGE target names
    if (word === 'then') {
      index = skipMergeAction(tokens, index + 1);
      continue;
    }

    const opaqueConstruct = OPAQUE_CONSTRUCT_BY_WORD[word];

    if (opaqueConstruct !== undefined) {
      return { kind: 'opaque', construct: opaqueConstruct };
    }

    if (word === 'copy') {
      const copy = readCopyTarget(tokens, index);

      if (copy === undefined) {
        return unreadable(word);
      }

      if (copy.reference !== undefined) {
        keyword ??= 'COPY';
        tables.push(copy.reference);
      }

      index = copy.nextIndex;
      continue;
    }

    const targetClause = TARGET_CLAUSE_BY_VERB[word];

    if (targetClause === undefined) {
      index += 1;
      continue;
    }

    const targets = readVerbTargets({ tokens, index, clause: targetClause });

    // Fail-closed: a writing keyword whose target this cannot read is refused by
    // the caller, never passed over because the rest of the statement parsed
    if (targets === undefined) {
      return unreadable(word);
    }

    keyword ??= word.toUpperCase();
    tables.push(...targets.references);
    index = targets.nextIndex;
  }

  return tables.length > 0
    ? { kind: 'tables', keyword: keyword ?? 'write', tables }
    : { kind: 'none' };
};

type OnemaSqlTargetClause = {
  // The word between the verb and its target, if the form has one
  introducer?: string;
  // `TRUNCATE a, b` names several; every other form names one
  isList?: boolean;
  // `TRUNCATE TABLE a` and `TRUNCATE a` are the same statement
  optionalWord?: string;
};

const TARGET_CLAUSE_BY_VERB: Record<string, OnemaSqlTargetClause> = {
  insert: { introducer: 'into' },
  merge: { introducer: 'into' },
  delete: { introducer: 'from' },
  update: {},
  truncate: { isList: true, optionalWord: 'table' },
};

const readVerbTargets = ({
  tokens,
  index,
  clause,
}: {
  tokens: OnemaSqlToken[];
  index: number;
  clause: OnemaSqlTargetClause;
}): { references: OnemaSqlTableReference[]; nextIndex: number } | undefined => {
  let cursor = index + 1;

  if (clause.introducer !== undefined) {
    if (!isWordAt(tokens, cursor, clause.introducer)) {
      return undefined;
    }

    cursor += 1;
  }

  if (
    clause.optionalWord !== undefined &&
    isWordAt(tokens, cursor, clause.optionalWord)
  ) {
    cursor += 1;
  }

  const references: OnemaSqlTableReference[] = [];

  for (;;) {
    const target = readTarget(tokens, cursor);

    if (target === undefined) {
      return undefined;
    }

    references.push(target.reference);
    cursor = target.nextIndex;

    if (clause.isList !== true || !isSymbolAt(tokens, cursor, ',')) {
      return { references, nextIndex: cursor };
    }

    cursor += 1;
  }
};

// `COPY … FROM` writes, `COPY … TO` reads, and reading is ONE-113's question.
// A `COPY` that is neither is a write whose target was not read.
const readCopyTarget = (
  tokens: OnemaSqlToken[],
  index: number,
):
  | { reference: OnemaSqlTableReference | undefined; nextIndex: number }
  | undefined => {
  if (isSymbolAt(tokens, index + 1, '(')) {
    const afterQuery = skipParenthesized(tokens, index + 1);

    // The query of a `COPY (…) TO` may itself be an INSERT, UPDATE or DELETE
    // with RETURNING, so reading continues inside the parentheses rather than
    // past them — only the COPY itself writes nothing here
    return afterQuery !== undefined && isWordAt(tokens, afterQuery, 'to')
      ? { reference: undefined, nextIndex: index + 2 }
      : undefined;
  }

  const target = readTarget(tokens, index + 1);

  if (target === undefined) {
    return undefined;
  }

  const direction = findCopyDirection(tokens, target.nextIndex);

  if (direction === undefined) {
    return undefined;
  }

  return {
    reference: direction.word === 'from' ? target.reference : undefined,
    nextIndex: direction.nextIndex,
  };
};

const findCopyDirection = (
  tokens: OnemaSqlToken[],
  fromIndex: number,
): { word: string; nextIndex: number } | undefined => {
  let depth = 0;

  for (let index = fromIndex; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token.kind === 'symbol') {
      if (token.value === '(') {
        depth += 1;
      } else if (token.value === ')') {
        depth -= 1;
      } else if (token.value === ';' && depth === 0) {
        return undefined;
      }

      continue;
    }

    if (token.kind === 'word' && depth === 0) {
      if (token.value === 'from' || token.value === 'to') {
        return { word: token.value, nextIndex: index + 1 };
      }
    }
  }

  return undefined;
};

type OnemaSqlNamePart = { value: string; isUnicodeEscaped: boolean };

const readTarget = (
  tokens: OnemaSqlToken[],
  fromIndex: number,
): { reference: OnemaSqlTableReference; nextIndex: number } | undefined => {
  let index = isWordAt(tokens, fromIndex, 'only') ? fromIndex + 1 : fromIndex;
  const firstPart = readNamePart(tokens, index);

  if (firstPart === undefined) {
    return undefined;
  }

  const parts: OnemaSqlNamePart[] = [firstPart];

  index += 1;

  // `database.schema.table` is as far as a qualified name goes
  while (parts.length < 3 && isSymbolAt(tokens, index, '.')) {
    const part = readNamePart(tokens, index + 1);

    if (part === undefined) {
      return undefined;
    }

    parts.push(part);
    index += 2;
  }

  const tablePart = parts[parts.length - 1];
  const schemaPart = parts.length > 1 ? parts[parts.length - 2] : undefined;
  const isUnicodeEscaped =
    tablePart.isUnicodeEscaped || schemaPart?.isUnicodeEscaped === true;

  return {
    reference: {
      ...(schemaPart === undefined ? {} : { schemaName: schemaPart.value }),
      tableName: tablePart.value,
      ...(isUnicodeEscaped ? { spelling: 'unicode-escaped' as const } : {}),
    },
    nextIndex: index,
  };
};

const readNamePart = (
  tokens: OnemaSqlToken[],
  index: number,
): OnemaSqlNamePart | undefined => {
  const token = tokens[index];

  if (token === undefined) {
    return undefined;
  }

  if (token.kind === 'name') {
    return { value: token.value, isUnicodeEscaped: token.isUnicodeEscaped };
  }

  // Postgres folds an unquoted identifier to lower case and keeps a quoted one
  // as written, so the two spellings name different tables
  return token.kind === 'word' && !NON_TABLE_WORDS.has(token.value)
    ? { value: token.value, isUnicodeEscaped: false }
    : undefined;
};

const skipLockClause = (tokens: OnemaSqlToken[], forIndex: number): number => {
  const words: string[] = [];
  let index = forIndex + 1;

  while (words.length < 3) {
    const token = tokens[index];

    if (token?.kind !== 'word') {
      return forIndex + 1;
    }

    words.push(token.value);
    index += 1;

    const phrase = words.join(' ');

    if (
      phrase === 'update' ||
      phrase === 'share' ||
      phrase === 'no key update' ||
      phrase === 'key share'
    ) {
      return index;
    }
  }

  return forIndex + 1;
};

// Leaves the `DO` to be read as a block when the action is neither of the two
// the clause allows — an unknown form is the caller's to refuse
const skipOnConflictAction = (
  tokens: OnemaSqlToken[],
  fromIndex: number,
): number => {
  let depth = 0;

  for (let index = fromIndex; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token.kind === 'symbol') {
      if (token.value === '(') {
        depth += 1;
      } else if (token.value === ')') {
        depth -= 1;
      } else if (token.value === ';' && depth === 0) {
        return index;
      }

      continue;
    }

    if (token.kind === 'word' && depth === 0 && token.value === 'do') {
      return isWordAt(tokens, index + 1, 'update') ||
        isWordAt(tokens, index + 1, 'nothing')
        ? index + 2
        : index;
    }
  }

  return tokens.length;
};

const skipMergeAction = (
  tokens: OnemaSqlToken[],
  fromIndex: number,
): number => {
  const token = tokens[fromIndex];

  if (token?.kind !== 'word') {
    return fromIndex;
  }

  if (token.value === 'do') {
    return isWordAt(tokens, fromIndex + 1, 'nothing')
      ? fromIndex + 2
      : fromIndex;
  }

  return MERGE_ACTION_WORDS.has(token.value) ? fromIndex + 1 : fromIndex;
};

const skipParenthesized = (
  tokens: OnemaSqlToken[],
  openIndex: number,
): number | undefined => {
  let depth = 0;

  for (let index = openIndex; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token.kind !== 'symbol') {
      continue;
    }

    if (token.value === '(') {
      depth += 1;
    } else if (token.value === ')') {
      depth -= 1;

      if (depth === 0) {
        return index + 1;
      }
    }
  }

  return undefined;
};

const isWordAt = (
  tokens: OnemaSqlToken[],
  index: number,
  word: string,
): boolean => {
  const token = tokens[index];

  return token?.kind === 'word' && token.value === word;
};

const isSymbolAt = (
  tokens: OnemaSqlToken[],
  index: number,
  symbol: string,
): boolean => {
  const token = tokens[index];

  return token?.kind === 'symbol' && token.value === symbol;
};

const unreadable = (word: string): OnemaSqlWriteTargets => ({
  kind: 'unreadable',
  keyword: word.toUpperCase(),
});

type OnemaSqlTokenization =
  | { kind: 'tokens'; tokens: OnemaSqlToken[] }
  | { kind: 'opaque'; construct: string };

const WHITESPACE = /\s/;

// Postgres lets any non-ASCII character stand in an unquoted identifier, so a
// table named in Cyrillic is a name here too rather than a form nothing reads
const IDENTIFIER_START = /[A-Za-z_]|[^\x00-\x7f]/;
const IDENTIFIER_CHARACTER = /[A-Za-z0-9_$]|[^\x00-\x7f]/;
const HEX_DIGITS = /^[0-9A-Fa-f]+$/;

// Only the symbols a qualified name and a clause boundary are read from; every
// other one is a token this has no question about
const STRUCTURAL_SYMBOLS = new Set(['.', ',', '(', ')', ';']);

// Dollar quoting opens a body this check cannot read, and `$1` is a parameter
// rather than an opening: the closing `$` is what tells the two apart
const DOLLAR_QUOTE_OPENING = /\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/y;

const UESCAPE_CLAUSE = /\s*UESCAPE\s*'(.)'/iy;

// Comments and string literals each hide the other's opening, so neither may be
// cut out before the other. Removing comments first read
// `SELECT '/*'; UPDATE …; SELECT '*/'` as one harmless SELECT, because the
// `/*` inside the first literal was taken for the start of a comment that ran
// across the UPDATE. The statement is walked once instead: whichever construct
// opens first is the one that closes, exactly as Postgres reads it.
//
// Literals and comments leave a token that says only "something was here";
// identifiers keep their decoded name, which is what the targets are read from.
const tokenizeSql = (sql: string): OnemaSqlTokenization => {
  const tokens: OnemaSqlToken[] = [];
  let index = 0;

  while (index < sql.length) {
    const character = sql[index];

    if (WHITESPACE.test(character)) {
      index += 1;
      continue;
    }

    if (character === '-' && sql[index + 1] === '-') {
      const lineEnd = sql.indexOf('\n', index);

      index = lineEnd === -1 ? sql.length : lineEnd;
      continue;
    }

    if (character === '/' && sql[index + 1] === '*') {
      const commentEnd = skipBlockComment(sql, index);

      if (commentEnd === undefined) {
        return { kind: 'opaque', construct: 'an unterminated block comment' };
      }

      index = commentEnd;
      continue;
    }

    if (character === "'") {
      const literalEnd = skipSingleQuoted(sql, index);

      if (literalEnd === undefined) {
        return { kind: 'opaque', construct: 'an unterminated string literal' };
      }

      index = literalEnd;
      tokens.push({ kind: 'other' });
      continue;
    }

    if (character === '"') {
      const quoted = readQuotedIdentifier(sql, index);

      if (quoted === undefined) {
        return {
          kind: 'opaque',
          construct: 'an unterminated quoted identifier',
        };
      }

      tokens.push({
        kind: 'name',
        value: quoted.value,
        isUnicodeEscaped: false,
      });
      index = quoted.nextIndex;
      continue;
    }

    // `U&"…"` is a quoted identifier whose escapes Postgres reads; the regexes
    // this replaced stopped at the `U` and reported a write on a table "u"
    if (
      (character === 'U' || character === 'u') &&
      sql[index + 1] === '&' &&
      sql[index + 2] === '"'
    ) {
      const unicodeName = readUnicodeEscapedIdentifier(sql, index);

      if (unicodeName === undefined) {
        return {
          kind: 'opaque',
          construct: 'an unterminated quoted identifier',
        };
      }

      tokens.push(
        unicodeName.value === undefined
          ? { kind: 'undecodable-name' }
          : {
              kind: 'name',
              value: unicodeName.value,
              isUnicodeEscaped: true,
            },
      );
      index = unicodeName.nextIndex;
      continue;
    }

    if (character === '$') {
      if (isDollarQuoteOpeningAt(sql, index)) {
        return { kind: 'opaque', construct: 'a dollar-quoted body' };
      }

      tokens.push({ kind: 'other' });
      index += 1;
      continue;
    }

    if (IDENTIFIER_START.test(character)) {
      let end = index + 1;

      while (
        end < sql.length &&
        IDENTIFIER_CHARACTER.test(sql[end]) &&
        !isDollarQuoteOpeningAt(sql, end)
      ) {
        end += 1;
      }

      tokens.push({ kind: 'word', value: sql.slice(index, end).toLowerCase() });
      index = end;
      continue;
    }

    tokens.push(
      STRUCTURAL_SYMBOLS.has(character)
        ? { kind: 'symbol', value: character }
        : { kind: 'other' },
    );
    index += 1;
  }

  return { kind: 'tokens', tokens };
};

const isDollarQuoteOpeningAt = (sql: string, index: number): boolean => {
  if (sql[index] !== '$') {
    return false;
  }

  DOLLAR_QUOTE_OPENING.lastIndex = index;

  return DOLLAR_QUOTE_OPENING.test(sql);
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

const readQuotedIdentifier = (
  sql: string,
  openIndex: number,
): { value: string; nextIndex: number } | undefined => {
  let value = '';
  let index = openIndex + 1;

  while (index < sql.length) {
    if (sql[index] === '"') {
      // A doubled quote is one quote of the name, not its end: the table of
      // `UPDATE "a""b"` is `a"b`, and keeping the pair kept a name nothing matches
      if (sql[index + 1] === '"') {
        value += '"';
        index += 2;
        continue;
      }

      return { value, nextIndex: index + 1 };
    }

    value += sql[index];
    index += 1;
  }

  return undefined;
};

// `U&"d\0061t\+000061"` is the table `data`, and `UESCAPE 'c'` replaces the
// backslash with another character. Undecodable escapes answer `undefined`:
// Postgres knows which table that is and this does not.
const readUnicodeEscapedIdentifier = (
  sql: string,
  openIndex: number,
): { value: string | undefined; nextIndex: number } | undefined => {
  const quoted = readQuotedIdentifier(sql, openIndex + 2);

  if (quoted === undefined) {
    return undefined;
  }

  UESCAPE_CLAUSE.lastIndex = quoted.nextIndex;

  const uescape = UESCAPE_CLAUSE.exec(sql);

  return {
    value: decodeUnicodeEscapes(quoted.value, uescape?.[1] ?? '\\'),
    nextIndex: uescape === null ? quoted.nextIndex : UESCAPE_CLAUSE.lastIndex,
  };
};

const decodeUnicodeEscapes = (
  body: string,
  escapeCharacter: string,
): string | undefined => {
  let value = '';
  let index = 0;

  while (index < body.length) {
    const character = body[index];

    if (character !== escapeCharacter) {
      value += character;
      index += 1;
      continue;
    }

    // A doubled escape character is the character itself
    if (body[index + 1] === escapeCharacter) {
      value += escapeCharacter;
      index += 2;
      continue;
    }

    const isSixDigitForm = body[index + 1] === '+';
    const digitsStart = index + (isSixDigitForm ? 2 : 1);
    const digitsLength = isSixDigitForm ? 6 : 4;
    const digits = body.slice(digitsStart, digitsStart + digitsLength);

    if (digits.length < digitsLength || !HEX_DIGITS.test(digits)) {
      return undefined;
    }

    const codePoint = Number.parseInt(digits, 16);

    if (codePoint > 0x10ffff) {
      return undefined;
    }

    value += String.fromCodePoint(codePoint);
    index = digitsStart + digitsLength;
  }

  return value;
};
