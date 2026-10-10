import {
  APPLICATION_UNIVERSAL_IDENTIFIER,
  applicationAuthContext,
  buildTestAccessScope,
  SALES_ROLE_UNIVERSAL_IDENTIFIER,
  systemAuthContext,
} from 'src/engine/onema-access/__tests__/utils/build-test-access-scope.util';
import { buildTestTableShape } from 'src/engine/onema-access/__tests__/utils/build-test-table-shape.util';
import { type OnemaAccessRules } from 'src/engine/onema-access/types/onema-access-rules.type';
import {
  assertOnemaWriteIsPermittedByParentState,
  type OnemaParentFreezeUpdate,
} from 'src/engine/onema-access/utils/assert-onema-write-is-permitted-by-parent-state.util';
import { type OnemaRawQueryExecutor } from 'src/engine/onema-access/utils/assert-onema-written-records-are-accessible.util';
import { setOnemaAccessRulesForTesting } from 'src/engine/onema-access/utils/load-onema-access-rules.util';
import { type WorkspaceAuthContext } from 'src/engine/core-modules/auth/types/workspace-auth-context.type';

const dataroomTableShape = buildTestTableShape({
  nameSingular: 'onemaDataroom',
  columnNames: ['status'],
});

const dataroomItemTableShape = buildTestTableShape({
  nameSingular: 'onemaDataroomItem',
  columnNames: ['name'],
  joinColumnNameByFieldName: { dataroom: 'dataroomId' },
  relationTargetByFieldName: { dataroom: 'onemaDataroom' },
});

const archivedWhenArchivedRules: OnemaAccessRules = {
  application: APPLICATION_UNIVERSAL_IDENTIFIER,
  roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
  objects: { onemaDataroomItem: { sales: { all: true } } },
  writeFrozenByParent: {
    onemaDataroomItem: [
      {
        foreignKey: 'dataroom',
        object: 'onemaDataroom',
        field: 'status',
        equals: 'ARCHIVED',
      },
    ],
  },
};

// A map from parent id to the value `executeRaw` hands back for its status
// column, standing in for the row a real `FOR UPDATE` lock would return
const buildExecuteRaw = (
  statusByParentId: Record<string, string>,
): OnemaRawQueryExecutor =>
  jest.fn(async (sql: string, parameters: Record<string, unknown>) => {
    const parameterKey = Object.keys(parameters).find((key) =>
      key.startsWith('onema'),
    );
    const parentIds = parameterKey
      ? (parameters[parameterKey] as string[])
      : [];

    return parentIds
      .filter((parentId) => parentId in statusByParentId)
      .map((parentId) => ({ id: parentId, status: statusByParentId[parentId] }));
  });

const assertPermitted = ({
  updates,
  statusByParentId,
  authContext,
}: {
  updates: OnemaParentFreezeUpdate[];
  statusByParentId: Record<string, string>;
  authContext?: WorkspaceAuthContext;
}) =>
  assertOnemaWriteIsPermittedByParentState({
    scope: buildTestAccessScope({
      tableShape: dataroomItemTableShape,
      tableShapes: [dataroomItemTableShape, dataroomTableShape],
      authContext,
    }),
    updates,
    executeRaw: buildExecuteRaw(statusByParentId),
  });

