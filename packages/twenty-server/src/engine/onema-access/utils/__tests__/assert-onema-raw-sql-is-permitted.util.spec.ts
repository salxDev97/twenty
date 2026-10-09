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
