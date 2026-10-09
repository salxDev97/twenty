import {
  buildTestAccessScope,
  SALES_ROLE_UNIVERSAL_IDENTIFIER,
} from 'src/engine/onema-access/__tests__/utils/build-test-access-scope.util';
import { buildTestTableShape } from 'src/engine/onema-access/__tests__/utils/build-test-table-shape.util';
import { ONEMA_RECORD_ID_BATCH_SIZE } from 'src/engine/onema-access/constants/onema-access.constants';
import { type OnemaAccessRules } from 'src/engine/onema-access/types/onema-access-rules.type';
import { setOnemaAccessRulesForTesting } from 'src/engine/onema-access/utils/load-onema-access-rules.util';
import { lockOnemaGuardedRecordsForUpdate } from 'src/engine/onema-access/utils/lock-onema-guarded-records.util';

const opportunityTableShape = buildTestTableShape({
  nameSingular: 'opportunity',
  columnNames: ['name', 'onemaStage'],
  joinColumnNameByFieldName: { company: 'companyId' },
});

const scope = buildTestAccessScope({ tableShape: opportunityTableShape });

const dealIsFinalRules: OnemaAccessRules = {
  roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
  objects: { opportunity: { sales: { all: true } } },
  freezeWhen: {
    opportunity: [{ field: 'onemaStage', equals: 'DEAL', fields: ['company'] }],
  },
};

describe('lockOnemaGuardedRecordsForUpdate', () => {
  afterEach(() => setOnemaAccessRulesForTesting(undefined));

  it('changes nothing while no rules file is configured', async () => {
    setOnemaAccessRulesForTesting(undefined);

    const executeRaw = jest.fn();

    expect(
      await lockOnemaGuardedRecordsForUpdate({
        scope,
        recordIds: ['opportunity-1'],
        executeRaw,
      }),
    ).toBeUndefined();
    expect(executeRaw).not.toHaveBeenCalled();
  });

  // A lock protecting no comparison is only contention
  it('locks nothing for an object the rules neither freeze nor gate by transition', async () => {
    setOnemaAccessRulesForTesting({
      roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
      objects: { opportunity: { sales: { all: true } } },
    });

    const executeRaw = jest.fn();

    expect(
      await lockOnemaGuardedRecordsForUpdate({
        scope,
        recordIds: ['opportunity-1'],
        executeRaw,
      }),
    ).toBeUndefined();
    expect(executeRaw).not.toHaveBeenCalled();
  });

  // hardening.md п. 3–5: a transition graph needs the same lock as a freeze,
  // with no freezeWhen rule in sight
  it('takes a row lock for an object gated by a transition graph alone', async () => {
    setOnemaAccessRulesForTesting({
      roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
      objects: { opportunity: { sales: { all: true } } },
      transitions: {
        opportunity: {
          field: 'onemaStage',
          rules: [{ from: null, to: ['DRAFT'], roleKeys: ['sales'] }],
        },
      },
    });

    const executeRaw = jest
      .fn()
      .mockResolvedValue([{ id: 'opportunity-1', onemaStage: null }]);

    const lockedRecordsById = await lockOnemaGuardedRecordsForUpdate({
      scope,
      recordIds: ['opportunity-1'],
      executeRaw,
    });

    expect(executeRaw.mock.calls[0][0]).toMatch(/FOR UPDATE$/);
    expect(lockedRecordsById?.get('opportunity-1')).toEqual({
      id: 'opportunity-1',
      onemaStage: null,
    });
  });

  it('takes a row lock and answers with the state read under it', async () => {
    setOnemaAccessRulesForTesting(dealIsFinalRules);

    const executeRaw = jest
      .fn()
      .mockResolvedValue([
        { id: 'opportunity-1', onemaStage: 'DEAL', companyId: 'company-1' },
      ]);

    const lockedRecordsById = await lockOnemaGuardedRecordsForUpdate({
      scope,
      recordIds: ['opportunity-1'],
      executeRaw,
    });

    const [sql, parameters] = executeRaw.mock.calls[0];

    expect(sql).toMatch(/FOR UPDATE$/);
    expect(sql).toMatch(/"workspace_test"\."_opportunity"/);
    expect(Object.values(parameters)[0]).toEqual(['opportunity-1']);
    expect(lockedRecordsById?.get('opportunity-1')).toEqual({
      id: 'opportunity-1',
      onemaStage: 'DEAL',
      companyId: 'company-1',
    });
  });

  // С3: every id is a bind parameter, and an update by filter has no small
  // bound on how many there are
  it('locks in batches rather than one statement', async () => {
    setOnemaAccessRulesForTesting(dealIsFinalRules);

    const recordIds = Array.from(
      { length: ONEMA_RECORD_ID_BATCH_SIZE + 1 },
      (_unused, index) => `opportunity-${index}`,
    );
    const executeRaw = jest.fn().mockResolvedValue([]);

    await lockOnemaGuardedRecordsForUpdate({ scope, recordIds, executeRaw });

    expect(executeRaw).toHaveBeenCalledTimes(2);
    expect(Object.values(executeRaw.mock.calls[0][1])[0]).toHaveLength(
      ONEMA_RECORD_ID_BATCH_SIZE,
    );
    expect(Object.values(executeRaw.mock.calls[1][1])[0]).toHaveLength(1);
  });

  it('refuses the write while the rules file is unusable', async () => {
    setOnemaAccessRulesForTesting({
      roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
      objects: { opportuntiy: { sales: { all: true } } },
    });

    await expect(
      lockOnemaGuardedRecordsForUpdate({
        scope,
        recordIds: ['opportunity-1'],
        executeRaw: jest.fn(),
      }),
    ).rejects.toThrow(/Onema access rules refuse this write/);
  });
});
