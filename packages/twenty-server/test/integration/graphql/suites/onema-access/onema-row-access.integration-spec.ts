import gql from 'graphql-tag';
import { default as request } from 'supertest';
import { findManyOperationFactory } from 'test/integration/graphql/utils/find-many-operation-factory.util';
import { findOneOperationFactory } from 'test/integration/graphql/utils/find-one-operation-factory.util';
import { groupByOperationFactory } from 'test/integration/graphql/utils/group-by-operation-factory.util';
import { makeGraphqlApiRequestWithMemberRole as makeRequestAsJony } from 'test/integration/graphql/utils/make-graphql-api-request-with-member-role.util';

import {
  type OnemaAccessRules,
  type OnemaCondition,
} from 'src/engine/onema-access/types/onema-access-rules.type';
import { setOnemaAccessRulesForTesting } from 'src/engine/onema-access/utils/load-onema-access-rules.util';
import { COMPANY_DATA_SEED_IDS } from 'src/engine/workspace-manager/dev-seeder/data/constants/company-data-seeds.constant';
import { WORKSPACE_MEMBER_DATA_SEED_IDS } from 'src/engine/workspace-manager/dev-seeder/data/constants/workspace-member-data-seeds.constant';

const client = request(`http://localhost:${APP_PORT}`);

// A handful of seeded companies: two of them have Jony as account owner
const COMPANY_IDS_UNDER_TEST = [
  COMPANY_DATA_SEED_IDS.ID_1,
  COMPANY_DATA_SEED_IDS.ID_2,
  COMPANY_DATA_SEED_IDS.ID_3,
  COMPANY_DATA_SEED_IDS.ID_8,
];

const companyFilter = { id: { in: COMPANY_IDS_UNDER_TEST } };

const findCompanies = async () => {
  const response = await makeRequestAsJony(
    findManyOperationFactory({
      objectMetadataSingularName: 'company',
      objectMetadataPluralName: 'companies',
      gqlFields: 'id name accountOwner { id }',
      filter: companyFilter,
    }),
  );

  expect(response.body.errors).toBeUndefined();

  return response.body.data.companies.edges.map(
    (edge: {
      node: { id: string; name: string; accountOwner?: { id: string } };
    }) => edge.node,
  );
};

const countCompanies = async () => {
  const response = await makeRequestAsJony({
    query: gql`
      query CompaniesTotalCount($filter: CompanyFilterInput) {
        companies(filter: $filter) {
          totalCount
        }
      }
    `,
    variables: { filter: companyFilter },
  });

  expect(response.body.errors).toBeUndefined();

  return response.body.data.companies.totalCount;
};

const findPeople = async (): Promise<
  { id: string; company?: { name: string } }[]
> => {
  const response = await makeRequestAsJony(
    findManyOperationFactory({
      objectMetadataSingularName: 'person',
      objectMetadataPluralName: 'people',
      gqlFields: 'id company { id name }',
      filter: { company: { id: { in: COMPANY_IDS_UNDER_TEST } } },
      first: 200,
    }),
  );

  expect(response.body.errors).toBeUndefined();

  return response.body.data.people.edges.map(
    (edge: { node: { id: string; company?: { name: string } } }) => edge.node,
  );
};

const findPeopleOrderedByCompany = async (): Promise<{ id: string }[]> => {
  const response = await makeRequestAsJony(
    findManyOperationFactory({
      objectMetadataSingularName: 'person',
      objectMetadataPluralName: 'people',
      gqlFields: 'id',
      filter: { company: { id: { in: COMPANY_IDS_UNDER_TEST } } },
      orderBy: [{ company: { name: 'AscNullsLast' } }],
      first: 200,
    }),
  );

  expect(response.body.errors).toBeUndefined();

  return response.body.data.people.edges.map(
    (edge: { node: { id: string } }) => edge.node,
  );
};

const findCompaniesWithPeople = async (): Promise<
  { name: string; people: { edges: { node: { id: string } }[] } }[]
