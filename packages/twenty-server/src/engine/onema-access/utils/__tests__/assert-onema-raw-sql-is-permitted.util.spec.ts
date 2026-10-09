import {
  buildTestAccessScope,
  SALES_ROLE_UNIVERSAL_IDENTIFIER,
} from 'src/engine/onema-access/__tests__/utils/build-test-access-scope.util';
import { buildTestTableShape } from 'src/engine/onema-access/__tests__/utils/build-test-table-shape.util';
import { type OnemaAccessRules } from 'src/engine/onema-access/types/onema-access-rules.type';
import { assertOnemaRawSqlIsPermitted } from 'src/engine/onema-access/utils/assert-onema-raw-sql-is-permitted.util';
import { setOnemaAccessRulesForTesting } from 'src/engine/onema-access/utils/load-onema-access-rules.util';

const opportunityTableShape = buildTestTableShape({
  nameSingular: 'opportunity',
  columnNames: ['name', 'onemaStage'],
});

// An object of the same workspace that no key of the file names: upstream writes
// raw SQL for its own bookkeeping, and an object under no rule breaks no rule
const campaignDeliveryTableShape = buildTestTableShape({
  nameSingular: 'campaignDelivery',
  columnNames: ['state', 'claimToken'],
});

const governedRules: OnemaAccessRules = {
  roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
  objects: { opportunity: { sales: { all: true } } },
};

const assertPermitted = ({
  sql,
  tableShape = opportunityTableShape,
}: {
  sql: string;
  tableShape?: typeof opportunityTableShape;
}) =>
  assertOnemaRawSqlIsPermitted({
    scope: buildTestAccessScope({
      tableShape,
      tableShapes: [opportunityTableShape, campaignDeliveryTableShape],
    }),
    sql,
  });

