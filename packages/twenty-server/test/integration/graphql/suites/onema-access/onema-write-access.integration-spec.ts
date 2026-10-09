import { default as request } from 'supertest';
import {
  createFixtureCompany,
  createFixturePerson,
  destroyFixtureRecords,
} from 'test/integration/graphql/suites/onema-access/utils/onema-access-fixtures.util';
import { createManyOperationFactory } from 'test/integration/graphql/utils/create-many-operation-factory.util';
import { createOneOperationFactory } from 'test/integration/graphql/utils/create-one-operation-factory.util';
import { deleteManyOperationFactory } from 'test/integration/graphql/utils/delete-many-operation-factory.util';
import { destroyOneOperationFactory } from 'test/integration/graphql/utils/destroy-one-operation-factory.util';
import { findManyOperationFactory } from 'test/integration/graphql/utils/find-many-operation-factory.util';
import { makeGraphqlApiRequest as makeRequestAsAdmin } from 'test/integration/graphql/utils/make-graphql-api-request.util';
import { makeGraphqlApiRequestWithMemberRole as makeRequestAsJony } from 'test/integration/graphql/utils/make-graphql-api-request-with-member-role.util';
import { restoreManyOperationFactory } from 'test/integration/graphql/utils/restore-many-operation-factory.util';
import { updateManyOperationFactory } from 'test/integration/graphql/utils/update-many-operation-factory.util';
import { updateOneOperationFactory } from 'test/integration/graphql/utils/update-one-operation-factory.util';

import { type OnemaAccessRules } from 'src/engine/onema-access/types/onema-access-rules.type';
import { setOnemaAccessRulesForTesting } from 'src/engine/onema-access/utils/load-onema-access-rules.util';
import { WORKSPACE_MEMBER_DATA_SEED_IDS } from 'src/engine/workspace-manager/dev-seeder/data/constants/workspace-member-data-seeds.constant';

const client = request(`http://localhost:${APP_PORT}`);

const CREATED_COMPANY_NAME = 'Onema write access (created)';
const REFUSED_COMPANY_NAME = 'Onema write access (refused)';
const REFUSED_PERSON_JOB_TITLE = 'Onema write access (refused person)';
const APPLICATION_UNIVERSAL_IDENTIFIER = 'onema-write-access-test-application';

const OWNED_COMPANY_NAME = 'Onema write access (owned)';
const SECOND_OWNED_COMPANY_NAME = 'Onema write access (owned, second)';
const FOREIGN_COMPANY_NAME = 'Onema write access (foreign)';
const OWNED_PERSON_JOB_TITLE = 'Onema write access (owned person)';

type SeedCompany = {
  id: string;
  name: string;
  accountOwner?: { id: string } | null;
};