describe('assertOnemaWriteIsPermittedByParentState', () => {
  afterEach(() => setOnemaAccessRulesForTesting(undefined));

  it('changes nothing while no rules file is configured', async () => {
    setOnemaAccessRulesForTesting(undefined);

    await expect(
      assertPermitted({
        updates: [
          { rawRecordBefore: undefined, setColumns: { dataroomId: 'room-1' } },
        ],
        statusByParentId: { 'room-1': 'ARCHIVED' },
      }),
    ).resolves.toBeUndefined();
  });

  it('refuses creating a child under an archived parent', async () => {
    setOnemaAccessRulesForTesting(archivedWhenArchivedRules);

    await expect(
      assertPermitted({
        updates: [
          { rawRecordBefore: undefined, setColumns: { dataroomId: 'room-1' } },
        ],
        statusByParentId: { 'room-1': 'ARCHIVED' },
      }),
    ).rejects.toThrow(
      /"onemaDataroomItem" cannot be written while its "onemaDataroom\.status" is "ARCHIVED"/,
    );
  });

  it('allows creating a child under an active parent', async () => {
    setOnemaAccessRulesForTesting(archivedWhenArchivedRules);

    await expect(
      assertPermitted({
        updates: [
          { rawRecordBefore: undefined, setColumns: { dataroomId: 'room-1' } },
        ],
        statusByParentId: { 'room-1': 'ACTIVE' },
      }),
    ).resolves.toBeUndefined();
  });

  it('refuses editing a child that already sits under an archived parent', async () => {
    setOnemaAccessRulesForTesting(archivedWhenArchivedRules);

    await expect(
      assertPermitted({
        updates: [
          {
            rawRecordBefore: { id: 'item-1', dataroomId: 'room-1' },
            setColumns: { name: 'renamed' },
          },
        ],
        statusByParentId: { 'room-1': 'ARCHIVED' },
      }),
    ).rejects.toThrow(/onemaDataroom\.status/);
  });

  // Moving the row out is refused the same way moving it in is: the row being
  // written still reads its old foreign key as frozen until the write is let
  // through, which it never is while that parent holds the condition
  it('refuses re-parenting away from an archived parent', async () => {
    setOnemaAccessRulesForTesting(archivedWhenArchivedRules);

    await expect(
      assertPermitted({
        updates: [
          {
            rawRecordBefore: { id: 'item-1', dataroomId: 'room-1' },
            setColumns: { dataroomId: 'room-2' },
          },
        ],
        statusByParentId: { 'room-1': 'ARCHIVED', 'room-2': 'ACTIVE' },
      }),
    ).rejects.toThrow(/onemaDataroom\.status/);
  });

  it('refuses re-parenting onto an archived parent', async () => {
    setOnemaAccessRulesForTesting(archivedWhenArchivedRules);

    await expect(
      assertPermitted({
        updates: [
          {
            rawRecordBefore: { id: 'item-1', dataroomId: 'room-1' },
            setColumns: { dataroomId: 'room-2' },
          },
        ],
        statusByParentId: { 'room-1': 'ACTIVE', 'room-2': 'ARCHIVED' },
      }),
    ).rejects.toThrow(/onemaDataroom\.status/);
  });

  it('allows a write while the parent is not archived', async () => {
    setOnemaAccessRulesForTesting(archivedWhenArchivedRules);

    await expect(
      assertPermitted({
        updates: [
          {
            rawRecordBefore: { id: 'item-1', dataroomId: 'room-1' },
            setColumns: { name: 'renamed' },
          },
        ],
        statusByParentId: { 'room-1': 'ACTIVE' },
      }),
    ).resolves.toBeUndefined();
  });

  // The application is exempt by default, the same exemption
  // writeRequiresParentAccess grants it (Б5): its automations write under a
  // token with no `$me`
  it('allows our own application under an archived parent by default', async () => {
    setOnemaAccessRulesForTesting(archivedWhenArchivedRules);

    await expect(
      assertPermitted({
        updates: [
          {
            rawRecordBefore: { id: 'item-1', dataroomId: 'room-1' },
            setColumns: { name: 'renamed' },
          },
        ],
        statusByParentId: { 'room-1': 'ARCHIVED' },
        authContext: applicationAuthContext,
      }),
    ).resolves.toBeUndefined();
  });

  it('refuses the application too once allowApplication is false', async () => {
    setOnemaAccessRulesForTesting({
      ...archivedWhenArchivedRules,
      writeFrozenByParent: {
        onemaDataroomItem: [
          {
            foreignKey: 'dataroom',
            object: 'onemaDataroom',
            field: 'status',
            equals: 'ARCHIVED',
            allowApplication: false,
          },
        ],
      },
    });

    await expect(
      assertPermitted({
        updates: [
          {
            rawRecordBefore: { id: 'item-1', dataroomId: 'room-1' },
            setColumns: { name: 'renamed' },
          },
        ],
        statusByParentId: { 'room-1': 'ARCHIVED' },
        authContext: applicationAuthContext,
      }),
    ).rejects.toThrow(/onemaDataroom\.status/);
  });

  // The invariant is of the product, not a permission of the caller, so a
  // worker holding the bypass is no exception either (Б2/Б5)
  it('refuses a worker holding the bypass just the same', async () => {
    setOnemaAccessRulesForTesting(archivedWhenArchivedRules);

    await expect(
      assertOnemaWriteIsPermittedByParentState({
        scope: buildTestAccessScope({
          tableShape: dataroomItemTableShape,
          tableShapes: [dataroomItemTableShape, dataroomTableShape],
          authContext: systemAuthContext,
          shouldBypassPermissionChecks: true,
        }),
        updates: [
          {
            rawRecordBefore: { id: 'item-1', dataroomId: 'room-1' },
            setColumns: { name: 'renamed' },
          },
        ],
        executeRaw: buildExecuteRaw({ 'room-1': 'ARCHIVED' }),
      }),
    ).rejects.toThrow(/onemaDataroom\.status/);
  });

  it('allows an orphan row with no parent on either side', async () => {
    setOnemaAccessRulesForTesting(archivedWhenArchivedRules);

    await expect(
      assertPermitted({
        updates: [
          {
            rawRecordBefore: { id: 'item-1', dataroomId: null },
            setColumns: { name: 'renamed' },
          },
        ],
        statusByParentId: {},
      }),
    ).resolves.toBeUndefined();
  });

  it('refuses every write while the rules file is unusable', async () => {
    setOnemaAccessRulesForTesting({
      roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
      objects: { onemaDataroomTypo: { sales: { all: true } } },
    });

    await expect(
      assertPermitted({
        updates: [
          {
            rawRecordBefore: { id: 'item-1', dataroomId: 'room-1' },
            setColumns: { name: 'renamed' },
          },
        ],
        statusByParentId: { 'room-1': 'ARCHIVED' },
      }),
    ).rejects.toThrow(/Onema access rules refuse this write/);
  });
});