describe('assertOnemaRawSqlIsPermitted', () => {
  afterEach(() => setOnemaAccessRulesForTesting(undefined));

  it('changes nothing while no rules file is configured', () => {
    setOnemaAccessRulesForTesting(undefined);

    expect(() =>
      assertPermitted({
        sql: 'UPDATE "workspace_test"."_opportunity" SET "onemaStage" = :p0',
      }),
    ).not.toThrow();
  });

  it('lets a plain read through', () => {
    setOnemaAccessRulesForTesting(governedRules);

    expect(() =>
      assertPermitted({
        sql: 'SELECT "id" FROM "workspace_test"."_opportunity" WHERE "id" = :p0',
      }),
    ).not.toThrow();
  });

  // The freeze of §12а Т-2 reads the row it compares exactly this way, and a
  // lock writes nothing
  it('lets a row lock through', () => {
    setOnemaAccessRulesForTesting(governedRules);

    expect(() =>
      assertPermitted({
        sql: 'SELECT * FROM "workspace_test"."_opportunity" WHERE "id" IN (:...ids) FOR UPDATE',
      }),
    ).not.toThrow();

    expect(() =>
      assertPermitted({
        sql: 'SELECT "id" FROM "workspace_test"."_opportunity" WHERE "id" = :p0 FOR NO KEY UPDATE',
      }),
    ).not.toThrow();
  });

  it.each([
    ['UPDATE "workspace_test"."_opportunity" SET "onemaStage" = :p0'],
    ['DELETE FROM "workspace_test"."_opportunity" WHERE "id" = :p0'],
    ['INSERT INTO "workspace_test"."_opportunity" ("id") VALUES (:p0)'],
    ['TRUNCATE "workspace_test"."_opportunity"'],
  ])('refuses %s on a governed object', (sql) => {
    setOnemaAccessRulesForTesting(governedRules);

    expect(() => assertPermitted({ sql })).toThrow(
      /would write outside every hook/,
    );
  });

  // The hole В3 names: the freeze, the protected fields and the check after the
  // write all hang off the repository's write paths, and a CTE like this one
  // passes none of them
  it('refuses a write hidden in a common table expression', () => {
    setOnemaAccessRulesForTesting(governedRules);

    expect(() =>
      assertPermitted({
        sql: 'WITH settled AS (UPDATE "workspace_test"."_opportunity" SET "onemaStage" = :p0 RETURNING "id") SELECT "id" FROM settled',
      }),
    ).toThrow(/would write outside every hook/);
  });

  it('refuses a second statement smuggled after a read', () => {
    setOnemaAccessRulesForTesting(governedRules);

    expect(() =>
      assertPermitted({
        sql: 'SELECT 1; DELETE FROM "workspace_test"."_opportunity" WHERE true',
      }),
    ).toThrow(/would write outside every hook/);
  });

  // Upstream settles a claimed delivery batch with a data-modifying CTE, and
  // that object is under no rule of ours — until it is, and then this refuses
  it('leaves an object no key of the file names alone', () => {
    setOnemaAccessRulesForTesting(governedRules);

    expect(() =>
      assertPermitted({
        sql: 'WITH settled AS (UPDATE "workspace_test"."_campaignDelivery" SET "state" = :p0 RETURNING "id") SELECT "id" FROM settled',
        tableShape: campaignDeliveryTableShape,
      }),
    ).not.toThrow();
  });

  it('refuses that same write once a rule names the object', () => {
    setOnemaAccessRulesForTesting({
      ...governedRules,
      application: 'onema-application',
      writeProtectedFields: { campaignDelivery: { state: [] } },
    });

    expect(() =>
      assertPermitted({
        sql: 'WITH settled AS (UPDATE "workspace_test"."_campaignDelivery" SET "state" = :p0 RETURNING "id") SELECT "id" FROM settled',
        tableShape: campaignDeliveryTableShape,
      }),
    ).toThrow(/would write outside every hook/);
  });

  // The hole the review named. The check used to ask which object the
  // repository was built for, which is a different question from which table
  // the statement writes: campaign delivery is governed by no rule of ours, and
  // its repository could write the opportunity table through this door.
  it('refuses a governed table written through an ungoverned repository', () => {
    setOnemaAccessRulesForTesting(governedRules);

    expect(() =>
      assertPermitted({
        sql: 'UPDATE "workspace_test"."_opportunity" SET "onemaStage" = :p0',
        tableShape: campaignDeliveryTableShape,
      }),
    ).toThrow(/"_opportunity" would write outside every hook/);
  });

  it('leaves an ungoverned table written through a governed repository alone', () => {
    setOnemaAccessRulesForTesting(governedRules);

    expect(() =>
      assertPermitted({
        sql: 'UPDATE "workspace_test"."_campaignDelivery" SET "state" = :p0',
      }),
    ).not.toThrow();
  });

  it.each([
    ['UPDATE "workspace_test"."_opportunity" SET "name" = :p0 FROM "x"'],
    ['UPDATE ONLY "workspace_test"."_opportunity" SET "name" = :p0'],
    ['MERGE INTO "workspace_test"."_opportunity" AS o USING "x" ON true'],
    [`COPY "workspace_test"."_opportunity" ("id") FROM STDIN`],
    ['DELETE FROM ONLY "workspace_test"."_opportunity" WHERE true'],
    [
      'TRUNCATE TABLE "workspace_test"."_campaignDelivery", "workspace_test"."_opportunity"',
    ],
  ])('reads the target table out of %s', (sql) => {
    setOnemaAccessRulesForTesting(governedRules);

    expect(() => assertPermitted({ sql })).toThrow(
      /would write outside every hook/,
    );
  });

  // The statement leaves the schema to the search path, so the table name alone
  // decides — which is the closed side of the question
  it('refuses a governed table named without its schema', () => {
    setOnemaAccessRulesForTesting(governedRules);

    expect(() =>
      assertPermitted({ sql: 'DELETE FROM "_opportunity" WHERE true' }),
    ).toThrow(/would write outside every hook/);
  });

  // `COPY … TO` reads, and reading is ONE-113's question, not this one
  it('lets a COPY that only reads through', () => {
    setOnemaAccessRulesForTesting(governedRules);

    expect(() =>
      assertPermitted({
        sql: 'COPY (SELECT "id" FROM "workspace_test"."_opportunity") TO STDOUT',
      }),
    ).not.toThrow();
  });

  // The body used to be cut out as a literal before the keywords were read,
  // which is exactly how a write hid from this check
  it('refuses a DO block that writes a governed table', () => {
    setOnemaAccessRulesForTesting(governedRules);

    expect(() =>
      assertPermitted({
        sql: 'DO $$ BEGIN UPDATE "workspace_test"."_opportunity" SET "onemaStage" = 1; END $$',
      }),
    ).toThrow(/a dollar-quoted body/);
  });

  // Whatever it writes, it writes somewhere this check cannot look, so there is
  // no reading of it that is safe
  it.each([
    ['DO $block$ BEGIN PERFORM 1; END $block$', /a dollar-quoted body/],
    ['CALL onema_settle_batch(:p0)', /a CALL/],
    ['EXECUTE settle_batch (:p0)', /an EXECUTE/],
  ])('refuses %s whatever table it names', (sql, reason) => {
    setOnemaAccessRulesForTesting(governedRules);

    expect(() => assertPermitted({ sql })).toThrow(reason);
  });

  // `ON CONFLICT DO NOTHING` is the insert path's own clause, not a DO block,
  // and the row it may touch is the one the INSERT already names
  it('does not read an ON CONFLICT clause as a block', () => {
    setOnemaAccessRulesForTesting(governedRules);

    expect(() =>
      assertPermitted({
        sql: 'INSERT INTO "workspace_test"."_campaignDelivery" ("id") VALUES (:p0) ON CONFLICT ("id") DO NOTHING',
      }),
    ).not.toThrow();
  });

  it('refuses an ON CONFLICT DO UPDATE on a governed table by its INSERT target', () => {
    setOnemaAccessRulesForTesting(governedRules);

    expect(() =>
      assertPermitted({
        sql: 'INSERT INTO "workspace_test"."_opportunity" ("id") VALUES (:p0) ON CONFLICT ("id") DO UPDATE SET "name" = :p1',
      }),
    ).toThrow(/"_opportunity" would write outside every hook/);
  });

  // A write this parser cannot attribute is refused rather than guessed at:
  // "probably nothing governed" is not an answer a closed-by-default check gives
  it('refuses a write whose target table it cannot read', () => {
    setOnemaAccessRulesForTesting(governedRules);

    expect(() => assertPermitted({ sql: 'UPDATE (:p0) SET "x" = 1' })).toThrow(
      /target table could not be read/,
    );
  });

  // The hole of review round 4: `U&"…"` is how Postgres spells an identifier
  // with escapes, and the regex this check used to read its target with stopped
  // at the `U` — it reported a write on a table called "u", found it under no
  // rule, and let the statement through to write the governed one.
  it.each([
    ['UPDATE U&"_opportunity" SET "onemaStage" = :p0'],
    ['UPDATE "workspace_test".U&"_opportunity" SET "onemaStage" = :p0'],
    ['UPDATE U&"\\005Fopportunity" SET "onemaStage" = :p0'],
    ['UPDATE U&"_opportunit\\+000079" SET "onemaStage" = :p0'],
    [`UPDATE U&"!005Fopportunity" UESCAPE '!' SET "onemaStage" = :p0`],
    ['DELETE FROM U&"\\0077orkspace_test".U&"_opportunity" WHERE true'],
    [
      'WITH settled AS (UPDATE U&"_opportunity" SET "onemaStage" = :p0 RETURNING "id") SELECT "id" FROM settled',
    ],
  ])('refuses %s on a governed object spelled with escapes', (sql) => {
    setOnemaAccessRulesForTesting(governedRules);

    expect(() => assertPermitted({ sql })).toThrow(
      /"_opportunity" would write outside every hook/,
    );
  });

  // And fail-closed for the rest: the decoding above is ours, not Postgres's, so
  // "this one decodes to a table no rule names" is not an answer worth passing
  it('refuses an ungoverned table spelled with escapes just the same', () => {
    setOnemaAccessRulesForTesting(governedRules);

    expect(() =>
      assertPermitted({
        sql: 'UPDATE U&"_campaignDelivery" SET "state" = :p0',
      }),
    ).toThrow(/Unicode-escaped identifier/);
  });

  // A doubled quote is one quote of the name, so the column it appears in must
  // not shift what the target reads as
  it('refuses a governed write whose column name carries a doubled quote', () => {
    setOnemaAccessRulesForTesting(governedRules);

    expect(() =>
      assertPermitted({
        sql: 'UPDATE "workspace_test"."_opportunity" SET "onema""Stage" = :p0',
      }),
    ).toThrow(/"_opportunity" would write outside every hook/);
  });

  // A string beside the target closes where Postgres closes it: an `E'…'` must
  // not swallow the statement, and a `$$…$$` is a body nothing here can read
  it.each([
    [
      `UPDATE "workspace_test"."_opportunity" SET "name" = E'\\\\' WHERE "id" = :p0`,
      /"_opportunity" would write outside every hook/,
    ],
    [
      `SELECT E'it''s'; DELETE FROM "workspace_test"."_opportunity" WHERE true`,
      /"_opportunity" would write outside every hook/,
    ],
    [
      'UPDATE "workspace_test"."_opportunity" SET "name" = $$ anything $$',
      /a dollar-quoted body/,
    ],
  ])('refuses %s', (sql, reason) => {
    setOnemaAccessRulesForTesting(governedRules);

    expect(() => assertPermitted({ sql })).toThrow(reason);
  });

  // Fail-closed on the forms this does not understand, rather than on the half
  // of the statement that happened to parse
  it.each([
    ['INSERT "workspace_test"."_campaignDelivery" ("id") VALUES (:p0)'],
    ['UPDATE SET "x" = 1'],
    ['COPY "workspace_test"."_campaignDelivery" ("id")'],
    ['TRUNCATE TABLE "workspace_test"."_campaignDelivery", (:p0)'],
  ])('refuses %s, whose target it cannot read', (sql) => {
    setOnemaAccessRulesForTesting(governedRules);

    expect(() => assertPermitted({ sql })).toThrow(
      /target table could not be read/,
    );
  });

  // The query of a `COPY … TO` may be a write with RETURNING, and that write is
  // as real as one at the top level
  it('refuses a governed write hidden in the query of a COPY that copies out', () => {
    setOnemaAccessRulesForTesting(governedRules);

    expect(() =>
      assertPermitted({
        sql: 'COPY (UPDATE "workspace_test"."_opportunity" SET "onemaStage" = :p0 RETURNING "id") TO STDOUT',
      }),
    ).toThrow(/"_opportunity" would write outside every hook/);
  });

  // A keyword inside a literal or a comment is text, not a statement
  it('reads past a keyword that is only text', () => {
    setOnemaAccessRulesForTesting(governedRules);

    expect(() =>
      assertPermitted({
        sql: `SELECT "id" FROM "workspace_test"."_opportunity" WHERE "name" = 'delete me' -- insert later`,
      }),
    ).not.toThrow();
  });

  it('reads past a column whose name merely starts like a keyword', () => {
    setOnemaAccessRulesForTesting(governedRules);

    expect(() =>
      assertPermitted({
        sql: 'SELECT "updatedAt", "deletedAt" FROM "workspace_test"."_opportunity"',
      }),
    ).not.toThrow();
  });

  // The bypass is not authority over an invariant (Б2), and raw SQL under it is
  // the most direct way around one there is
  it('refuses a raw write under the bypass just the same', () => {
    setOnemaAccessRulesForTesting(governedRules);

    expect(() =>
      assertOnemaRawSqlIsPermitted({
        scope: buildTestAccessScope({
          tableShape: opportunityTableShape,
          shouldBypassPermissionChecks: true,
        }),
        sql: 'DELETE FROM "workspace_test"."_opportunity" WHERE true',
      }),
    ).toThrow(/would write outside every hook/);
  });
});
