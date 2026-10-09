import {
  applicationAuthContext,
  buildTestAccessScope,
  SALES_ROLE_UNIVERSAL_IDENTIFIER,
  systemAuthContext,
} from 'src/engine/onema-access/__tests__/utils/build-test-access-scope.util';
import { buildTestTableShape } from 'src/engine/onema-access/__tests__/utils/build-test-table-shape.util';
import { type OnemaAccessRules } from 'src/engine/onema-access/types/onema-access-rules.type';
import {
  assertOnemaFrozenFieldsAreUnchanged,
  type OnemaFrozenFieldUpdate,
} from 'src/engine/onema-access/utils/assert-onema-frozen-fields-are-unchanged.util';
import { setOnemaAccessRulesForTesting } from 'src/engine/onema-access/utils/load-onema-access-rules.util';
import { type WorkspaceAuthContext } from 'src/engine/core-modules/auth/types/workspace-auth-context.type';

const opportunityTableShape = buildTestTableShape({
  nameSingular: 'opportunity',
  columnNames: ['name', 'onemaStage', 'onemaContractFiles'],
  joinColumnNameByFieldName: { company: 'companyId' },
});

const dealIsFinalRules: OnemaAccessRules = {
  roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
  objects: { opportunity: { sales: { all: true } } },
  freezeWhen: {
    opportunity: [
      {
        field: 'onemaStage',
        equals: 'DEAL',
        fields: ['company', 'onemaContractFiles'],
      },
    ],
  },
};

const assertUnchanged = ({
  updates,
  authContext,
}: {
  updates: OnemaFrozenFieldUpdate[];
  authContext?: WorkspaceAuthContext;
}) =>
  assertOnemaFrozenFieldsAreUnchanged({
    scope: buildTestAccessScope({
      tableShape: opportunityTableShape,
      authContext,
    }),
    updates,
  });

const dealBefore = {
  id: 'opportunity-1',
  onemaStage: 'DEAL',
  companyId: 'company-1',
  onemaContractFiles: [{ fileId: 'file-1' }],
};

describe('assertOnemaFrozenFieldsAreUnchanged', () => {
  afterEach(() => setOnemaAccessRulesForTesting(undefined));

  it('changes nothing while no rules file is configured', () => {
    setOnemaAccessRulesForTesting(undefined);

    expect(() =>
      assertUnchanged({
        updates: [
          { rawRecordBefore: dealBefore, setColumns: { companyId: 'other' } },
        ],
      }),
    ).not.toThrow();
  });

  it('refuses a frozen relation once the condition holds', () => {
    setOnemaAccessRulesForTesting(dealIsFinalRules);

    expect(() =>
      assertUnchanged({
        updates: [
          {
            rawRecordBefore: dealBefore,
            setColumns: { companyId: 'company-2' },
          },
        ],
      }),
    ).toThrow(/"opportunity\.company" is frozen while "onemaStage" is "DEAL"/);
  });

  // The whole point of Т-2: the file count and the signature date stay put, so
  // a rule that only sees the state after the write finds nothing wrong
  it('refuses a swapped contract file that keeps the shape of the old one', () => {
    setOnemaAccessRulesForTesting(dealIsFinalRules);

    expect(() =>
      assertUnchanged({
        updates: [
          {
            rawRecordBefore: dealBefore,
            setColumns: { onemaContractFiles: [{ fileId: 'file-2' }] },
          },
        ],
      }),
    ).toThrow(/opportunity\.onemaContractFiles/);
  });

  it('allows a frozen field while the condition does not hold yet', () => {
    setOnemaAccessRulesForTesting(dealIsFinalRules);

    expect(() =>
      assertUnchanged({
        updates: [
          {
            rawRecordBefore: { ...dealBefore, onemaStage: 'PROPOSAL' },
            setColumns: { companyId: 'company-2', onemaStage: 'DEAL' },
          },
        ],
      }),
    ).not.toThrow();
  });

  it('allows a field the rules do not freeze', () => {
    setOnemaAccessRulesForTesting(dealIsFinalRules);

    expect(() =>
      assertUnchanged({
        updates: [
          { rawRecordBefore: dealBefore, setColumns: { name: 'Renamed' } },
        ],
      }),
    ).not.toThrow();
  });

  // A client that sends the whole record back writes every field, including the
  // frozen ones, with the values they already hold
  it('allows a frozen field rewritten with the value it already holds', () => {
    setOnemaAccessRulesForTesting(dealIsFinalRules);

    expect(() =>
      assertUnchanged({
        updates: [
          {
            rawRecordBefore: dealBefore,
            setColumns: {
              companyId: 'company-1',
              onemaContractFiles: [{ fileId: 'file-1' }],
            },
          },
        ],
      }),
    ).not.toThrow();
  });

  // A field that something may still change is not frozen
  it('refuses our own application just the same', () => {
    setOnemaAccessRulesForTesting(dealIsFinalRules);

    expect(() =>
      assertUnchanged({
        updates: [
          {
            rawRecordBefore: dealBefore,
            setColumns: { companyId: 'company-2' },
          },
        ],
        authContext: applicationAuthContext,
      }),
    ).toThrow(/opportunity\.company/);
  });

  it('refuses every write while the rules file is unusable', () => {
    setOnemaAccessRulesForTesting({
      roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
      objects: { opportuntiy: { sales: { all: true } } },
    });

    expect(() =>
      assertUnchanged({
        updates: [{ rawRecordBefore: dealBefore, setColumns: { name: 'x' } }],
      }),
    ).toThrow(/Onema access rules refuse this write/);
  });

  // A frozen field is an invariant of the product, not a permission of the
  // caller, so a worker holding the bypass is no exception either (Б2)
  it('refuses a worker holding the bypass just the same', () => {
    setOnemaAccessRulesForTesting(dealIsFinalRules);

    expect(() =>
      assertOnemaFrozenFieldsAreUnchanged({
        scope: buildTestAccessScope({
          tableShape: opportunityTableShape,
          authContext: systemAuthContext,
          shouldBypassPermissionChecks: true,
        }),
        updates: [
          {
            rawRecordBefore: dealBefore,
            setColumns: { companyId: 'company-2' },
          },
        ],
      }),
    ).toThrow(/opportunity\.company/);
  });

  it('leaves an unfrozen field alone under the bypass', () => {
    setOnemaAccessRulesForTesting(dealIsFinalRules);

    expect(() =>
      assertOnemaFrozenFieldsAreUnchanged({
        scope: buildTestAccessScope({
          tableShape: opportunityTableShape,
          authContext: systemAuthContext,
          shouldBypassPermissionChecks: true,
        }),
        updates: [
          { rawRecordBefore: dealBefore, setColumns: { name: 'Renamed' } },
        ],
      }),
    ).not.toThrow();
  });
});