type SeedPerson = {
  id: string;
  jobTitle: string | null;
  company?: { id: string } | null;
  deletedAt?: string | null;
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

  const companyOwnedByMeRules = (): OnemaAccessRules => ({
    roles: { member: memberRoleUniversalIdentifier },
    objects: { company: { member: { eq: ['accountOwner', '$me'] } } },
    ownerDefaults: { company: { member: 'accountOwner' } },
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

  // Б5: `person` carries no rule of its own here — like `projectMember`, it is
  // not an object anybody browses, only one whose link decides what else is
  // visible. Its own rule can therefore say nothing about whose company it joins.
  const personGrantsAccessToItsCompanyRules = (): OnemaAccessRules => ({
    roles: { member: memberRoleUniversalIdentifier },
    objects: { company: { member: { eq: ['accountOwner', '$me'] } } },
    writeRequiresParentAccess: {
      person: [{ foreignKey: 'company', object: 'company' }],
    },
  });

  // A soft-deleted row is hidden from an ordinary read, so the only way to ask
  // "which of these is deleted" is to ask for the deleted ones
  const readSoftDeletedPersonIds = async (
    personIds: string[],
  ): Promise<string[]> =>
    (
      await readBehindTheRules<SeedPerson>({
        objectMetadataSingularName: 'person',
        objectMetadataPluralName: 'people',
        gqlFields: 'id deletedAt',
        filter: { id: { in: personIds }, not: { deletedAt: { is: 'NULL' } } },
      })
    ).map((person) => person.id);

  const readPersonCompanyId = async (
    personId: string,
  ): Promise<string | undefined> =>
    (
      await readBehindTheRules<SeedPerson>({
        objectMetadataSingularName: 'person',
        objectMetadataPluralName: 'people',
        gqlFields: 'id company { id }',
        filter: { id: { eq: personId } },
      })
    )[0]?.company?.id;

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

    setOnemaAccessRulesForTesting(undefined);

    ownedCompanyId = (
      await createFixtureCompany({
        name: OWNED_COMPANY_NAME,
        accountOwnerId: WORKSPACE_MEMBER_DATA_SEED_IDS.JONY,
      })
    ).id;
    secondOwnedCompanyId = (
      await createFixtureCompany({
        name: SECOND_OWNED_COMPANY_NAME,
        accountOwnerId: WORKSPACE_MEMBER_DATA_SEED_IDS.JONY,
      })
    ).id;
    foreignCompanyId = (
      await createFixtureCompany({
        name: FOREIGN_COMPANY_NAME,
        accountOwnerId: WORKSPACE_MEMBER_DATA_SEED_IDS.PHIL,
      })
    ).id;

    // The person hangs on a company of the author, since the parent it hangs on
    // is the whole point of the child rule
    ownedPersonId = (
      await createFixturePerson({
        jobTitle: OWNED_PERSON_JOB_TITLE,
        companyId: ownedCompanyId,
      })
    ).id;
  });

  afterAll(async () => {
    setOnemaAccessRulesForTesting(undefined);

    await destroyFixtureRecords({
      objectMetadataSingularName: 'person',
      recordIds: [ownedPersonId],
    });
    await destroyFixtureRecords({
      objectMetadataSingularName: 'company',
      recordIds: [ownedCompanyId, secondOwnedCompanyId, foreignCompanyId],
    });
  });

  // The shared person is moved and renamed by most tests here, and a test that
  // fails before its own cleanup would otherwise take every later one with it
  afterEach(async () => {
    setOnemaAccessRulesForTesting(undefined);

    await makeRequestAsAdmin(
      updateOneOperationFactory({
        objectMetadataSingularName: 'person',
        gqlFields: 'id jobTitle company { id }',
        recordId: ownedPersonId,
        data: { jobTitle: OWNED_PERSON_JOB_TITLE, companyId: ownedCompanyId },
      }),
    );
  });

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
    ).toBe(OWNED_PERSON_JOB_TITLE);
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
        data: { jobTitle: OWNED_PERSON_JOB_TITLE },
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
        data: { jobTitle: OWNED_PERSON_JOB_TITLE, companyId: ownedCompanyId },
      }),
    );
  });

  // rls-design §12а Т-2 plus the latch of В1: the stage may be reached and never
  // left, so the detour "leave the stage, swap the company, come back" has no
  // middle step to use
  it('refuses leaving a state the rules declare irreversible', async () => {
    setOnemaAccessRulesForTesting(undefined);
    await makeRequestAsAdmin(
      updateOneOperationFactory({
        objectMetadataSingularName: 'person',
        gqlFields: 'id jobTitle',
        recordId: ownedPersonId,
        data: { jobTitle: 'NOT A DEAL' },
      }),
    );

    const latchedRules: OnemaAccessRules = {
      roles: { member: memberRoleUniversalIdentifier },
      objects: { person: { member: { all: true } } },
      freezeWhen: {
        person: [
          {
            field: 'jobTitle',
            equals: 'DEAL',
            fields: ['company'],
            isIrreversible: true,
          },
        ],
      },
    };

    // Step 1: the record reaches the state, company and all
    setOnemaAccessRulesForTesting(latchedRules);

    const entering = await makeRequestAsJony(
      updateOneOperationFactory({
        objectMetadataSingularName: 'person',
        gqlFields: 'id jobTitle',
        recordId: ownedPersonId,
        data: { jobTitle: 'DEAL' },
      }),
    );

    expect(entering.body.errors).toBeUndefined();

    // Step 2: the state cannot be left, which is what the detour needed
    setOnemaAccessRulesForTesting(latchedRules);
    expectForbidden(
      await makeRequestAsJony(
        updateOneOperationFactory({
          objectMetadataSingularName: 'person',
          gqlFields: 'id jobTitle',
          recordId: ownedPersonId,
          data: { jobTitle: 'PROPOSAL' },
        }),
      ),
    );

    // Step 3: and the company it entered with is still frozen
    setOnemaAccessRulesForTesting(latchedRules);
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

    expect(await readPersonCompanyId(ownedPersonId)).toBe(ownedCompanyId);

    setOnemaAccessRulesForTesting(undefined);
    await makeRequestAsAdmin(
      updateOneOperationFactory({
        objectMetadataSingularName: 'person',
        gqlFields: 'id jobTitle',
        recordId: ownedPersonId,
        data: { jobTitle: OWNED_PERSON_JOB_TITLE },
      }),
    );
  });

  // В2, and the limit of what an end-to-end test can say about it. The row lock
  // exists so that a transaction cannot decide on a pre-image another
  // transaction has already replaced. Its effect is not visible from outside:
  // "the record reached DEAL and then the company changed" and "the company
  // changed and then the record reached DEAL" leave exactly the same row, and
  // the second is a legitimate serial order. That the comparison reads the row
  // under `SELECT … FOR UPDATE` is pinned by the unit test on the lock itself.
  //
  // What this does assert is the part a race could still break in the open: a
  // freeze that already holds is never slipped past by writers arriving at once.
  it('refuses every one of several writers racing a freeze that already holds', async () => {
    const freezeRules: OnemaAccessRules = {
      roles: { member: memberRoleUniversalIdentifier },
      objects: { person: { member: { all: true } } },
      freezeWhen: {
        person: [{ field: 'jobTitle', equals: 'DEAL', fields: ['company'] }],
      },
    };

    setOnemaAccessRulesForTesting(undefined);
    await makeRequestAsAdmin(
      updateOneOperationFactory({
        objectMetadataSingularName: 'person',
        gqlFields: 'id jobTitle company { id }',
        recordId: ownedPersonId,
        data: { jobTitle: 'DEAL', companyId: ownedCompanyId },
      }),
    );

    setOnemaAccessRulesForTesting(freezeRules);

    const racers = await Promise.all(
      [
        secondOwnedCompanyId,
        foreignCompanyId,
        secondOwnedCompanyId,
        foreignCompanyId,
      ].map((companyId) =>
        makeRequestAsJony(
          updateOneOperationFactory({
            objectMetadataSingularName: 'person',
            gqlFields: 'id company { id }',
            recordId: ownedPersonId,
            data: { companyId },
          }),
        ),
      ),
    );

    for (const racer of racers) {
      expectForbidden(racer);
    }

    expect(await readPersonCompanyId(ownedPersonId)).toBe(ownedCompanyId);
  });

  // Б5, rls-design §5. The record is visible to whoever just wrote it — that is
  // what makes the check after the write say yes — and the question nothing was
  // asking is whose record it attached itself to.
  describe('a record whose link decides what else is visible', () => {
    const LINKED_PERSON_JOB_TITLE = 'Onema write access (linked person)';
    const NESTED_COMPANY_NAME = 'Onema write access (nested company)';

    // Every test of this block leaves behind only rows carrying these two names,
    // and both are swept here: the order the tests run in decides nothing
    afterEach(async () => {
      setOnemaAccessRulesForTesting(undefined);

      const leftoverPeople = await readBehindTheRules<SeedPerson>({
        objectMetadataSingularName: 'person',
        objectMetadataPluralName: 'people',
        gqlFields: 'id jobTitle',
        filter: { jobTitle: { eq: LINKED_PERSON_JOB_TITLE } },
      });

      await destroyFixtureRecords({
        objectMetadataSingularName: 'person',
        recordIds: leftoverPeople.map((person) => person.id),
      });

      const leftoverCompanies = await readBehindTheRules<SeedCompany>({
        objectMetadataSingularName: 'company',
        objectMetadataPluralName: 'companies',
        gqlFields: 'id name',
        filter: { name: { eq: NESTED_COMPANY_NAME } },
      });

      await destroyFixtureRecords({
        objectMetadataSingularName: 'company',
        recordIds: leftoverCompanies.map((company) => company.id),
      });

      // The patch tests move the shared person, and a test that failed before
      // its own cleanup would otherwise take every later one with it
      await makeRequestAsAdmin(
        updateOneOperationFactory({
          objectMetadataSingularName: 'person',
          gqlFields: 'id company { id }',
          recordId: ownedPersonId,
          data: { companyId: ownedCompanyId },
        }),
      );
    });

    it('refuses a record attached to a parent its author may not see', async () => {
      setOnemaAccessRulesForTesting(personGrantsAccessToItsCompanyRules());

      expectForbidden(
        await makeRequestAsJony(
          createOneOperationFactory({
            objectMetadataSingularName: 'person',
            gqlFields: 'id jobTitle',
            data: {
              jobTitle: LINKED_PERSON_JOB_TITLE,
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
          filter: { jobTitle: { eq: LINKED_PERSON_JOB_TITLE } },
        }),
      ).toEqual([]);
    });

    // The refusal above means nothing until the same rule lets the legitimate
    // attachment through
    it('accepts a record attached to a parent its author owns', async () => {
      setOnemaAccessRulesForTesting(personGrantsAccessToItsCompanyRules());

      const creation = await makeRequestAsJony(
        createOneOperationFactory({
          objectMetadataSingularName: 'person',
          gqlFields: 'id jobTitle company { id }',
          data: {
            jobTitle: LINKED_PERSON_JOB_TITLE,
            companyId: ownedCompanyId,
          },
        }),
      );

      expect(creation.body.errors).toBeUndefined();
      expect(creation.body.data.createPerson.company.id).toBe(ownedCompanyId);
    });

    // The other side of the link: moving an existing record onto a foreign
    // parent is the same grant, written as an update
    it('refuses moving an existing record onto a parent its author may not see', async () => {
      setOnemaAccessRulesForTesting(personGrantsAccessToItsCompanyRules());

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

      expect(await readPersonCompanyId(ownedPersonId)).toBe(ownedCompanyId);

      setOnemaAccessRulesForTesting(personGrantsAccessToItsCompanyRules());

      const allowedMove = await makeRequestAsJony(
        updateOneOperationFactory({
          objectMetadataSingularName: 'person',
          gqlFields: 'id company { id }',
          recordId: ownedPersonId,
          data: { companyId: secondOwnedCompanyId },
        }),
      );

      expect(allowedMove.body.errors).toBeUndefined();

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

    // The nested form of the same link, which the review asked for separately:
    // `company: { connect: { where: { id } } }` sets the same foreign key by a
    // different road through the API, and a check that only knew about the flat
    // `companyId` would have been walked straight past.
    //
    // It turns out to be closed one gate earlier than the flat form, and the
    // error says so: the connect resolves its target by reading it, that read
    // carries the predicate of point №1, and a company the author may not see
    // is simply not there to connect to. Hence BAD_USER_INPUT rather than the
    // FORBIDDEN of the check after the write — the write never happens at all.
    it('refuses a nested connect to a parent its author may not see', async () => {
      setOnemaAccessRulesForTesting(personGrantsAccessToItsCompanyRules());

      const creation = await makeRequestAsJony(
        createOneOperationFactory({
          objectMetadataSingularName: 'person',
          gqlFields: 'id jobTitle',
          data: {
            jobTitle: LINKED_PERSON_JOB_TITLE,
            company: { connect: { where: { id: foreignCompanyId } } },
          },
        }),
      );

      expect(creation.body.errors).toBeDefined();
      expect(creation.body.errors[0].message).toMatch(
        /found 0 .*to connect to company|Expected 1 record to connect to company/,
      );

      expect(
        await readBehindTheRules<SeedPerson>({
          objectMetadataSingularName: 'person',
          objectMetadataPluralName: 'people',
          gqlFields: 'id jobTitle',
          filter: { jobTitle: { eq: LINKED_PERSON_JOB_TITLE } },
        }),
      ).toEqual([]);
    });

    it('accepts a nested connect to a parent its author owns', async () => {
      setOnemaAccessRulesForTesting(personGrantsAccessToItsCompanyRules());

      const creation = await makeRequestAsJony(
        createOneOperationFactory({
          objectMetadataSingularName: 'person',
          gqlFields: 'id jobTitle company { id }',
          data: {
            jobTitle: LINKED_PERSON_JOB_TITLE,
            company: { connect: { where: { id: ownedCompanyId } } },
          },
        }),
      );

      expect(creation.body.errors).toBeUndefined();
      expect(creation.body.data.createPerson.company.id).toBe(ownedCompanyId);
    });

    // The patch form: the same nested shape on an update moves an existing
    // record onto a foreign parent, which is the grant written sideways — and
    // is closed by the same unreachable connect target as the creation above
    it('refuses a nested connect that moves a record onto a foreign parent', async () => {
      setOnemaAccessRulesForTesting(personGrantsAccessToItsCompanyRules());

      const move = await makeRequestAsJony(
        updateOneOperationFactory({
          objectMetadataSingularName: 'person',
          gqlFields: 'id company { id }',
          recordId: ownedPersonId,
          data: { company: { connect: { where: { id: foreignCompanyId } } } },
        }),
      );

      expect(move.body.errors).toBeDefined();
      expect(await readPersonCompanyId(ownedPersonId)).toBe(ownedCompanyId);
    });

    // The same patch onto a parent the author does own goes through, so the
    // refusal above is a refusal and not a shape the API rejects outright
    it('accepts a nested connect that moves a record onto an owned parent', async () => {
      setOnemaAccessRulesForTesting(personGrantsAccessToItsCompanyRules());

      const move = await makeRequestAsJony(
        updateOneOperationFactory({
          objectMetadataSingularName: 'person',
          gqlFields: 'id company { id }',
          recordId: ownedPersonId,
          data: {
            company: { connect: { where: { id: secondOwnedCompanyId } } },
          },
        }),
      );

      expect(move.body.errors).toBeUndefined();
      expect(await readPersonCompanyId(ownedPersonId)).toBe(
        secondOwnedCompanyId,
      );
    });

    // `create` makes the parent inside the same mutation, so there is no
    // earlier read to close it — the only thing standing between the author and
    // a child hung on a parent is the check after the write. Here the parent is
    // made visible to its author, so both the parent and the child are admitted.
    it('accepts a nested create of the parent it then hangs on', async () => {
      setOnemaAccessRulesForTesting(personGrantsAccessToItsCompanyRules());

      const creation = await makeRequestAsJony(
        createOneOperationFactory({
          objectMetadataSingularName: 'person',
          gqlFields: 'id jobTitle company { id name accountOwner { id } }',
          data: {
            jobTitle: LINKED_PERSON_JOB_TITLE,
            company: {
              create: {
                name: NESTED_COMPANY_NAME,
                accountOwnerId: WORKSPACE_MEMBER_DATA_SEED_IDS.JONY,
              },
            },
          },
        }),
      );

      expect(creation.body.errors).toBeUndefined();

      // Asked of the row rather than of the response: what the mutation
      // selects back is a read of its own, and the question here is what was
      // written
      const nestedCompanies = await readBehindTheRules<SeedCompany>({
        objectMetadataSingularName: 'company',
        objectMetadataPluralName: 'companies',
        gqlFields: 'id name accountOwner { id }',
        filter: { name: { eq: NESTED_COMPANY_NAME } },
      });

      expect(nestedCompanies).toHaveLength(1);
      expect(nestedCompanies[0].accountOwner?.id).toBe(
        WORKSPACE_MEMBER_DATA_SEED_IDS.JONY,
      );
      expect(
        await readPersonCompanyId(creation.body.data.createPerson.id),
      ).toBe(nestedCompanies[0].id);
    });

    // And the same nested create under rules that close `company` to this role
    // outright: the parent the mutation makes is one its own author may not
    // see, so the child may not hang on it either
    it('refuses a nested create of a parent its author would not see', async () => {
      setOnemaAccessRulesForTesting({
        roles: { member: memberRoleUniversalIdentifier },
        objects: { company: { member: { eq: ['accountOwner', null] } } },
        writeRequiresParentAccess: {
          person: [{ foreignKey: 'company', object: 'company' }],
        },
      });

      expectForbidden(
        await makeRequestAsJony(
          createOneOperationFactory({
            objectMetadataSingularName: 'person',
            gqlFields: 'id jobTitle company { id }',
            data: {
              jobTitle: LINKED_PERSON_JOB_TITLE,
              company: {
                create: {
                  name: NESTED_COMPANY_NAME,
                  accountOwnerId: WORKSPACE_MEMBER_DATA_SEED_IDS.JONY,
                },
              },
            },
          }),
        ),
      );

      expect(
        await readBehindTheRules<SeedPerson>({
          objectMetadataSingularName: 'person',
          objectMetadataPluralName: 'people',
          gqlFields: 'id jobTitle',
          filter: { jobTitle: { eq: LINKED_PERSON_JOB_TITLE } },
        }),
      ).toEqual([]);
    });
  });

  // Б4 and С2: one row at a time was the only shape the check had ever been
  // asked about, and a write by filter or by batch is where "nothing came back"
  // used to pass for "nothing happened"
  describe('a write that touches more than one record', () => {
    const BATCH_PERSON_JOB_TITLE = 'Onema write access (batch person)';

    let secondOwnedPersonId: string;
    let foreignPersonId: string;

    beforeAll(async () => {
      setOnemaAccessRulesForTesting(undefined);

      secondOwnedPersonId = (
        await createFixturePerson({
          jobTitle: 'Onema write access (second owned person)',
          companyId: ownedCompanyId,
        })
      ).id;
      foreignPersonId = (
        await createFixturePerson({
          jobTitle: 'Onema write access (foreign person)',
          companyId: foreignCompanyId,
        })
      ).id;
    });

    afterAll(async () => {
      setOnemaAccessRulesForTesting(undefined);
      await destroyFixtureRecords({
        objectMetadataSingularName: 'person',
        recordIds: [secondOwnedPersonId, foreignPersonId],
      });
    });

    afterEach(async () => {
      setOnemaAccessRulesForTesting(undefined);

      await makeRequestAsAdmin(
        updateOneOperationFactory({
          objectMetadataSingularName: 'person',
          gqlFields: 'id company { id }',
          recordId: secondOwnedPersonId,
          data: { companyId: ownedCompanyId },
        }),
      );

      const leftovers = await readBehindTheRules<SeedPerson>({
        objectMetadataSingularName: 'person',
        objectMetadataPluralName: 'people',
        gqlFields: 'id jobTitle',
        filter: { jobTitle: { eq: BATCH_PERSON_JOB_TITLE } },
      });

      await destroyFixtureRecords({
        objectMetadataSingularName: 'person',
        recordIds: leftovers.map((person) => person.id),
      });
    });

    it('refuses an update by filter that would move records out of sight', async () => {
      setOnemaAccessRulesForTesting(personFollowsItsCompanyRules());

      expectForbidden(
        await makeRequestAsJony(
          updateManyOperationFactory({
            objectMetadataSingularName: 'person',
            objectMetadataPluralName: 'people',
            gqlFields: 'id company { id }',
            filter: { id: { in: [ownedPersonId, secondOwnedPersonId] } },
            data: { companyId: foreignCompanyId },
          }),
        ),
      );

      expect(await readPersonCompanyId(ownedPersonId)).toBe(ownedCompanyId);
      expect(await readPersonCompanyId(secondOwnedPersonId)).toBe(
        ownedCompanyId,
      );
    });

    // С2: the legal record of the batch has to go with the illegal one, or the
    // refusal is only half a refusal
    it('rolls the whole batch back when one record of it is refused', async () => {
      setOnemaAccessRulesForTesting(personFollowsItsCompanyRules());

      expectForbidden(
        await makeRequestAsJony(
          createManyOperationFactory({
            objectMetadataSingularName: 'person',
            objectMetadataPluralName: 'people',
            gqlFields: 'id jobTitle',
            data: [
              { jobTitle: BATCH_PERSON_JOB_TITLE, companyId: ownedCompanyId },
              { jobTitle: BATCH_PERSON_JOB_TITLE, companyId: foreignCompanyId },
            ],
          }),
        ),
      );

      expect(
        await readBehindTheRules<SeedPerson>({
          objectMetadataSingularName: 'person',
          objectMetadataPluralName: 'people',
          gqlFields: 'id jobTitle',
          filter: { jobTitle: { eq: BATCH_PERSON_JOB_TITLE } },
        }),
      ).toEqual([]);

      // The same batch without the illegal record goes through, so what was
      // refused was the record and not the shape of the write
      setOnemaAccessRulesForTesting(personFollowsItsCompanyRules());

      const legalBatch = await makeRequestAsJony(
        createManyOperationFactory({
          objectMetadataSingularName: 'person',
          objectMetadataPluralName: 'people',
          gqlFields: 'id jobTitle',
          data: [
            { jobTitle: BATCH_PERSON_JOB_TITLE, companyId: ownedCompanyId },
            {
              jobTitle: BATCH_PERSON_JOB_TITLE,
              companyId: secondOwnedCompanyId,
            },
          ],
        }),
      );

      expect(legalBatch.body.errors).toBeUndefined();
      expect(legalBatch.body.data.createPeople).toHaveLength(2);
    });

    it('soft-deletes and restores by filter only the records it may see', async () => {
      setOnemaAccessRulesForTesting(personFollowsItsCompanyRules());

      const deletion = await makeRequestAsJony(
        deleteManyOperationFactory({
          objectMetadataSingularName: 'person',
          objectMetadataPluralName: 'people',
          gqlFields: 'id',
          filter: { id: { in: [secondOwnedPersonId, foreignPersonId] } },
        }),
      );

      expect(deletion.body.errors).toBeUndefined();
      expect(
        deletion.body.data.deletePeople.map((person: SeedPerson) => person.id),
      ).toEqual([secondOwnedPersonId]);

      // The foreign person was named by the filter and survived it: the
      // predicate of point №1 narrows a delete by filter like any other read
      expect(
        await readSoftDeletedPersonIds([secondOwnedPersonId, foreignPersonId]),
      ).toEqual([secondOwnedPersonId]);

      setOnemaAccessRulesForTesting(personFollowsItsCompanyRules());

      const restoration = await makeRequestAsJony(
        restoreManyOperationFactory({
          objectMetadataSingularName: 'person',
          objectMetadataPluralName: 'people',
          gqlFields: 'id',
          filter: { id: { in: [secondOwnedPersonId, foreignPersonId] } },
        }),
      );

      expect(restoration.body.errors).toBeUndefined();
      expect(
        await readSoftDeletedPersonIds([secondOwnedPersonId, foreignPersonId]),
      ).toEqual([]);
    });

    // Б3. ORM v2 has no `ON CONFLICT DO UPDATE` on workspace records: an upsert
    // resolves the conflict first and then takes the ordinary insert or batch
    // update path. This is what proves the conflict-update branch really does
    // pass through the check after the write.
    it('refuses an upsert whose conflict branch would move a record out of sight', async () => {
      setOnemaAccessRulesForTesting(personFollowsItsCompanyRules());

      expectForbidden(
        await makeRequestAsJony(
          createManyOperationFactory({
            objectMetadataSingularName: 'person',
            objectMetadataPluralName: 'people',
            gqlFields: 'id company { id }',
            upsert: true,
            data: [{ id: ownedPersonId, companyId: foreignCompanyId }],
          }),
        ),
      );

      expect(await readPersonCompanyId(ownedPersonId)).toBe(ownedCompanyId);

      setOnemaAccessRulesForTesting(personFollowsItsCompanyRules());

      const allowedUpsert = await makeRequestAsJony(
        createManyOperationFactory({
          objectMetadataSingularName: 'person',
          objectMetadataPluralName: 'people',
          gqlFields: 'id company { id }',
          upsert: true,
          data: [{ id: ownedPersonId, companyId: secondOwnedCompanyId }],
        }),
      );

      expect(allowedUpsert.body.errors).toBeUndefined();

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

    // The conflict is resolved under the same predicate as a read, so a record
    // the author cannot see is not a record they can quietly take over
    it('does not let an upsert take over a record its author cannot see', async () => {
      setOnemaAccessRulesForTesting(personFollowsItsCompanyRules());

      const upsert = await makeRequestAsJony(
        createManyOperationFactory({
          objectMetadataSingularName: 'person',
          objectMetadataPluralName: 'people',
          gqlFields: 'id company { id }',
          upsert: true,
          data: [{ id: foreignPersonId, companyId: ownedCompanyId }],
        }),
      );

      expect(upsert.body.errors).toBeDefined();
      expect(await readPersonCompanyId(foreignPersonId)).toBe(foreignCompanyId);
    });
  });
});
