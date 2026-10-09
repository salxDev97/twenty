import { collectOnemaSqlWriteTargets } from 'src/engine/onema-access/utils/collect-onema-sql-write-targets.util';

describe('collectOnemaSqlWriteTargets', () => {
  it.each([
    ['SELECT "id" FROM "workspace_x"."_task"'],
    ['SELECT * FROM "workspace_x"."_task" WHERE "id" = :p0 FOR UPDATE'],
    ['SELECT "id" FROM "workspace_x"."_task" FOR NO KEY UPDATE'],
    ['SELECT "updatedAt", "deletedAt" FROM "workspace_x"."_task"'],
    [`SELECT 1 WHERE "name" = 'delete from everything' -- insert later`],
    ['COPY (SELECT "id" FROM "workspace_x"."_task") TO STDOUT'],
  ])('reads no write out of %s', (sql) => {
    expect(collectOnemaSqlWriteTargets(sql)).toEqual({ kind: 'none' });
  });

  it.each([
    [
      'UPDATE "workspace_x"."_task" SET "title" = :p0',
      'UPDATE',
      [{ schemaName: 'workspace_x', tableName: '_task' }],
    ],
    [
      'INSERT INTO "workspace_x"."_task" ("id") VALUES (:p0)',
      'INSERT',
      [{ schemaName: 'workspace_x', tableName: '_task' }],
    ],
    [
      'DELETE FROM ONLY "workspace_x"."_task" WHERE true',
      'DELETE',
      [{ schemaName: 'workspace_x', tableName: '_task' }],
    ],
    [
      'MERGE INTO "workspace_x"."_task" AS t USING "s" ON true',
      'MERGE',
      [{ schemaName: 'workspace_x', tableName: '_task' }],
    ],
    [
      'COPY "workspace_x"."_task" ("id") FROM STDIN',
      'COPY',
      [{ schemaName: 'workspace_x', tableName: '_task' }],
    ],
    // An unqualified name is left to the search path, and the table alone is
    // all the statement says
    [
      'DELETE FROM task_queue WHERE true',
      'DELETE',
      [{ tableName: 'task_queue' }],
    ],
  ])('reads %s as a write on its table', (sql, keyword, tables) => {
    expect(collectOnemaSqlWriteTargets(sql)).toEqual({
      kind: 'tables',
      keyword,
      tables,
    });
  });

  // Upstream settles a claimed batch exactly this way, and the write inside the
  // CTE is as real as one at the top level
  it('reads the write out of a data-modifying common table expression', () => {
    expect(
      collectOnemaSqlWriteTargets(
        'WITH settled AS (UPDATE "workspace_x"."_delivery" SET "state" = :p0 RETURNING "id") SELECT "id" FROM settled',
      ),
    ).toEqual({
      kind: 'tables',
      keyword: 'UPDATE',
      tables: [{ schemaName: 'workspace_x', tableName: '_delivery' }],
    });
  });

  it('reads every table a TRUNCATE lists', () => {
    expect(
      collectOnemaSqlWriteTargets(
        'TRUNCATE TABLE "workspace_x"."_a", ONLY "workspace_x"."_b"',
      ),
    ).toEqual({
      kind: 'tables',
      keyword: 'TRUNCATE',
      tables: [
        { schemaName: 'workspace_x', tableName: '_a' },
        { schemaName: 'workspace_x', tableName: '_b' },
      ],
    });
  });

  // The row an ON CONFLICT action touches is the one the INSERT already names,
  // so dropping the clause loses no target — and keeping it would read
  // "UPDATE SET" as a table
  it('reads an ON CONFLICT DO UPDATE as a write on the INSERT target', () => {
    expect(
      collectOnemaSqlWriteTargets(
        'INSERT INTO "workspace_x"."_task" ("id") VALUES (:p0) ON CONFLICT ("id") DO UPDATE SET "title" = :p1',
      ),
    ).toEqual({
      kind: 'tables',
      keyword: 'INSERT',
      tables: [{ schemaName: 'workspace_x', tableName: '_task' }],
    });
  });

  it('does not read an ON CONFLICT DO NOTHING as a block', () => {
    expect(
      collectOnemaSqlWriteTargets(
        'INSERT INTO "workspace_x"."_task" ("id") VALUES (:p0) ON CONFLICT ("id") DO NOTHING',
      ),
    ).toEqual({
      kind: 'tables',
      keyword: 'INSERT',
      tables: [{ schemaName: 'workspace_x', tableName: '_task' }],
    });
  });

  // The body of a block used to be cut out as a literal before the keywords
  // were read, which is exactly how a write hid from this
  it.each([
    [
      'DO $$ BEGIN UPDATE "workspace_x"."_task" SET "title" = 1; END $$',
      'a dollar-quoted body',
    ],
    ['DO $body$ BEGIN PERFORM 1; END $body$', 'a dollar-quoted body'],
    ['CALL settle_batch(:p0)', 'a CALL'],
    ['EXECUTE settle_batch (:p0)', 'an EXECUTE'],
  ])('reads %s as opaque', (sql, construct) => {
    expect(collectOnemaSqlWriteTargets(sql)).toEqual({
      kind: 'opaque',
      construct,
    });
  });

  it.each([
    ['UPDATE (:p0) SET "x" = 1', 'UPDATE'],
    ['COPY FROM PROGRAM :p0', 'COPY'],
  ])('reads %s as a write it cannot attribute', (sql, keyword) => {
    expect(collectOnemaSqlWriteTargets(sql)).toEqual({
      kind: 'unreadable',
      keyword,
    });
  });

  // The review's own case: cutting comments out before literals turned the
  // `/*` of the first literal into the opening of a comment that swallowed the
  // UPDATE, and the whole thing read as a harmless SELECT
  it('reads the write between two literals that look like a comment', () => {
    expect(
      collectOnemaSqlWriteTargets(
        `SELECT '/*'; UPDATE "workspace_x"."_task" SET "title" = :p0; SELECT '*/'`,
      ),
    ).toEqual({
      kind: 'tables',
      keyword: 'UPDATE',
      tables: [{ schemaName: 'workspace_x', tableName: '_task' }],
    });
  });

  // The other direction: a literal opening inside a comment is text of the
  // comment, and must not swallow the statement that follows
  it('reads the write after a comment holding an unbalanced quote', () => {
    expect(
      collectOnemaSqlWriteTargets(
        `-- it's a note about delete\nUPDATE "workspace_x"."_task" SET "title" = :p0`,
      ),
    ).toEqual({
      kind: 'tables',
      keyword: 'UPDATE',
      tables: [{ schemaName: 'workspace_x', tableName: '_task' }],
    });
  });

  it('reads the write after a block comment that nests another one', () => {
    expect(
      collectOnemaSqlWriteTargets(
        '/* outer /* inner */ still the outer */ DELETE FROM "workspace_x"."_task"',
      ),
    ).toEqual({
      kind: 'tables',
      keyword: 'DELETE',
      tables: [{ schemaName: 'workspace_x', tableName: '_task' }],
    });
  });

  // A doubled quote is one quote of the literal; reading it as its end used to
  // leave the rest of the literal standing as if it were statement text
  it.each([
    [`SELECT 'it''s; UPDATE "workspace_x"."_task" SET x = 1; --'`],
    [`SELECT E'\\'; UPDATE "workspace_x"."_task" SET x = 1; --'`],
  ])('reads no write out of %s', (sql) => {
    expect(collectOnemaSqlWriteTargets(sql)).toEqual({ kind: 'none' });
  });

  // A dollar quote inside a literal opens nothing, and the statement around it
  // still has to be read
  it('does not take a dollar quote inside a literal for a body', () => {
    expect(
      collectOnemaSqlWriteTargets(
        `UPDATE "workspace_x"."_task" SET "title" = '$$ BEGIN END $$'`,
      ),
    ).toEqual({
      kind: 'tables',
      keyword: 'UPDATE',
      tables: [{ schemaName: 'workspace_x', tableName: '_task' }],
    });
  });

  // Nothing here can say where an unclosed construct would have ended, so the
  // statement is refused rather than read as far as it happens to parse
  it.each([
    [`SELECT 'unterminated`, 'an unterminated string literal'],
    ['SELECT /* unterminated', 'an unterminated block comment'],
    ['SELECT "unterminated', 'an unterminated quoted identifier'],
  ])('reads %s as opaque', (sql, construct) => {
    expect(collectOnemaSqlWriteTargets(sql)).toEqual({
      kind: 'opaque',
      construct,
    });
  });

  // Postgres folds an unquoted identifier and keeps a quoted one as written, so
  // the two spellings are normalized apart rather than being treated as one
  it('keeps the case of a quoted name and folds an unquoted one', () => {
    expect(
      collectOnemaSqlWriteTargets('UPDATE "WorkspaceX"._Task SET "x" = 1'),
    ).toEqual({
      kind: 'tables',
      keyword: 'UPDATE',
      tables: [{ schemaName: 'WorkspaceX', tableName: '_task' }],
    });
  });

  // A doubled quote inside a quoted identifier is one quote of the name. The
  // regex this replaced read `"a""b"` as the name `a` followed by nonsense.
  it('reads a doubled quote as one quote of the name', () => {
    expect(
      collectOnemaSqlWriteTargets('UPDATE "work""space"."_ta""sk" SET "x" = 1'),
    ).toEqual({
      kind: 'tables',
      keyword: 'UPDATE',
      tables: [{ schemaName: 'work"space', tableName: '_ta"sk' }],
    });
  });

  // The hole of review round 4: `U&"…"` is a quoted identifier whose escapes
  // Postgres reads, and a regex that stops at the `U` reports a write on a
  // table called "u" — ungoverned, and waved through
  it.each([
    [
      'UPDATE U&"_task" SET "title" = :p0',
      'UPDATE',
      [{ tableName: '_task', spelling: 'unicode-escaped' }],
    ],
    [
      'UPDATE "workspace_x".U&"_t\\0061sk" SET "title" = :p0',
      'UPDATE',
      [
        {
          schemaName: 'workspace_x',
          tableName: '_task',
          spelling: 'unicode-escaped',
        },
      ],
    ],
    [
      'UPDATE U&"_t\\+000061sk" SET "title" = :p0',
      'UPDATE',
      [{ tableName: '_task', spelling: 'unicode-escaped' }],
    ],
    // `UESCAPE` puts another character in the backslash's place
    [
      `UPDATE U&"_t!0061sk" UESCAPE '!' SET "title" = :p0`,
      'UPDATE',
      [{ tableName: '_task', spelling: 'unicode-escaped' }],
    ],
    // A doubled escape character is the character itself, not an escape
    [
      'UPDATE U&"_t\\\\sk" SET "title" = :p0',
      'UPDATE',
      [{ tableName: '_t\\sk', spelling: 'unicode-escaped' }],
    ],
    [
      'DELETE FROM U&"\\0077orkspace_x".U&"_task" WHERE true',
      'DELETE',
      [
        {
          schemaName: 'workspace_x',
          tableName: '_task',
          spelling: 'unicode-escaped',
        },
      ],
    ],
  ])('decodes the Unicode-escaped target of %s', (sql, keyword, tables) => {
    expect(collectOnemaSqlWriteTargets(sql)).toEqual({
      kind: 'tables',
      keyword,
      tables,
    });
  });

  // Postgres knows which table these name and this does not, which is the one
  // answer a closed-by-default check may not guess at
  it.each([
    ['UPDATE U&"_t\\00zzsk" SET "x" = 1', 'UPDATE'],
    ['UPDATE U&"_t\\006" SET "x" = 1', 'UPDATE'],
    [`INSERT INTO U&"_t!00zzsk" UESCAPE '!' ("id") VALUES (:p0)`, 'INSERT'],
  ])('reads %s as a write it cannot attribute', (sql, keyword) => {
    expect(collectOnemaSqlWriteTargets(sql)).toEqual({
      kind: 'unreadable',
      keyword,
    });
  });

  // Fail-closed on the forms nothing here understands: the write is reported,
  // not the half of it that happened to parse
  it.each([
    ['INSERT "workspace_x"."_task" ("id") VALUES (:p0)', 'INSERT'],
    ['DELETE "workspace_x"."_task" WHERE true', 'DELETE'],
    ['MERGE "workspace_x"."_task" USING "s" ON true', 'MERGE'],
    ['UPDATE 42 SET "x" = 1', 'UPDATE'],
    ['UPDATE SET "x" = 1', 'UPDATE'],
    ['TRUNCATE TABLE "workspace_x"."_a", (:p0)', 'TRUNCATE'],
    ['COPY "workspace_x"."_task" ("id")', 'COPY'],
    [
      'INSERT INTO "workspace_x"."_task" ("id") VALUES (:p0) ON CONFLICT ("id") DO SOMETHING',
      'INSERT',
    ],
  ])('refuses to read %s as a write on nothing', (sql, keyword) => {
    const writeTargets = collectOnemaSqlWriteTargets(sql);

    expect(
      writeTargets.kind === 'unreadable' || writeTargets.kind === 'opaque',
    ).toBe(true);

    if (writeTargets.kind === 'unreadable') {
      expect(writeTargets.keyword).toBe(keyword);
    }
  });

  // A statement whose target reads cleanly is not excused by a second one that
  // does not: both are the same raw query
  it('reports the unreadable target of a statement that also writes a table it can read', () => {
    expect(
      collectOnemaSqlWriteTargets(
        'UPDATE "workspace_x"."_task" SET "x" = 1; UPDATE (:p0) SET "y" = 2',
      ),
    ).toEqual({ kind: 'unreadable', keyword: 'UPDATE' });
  });

  // An `E'…'` literal beside the target closes where Postgres closes it, so the
  // target before it and the statement after it are both still read
  it.each([
    [
      `UPDATE "workspace_x"."_task" SET "title" = E'\\\\' WHERE "id" = :p0`,
      'UPDATE',
      [{ schemaName: 'workspace_x', tableName: '_task' }],
    ],
    [
      `SELECT E'it''s'; DELETE FROM "workspace_x"."_task" WHERE true`,
      'DELETE',
      [{ schemaName: 'workspace_x', tableName: '_task' }],
    ],
  ])(
    'reads the write beside an escape string literal in %s',
    (sql, keyword, tables) => {
      expect(collectOnemaSqlWriteTargets(sql)).toEqual({
        kind: 'tables',
        keyword,
        tables,
      });
    },
  );

  // A dollar-quoted string beside the target is a body this cannot read, and a
  // body may hold anything
  it('reads a dollar-quoted string beside the target as opaque', () => {
    expect(
      collectOnemaSqlWriteTargets(
        'UPDATE "workspace_x"."_task" SET "title" = $$ anything $$',
      ),
    ).toEqual({ kind: 'opaque', construct: 'a dollar-quoted body' });
  });

  // `COPY (…) TO` reads, but its query may be a data-modifying statement with
  // RETURNING, and that write is as real as one at the top level
  it('reads the write inside the query of a COPY that only copies out', () => {
    expect(
      collectOnemaSqlWriteTargets(
        'COPY (UPDATE "workspace_x"."_task" SET "title" = :p0 RETURNING "id") TO STDOUT',
      ),
    ).toEqual({
      kind: 'tables',
      keyword: 'UPDATE',
      tables: [{ schemaName: 'workspace_x', tableName: '_task' }],
    });
  });

  // A MERGE writes the row its own target names, and `THEN UPDATE SET` used to
  // add a second write on a table called "set"
  it('reads a MERGE with actions as a write on its target alone', () => {
    expect(
      collectOnemaSqlWriteTargets(
        'MERGE INTO "workspace_x"."_task" AS t USING "s" ON true WHEN MATCHED THEN UPDATE SET "title" = :p0 WHEN NOT MATCHED THEN INSERT ("id") VALUES (:p1)',
      ),
    ).toEqual({
      kind: 'tables',
      keyword: 'MERGE',
      tables: [{ schemaName: 'workspace_x', tableName: '_task' }],
    });
  });

  // A qualified name is not a statement, whatever its last part reads like
  it('does not read the tail of a qualified name as a verb', () => {
    expect(
      collectOnemaSqlWriteTargets(
        'SELECT onema_utils.truncate(:p0) FROM "workspace_x"."_task"',
      ),
    ).toEqual({ kind: 'none' });
  });
});
