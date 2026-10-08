import {
  apiKeyAuthContext,
  buildTestAccessScope,
  SALES_ROLE_UNIVERSAL_IDENTIFIER,
  WORKSPACE_MEMBER_ID,
} from 'src/engine/onema-access/__tests__/utils/build-test-access-scope.util';
import { buildTestTableShape } from 'src/engine/onema-access/__tests__/utils/build-test-table-shape.util';
import { type OnemaAccessRules } from 'src/engine/onema-access/types/onema-access-rules.type';
import { assertOnemaWrittenRecordsAreAccessible } from 'src/engine/onema-access/utils/assert-onema-written-records-are-accessible.util';
import { resetOnemaParameterNamespaceForTesting } from 'src/engine/onema-access/utils/compile-onema-row-access.util';
import { setOnemaAccessRulesForTesting } from 'src/engine/onema-access/utils/load-onema-access-rules.util';
import { type WorkspaceAuthContext } from 'src/engine/core-modules/auth/types/workspace-auth-context.type';

const projectTableShape = buildTestTableShape({
  nameSingular: 'project',
  joinColumnNameByFieldName: { projectManager: 'projectManagerId' },
});
const taskTableShape = buildTestTableShape({
  nameSingular: 'task',
  columnNames: ['title'],
  joinColumnNameByFieldName: { project: 'projectId' },
});

// rls-design §11: a task is visible through the project it hangs on, so moving
// it to another project is a write that can take it out of its author's sight
const taskFollowsItsProjectRules: OnemaAccessRules = {
  roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
  objects: {
    project: { sales: { eq: ['projectManager', '$me'] } },
    task: { sales: { parent: { foreignKey: 'project', object: 'project' } } },
  },
};

const buildExecuteRaw = (admittedRecordIds: string[]) =>
  jest.fn(async () => admittedRecordIds.map((id) => ({ id })));

const assertAccessible = ({
  writtenRecords,
  executeRaw,
  authContext,
}: {
  writtenRecords: Record<string, unknown>[];
  executeRaw: ReturnType<typeof buildExecuteRaw>;
  authContext?: WorkspaceAuthContext;
}) =>
  assertOnemaWrittenRecordsAreAccessible({
    scope: buildTestAccessScope({
      tableShape: taskTableShape,
      tableShapes: [taskTableShape, projectTableShape],
      authContext,
    }),
    writtenRecords,
    executeRaw,
  });

describe('assertOnemaWrittenRecordsAreAccessible', () => {
  beforeEach(() => resetOnemaParameterNamespaceForTesting());

  afterEach(() => setOnemaAccessRulesForTesting(undefined));

  it('reads nothing back while no rules file is configured', async () => {
    setOnemaAccessRulesForTesting(undefined);

    const executeRaw = buildExecuteRaw([]);

    await assertAccessible({
      writtenRecords: [{ id: 'task-1' }],
      executeRaw,
    });

    expect(executeRaw).not.toHaveBeenCalled();
  });

  it('accepts a written record the rule still admits', async () => {
    setOnemaAccessRulesForTesting(taskFollowsItsProjectRules);

    const executeRaw = buildExecuteRaw(['task-1', 'task-2']);

    await assertAccessible({
      writtenRecords: [{ id: 'task-1' }, { id: 'task-2' }],
      executeRaw,
    });

    const [sql, parameters] = executeRaw.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];

    expect(sql).toContain('FROM "workspace_test"."_task" AS "task"');
    expect(sql).toContain('EXISTS');
    expect(parameters.onemaWrittenRecordIds).toEqual(['task-1', 'task-2']);
    expect(Object.values(parameters)).toContain(WORKSPACE_MEMBER_ID);
  });

  // The write moved the row out of what its author may see: this is the
  // re-parenting of rls-design §3.2, and the transaction has to go
  it('refuses a written record the rule no longer admits', async () => {
    setOnemaAccessRulesForTesting(taskFollowsItsProjectRules);

    await expect(
      assertAccessible({
        writtenRecords: [{ id: 'task-1' }, { id: 'task-2' }],
        executeRaw: buildExecuteRaw(['task-1']),
      }),
    ).rejects.toThrow(/task-2 would not be visible to their author/);
  });

  it('refuses every written record when the role may see none at all', async () => {
    setOnemaAccessRulesForTesting(taskFollowsItsProjectRules);

    const executeRaw = buildExecuteRaw([]);

    await expect(
      assertAccessible({
        writtenRecords: [{ id: 'task-1' }],
        executeRaw,
        authContext: apiKeyAuthContext,
      }),
    ).rejects.toThrow(/the role may see no record of "task"/);

    expect(executeRaw).not.toHaveBeenCalled();
  });

  it('reads nothing back for a role the rules open entirely', async () => {
    setOnemaAccessRulesForTesting({
      roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
      objects: { task: { sales: { all: true } } },
    });

    const executeRaw = buildExecuteRaw([]);

    await assertAccessible({ writtenRecords: [{ id: 'task-1' }], executeRaw });

    expect(executeRaw).not.toHaveBeenCalled();
  });

  // A write whose returned rows carry no id cannot be checked, and an
  // unverifiable write is refused rather than waved through
  it('refuses a written record that came back without an id', async () => {
    setOnemaAccessRulesForTesting(taskFollowsItsProjectRules);

    await expect(
      assertAccessible({
        writtenRecords: [{ title: 'No id here' }],
        executeRaw: buildExecuteRaw([]),
      }),
    ).rejects.toThrow(/came back without an id/);
  });

  it('refuses every write while the rules file is unusable', async () => {
    setOnemaAccessRulesForTesting({
      roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
      objects: { tsak: { sales: { all: true } } },
    });

    await expect(
      assertAccessible({
        writtenRecords: [{ id: 'task-1' }],
        executeRaw: buildExecuteRaw(['task-1']),
      }),
    ).rejects.toThrow(/Onema access rules refuse this write/);
  });

  it('does nothing for a caller holding the explicit bypass', async () => {
    setOnemaAccessRulesForTesting(taskFollowsItsProjectRules);

    const executeRaw = buildExecuteRaw([]);

    await assertOnemaWrittenRecordsAreAccessible({
      scope: buildTestAccessScope({
        tableShape: taskTableShape,
        tableShapes: [taskTableShape, projectTableShape],
        shouldBypassPermissionChecks: true,
      }),
      writtenRecords: [{ id: 'task-1' }],
      executeRaw,
    });

    expect(executeRaw).not.toHaveBeenCalled();
  });
});
