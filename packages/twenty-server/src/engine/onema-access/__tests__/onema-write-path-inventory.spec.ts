import fs from 'fs';
import path from 'path';

const SERVER_SOURCE_ROOT = path.join(__dirname, '../../..');
const INVENTORY_ROOT = path.join(__dirname, 'inventory');

// ONE-113, rls-design §2 and §10. Three lists of call sites that reach around
// the hook, kept as data next to this file so they can be regenerated with the
// commands in the module README rather than retyped. The check is not "these
// files are safe" — it is "this set has not changed since somebody looked".
//
// A failure here is not a bug to be made green: it says a path was added,
// moved or removed, and asks for the one review nothing else forces. The entry
// goes into the inventory together with the handover line that says why it is
// allowed to stay.
const INVENTORIES = [
  {
    // Raw SQL in runtime code. Statements built here pass none of the five
    // hooks, so a new one on a table the rules govern is a hole; `database/`
    // is left out on purpose — migrations and upgrade commands run offline,
    // under an operator, and are inventoried by the upgrade-command rules.
    name: 'raw SQL in runtime code',
    fileName: 'raw-sql-runtime-call-sites.txt',
    directories: ['engine', 'modules'],
    pattern: /\.query\s*[<(]/,
  },
  {
    // `shouldBypassPermissionChecks: true`. The one trusted bypass of record
    // visibility (README, "Умолчания"), and the one the release gate owed a
    // count of: write invariants stay on, visibility does not.
    name: 'permission bypass',
    fileName: 'permission-bypass-call-sites.txt',
    directories: ['engine', 'modules', 'database'],
    pattern: /shouldBypassPermissionChecks: true/,
  },
  {
    // `lite: true` workspace contexts. A lite context carries no role maps, so
    // the rules read every role as unknown and close every governed object —
    // no leak, but a silent full denial for whatever runs in one.
    name: 'lite workspace context',
    fileName: 'lite-workspace-context-call-sites.txt',
    directories: ['engine', 'modules'],
    pattern: /lite: true/,
  },
];

// The objects the rules file governs. Nothing in the inventories above may name
// their tables: a standard object is its own name, ours carry the custom prefix
// (compute-table-name.util.ts).
const EXAMPLE_RULES_PATH = path.join(
  SERVER_SOURCE_ROOT,
  '../onema/access-rules.example.json',
);

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

const readInventory = (fileName: string): string[] =>
  fs
    .readFileSync(path.join(INVENTORY_ROOT, fileName), 'utf-8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

const findCallSites = ({
  directories,
  pattern,
}: {
  directories: string[];
  pattern: RegExp;
}): string[] =>
  directories
    .flatMap((directory) =>
      listSourceFiles(path.join(SERVER_SOURCE_ROOT, directory)),
    )
    .filter((filePath) => pattern.test(fs.readFileSync(filePath, 'utf-8')))
    .map(relativeToSource)
    .sort();

describe('onema write path inventory', () => {
  it.each(INVENTORIES)(
    'finds exactly the inventoried call sites of $name',
    ({ fileName, directories, pattern }) => {
      const inventoried = readInventory(fileName);
      const found = findCallSites({ directories, pattern });

      expect(
        found.filter((filePath) => !inventoried.includes(filePath)),
      ).toEqual([]);
      expect(
        inventoried.filter((filePath) => !found.includes(filePath)),
      ).toEqual([]);
    },
  );

  it.each(INVENTORIES)(
    'has something to inventory for $name',
    ({ fileName }) => {
      expect(readInventory(fileName).length).toBeGreaterThan(10);
    },
  );

  // The question the three lists exist to answer: does anything reach a table
  // the rules govern without going through the hook? A quoted name is enough to
  // fail on — but only a quoted one: `objectName: 'company'` in a prefilled
  // workflow step is not a table, while every statement this codebase writes
  // escapes its identifiers (`escapeIdentifier`), so a governed table appears
  // as `"company"` or `"_company"` and nothing else. A table named through a
  // helper is invisible to this check; what catches that one is the inventory
  // above noticing the file at all.
  it('keeps the tables the rules govern out of every raw SQL call site', () => {
    const rules = JSON.parse(fs.readFileSync(EXAMPLE_RULES_PATH, 'utf-8'));
    const governedObjectNames: string[] = [
      ...new Set([...rules.requiredObjects, ...Object.keys(rules.objects)]),
    ];

    expect(governedObjectNames.length).toBeGreaterThan(0);

    const governedTablePattern = new RegExp(
      `"_?(${governedObjectNames.join('|')})"`,
    );

    const offenders = readInventory('raw-sql-runtime-call-sites.txt').filter(
      (relativePath) =>
        governedTablePattern.test(
          fs.readFileSync(path.join(SERVER_SOURCE_ROOT, relativePath), 'utf-8'),
        ),
    );

    expect(offenders).toEqual([]);
  });
});
