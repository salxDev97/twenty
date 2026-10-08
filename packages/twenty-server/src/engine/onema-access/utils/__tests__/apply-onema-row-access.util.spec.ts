import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  buildTestTableShape,
  buildTestTableShapeRegistry,
} from 'src/engine/onema-access/__tests__/utils/build-test-table-shape.util';
import {
  ONEMA_ACCESS_ENFORCE_ENABLED_VALUE,
  ONEMA_ACCESS_ENFORCE_ENVIRONMENT_VARIABLE,
  ONEMA_ACCESS_RULES_PATH_ENVIRONMENT_VARIABLE,
} from 'src/engine/onema-access/constants/onema-access.constants';
import { type OnemaAccessRules } from 'src/engine/onema-access/types/onema-access-rules.type';
import { applyOnemaRowAccess } from 'src/engine/onema-access/utils/apply-onema-row-access.util';
import { setOnemaAccessRulesForTesting } from 'src/engine/onema-access/utils/load-onema-access-rules.util';
import { type WorkspaceSelectQueryBuilder } from 'src/engine/twenty-orm/query-builder/workspace-select-query-builder';
import { type WorkspaceTableShape } from 'src/engine/twenty-orm/table-shape/types/workspace-table-shape.type';
import { type WorkspaceInternalContext } from 'src/engine/twenty-orm/interfaces/workspace-internal-context.interface';
import { type WorkspaceAuthContext } from 'src/engine/core-modules/auth/types/workspace-auth-context.type';

const SALES_ROLE_ID = '00000000-0000-4000-8000-000000000005';
const SALES_ROLE_UNIVERSAL_IDENTIFIER = 'onema-sales';
const APPLICATION_ROLE_ID = '00000000-0000-4000-8000-000000000009';
const APPLICATION_ROLE_UNIVERSAL_IDENTIFIER = 'onema-application';
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
  roles: {
    sales: SALES_ROLE_UNIVERSAL_IDENTIFIER,
    application: APPLICATION_ROLE_UNIVERSAL_IDENTIFIER,
  },
  objects: {
    opportunity: {
      sales: { eq: ['owner', '$me'] },
      application: { eq: ['owner', '$me'] },
    },
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
  flatObjectMetadataMaps: {},
  userWorkspaceRoleMap: { [USER_WORKSPACE_ID]: SALES_ROLE_ID },
  apiKeyRoleMap: { 'api-key-id': SALES_ROLE_ID },
  flatRoleMaps: {
    byUniversalIdentifier: {
      [SALES_ROLE_UNIVERSAL_IDENTIFIER]: { id: SALES_ROLE_ID },
      [APPLICATION_ROLE_UNIVERSAL_IDENTIFIER]: { id: APPLICATION_ROLE_ID },
    },
    universalIdentifierById: {
      [SALES_ROLE_ID]: SALES_ROLE_UNIVERSAL_IDENTIFIER,
      [APPLICATION_ROLE_ID]: APPLICATION_ROLE_UNIVERSAL_IDENTIFIER,
    },
    universalIdentifiersByApplicationId: {},
  },
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
    getJoinedTableShape: (joinAlias: string): WorkspaceTableShape | undefined =>
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

  // The trusted bypass is the explicit shouldBypassPermissionChecks the caller
  // asks for, which returns before this hook; a system auth context on its own
  // proves nothing, since buildSystemAuthContext is reachable from workflows,
  // AI tools and the timeline
  it('hides everything from a system context that was granted no bypass', () => {
    setOnemaAccessRulesForTesting(rules);

    const queryBuilderMock = buildQueryBuilderMock({ alias: 'opportunity' });

    apply(queryBuilderMock, { type: 'system' } as WorkspaceAuthContext);

    expect(queryBuilderMock.addRowAccessCondition).toHaveBeenCalledWith(
      '1=0',
      {},
    );
  });

  it('hides everything from an application, which has no "$me"', () => {
    setOnemaAccessRulesForTesting(rules);

    const queryBuilderMock = buildQueryBuilderMock({ alias: 'opportunity' });

    apply(queryBuilderMock, {
      type: 'application',
      application: { defaultRoleId: APPLICATION_ROLE_ID },
    } as unknown as WorkspaceAuthContext);

    expect(queryBuilderMock.addRowAccessCondition).toHaveBeenCalledWith(
      '1=0',
      {},
    );
  });

  it('applies nothing until the release gate is open', () => {
    const temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'onema-access-gate-'),
    );
    const rulesPath = path.join(temporaryDirectory, 'access-rules.json');

    fs.writeFileSync(rulesPath, JSON.stringify(rules));
    setOnemaAccessRulesForTesting(undefined);
    process.env[ONEMA_ACCESS_RULES_PATH_ENVIRONMENT_VARIABLE] = rulesPath;

    try {
      const gatedQueryBuilderMock = buildQueryBuilderMock({
        alias: 'opportunity',
      });

      apply(gatedQueryBuilderMock);

      expect(
        gatedQueryBuilderMock.addRowAccessCondition,
      ).not.toHaveBeenCalled();

      process.env[ONEMA_ACCESS_ENFORCE_ENVIRONMENT_VARIABLE] =
        ONEMA_ACCESS_ENFORCE_ENABLED_VALUE;

      const enforcedQueryBuilderMock = buildQueryBuilderMock({
        alias: 'opportunity',
      });

      apply(enforcedQueryBuilderMock);

      expect(enforcedQueryBuilderMock.addRowAccessCondition).toHaveBeenCalled();
    } finally {
      delete process.env[ONEMA_ACCESS_RULES_PATH_ENVIRONMENT_VARIABLE];
      delete process.env[ONEMA_ACCESS_ENFORCE_ENVIRONMENT_VARIABLE];
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  // A typo leaves the object it meant to protect with no rule at all, which
  // reads as "upstream permissions only" — the one failure mode that opens data
  it('closes the whole query when the rules name an object the workspace lacks', () => {
    setOnemaAccessRulesForTesting({
      roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
      objects: { opportuntiy: { sales: { eq: ['owner', '$me'] } } },
    });

    const queryBuilderMock = buildQueryBuilderMock({ alias: 'opportunity' });

    apply(queryBuilderMock);

    expect(queryBuilderMock.addRowAccessCondition).toHaveBeenCalledWith(
      '1=0',
      {},
    );
  });

  it('closes the whole query when an alias has no table shape', () => {
    setOnemaAccessRulesForTesting(rules);

    const queryBuilderMock = {
      ...buildQueryBuilderMock({ alias: 'opportunity' }),
      getJoinAliases: () => [{ name: 'mystery', isToMany: false }],
      getJoinedTableShape: () => undefined,
    };

    apply(queryBuilderMock);

    expect(queryBuilderMock.addRowAccessCondition).toHaveBeenLastCalledWith(
      '1=0',
      {},
    );
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
