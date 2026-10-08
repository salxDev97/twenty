import { default as request } from 'supertest';
import { createOneOperationFactory } from 'test/integration/graphql/utils/create-one-operation-factory.util';
import { destroyOneOperationFactory } from 'test/integration/graphql/utils/destroy-one-operation-factory.util';
import { findManyOperationFactory } from 'test/integration/graphql/utils/find-many-operation-factory.util';
import { makeGraphqlApiRequest as makeRequestAsAdmin } from 'test/integration/graphql/utils/make-graphql-api-request.util';
import { makeGraphqlApiRequestWithMemberRole as makeRequestAsJony } from 'test/integration/graphql/utils/make-graphql-api-request-with-member-role.util';
import { updateOneOperationFactory } from 'test/integration/graphql/utils/update-one-operation-factory.util';

import { type OnemaAccessRules } from 'src/engine/onema-access/types/onema-access-rules.type';
import { setOnemaAccessRulesForTesting } from 'src/engine/onema-access/utils/load-onema-access-rules.util';
import { COMPANY_DATA_SEED_IDS } from 'src/engine/workspace-manager/dev-seeder/data/constants/company-data-seeds.constant';
import { WORKSPACE_MEMBER_DATA_SEED_IDS } from 'src/engine/workspace-manager/dev-seeder/data/constants/workspace-member-data-seeds.constant';

const client = request(`http://localhost:${APP_PORT}`);

const COMPANY_IDS_UNDER_TEST = [
  COMPANY_DATA_SEED_IDS.ID_1,
  COMPANY_DATA_SEED_IDS.ID_2,
  COMPANY_DATA_SEED_IDS.ID_3,
  COMPANY_DATA_SEED_IDS.ID_8,
];

const CREATED_COMPANY_NAME = 'Onema write access (created)';
const REFUSED_COMPANY_NAME = 'Onema write access (refused)';
const REFUSED_PERSON_JOB_TITLE = 'Onema write access (refused person)';
const APPLICATION_UNIVERSAL_IDENTIFIER = 'onema-write-access-test-application';

type SeedCompany = {
  id: string;
  name: string;
  accountOwner?: { id: string } | null;
};

type SeedPerson = {
  id: string;
  jobTitle: string | null;
  company?: { id: string } | null;
};

// Read back with the rules switched off and as the admin: the question is what
// the row holds, not who may see it
const readBehindTheRules = async <TNode>({
  objectMetadataSingularName,
  objectMetadataPluralName,
  gqlFields,
  filter,
}: {
  objectMetadataSingularName: string;
  objectMetadataPluralName: string;
  gqlFields: string;
  filter: object;
}): Promise<TNode[]> => {
  setOnemaAccessRulesForTesting(undefined);

  const response = await makeRequestAsAdmin(
    findManyOperationFactory({
      objectMetadataSingularName,
      objectMetadataPluralName,
      gqlFields,
      filter,
      first: 200,
    }),
  );

  expect(response.body.errors).toBeUndefined();

  return response.body.data[objectMetadataPluralName].edges.map(
    (edge: { node: TNode }) => edge.node,
  );
};

const findCompaniesAsJony = async (filter: object): Promise<SeedCompany[]> => {
  const response = await makeRequestAsJony(
    findManyOperationFactory({
      objectMetadataSingularName: 'company',
      objectMetadataPluralName: 'companies',
      gqlFields: 'id name accountOwner { id }',
      filter,
      first: 200,
    }),
  );

  expect(response.body.errors).toBeUndefined();

  return response.body.data.companies.edges.map(
    (edge: { node: SeedCompany }) => edge.node,
  );
};

const expectForbidden = (response: { body: { errors?: unknown[] } }): void => {
  expect(response.body.errors).toBeDefined();
  expect(
    (response.body.errors?.[0] as { extensions: { code: string } }).extensions
      .code,
  ).toBe('FORBIDDEN');
};

