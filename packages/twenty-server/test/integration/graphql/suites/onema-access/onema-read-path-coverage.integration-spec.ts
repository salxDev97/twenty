import { default as request } from 'supertest';
import {
  createFixtureCompany,
  destroyFixtureRecords,
} from 'test/integration/graphql/suites/onema-access/utils/onema-access-fixtures.util';
import { makeGraphqlApiRequest } from 'test/integration/graphql/utils/make-graphql-api-request.util';
import { findManyOperationFactory } from 'test/integration/graphql/utils/find-many-operation-factory.util';
import { groupByOperationFactory } from 'test/integration/graphql/utils/group-by-operation-factory.util';
import { search } from 'test/integration/graphql/utils/search.util';
import { makeRestApiRequest } from 'test/integration/rest/utils/make-rest-api-request.util';
import { waitForAllJobsToFinish } from 'test/integration/utils/wait-for-all-jobs-to-finish.util';

import { type OnemaAccessRules } from 'src/engine/onema-access/types/onema-access-rules.type';
import { setOnemaAccessRulesForTesting } from 'src/engine/onema-access/utils/load-onema-access-rules.util';
import { WORKSPACE_MEMBER_DATA_SEED_IDS } from 'src/engine/workspace-manager/dev-seeder/data/constants/workspace-member-data-seeds.constant';

const client = request(`http://localhost:${APP_PORT}`);

// A word of its own, so the search index of the workspace cannot answer with
// anything the suite did not create
const SEARCH_TOKEN = 'onemareadpath';

// Distinct headcounts, so a sum that quietly covered the wrong rows cannot
// land on the expected number by accident
const COMPANY_FIXTURES = [
  {
    name: `${SEARCH_TOKEN} owned by the member`,
    ownerId: WORKSPACE_MEMBER_DATA_SEED_IDS.JONY,
    employees: 11,
  },
  {
    name: `${SEARCH_TOKEN} owned by somebody else`,
    ownerId: WORKSPACE_MEMBER_DATA_SEED_IDS.PHIL,
    employees: 101,
  },
  {
    name: `${SEARCH_TOKEN} owned by the admin`,
    ownerId: WORKSPACE_MEMBER_DATA_SEED_IDS.JANE,
    employees: 1001,
  },
];

let companyIdsUnderTest: string[] = [];

const companyNamesOf = (records: { name: string }[]): string[] =>
  records
    .map((record) => record.name)
    .filter((name) => name.startsWith(SEARCH_TOKEN))
    .sort();

