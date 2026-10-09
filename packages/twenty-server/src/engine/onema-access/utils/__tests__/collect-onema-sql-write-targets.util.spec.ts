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
});