describe('onemaWriteAccess', () => {
  let memberRoleUniversalIdentifier: string;
  let ownedCompanyId: string;
  let secondOwnedCompanyId: string;
  let foreignCompanyId: string;
  let ownedPersonId: string;
  let ownedPersonJobTitle: string | null;

  const companyOwnedByMeRules = (): OnemaAccessRules => ({
    roles: { member: memberRoleUniversalIdentifier },
    objects: { company: { member: { eq: ['accountOwner', '$me'] } } },
  });

  const personFollowsItsCompanyRules = (): OnemaAccessRules => ({
    roles: { member: memberRoleUniversalIdentifier },
    objects: {
      company: { member: { eq: ['accountOwner', '$me'] } },
      person: {
        member: { parent: { foreignKey: 'company', object: 'company' } },
      },
    },
  });

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

    memberRoleUniversalIdentifier = rolesResponse.body.data.getRoles.find(
      (role: { workspaceMembers?: { id: string }[] }) =>
        role.workspaceMembers?.some(
          (workspaceMember) =>
            workspaceMember.id === WORKSPACE_MEMBER_DATA_SEED_IDS.JONY,
        ),
    ).universalIdentifier;

    expect(memberRoleUniversalIdentifier).toBeDefined();

    const companies = await readBehindTheRules<SeedCompany>({
      objectMetadataSingularName: 'company',
      objectMetadataPluralName: 'companies',
      gqlFields: 'id name accountOwner { id }',
      filter: { id: { in: COMPANY_IDS_UNDER_TEST } },
    });

    const ownedCompanies = companies.filter(
      (company) =>
        company.accountOwner?.id === WORKSPACE_MEMBER_DATA_SEED_IDS.JONY,
    );
    const foreignCompany = companies.find(
      (company) =>
        company.accountOwner?.id !== WORKSPACE_MEMBER_DATA_SEED_IDS.JONY,
    );

    expect(ownedCompanies.length).toBeGreaterThan(1);
    expect(foreignCompany).toBeDefined();

    ownedCompanyId = ownedCompanies[0].id;
    secondOwnedCompanyId = ownedCompanies[1].id;
    foreignCompanyId = (foreignCompany as SeedCompany).id;

    const ownedPeople = await readBehindTheRules<SeedPerson>({
      objectMetadataSingularName: 'person',
      objectMetadataPluralName: 'people',
      gqlFields: 'id jobTitle company { id }',
      filter: { company: { id: { eq: ownedCompanyId } } },
    });

    expect(ownedPeople.length).toBeGreaterThan(0);

    ownedPersonId = ownedPeople[0].id;
    ownedPersonJobTitle = ownedPeople[0].jobTitle;
  });

  afterEach(() => setOnemaAccessRulesForTesting(undefined));

  // rls-design §11, "S1 создаёт лид, owner недоступен на запись": without the
  // pre-hook the record would be born unowned, and the check after the write
  // would then refuse the creation outright
  it('fills the owner of a created record and shows it to its author', async () => {
    setOnemaAccessRulesForTesting(companyOwnedByMeRules());

    const creation = await makeRequestAsJony(
      createOneOperationFactory({
        objectMetadataSingularName: 'company',
        gqlFields: 'id name accountOwner { id }',
        data: { name: CREATED_COMPANY_NAME },
      }),
    );

    expect(creation.body.errors).toBeUndefined();

    const createdCompanyId = creation.body.data.createCompany.id;

    expect(creation.body.data.createCompany.accountOwner.id).toBe(
      WORKSPACE_MEMBER_DATA_SEED_IDS.JONY,
    );

    setOnemaAccessRulesForTesting(companyOwnedByMeRules());

    const visible = await findCompaniesAsJony({
      name: { eq: CREATED_COMPANY_NAME },
    });

    expect(visible.map((company) => company.id)).toEqual([createdCompanyId]);

    setOnemaAccessRulesForTesting(undefined);
    await makeRequestAsAdmin(
      destroyOneOperationFactory({
        objectMetadataSingularName: 'company',
        gqlFields: 'id',
        recordId: createdCompanyId,
      }),
    );
  });

  // Point №4 on an insert: the row is written, read back under the same rule and
  // found missing, so the transaction goes
  it('refuses a record created outside what its author may see', async () => {
    setOnemaAccessRulesForTesting(companyOwnedByMeRules());

    expectForbidden(
      await makeRequestAsJony(
        createOneOperationFactory({
          objectMetadataSingularName: 'company',
          gqlFields: 'id name',
          data: {
            name: REFUSED_COMPANY_NAME,
            accountOwnerId: WORKSPACE_MEMBER_DATA_SEED_IDS.PHIL,
          },
        }),
      ),
    );

    expect(
      await readBehindTheRules<SeedCompany>({
        objectMetadataSingularName: 'company',
        objectMetadataPluralName: 'companies',
        gqlFields: 'id name',
        filter: { name: { eq: REFUSED_COMPANY_NAME } },
      }),
    ).toEqual([]);
  });

  // rls-design §11: "C1 создаёт dataRoomItem в P2" — the foreign key has to be
  // writable, so field permissions cannot close this one
  it('refuses a child created under a parent of somebody else', async () => {
    setOnemaAccessRulesForTesting(personFollowsItsCompanyRules());

    expectForbidden(
      await makeRequestAsJony(
        createOneOperationFactory({
          objectMetadataSingularName: 'person',
          gqlFields: 'id jobTitle',
          data: {
            jobTitle: REFUSED_PERSON_JOB_TITLE,
            companyId: foreignCompanyId,
          },
        }),
      ),
    );

    expect(
      await readBehindTheRules<SeedPerson>({
        objectMetadataSingularName: 'person',
        objectMetadataPluralName: 'people',
        gqlFields: 'id jobTitle',
        filter: { jobTitle: { eq: REFUSED_PERSON_JOB_TITLE } },
      }),
    ).toEqual([]);
  });

  // rls-design §11: "M1 переносит T1 в чужой проект P2". The criteria of the
  // update still admit the row — it is where the row lands that is refused
  it('refuses moving a child into a parent of somebody else', async () => {
    setOnemaAccessRulesForTesting(personFollowsItsCompanyRules());

    expectForbidden(
      await makeRequestAsJony(
        updateOneOperationFactory({
          objectMetadataSingularName: 'person',
          gqlFields: 'id company { id }',
          recordId: ownedPersonId,
          data: { companyId: foreignCompanyId },
        }),
      ),
    );

    expect(
      (
        await readBehindTheRules<SeedPerson>({
          objectMetadataSingularName: 'person',
          objectMetadataPluralName: 'people',
          gqlFields: 'id company { id }',
          filter: { id: { eq: ownedPersonId } },
        })
      )[0].company?.id,
    ).toBe(ownedCompanyId);

    // "The move was refused" means nothing unless the same rule lets a move
    // between two companies of the author through
    setOnemaAccessRulesForTesting(personFollowsItsCompanyRules());

    const allowedMove = await makeRequestAsJony(
      updateOneOperationFactory({
        objectMetadataSingularName: 'person',
        gqlFields: 'id company { id }',
        recordId: ownedPersonId,
        data: { companyId: secondOwnedCompanyId },
      }),
    );

    expect(allowedMove.body.errors).toBeUndefined();
    expect(allowedMove.body.data.updatePerson.company.id).toBe(
      secondOwnedCompanyId,
    );

    setOnemaAccessRulesForTesting(undefined);
    await makeRequestAsAdmin(
      updateOneOperationFactory({
        objectMetadataSingularName: 'person',
        gqlFields: 'id company { id }',
        recordId: ownedPersonId,
        data: { companyId: ownedCompanyId },
      }),
    );
  });

  // rls-design §12а Т-1: the field is written by the application alone, and no
  // object or field permission of the member role changes that
  it('refuses a protected field written by a person', async () => {
    setOnemaAccessRulesForTesting({
      application: APPLICATION_UNIVERSAL_IDENTIFIER,
      roles: { member: memberRoleUniversalIdentifier },
      objects: { person: { member: { all: true } } },
      writeProtectedFields: { person: { jobTitle: [] } },
    });

    expectForbidden(
      await makeRequestAsJony(
        updateOneOperationFactory({
          objectMetadataSingularName: 'person',
          gqlFields: 'id jobTitle',
          recordId: ownedPersonId,
          data: { jobTitle: 'written through a protected field' },
        }),
      ),
    );

    expect(
      (
        await readBehindTheRules<SeedPerson>({
          objectMetadataSingularName: 'person',
          objectMetadataPluralName: 'people',
          gqlFields: 'id jobTitle',
          filter: { id: { eq: ownedPersonId } },
        })
      )[0].jobTitle,
    ).toBe(ownedPersonJobTitle);
  });

  it('lets a role the rules name write the protected field it names', async () => {
    setOnemaAccessRulesForTesting({
      application: APPLICATION_UNIVERSAL_IDENTIFIER,
      roles: { member: memberRoleUniversalIdentifier },
      objects: { person: { member: { all: true } } },
      writeProtectedFields: { person: { jobTitle: ['member'] } },
    });

    const update = await makeRequestAsJony(
      updateOneOperationFactory({
        objectMetadataSingularName: 'person',
        gqlFields: 'id jobTitle',
        recordId: ownedPersonId,
        data: { jobTitle: 'written by a role the rules name' },
      }),
    );

    expect(update.body.errors).toBeUndefined();
    expect(update.body.data.updatePerson.jobTitle).toBe(
      'written by a role the rules name',
    );

    setOnemaAccessRulesForTesting(undefined);
    await makeRequestAsAdmin(
      updateOneOperationFactory({
        objectMetadataSingularName: 'person',
        gqlFields: 'id jobTitle',
        recordId: ownedPersonId,
        data: { jobTitle: ownedPersonJobTitle },
      }),
    );
  });

  // rls-design §12а Т-2: what the record already says freezes what may still be
  // written to it — the company of a lead that reached "Сделка"
  it('freezes a field once the record satisfies the condition', async () => {
    setOnemaAccessRulesForTesting(undefined);
    await makeRequestAsAdmin(
      updateOneOperationFactory({
        objectMetadataSingularName: 'person',
        gqlFields: 'id jobTitle',
        recordId: ownedPersonId,
        data: { jobTitle: 'DEAL' },
      }),
    );

    const freezeRules: OnemaAccessRules = {
      roles: { member: memberRoleUniversalIdentifier },
      objects: { person: { member: { all: true } } },
      freezeWhen: {
        person: [{ field: 'jobTitle', equals: 'DEAL', fields: ['company'] }],
      },
    };

    setOnemaAccessRulesForTesting(freezeRules);

    expectForbidden(
      await makeRequestAsJony(
        updateOneOperationFactory({
          objectMetadataSingularName: 'person',
          gqlFields: 'id company { id }',
          recordId: ownedPersonId,
          data: { companyId: secondOwnedCompanyId },
        }),
      ),
    );

    expect(
      (
        await readBehindTheRules<SeedPerson>({
          objectMetadataSingularName: 'person',
          objectMetadataPluralName: 'people',
          gqlFields: 'id company { id }',
          filter: { id: { eq: ownedPersonId } },
        })
      )[0].company?.id,
    ).toBe(ownedCompanyId);

    // The same write on a record that does not satisfy the condition goes
    // through, so the refusal above is the freeze and not the rule
    setOnemaAccessRulesForTesting(undefined);
    await makeRequestAsAdmin(
      updateOneOperationFactory({
        objectMetadataSingularName: 'person',
        gqlFields: 'id jobTitle',
        recordId: ownedPersonId,
        data: { jobTitle: 'NOT A DEAL' },
      }),
    );

    setOnemaAccessRulesForTesting(freezeRules);

    const thawedMove = await makeRequestAsJony(
      updateOneOperationFactory({
        objectMetadataSingularName: 'person',
        gqlFields: 'id company { id }',
        recordId: ownedPersonId,
        data: { companyId: secondOwnedCompanyId },
      }),
    );

    expect(thawedMove.body.errors).toBeUndefined();
    expect(thawedMove.body.data.updatePerson.company.id).toBe(
      secondOwnedCompanyId,
    );

    setOnemaAccessRulesForTesting(undefined);
    await makeRequestAsAdmin(
      updateOneOperationFactory({
        objectMetadataSingularName: 'person',
        gqlFields: 'id jobTitle company { id }',
        recordId: ownedPersonId,
        data: { jobTitle: ownedPersonJobTitle, companyId: ownedCompanyId },
      }),
    );
  });
});
