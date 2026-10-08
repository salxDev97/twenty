import {
  buildTestAccessScope,
  CEO_ROLE_UNIVERSAL_IDENTIFIER,
  ceoAuthContext,
  apiKeyAuthContext,
  SALES_ROLE_UNIVERSAL_IDENTIFIER,
  WORKSPACE_MEMBER_ID,
} from 'src/engine/onema-access/__tests__/utils/build-test-access-scope.util';
import { buildTestTableShape } from 'src/engine/onema-access/__tests__/utils/build-test-table-shape.util';
import { type OnemaAccessRules } from 'src/engine/onema-access/types/onema-access-rules.type';
import { applyOnemaOwnerDefaults } from 'src/engine/onema-access/utils/apply-onema-owner-defaults.util';
import { setOnemaAccessRulesForTesting } from 'src/engine/onema-access/utils/load-onema-access-rules.util';

const opportunityTableShape = buildTestTableShape({
  nameSingular: 'opportunity',
  columnNames: ['name'],
  joinColumnNameByFieldName: { owner: 'ownerId' },
});

const scope = buildTestAccessScope({ tableShape: opportunityTableShape });

const ownedByMeRules: OnemaAccessRules = {
  roles: {
    sales: SALES_ROLE_UNIVERSAL_IDENTIFIER,
    ceo: CEO_ROLE_UNIVERSAL_IDENTIFIER,
  },
  objects: {
    opportunity: {
      sales: { eq: ['owner', '$me'] },
      ceo: { all: true },
    },
  },
};

describe('applyOnemaOwnerDefaults', () => {
  afterEach(() => setOnemaAccessRulesForTesting(undefined));

  it('changes nothing while no rules file is configured', () => {
    setOnemaAccessRulesForTesting(undefined);

    expect(
      applyOnemaOwnerDefaults({ scope, records: [{ name: 'A lead' }] }),
    ).toBeUndefined();
  });

  it('fills the owner the rule reads as "$me" when the record leaves it empty', () => {
    setOnemaAccessRulesForTesting(ownedByMeRules);

    expect(
      applyOnemaOwnerDefaults({ scope, records: [{ name: 'A lead' }] }),
    ).toEqual([{ name: 'A lead', ownerId: WORKSPACE_MEMBER_ID }]);
  });

  it('leaves an owner the caller named alone, by either spelling', () => {
    setOnemaAccessRulesForTesting(ownedByMeRules);

    expect(
      applyOnemaOwnerDefaults({
        scope,
        records: [
          { name: 'By join column', ownerId: 'somebody-else' },
          { name: 'By field name', owner: 'somebody-else' },
        ],
      }),
    ).toBeUndefined();
  });

  // An explicit null is "nobody owns this", which is exactly the record that
  // would vanish from its own author
  it('treats an explicit null owner as empty', () => {
    setOnemaAccessRulesForTesting(ownedByMeRules);

    expect(
      applyOnemaOwnerDefaults({
        scope,
        records: [{ name: 'A lead', ownerId: null }],
      }),
    ).toEqual([{ name: 'A lead', ownerId: WORKSPACE_MEMBER_ID }]);
  });

  // A role that already sees every record of the object does not need an owner
  // to find what it created, and handing it one would assign ownership silently
  it('substitutes nothing for a role the rules open entirely', () => {
    setOnemaAccessRulesForTesting(ownedByMeRules);

    expect(
      applyOnemaOwnerDefaults({
        scope: buildTestAccessScope({
          tableShape: opportunityTableShape,
          authContext: ceoAuthContext,
        }),
        records: [{ name: 'A lead' }],
      }),
    ).toBeUndefined();
  });

  it('substitutes nothing when "$me" is unknown', () => {
    setOnemaAccessRulesForTesting(ownedByMeRules);

    expect(
      applyOnemaOwnerDefaults({
        scope: buildTestAccessScope({
          tableShape: opportunityTableShape,
          authContext: apiKeyAuthContext,
        }),
        records: [{ name: 'A lead' }],
      }),
    ).toBeUndefined();
  });

  it('substitutes nothing when the object carries no rule at all', () => {
    setOnemaAccessRulesForTesting({
      roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
      objects: {},
    });

    expect(
      applyOnemaOwnerDefaults({ scope, records: [{ name: 'A lead' }] }),
    ).toBeUndefined();
  });

  // "Mine, or watched by me" has no single owner a new record should get, and
  // guessing one would hand out ownership the file never asked for
  it('substitutes nothing when the rule is more than a plain owner equality', () => {
    setOnemaAccessRulesForTesting({
      roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
      objects: {
        opportunity: {
          sales: {
            or: [{ eq: ['owner', '$me'] }, { eq: ['name', 'public lead'] }],
          },
        },
      },
    });

    expect(
      applyOnemaOwnerDefaults({ scope, records: [{ name: 'A lead' }] }),
    ).toBeUndefined();
  });

  it('refuses the write when the rules file stopped being usable', () => {
    setOnemaAccessRulesForTesting({
      roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
      objects: { opportuntiy: { sales: { all: true } } },
    });

    expect(() =>
      applyOnemaOwnerDefaults({ scope, records: [{ name: 'A lead' }] }),
    ).toThrow(/Onema access rules refuse this write/);
  });

  it('does nothing for a caller holding the explicit bypass', () => {
    setOnemaAccessRulesForTesting(ownedByMeRules);

    expect(
      applyOnemaOwnerDefaults({
        scope: buildTestAccessScope({
          tableShape: opportunityTableShape,
          shouldBypassPermissionChecks: true,
        }),
        records: [{ name: 'A lead' }],
      }),
    ).toBeUndefined();
  });
});