// rls-design §11, the reading rows the suites of ONE-110…112 do not reach:
// search and Cmd+K, the REST runner, and an API key holding a role whose rule
// asks who "$me" is. Each goes through the hook of point №1 by a different
// door, and "the hook is one place" is an argument, not a test.
describe('onemaReadPathCoverage', () => {
  let memberRoleUniversalIdentifier: string;
  let adminRoleUniversalIdentifier: string;

  const findRolesOfWorkspaceMembers = async () => {
    const rolesResponse = await client
      .post('/metadata')
      .set('Authorization', `Bearer ${APPLE_JANE_ADMIN_ACCESS_TOKEN}`)
      .send({
        query: `
          query GetRoles {
            getRoles {
              id
              universalIdentifier
              workspaceMembers {
                id
              }
            }
          }
        `,
      });

    return rolesResponse.body.data.getRoles as {
      universalIdentifier: string;
      workspaceMembers?: { id: string }[];
    }[];
  };

  const roleUniversalIdentifierOfWorkspaceMember = (
    roles: {
      universalIdentifier: string;
      workspaceMembers?: { id: string }[];
    }[],
    workspaceMemberId: string,
  ): string =>
    roles.find((role) =>
      role.workspaceMembers?.some(
        (workspaceMember) => workspaceMember.id === workspaceMemberId,
      ),
    )!.universalIdentifier;

  beforeAll(async () => {
    jest.useRealTimers();

    const roles = await findRolesOfWorkspaceMembers();

    memberRoleUniversalIdentifier = roleUniversalIdentifierOfWorkspaceMember(
      roles,
      WORKSPACE_MEMBER_DATA_SEED_IDS.JONY,
    );
    adminRoleUniversalIdentifier = roleUniversalIdentifierOfWorkspaceMember(
      roles,
      WORKSPACE_MEMBER_DATA_SEED_IDS.JANE,
    );

    expect(memberRoleUniversalIdentifier).toBeDefined();
    expect(adminRoleUniversalIdentifier).toBeDefined();

    setOnemaAccessRulesForTesting(undefined);

    const createdCompanies = [];

    for (const { name, ownerId, employees } of COMPANY_FIXTURES) {
      createdCompanies.push(
        await createFixtureCompany({
          name,
          accountOwnerId: ownerId,
          employees,
        }),
      );
    }

    companyIdsUnderTest = createdCompanies.map((company) => company.id);

    // The search index is filled by a job, and a search run before it lands
    // would be a test of the queue rather than of the rules
    await waitForAllJobsToFinish();
  });

  afterAll(async () => {
    setOnemaAccessRulesForTesting(undefined);

    await destroyFixtureRecords({
      objectMetadataSingularName: 'company',
      recordIds: companyIdsUnderTest,
    });

    jest.useFakeTimers();
  });

  afterEach(() => setOnemaAccessRulesForTesting(undefined));

  // Narrowed to the rows of this suite by id, so nothing it asserts depends on
  // what else the workspace holds
  const findCompaniesOverRestWithBearer = async (bearer: string) => {
    const idFilter = `id[in]:[${companyIdsUnderTest
      .map((companyId) => `"${companyId}"`)
      .join(',')}]`;

    const response = await makeRestApiRequest({
      method: 'get',
      path: `/companies?filter=${encodeURIComponent(idFilter)}&limit=30`,
      bearer,
    });

    expect(response.status).toBe(200);

    return response;
  };

  const installOwnerRuleFor = (
    roleKey: string,
    universalIdentifier: string,
  ) => {
    const rules: OnemaAccessRules = {
      roles: { [roleKey]: universalIdentifier },
      objects: {
        company: { [roleKey]: { eq: ['accountOwner', '$me'] } },
      },
    };

    setOnemaAccessRulesForTesting(rules);
  };

  describe('search and Cmd+K', () => {
    const searchCompanies = async (accessToken: string) => {
      const { data } = await search({
        searchInput: SEARCH_TOKEN,
        limit: 30,
        includedObjectNameSingulars: ['company'],
        accessToken,
        expectToFail: false,
      });

      // A search result is a label and a record id, not a record
      return data.search.edges
        .map((edge) => edge.node.label)
        .filter((label) => label.startsWith(SEARCH_TOKEN))
        .sort();
    };

    it('finds every company of the suite while no rules file is configured', async () => {
      expect(
        await searchCompanies(APPLE_JONY_MEMBER_ACCESS_TOKEN),
      ).toHaveLength(COMPANY_FIXTURES.length);
    });

    it('finds only the company of the member once the rule names the owner', async () => {
      installOwnerRuleFor('member', memberRoleUniversalIdentifier);

      expect(await searchCompanies(APPLE_JONY_MEMBER_ACCESS_TOKEN)).toEqual([
        COMPANY_FIXTURES[0].name,
      ]);
    });
  });

  describe('the REST runner', () => {
    const findCompaniesOverRest = async (bearer: string) => {
      const response = await findCompaniesOverRestWithBearer(bearer);

      return companyNamesOf(response.body.data.companies);
    };

    it('returns every company of the suite while no rules file is configured', async () => {
      expect(
        await findCompaniesOverRest(APPLE_JONY_MEMBER_ACCESS_TOKEN),
      ).toHaveLength(COMPANY_FIXTURES.length);
    });

    it('returns only the company of the member once the rule names the owner', async () => {
      installOwnerRuleFor('member', memberRoleUniversalIdentifier);

      expect(
        await findCompaniesOverRest(APPLE_JONY_MEMBER_ACCESS_TOKEN),
      ).toEqual([COMPANY_FIXTURES[0].name]);
    });
  });

  // §11, "groupBy lead + sum(amount)" and "salesSummary → итог отдела". The
  // count of a group is narrowed already (onema-row-access); an aggregate is a
  // second expression on the same query, and a total that still carries the
  // rows of somebody else tells the member the figure they are not allowed to
  // read, one subtraction away
  describe('an aggregate over the groups', () => {
    const sumEmployeesOverVisibleCompanies = async (accessToken: string) => {
      const response = await makeGraphqlApiRequest(
        groupByOperationFactory({
          objectMetadataSingularName: 'company',
          objectMetadataPluralName: 'companies',
          groupBy: [{ name: true }],
          filter: { id: { in: companyIdsUnderTest } },
          gqlFields: 'sumEmployees',
          limit: 100,
        }),
        accessToken,
      );

      expect(response.body.errors).toBeUndefined();

      return (
        response.body.data.companiesGroupBy as { sumEmployees: number }[]
      ).reduce((total, group) => total + group.sumEmployees, 0);
    };

    const totalHeadcountOf = (fixtures: { employees: number }[]) =>
      fixtures.reduce((total, fixture) => total + fixture.employees, 0);

    it('sums every company of the suite while no rules file is configured', async () => {
      expect(
        await sumEmployeesOverVisibleCompanies(APPLE_JONY_MEMBER_ACCESS_TOKEN),
      ).toBe(totalHeadcountOf(COMPANY_FIXTURES));
    });

    it('sums only the company of the member once the rule names the owner', async () => {
      installOwnerRuleFor('member', memberRoleUniversalIdentifier);

      expect(
        await sumEmployeesOverVisibleCompanies(APPLE_JONY_MEMBER_ACCESS_TOKEN),
      ).toBe(COMPANY_FIXTURES[0].employees);
    });
  });

  // §11, "API-ключ с ролью «Сейлз», lead → 0 (`$me` нет)". The seeded key holds
  // the admin role, so the same rule is asked of a person and of a key: the
  // person sees their own row, the key sees nothing, and the only difference
  // between the two is that one of them is somebody.
  describe('an API key holding a role whose rule asks for "$me"', () => {
    const findCompaniesAsAdmin = async () => {
      const response = await makeGraphqlApiRequest(
        findManyOperationFactory({
          objectMetadataSingularName: 'company',
          objectMetadataPluralName: 'companies',
          gqlFields: 'id name',
          filter: { id: { in: companyIdsUnderTest } },
        }),
      );

      expect(response.body.errors).toBeUndefined();

      return companyNamesOf(
        response.body.data.companies.edges.map(
          (edge: { node: { name: string } }) => edge.node,
        ),
      );
    };

    const findCompaniesWithTheApiKey = async () => {
      const response =
        await findCompaniesOverRestWithBearer(API_KEY_ACCESS_TOKEN);

      return companyNamesOf(response.body.data.companies);
    };

    it('shows the person their own record and the key none at all', async () => {
      installOwnerRuleFor('admin', adminRoleUniversalIdentifier);

      expect(await findCompaniesAsAdmin()).toEqual([COMPANY_FIXTURES[2].name]);
      expect(await findCompaniesWithTheApiKey()).toEqual([]);
    });

    it('shows the key every record once no rules file is configured', async () => {
      expect(await findCompaniesWithTheApiKey()).toHaveLength(
        COMPANY_FIXTURES.length,
      );
    });
  });
});
