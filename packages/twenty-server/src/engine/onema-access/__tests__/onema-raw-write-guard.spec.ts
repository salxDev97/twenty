import fs from 'fs';
import path from 'path';

const SERVER_SOURCE_ROOT = path.join(__dirname, '../../..');

// The one file allowed to write through the audited raw executor. Adding a
// second one means a new write path, and a new write path has to carry the
// hooks of rls-design §3.2–§3.3 and §12а — which is the review this list forces.
const AUDITED_RAW_WRITE_FILES = [
  'engine/twenty-orm/repository/workspace-repository.ts',
];

// `ON CONFLICT DO UPDATE` on a workspace record would update a row the insert
// path never read, so the freeze would compare nothing and the check after the
// write would never see it. ORM v2 builds `DO NOTHING` only, and this keeps it
// that way: a DO UPDATE has to come with its own pre-image and post-check.
const SQL_BUILDER_DIRECTORY = 'engine/twenty-orm/sql';

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

      return entry.isFile() && entry.name.endsWith('.ts') ? [entryPath] : [];
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

  it('keeps ON CONFLICT DO UPDATE out of the workspace record statements', () => {
    const offenders = sourceFiles
      .filter((filePath) =>
        relativeToSource(filePath).startsWith(SQL_BUILDER_DIRECTORY),
      )
      .filter((filePath) =>
        /ON\s+CONFLICT[\s\S]{0,80}?DO\s+UPDATE/i.test(
          fs.readFileSync(filePath, 'utf-8'),
        ),
      );

    expect(offenders.map(relativeToSource)).toEqual([]);
  });
});
