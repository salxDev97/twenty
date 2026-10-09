import fs from 'fs';
import path from 'path';

const SERVER_SOURCE_ROOT = path.join(__dirname, '../../..');

// The one file allowed to write through the audited raw executor. Adding a
// second one means a new write path, and a new write path has to carry the
// hooks of rls-design §3.2–§3.3 and §12а — which is the review this list forces.
const AUDITED_RAW_WRITE_FILES = [
  'engine/twenty-orm/repository/workspace-repository.ts',
];

// The two raw executors of the ORM, and the guard each one has to carry. A
// statement handed to either passes none of the write hooks, so both are checked
// against the rules before they reach the database (rls-design §4, В3).
const RAW_SQL_ENTRY_POINT_FILES = [
  'engine/twenty-orm/repository/workspace-repository.ts',
  'engine/twenty-orm/datasource/workspace-data-source.ts',
];

const RAW_SQL_GUARD = 'assertOnemaRawSqlIsPermitted';

// `ON CONFLICT DO UPDATE` on a workspace record would update a row the insert
// path never read, so the freeze would compare nothing and the check after the
// write would never see it. ORM v2 builds `DO NOTHING` only, and this keeps it
// that way: a DO UPDATE has to come with its own pre-image and post-check.
//
// Scanned over the whole server rather than the statement builders alone, which
// is what the review asked for (Б3): the builders are where the clause belongs,
// so a DO UPDATE appearing anywhere else is exactly the one worth catching —
// and widening the scan is what turned up the three below.
//
// Nothing bounds how far the action may sit from the clause it belongs to — a
// column list, a `WHERE`, a formatted template literal — so the distance is not
// bounded here either. The lookahead only keeps one clause from being paired
// with the action of a later one; it never lets a pair through.
const ON_CONFLICT_DO_UPDATE =
  /\bON\s+CONFLICT\b(?:(?!\bON\s+CONFLICT\b)[\s\S])*?\bDO\s+UPDATE\b/i;

// The four that were already there when this check was widened. None of them
// writes a workspace record through the ORM. A fifth entry means somebody wrote
// a new upsert, and that is the review this list forces — on a workspace record
// it must bring its own pre-image and its own check after the write.
//
// What a text scan can prove and what it cannot: it sees the SQL this codebase
// spells out, not the SQL TypeORM generates for a core entity. That is why
// `WorkspaceScopedRepository` is on the list rather than being made to pass —
// upstream states in its own header that workspace data goes through
// `WorkspaceRepository`, which builds `DO NOTHING` and nothing else.
const ON_CONFLICT_DO_UPDATE_EXEMPT_FILES = [
  // core."workflowVersion" — the core schema mirror, not a workspace record
  'engine/core-modules/workflow/services/workflow-version-core-sync.service.ts',
  // core."keyValuePair" — where the migration command keeps its own cursor
  'database/commands/agent-history/agent-history-migration-state.service.ts',
  // Agent history tables, which may live in the workspace schema. A one-off
  // migration command copying upstream's own bookkeeping, under no rule of the
  // file and outside every runtime write path.
  'database/commands/agent-history/agent-history-migration-data.service.ts',
  // Upstream's own note about TypeORM's upsert, on a repository whose header
  // says workspace data belongs to WorkspaceRepository instead
  'engine/twenty-orm/workspace-scoped-repository/workspace-scoped-repository.ts',
  // Arrived with 2.46, and the check did its job: both write
  // `agentChatThreadParticipant` — a workspace-schema table (ONE-113) — with
  // raw SQL, past every hook. They stay because no rule of the file names an
  // AI chat object and §12 keeps AI off in v1, not because raw upserts there
  // are safe. `onema-write-path-inventory.spec.ts` holds the other half of
  // that sentence: it fails the day a governed table is named in a raw
  // statement, and the day either file moves or multiplies.
  'database/commands/upgrade-version-command/2-46/utils/backfill-agent-chat-thread-inbox-state.util.ts',
  'engine/metadata-modules/ai/ai-chat/services/agent-chat-thread-participant.service.ts',
];

// Where a workspace record's own statements are built. The clause has no
// business here at all, exemptions included.
const WORKSPACE_RECORD_WRITE_DIRECTORIES = [
  'engine/twenty-orm/sql/',
  'engine/twenty-orm/repository/',
];

// A `.sql` file and a `.js` one reach the database exactly like a `.ts` one, and
// scanning the TypeScript alone is what the review called a guard that does not
// cover `src` (Б3)
const SCANNED_EXTENSIONS = ['.ts', '.js', '.sql'];

const listSourceFiles = (directory: string): string[] =>
  fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        return entry.name === 'node_modules' || entry.name === 'dist'
          ? []
          : listSourceFiles(entryPath);
      }

      return entry.isFile() &&
        SCANNED_EXTENSIONS.some((extension) => entry.name.endsWith(extension))
        ? [entryPath]
        : [];
    })
    .filter((filePath) => !filePath.endsWith('.spec.ts'));

