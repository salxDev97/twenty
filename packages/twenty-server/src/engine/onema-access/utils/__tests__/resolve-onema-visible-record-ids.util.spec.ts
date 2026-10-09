import {
  buildTestAccessScope,
  ceoAuthContext,
  salesAuthContext,
  SALES_ROLE_ID,
  SALES_ROLE_UNIVERSAL_IDENTIFIER,
  CEO_ROLE_ID,
  CEO_ROLE_UNIVERSAL_IDENTIFIER,
  WORKSPACE_MEMBER_ID,
} from 'src/engine/onema-access/__tests__/utils/build-test-access-scope.util';
import { buildTestTableShape } from 'src/engine/onema-access/__tests__/utils/build-test-table-shape.util';
import { type OnemaAccessRules } from 'src/engine/onema-access/types/onema-access-rules.type';
import { resetOnemaParameterNamespaceForTesting } from 'src/engine/onema-access/utils/compile-onema-row-access.util';
import { setOnemaAccessRulesForTesting } from 'src/engine/onema-access/utils/load-onema-access-rules.util';
import { buildOnemaAccessSubject } from 'src/engine/onema-access/utils/resolve-onema-access-subject.util';
import { resolveOnemaVisibleRecordIds } from 'src/engine/onema-access/utils/resolve-onema-visible-record-ids.util';

const opportunityTableShape = buildTestTableShape({
  nameSingular: 'opportunity',
  joinColumnNameByFieldName: { owner: 'ownerId' },
});

const rules: OnemaAccessRules = {
  roles: {
    sales: SALES_ROLE_UNIVERSAL_IDENTIFIER,
    ceo: CEO_ROLE_UNIVERSAL_IDENTIFIER,
  },
  requiredObjects: ['opportunity'],
  objects: {
    opportunity: {
      sales: { eq: ['owner', '$me'] },
      ceo: { all: true },
    },
  },
};

const scope = buildTestAccessScope({ tableShape: opportunityTableShape });

const flatRoleMaps = scope.internalContext.flatRoleMaps;

describe('resolveOnemaVisibleRecordIds', () => {
  beforeEach(() => resetOnemaParameterNamespaceForTesting());

  afterEach(() => setOnemaAccessRulesForTesting(undefined));

  it('asks the database nothing when no rules file is configured', async () => {
    setOnemaAccessRulesForTesting(undefined);

    const executeRaw = jest.fn();

    const visibleRecordIds = await resolveOnemaVisibleRecordIds({
      scope,
      recordIds: ['record-1'],
      executeRaw,
    });

    expect(visibleRecordIds).toBeUndefined();
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it('keeps only the ids the rule of the subscriber returns', async () => {
    setOnemaAccessRulesForTesting(rules);

    const executeRaw = jest.fn().mockResolvedValue([{ id: 'record-1' }]);

    const visibleRecordIds = await resolveOnemaVisibleRecordIds({
      scope,
      recordIds: ['record-1', 'record-2'],
      executeRaw,
    });

    expect(visibleRecordIds).toEqual(new Set(['record-1']));

    const [sql, parameters] = executeRaw.mock.calls[0];

    expect(sql).toContain(
      'FROM "workspace_test"."_opportunity" AS "opportunity"',
    );
    expect(sql).toContain(
      '"opportunity"."id" IN (:...onemaCandidateRecordIds)',
    );
    expect(sql).toContain('"opportunity"."ownerId" =');
    expect(parameters.onemaCandidateRecordIds).toEqual([
      'record-1',
      'record-2',
    ]);
    expect(Object.values(parameters)).toContain(WORKSPACE_MEMBER_ID);
  });

  // rls-design §4: the subscriber of a stream is not the actor whose write the
  // event is about, so the roles the publisher resolved have to win over the
  // auth context the repository happens to carry
  it('reads the roles of the passed subject, not of the auth context', async () => {
    setOnemaAccessRulesForTesting(rules);

    const executeRaw = jest.fn().mockResolvedValue([]);

    const visibleRecordIds = await resolveOnemaVisibleRecordIds({
      scope: {
        ...scope,
        authContext: salesAuthContext,
        subject: buildOnemaAccessSubject({
          roleIds: [CEO_ROLE_ID],
          workspaceMemberId: undefined,
          flatRoleMaps,
        }),
      },
      recordIds: ['record-1'],
      executeRaw,
    });

    // The CEO rule is `all`, so there is nothing to narrow and nothing to ask
    expect(visibleRecordIds).toBeUndefined();
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it('closes everything for a subject whose role the rules do not name', async () => {
    setOnemaAccessRulesForTesting(rules);

    const executeRaw = jest.fn();

    const visibleRecordIds = await resolveOnemaVisibleRecordIds({
      scope: {
        ...scope,
        authContext: ceoAuthContext,
        subject: buildOnemaAccessSubject({
          roleIds: ['some-role-nobody-declared'],
          workspaceMemberId: WORKSPACE_MEMBER_ID,
          flatRoleMaps,
        }),
      },
      recordIds: ['record-1'],
      executeRaw,
    });

    expect(visibleRecordIds).toEqual(new Set());
    expect(executeRaw).not.toHaveBeenCalled();
  });

  // Rules that do not match the workspace close the stream rather than falling
  // back to upstream permissions, exactly as they close a query (ADR-003)
  it('closes everything when the rules do not match this workspace', async () => {
    setOnemaAccessRulesForTesting({
      ...rules,
      roles: { ...rules.roles, ghost: 'onema-role-that-does-not-exist' },
      objects: {
        opportunity: {
          ...rules.objects.opportunity,
          ghost: { all: true },
        },
      },
    });

    const executeRaw = jest.fn();

    const visibleRecordIds = await resolveOnemaVisibleRecordIds({
      scope,
      recordIds: ['record-1'],
      executeRaw,
    });

    expect(visibleRecordIds).toEqual(new Set());
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it('batches the ids rather than binding every one of them at once', async () => {
    setOnemaAccessRulesForTesting(rules);

    const recordIds = Array.from(
      { length: 501 },
      (_, index) => `record-${index}`,
    );
    const executeRaw = jest.fn().mockResolvedValue([]);

    await resolveOnemaVisibleRecordIds({
      scope: {
        ...scope,
        subject: buildOnemaAccessSubject({
          roleIds: [SALES_ROLE_ID],
          workspaceMemberId: WORKSPACE_MEMBER_ID,
          flatRoleMaps,
        }),
      },
      recordIds,
      executeRaw,
    });

    expect(executeRaw).toHaveBeenCalledTimes(2);
    expect(executeRaw.mock.calls[1][1].onemaCandidateRecordIds).toEqual([
      'record-500',
    ]);
  });
});
