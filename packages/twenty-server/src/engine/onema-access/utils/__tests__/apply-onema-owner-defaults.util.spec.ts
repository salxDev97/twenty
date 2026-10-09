import {
  apiKeyAuthContext,
  buildTestAccessScope,
  CEO_ROLE_UNIVERSAL_IDENTIFIER,
  ceoAuthContext,
  multiRoleAuthContext,
  SALES_ROLE_UNIVERSAL_IDENTIFIER,
  WORKSPACE_MEMBER_ID,
} from 'src/engine/onema-access/__tests__/utils/build-test-access-scope.util';
import { buildTestTableShape } from 'src/engine/onema-access/__tests__/utils/build-test-table-shape.util';
import { type OnemaAccessRules } from 'src/engine/onema-access/types/onema-access-rules.type';
import { applyOnemaOwnerDefaults } from 'src/engine/onema-access/utils/apply-onema-owner-defaults.util';
import { setOnemaAccessRulesForTesting } from 'src/engine/onema-access/utils/load-onema-access-rules.util';

const workspaceMemberTableShape = buildTestTableShape({
  nameSingular: 'workspaceMember',
});

const opportunityTableShape = buildTestTableShape({
  nameSingular: 'opportunity',
  columnNames: ['name'],
  joinColumnNameByFieldName: { owner: 'ownerId', coOwner: 'coOwnerId' },
  relationTargetByFieldName: {
    owner: 'workspaceMember',
    coOwner: 'workspaceMember',
  },
});

const buildScope = (
  overrides: Partial<Parameters<typeof buildTestAccessScope>[0]> = {},
) =>
  buildTestAccessScope({
    tableShape: opportunityTableShape,
    tableShapes: [opportunityTableShape, workspaceMemberTableShape],
    ...overrides,
  });

const scope = buildScope();

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
  ownerDefaults: { opportunity: { sales: 'owner' } },
};

describe('applyOnemaOwnerDefaults', () => {
  afterEach(() => setOnemaAccessRulesForTesting(undefined));

  it('changes nothing while no rules file is configured', () => {
    setOnemaAccessRulesForTesting(undefined);

    expect(
      applyOnemaOwnerDefaults({ scope, records: [{ name: 'A lead' }] }),
    ).toBeUndefined();
  });

  it('fills the owner the file names when the record leaves it empty', () => {
    setOnemaAccessRulesForTesting(ownedByMeRules);

    expect(
      applyOnemaOwnerDefaults({ scope, records: [{ name: 'A lead' }] }),
    ).toEqual([{ name: 'A lead', ownerId: WORKSPACE_MEMBER_ID }]);
  });

  // An explicit null is a record nobody owns, which under the rule that names
  // the default is a record its own author cannot see — so the default stands
  // and the write succeeds, rather than being refused by the check after it
  it.each([['owner'], ['ownerId']])(
    'fills the owner over an explicit null written as "%s"',
    (spelling) => {
      setOnemaAccessRulesForTesting(ownedByMeRules);

      expect(
        applyOnemaOwnerDefaults({
          scope,
          records: [{ name: 'A lead', [spelling]: null }],
        }),
      ).toEqual([
        { name: 'A lead', [spelling]: null, ownerId: WORKSPACE_MEMBER_ID },
      ]);
    },
  );

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

  // A role that already sees every record of the object is named by no owner
  // default, so it gets none — and ownership is never assigned silently
  it('substitutes nothing for a role the rules open entirely', () => {
    setOnemaAccessRulesForTesting(ownedByMeRules);

    expect(
      applyOnemaOwnerDefaults({
        scope: buildScope({ authContext: ceoAuthContext }),
        records: [{ name: 'A lead' }],
      }),
    ).toBeUndefined();
  });

  // Reading the default off the rule used to mean two roles answered "owner"
  // and "everything", which is two answers, and the owner silently disappeared —
  // leaving the record invisible to the very person who had just created it
  it('still fills the owner for a person who also holds a role seeing everything', () => {
    setOnemaAccessRulesForTesting(ownedByMeRules);

    expect(
      applyOnemaOwnerDefaults({
        scope: buildScope({ authContext: multiRoleAuthContext }),
        records: [{ name: 'A lead' }],
      }),
    ).toEqual([{ name: 'A lead', ownerId: WORKSPACE_MEMBER_ID }]);
  });

  // Two named roles pointing at two owner fields have no single answer, and the
  // check after the write refuses the creation loudly instead
  it('substitutes nothing when two roles of the holder name two owner fields', () => {
    setOnemaAccessRulesForTesting({
      roles: {
        sales: SALES_ROLE_UNIVERSAL_IDENTIFIER,
        ceo: CEO_ROLE_UNIVERSAL_IDENTIFIER,
      },
      objects: {
        opportunity: {
          sales: { eq: ['owner', '$me'] },
          ceo: { eq: ['coOwner', '$me'] },
        },
      },
      ownerDefaults: { opportunity: { sales: 'owner', ceo: 'coOwner' } },
    });

    expect(
      applyOnemaOwnerDefaults({
        scope: buildScope({ authContext: multiRoleAuthContext }),
        records: [{ name: 'A lead' }],
      }),
    ).toBeUndefined();
  });

  it('substitutes nothing when "$me" is unknown', () => {
    setOnemaAccessRulesForTesting(ownedByMeRules);

    expect(
      applyOnemaOwnerDefaults({
        scope: buildScope({ authContext: apiKeyAuthContext }),
        records: [{ name: 'A lead' }],
      }),
    ).toBeUndefined();
  });

  // The hole С1 names: `assignee`, `projectManager` and any future service field
  // written as "mine" used to be filled with the current participant on their
  // own, because the rule looked exactly like an owner rule
  it('substitutes nothing for a rule that reads as "$me" without being declared an owner', () => {
    setOnemaAccessRulesForTesting({
      roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
      objects: { opportunity: { sales: { eq: ['owner', '$me'] } } },
    });

    expect(
      applyOnemaOwnerDefaults({ scope, records: [{ name: 'A lead' }] }),
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
        scope: buildScope({ shouldBypassPermissionChecks: true }),
        records: [{ name: 'A lead' }],
      }),
    ).toBeUndefined();
  });
});