> => {
  const response = await makeRequestAsJony(
    findManyOperationFactory({
      objectMetadataSingularName: 'company',
      objectMetadataPluralName: 'companies',
      gqlFields: 'id name people { edges { node { id } } }',
      filter: companyFilter,
    }),
  );

  expect(response.body.errors).toBeUndefined();

  return response.body.data.companies.edges.map(
    (edge: {
      node: { name: string; people: { edges: { node: { id: string } }[] } };
    }) => edge.node,
  );
};

const groupCompaniesByName = async () => {
  const response = await makeRequestAsJony(
    groupByOperationFactory({
      objectMetadataSingularName: 'company',
      objectMetadataPluralName: 'companies',
      groupBy: [{ name: true }],
      filter: companyFilter,
      limit: 100,
    }),
  );

  expect(response.body.errors).toBeUndefined();

  return response.body.data.companiesGroupBy as {
    groupByDimensionValues: string[];
    totalCount: number;
  }[];
};

describe('onemaRowAccess', () => {
  let memberRoleUniversalIdentifier: string;
  let allCompanyNames: string[];
  let ownedCompanyNames: string[];
  let foreignCompanyId: string;

  beforeAll(async () => {
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

    // rls-design §4 forbids identifying a role by its UI label, which is
    // renamed: the rule names the universalIdentifier, and the test finds the
    // role the way the product does — by who actually holds it
    memberRoleUniversalIdentifier = rolesResponse.body.data.getRoles.find(
      (role: { workspaceMembers?: { id: string }[] }) =>
        role.workspaceMembers?.some(
          (workspaceMember) =>
            workspaceMember.id === WORKSPACE_MEMBER_DATA_SEED_IDS.JONY,
        ),
    ).universalIdentifier;

    expect(memberRoleUniversalIdentifier).toBeDefined();

    // Expectations come from the unfiltered view, so the test does not restate
    // which seeded company belongs to whom
    setOnemaAccessRulesForTesting(undefined);

    const companies = await findCompanies();

    allCompanyNames = companies.map(
      (company: { name: string }) => company.name,
    );
    ownedCompanyNames = companies
      .filter(
        (company: { accountOwner?: { id: string } }) =>
          company.accountOwner?.id === WORKSPACE_MEMBER_DATA_SEED_IDS.JONY,
      )
      .map((company: { name: string }) => company.name);
    foreignCompanyId = companies.find(
      (company: { accountOwner?: { id: string } }) =>
        company.accountOwner?.id !== WORKSPACE_MEMBER_DATA_SEED_IDS.JONY,
    ).id;

    expect(ownedCompanyNames.length).toBeGreaterThan(0);
    expect(ownedCompanyNames.length).toBeLessThan(allCompanyNames.length);
  });

  afterEach(() => setOnemaAccessRulesForTesting(undefined));

  const installCompanyRule = (condition: OnemaCondition | undefined) => {
    const rules: OnemaAccessRules = {
      roles: { member: memberRoleUniversalIdentifier },
      objects: { company: condition ? { member: condition } : {} },
    };

    setOnemaAccessRulesForTesting(rules);
  };

  const installOwnedCompanyAndItsPeopleRule = () => {
    setOnemaAccessRulesForTesting({
      roles: { member: memberRoleUniversalIdentifier },
      objects: {
        company: { member: { eq: ['accountOwner', '$me'] } },
        person: {
          member: { parent: { foreignKey: 'company', object: 'company' } },
        },
      },
    });
  };

  it('changes nothing while no rules file is configured', async () => {
    setOnemaAccessRulesForTesting(undefined);

    const companies = await findCompanies();

    expect(
      companies.map((company: { name: string }) => company.name).sort(),
    ).toEqual([...allCompanyNames].sort());
  });

  it('shows every record to a role the rules open entirely', async () => {
    installCompanyRule({ all: true });

    const companies = await findCompanies();

    expect(
      companies.map((company: { name: string }) => company.name).sort(),
    ).toEqual([...allCompanyNames].sort());
  });

  it('shows only the records of the member through findMany', async () => {
    installCompanyRule({ eq: ['accountOwner', '$me'] });

    const companies = await findCompanies();

    expect(
      companies.map((company: { name: string }) => company.name).sort(),
    ).toEqual([...ownedCompanyNames].sort());
  });

  it('hides a record of somebody else from findOne by id', async () => {
    installCompanyRule({ eq: ['accountOwner', '$me'] });

    const response = await makeRequestAsJony(
      findOneOperationFactory({
        objectMetadataSingularName: 'company',
        gqlFields: 'id name',
        filter: { id: { eq: foreignCompanyId } },
      }),
    );

    // findOne treats a denied record the same as one that was never there:
    // the same NOT_FOUND error upstream raises for a genuinely missing id
    expect(response.body.errors[0].extensions.code).toBe('NOT_FOUND');
    expect(response.body.data.company).toBeNull();
  });

  it('counts only the records of the member', async () => {
    installCompanyRule({ eq: ['accountOwner', '$me'] });

    expect(await countCompanies()).toBe(ownedCompanyNames.length);
  });

  it('groups only the records of the member', async () => {
    installCompanyRule({ eq: ['accountOwner', '$me'] });

    const groups = await groupCompaniesByName();

    expect(
      groups.map((group) => group.groupByDimensionValues[0]).sort(),
    ).toEqual([...ownedCompanyNames].sort());
    expect(groups.reduce((total, group) => total + group.totalCount, 0)).toBe(
      ownedCompanyNames.length,
    );
  });

  it('lets a child record follow the rule of its parent', async () => {
    setOnemaAccessRulesForTesting(undefined);

    const allPeople = await findPeople();
    const expectedPersonIds = allPeople
      .filter((person) =>
        ownedCompanyNames.includes(person.company?.name ?? ''),
      )
      .map((person) => person.id);

    expect(expectedPersonIds.length).toBeGreaterThan(0);
    expect(expectedPersonIds.length).toBeLessThan(allPeople.length);

    installOwnedCompanyAndItsPeopleRule();

    const visiblePeople = await findPeople();

    expect(visiblePeople.map((person) => person.id).sort()).toEqual(
      [...expectedPersonIds].sort(),
    );
  });

  // Two aliases of two different objects in one query, which is where a rule
  // applied to the main alias only would still leak through the relation
  it('narrows a relation read nested under an already narrowed list', async () => {
    setOnemaAccessRulesForTesting(undefined);

    const allPeople = await findPeople();
    const expectedPersonIds = allPeople
      .filter((person) =>
        ownedCompanyNames.includes(person.company?.name ?? ''),
      )
      .map((person) => person.id);

    installOwnedCompanyAndItsPeopleRule();

    const nested = await findCompaniesWithPeople();

    expect(nested.map((company) => company.name).sort()).toEqual(
      [...ownedCompanyNames].sort(),
    );
    expect(
      nested
        .flatMap((company) => company.people.edges.map((edge) => edge.node.id))
        .sort(),
    ).toEqual([...expectedPersonIds].sort());
  });

  // Filter and order both join company, so the same table carries the rule
  // under more than one alias of one query
  it('narrows a list filtered and ordered by the same relation', async () => {
    setOnemaAccessRulesForTesting(undefined);

    const allPeople = await findPeople();
    const expectedPersonIds = allPeople
      .filter((person) =>
        ownedCompanyNames.includes(person.company?.name ?? ''),
      )
      .map((person) => person.id);

    installOwnedCompanyAndItsPeopleRule();

    const visiblePeople = await findPeopleOrderedByCompany();

    expect(visiblePeople.map((person) => person.id).sort()).toEqual(
      [...expectedPersonIds].sort(),
    );
  });

  it('hides every record when the rules do not name the role of the member', async () => {
    installCompanyRule(undefined);

    expect(await findCompanies()).toEqual([]);
    expect(await countCompanies()).toBe(0);
  });

  it('hides every record when the rules name an object this workspace lacks', async () => {
    setOnemaAccessRulesForTesting({
      roles: { member: memberRoleUniversalIdentifier },
      objects: {
        compny: { member: { all: true } },
        company: { member: { all: true } },
      },
    });

    expect(await findCompanies()).toEqual([]);
  });
});