const relativeToSource = (filePath: string): string =>
  path.relative(SERVER_SOURCE_ROOT, filePath).split(path.sep).join('/');

describe('onema raw write guard', () => {
  const sourceFiles = listSourceFiles(SERVER_SOURCE_ROOT);

  it('finds the server sources to scan', () => {
    expect(sourceFiles.length).toBeGreaterThan(100);
  });

  it('keeps the audited raw write executor to its declared callers', () => {
    const callers = sourceFiles.filter((filePath) =>
      fs.readFileSync(filePath, 'utf-8').includes('executeRawWrite'),
    );

    expect(callers.map(relativeToSource).sort()).toEqual(
      [...AUDITED_RAW_WRITE_FILES].sort(),
    );
  });

  // The second raw executor went unguarded through three rounds of review
  // precisely because nothing named it here
  it.each(RAW_SQL_ENTRY_POINT_FILES)(
    'guards the raw SQL of %s',
    (relativePath) => {
      expect(
        fs.readFileSync(path.join(SERVER_SOURCE_ROOT, relativePath), 'utf-8'),
      ).toContain(RAW_SQL_GUARD);
    },
  );

  // A guard nobody calls protects nothing, and a third raw executor would be a
  // third place to add one
  it('keeps the guard to the raw executors that declare it', () => {
    const callers = sourceFiles.filter((filePath) =>
      fs.readFileSync(filePath, 'utf-8').includes(`${RAW_SQL_GUARD}({`),
    );

    expect(callers.map(relativeToSource).sort()).toEqual(
      [...RAW_SQL_ENTRY_POINT_FILES].sort(),
    );
  });

  // The clause and its action may sit any distance apart, and a bound on that
  // distance is a hole the next upsert walks straight through
  it('flags ON CONFLICT DO UPDATE however far apart the two halves are', () => {
    expect(
      ON_CONFLICT_DO_UPDATE.test(
        `INSERT INTO "t" ("a") VALUES (1) ON CONFLICT ("a")${' '.repeat(5000)}DO UPDATE SET "a" = 1`,
      ),
    ).toBe(true);
  });

  it('does not flag an ON CONFLICT DO NOTHING followed by an unrelated clause', () => {
    expect(
      ON_CONFLICT_DO_UPDATE.test(
        'INSERT INTO "t" ("a") VALUES (1) ON CONFLICT ("a") DO NOTHING',
      ),
    ).toBe(false);
  });

  it('keeps ON CONFLICT DO UPDATE out of every statement the server builds', () => {
    const offenders = sourceFiles
      .filter(
        (filePath) =>
          !ON_CONFLICT_DO_UPDATE_EXEMPT_FILES.includes(
            relativeToSource(filePath),
          ),
      )
      .filter((filePath) =>
        ON_CONFLICT_DO_UPDATE.test(fs.readFileSync(filePath, 'utf-8')),
      );

    expect(offenders.map(relativeToSource)).toEqual([]);
  });

  // A stale exemption is a hole that looks like a decision: once a file loses
  // the clause, its name has to leave the list rather than stand ready for the
  // next one somebody adds there
  it('keeps every exempted file to one that still carries the clause', () => {
    const exemptFilesStillCarryingTheClause =
      ON_CONFLICT_DO_UPDATE_EXEMPT_FILES.filter((relativePath) =>
        ON_CONFLICT_DO_UPDATE.test(
          fs.readFileSync(path.join(SERVER_SOURCE_ROOT, relativePath), 'utf-8'),
        ),
      );

    expect(exemptFilesStillCarryingTheClause).toEqual(
      ON_CONFLICT_DO_UPDATE_EXEMPT_FILES,
    );
  });

  it('keeps the clause out of the workspace record write path unconditionally', () => {
    const offenders = sourceFiles
      .filter((filePath) =>
        WORKSPACE_RECORD_WRITE_DIRECTORIES.some((directory) =>
          relativeToSource(filePath).startsWith(directory),
        ),
      )
      .filter((filePath) =>
        ON_CONFLICT_DO_UPDATE.test(fs.readFileSync(filePath, 'utf-8')),
      );

    expect(offenders.map(relativeToSource)).toEqual([]);
  });

  // A directory that stopped existing would make the check above pass by
  // scanning nothing
  it('finds the workspace record write path it scans', () => {
    for (const directory of WORKSPACE_RECORD_WRITE_DIRECTORIES) {
      expect(
        sourceFiles.filter((filePath) =>
          relativeToSource(filePath).startsWith(directory),
        ).length,
      ).toBeGreaterThan(0);
    }
  });
});
