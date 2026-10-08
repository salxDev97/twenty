import {
  buildTestTableShape,
  buildTestTableShapeRegistry,
} from 'src/engine/onema-access/__tests__/utils/build-test-table-shape.util';
import { type OnemaAccessRules } from 'src/engine/onema-access/types/onema-access-rules.type';
import { applyOnemaRowAccess } from 'src/engine/onema-access/utils/apply-onema-row-access.util';
import { setOnemaAccessRulesForTesting } from 'src/engine/onema-access/utils/load-onema-access-rules.util';
import { type WorkspaceSelectQueryBuilder } from 'src/engine/twenty-orm/query-builder/workspace-select-query-builder';
import { type WorkspaceTableShape } from 'src/engine/twenty-orm/table-shape/types/workspace-table-shape.type';
import { type WorkspaceInternalContext } from 'src/engine/twenty-orm/interfaces/workspace-internal-context.interface';
import { type WorkspaceAuthContext } from 'src/engine/core-modules/auth/types/workspace-auth-context.type';

const SALES_ROLE_ID = '00000000-0000-4000-8000-000000000005';
const WORKSPACE_MEMBER_ID = '11111111-1111-4111-8111-111111111111';
const USER_WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';

const opportunityTableShape = buildTestTableShape({
  nameSingular: 'opportunity',
  joinColumnNameByFieldName: { owner: 'ownerId' },
});
const companyTableShape = buildTestTableShape({ nameSingular: 'company' });

const { objectIdByNameSingular, tableShapeByObjectMetadataId } =
  buildTestTableShapeRegistry([opportunityTableShape, companyTableShape]);

const rules: OnemaAccessRules = {
  roles: { sales: SALES_ROLE_ID },
  objects: {
    opportunity: { sales: { eq: ['owner', '$me'] } },
    company: {},
  },
};

const userAuthContext = {
  type: 'user',
  workspaceMemberId: WORKSPACE_MEMBER_ID,
  userWorkspaceId: USER_WORKSPACE_ID,
} as unknown as WorkspaceAuthContext;

const internalContext = {
  objectIdByNameSingular,
  userWorkspaceRoleMap: { [USER_WORKSPACE_ID]: SALES_ROLE_ID },
  apiKeyRoleMap: { 'api-key-id': SALES_ROLE_ID },
} as unknown as WorkspaceInternalContext;

const buildQueryBuilderMock = ({
  alias,
  joinedTableShapeByAlias = {},
}: {
  alias: string;
  joinedTableShapeByAlias?: Record<string, WorkspaceTableShape>;
}) => {
  const appliedMarks = new Set<string>();

  return {
    alias,
    addRowAccessCondition: jest.fn(),
    addJoinCondition: jest.fn(),
    setParameters: jest.fn(),
    getJoinAliases: () =>
      Object.keys(joinedTableShapeByAlias).map((name) => ({
        name,
        isToMany: false,
      })),
    getJoinedTableShape: (joinAlias: string) =>
      joinedTableShapeByAlias[joinAlias],
    markRowLevelPermissionApplied: (mark: string) => {
      if (appliedMarks.has(mark)) {
        return false;
      }

      appliedMarks.add(mark);

      return true;
    },
  };
};

const apply = (
  queryBuilderMock: ReturnType<typeof buildQueryBuilderMock>,
  authContext: WorkspaceAuthContext = userAuthContext,
) =>
  applyOnemaRowAccess({
    queryBuilder: queryBuilderMock as unknown as WorkspaceSelectQueryBuilder,
    tableShape: opportunityTableShape,
    authContext,
    internalContext,
    tableShapeByObjectMetadataId,
  });

describe('applyOnemaRowAccess', () => {
  afterEach(() => setOnemaAccessRulesForTesting(undefined));

  it('does nothing when no rules file is configured', () => {
    setOnemaAccessRulesForTesting(undefined);

    const queryBuilderMock = buildQueryBuilderMock({ alias: 'opportunity' });

    apply(queryBuilderMock);

    expect(queryBuilderMock.addRowAccessCondition).not.toHaveBeenCalled();
  });

  it('narrows the main alias with the condition of the role', () => {
    setOnemaAccessRulesForTesting(rules);

    const queryBuilderMock = buildQueryBuilderMock({ alias: 'opportunity' });

    apply(queryBuilderMock);

    expect(queryBuilderMock.addRowAccessCondition).toHaveBeenCalledWith(
      '"opportunity"."ownerId" = :onema_opportunity_p0',
      { onema_opportunity_p0: WORKSPACE_MEMBER_ID },
    );
  });

  it('applies the condition once per alias, however often it runs', () => {
    setOnemaAccessRulesForTesting(rules);

    const queryBuilderMock = buildQueryBuilderMock({ alias: 'opportunity' });

    apply(queryBuilderMock);
    apply(queryBuilderMock);

    expect(queryBuilderMock.addRowAccessCondition).toHaveBeenCalledTimes(1);
  });

  it('closes a joined alias the role may not read at all', () => {
    setOnemaAccessRulesForTesting(rules);

    const queryBuilderMock = buildQueryBuilderMock({
      alias: 'opportunity',
      joinedTableShapeByAlias: { opportunityCompany: companyTableShape },
    });

    apply(queryBuilderMock);

    expect(queryBuilderMock.addJoinCondition).toHaveBeenCalledWith(
      'opportunityCompany',
      '1=0',
    );
  });

  it('leaves system work untouched', () => {
    setOnemaAccessRulesForTesting(rules);

    const queryBuilderMock = buildQueryBuilderMock({ alias: 'opportunity' });

    apply(queryBuilderMock, { type: 'system' } as WorkspaceAuthContext);

    expect(queryBuilderMock.addRowAccessCondition).not.toHaveBeenCalled();
  });

  it('hides everything from an API key, which has no "$me"', () => {
    setOnemaAccessRulesForTesting(rules);

    const queryBuilderMock = buildQueryBuilderMock({ alias: 'opportunity' });

    apply(queryBuilderMock, {
      type: 'apiKey',
      apiKey: { id: 'api-key-id' },
    } as unknown as WorkspaceAuthContext);

    expect(queryBuilderMock.addRowAccessCondition).toHaveBeenCalledWith(
      '1=0',
      {},
    );
  });
});
