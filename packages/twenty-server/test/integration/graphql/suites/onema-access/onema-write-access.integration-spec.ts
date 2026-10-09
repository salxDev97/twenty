import { Client } from 'pg';
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
import { mergeManyOperationFactory } from 'test/integration/graphql/utils/merge-many-operation-factory.util';
import { restoreManyOperationFactory } from 'test/integration/graphql/utils/restore-many-operation-factory.util';
import { updateManyOperationFactory } from 'test/integration/graphql/utils/update-many-operation-factory.util';
import { updateOneOperationFactory } from 'test/integration/graphql/utils/update-one-operation-factory.util';
import { getAppProviderByClassName } from 'test/integration/utils/get-app-provider-by-class-name.util';

import { TwentyConfigService } from 'src/engine/core-modules/twenty-config/twenty-config.service';
import { type OnemaAccessRules } from 'src/engine/onema-access/types/onema-access-rules.type';
import { setOnemaAccessRulesForTesting } from 'src/engine/onema-access/utils/load-onema-access-rules.util';
import { computeTableName } from 'src/engine/utils/compute-table-name.util';
import { SEED_APPLE_WORKSPACE_ID } from 'src/engine/workspace-manager/dev-seeder/core/constants/seeder-workspaces.constant';
import { WORKSPACE_MEMBER_DATA_SEED_IDS } from 'src/engine/workspace-manager/dev-seeder/data/constants/workspace-member-data-seeds.constant';
import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';
import { escapeIdentifier } from 'src/engine/workspace-manager/workspace-migration/utils/remove-sql-injection.util';

const client = request(`http://localhost:${APP_PORT}`);

// `person` is a standard object, so its table carries no custom prefix
const PERSON_TABLE = `${escapeIdentifier(
  getWorkspaceSchemaName(SEED_APPLE_WORKSPACE_ID),
)}.${escapeIdentifier(computeTableName('person', false))}`;

type OnemaLockWaiter = { query: string; xact_start: Date; query_start: Date };

// Supertest sends the request when it is ended, not when its result is awaited,
// and this one has to be in flight while another transaction holds the row lock
const startRequest = <TResponse>(
  pendingRequest: PromiseLike<TResponse> & {
    end: (callback: (error: Error | null, response: TResponse) => void) => void;
  },
): Promise<TResponse> =>
  new Promise((resolve, reject) => {
    pendingRequest.end((error, response) =>
      error === null ? resolve(response) : reject(error),
    );
  });

// The statement blocked on the row lock, read while it is blocked: it cannot
// proceed until the lock holder commits, so there is no window to miss — only a
// request that never took the lock would leave nothing to find
const waitForLockWaiter = async (
  lockHolder: Client,
): Promise<OnemaLockWaiter> => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    // The lock holder polls from inside its own transaction, and Postgres caches
    // the activity snapshot for the whole of one — without this every read after
    // the first answers with the state the database was in before the request
    // under test had started
    await lockHolder.query('SELECT pg_stat_clear_snapshot()');

    const waiters = await lockHolder.query<OnemaLockWaiter>(
      `SELECT "query", "xact_start", "query_start"
         FROM "pg_stat_activity"
        WHERE "pid" <> pg_backend_pid()
          AND "datname" = current_database()
          AND "state" = 'active'
          AND "wait_event_type" = 'Lock'`,
    );

    if (waiters.rows.length === 1) {
      return waiters.rows[0];
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(
    'no statement of the application was waiting on the row lock: the freeze read its pre-image without taking one',
  );
};

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

  // В2 and §12а Т-2, the half of the question that is decidable without a race.
  // The race itself — two writers arriving together, where what the scheduler
  // does with them is part of the answer — is probabilistic and lives outside
  // the mandatory run (test/integration/onema-race/).
  //
  // This one is ordered throughout. A second connection takes the row's lock and,
  // while holding it, moves the record into the frozen state. The request under
  // test has by then already read its own snapshot of the record — "not frozen"
  // — so it can only refuse if it reads the pre-image again under a lock it has
  // to wait for. What it is waiting on is read out of `pg_stat_activity` while
  // it waits: the blocked statement has to be a `SELECT … FOR UPDATE` on the
  // person table rather than the UPDATE itself, in a transaction that opened
  // before that statement — the writing transaction, which had already read the
  // record. Then the lock is released, and the answer has to be a refusal with
  // the row untouched.
  //
  // Without the lock the request decides on the snapshot it read first, finds no
  // freeze, and writes: the company moves and nothing is blocked at all.
  it('reads the pre-image of the freeze under a row lock in the writing transaction', async () => {
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
        data: { jobTitle: 'NOT A DEAL', companyId: ownedCompanyId },
      }),
    );

    const blocker = new Client({
      connectionString: getAppProviderByClassName<TwentyConfigService>(
        'TwentyConfigService',
      ).get('PG_DATABASE_URL'),
    });

    await blocker.connect();

    try {
      await blocker.query('BEGIN');

      const frozenByTheOtherWriter = await blocker.query(
        `UPDATE ${PERSON_TABLE} SET "jobTitle" = 'DEAL' WHERE "id" = $1`,
        [ownedPersonId],
      );

      // A lock on no row would make everything below pass for the wrong reason
      expect(frozenByTheOtherWriter.rowCount).toBe(1);

      setOnemaAccessRulesForTesting(freezeRules);

      const blockedMove = startRequest(
        makeRequestAsJony(
          updateOneOperationFactory({
            objectMetadataSingularName: 'person',
            gqlFields: 'id company { id }',
            recordId: ownedPersonId,
            data: { companyId: secondOwnedCompanyId },
          }),
        ),
      );

      const lockWaiter = await waitForLockWaiter(blocker);

      expect(lockWaiter.query).toMatch(/FOR\s+(?:NO\s+KEY\s+)?UPDATE/i);
      expect(lockWaiter.query).toContain('person');

      // A statement of its own would have opened its transaction at its own
      // start; this one belongs to a transaction that was already reading the
      // record before it
      expect(new Date(lockWaiter.xact_start).getTime()).toBeLessThan(
        new Date(lockWaiter.query_start).getTime(),
      );

      await blocker.query('COMMIT');

      expectForbidden(await blockedMove);
      expect(await readPersonCompanyId(ownedPersonId)).toBe(ownedCompanyId);
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      await blocker.end();
    }
  });

  // The review's open question on Т-2: a soft delete and a restore write
  // `deletedAt` and nothing else, so a rule naming that field frozen used to see
  // neither. Putting a settled record away is a change to it like any other.
  describe('a frozen record being put away and brought back', () => {
    const deletedAtFrozenRules = (): OnemaAccessRules => ({
      roles: { member: memberRoleUniversalIdentifier },
      objects: { person: { member: { all: true } } },
      freezeWhen: {
        person: [{ field: 'jobTitle', equals: 'DEAL', fields: ['deletedAt'] }],
      },
    });

    const setJobTitleAsAdmin = async (jobTitle: string): Promise<void> => {
      setOnemaAccessRulesForTesting(undefined);
      await makeRequestAsAdmin(
        updateOneOperationFactory({
          objectMetadataSingularName: 'person',
          gqlFields: 'id jobTitle',
          recordId: ownedPersonId,
          data: { jobTitle },
        }),
      );
    };

    afterEach(async () => {
      setOnemaAccessRulesForTesting(undefined);
      await makeRequestAsAdmin(
        restoreManyOperationFactory({
          objectMetadataSingularName: 'person',
          objectMetadataPluralName: 'people',
          gqlFields: 'id',
          filter: { id: { eq: ownedPersonId } },
        }),
      );
    });

    it('refuses soft-deleting a record whose deletedAt is frozen', async () => {
      await setJobTitleAsAdmin('DEAL');
      setOnemaAccessRulesForTesting(deletedAtFrozenRules());

      expectForbidden(
        await makeRequestAsJony(
          deleteManyOperationFactory({
            objectMetadataSingularName: 'person',
            objectMetadataPluralName: 'people',
            gqlFields: 'id',
            filter: { id: { eq: ownedPersonId } },
          }),
        ),
      );

      expect(await readSoftDeletedPersonIds([ownedPersonId])).toEqual([]);
    });

    it('refuses restoring a record whose deletedAt is frozen', async () => {
      await setJobTitleAsAdmin('NOT A DEAL');
      setOnemaAccessRulesForTesting(undefined);
      await makeRequestAsAdmin(
        deleteManyOperationFactory({
          objectMetadataSingularName: 'person',
          objectMetadataPluralName: 'people',
          gqlFields: 'id',
          filter: { id: { eq: ownedPersonId } },
        }),
      );
      await setJobTitleAsAdmin('DEAL');

      setOnemaAccessRulesForTesting(deletedAtFrozenRules());

      expectForbidden(
        await makeRequestAsJony(
          restoreManyOperationFactory({
            objectMetadataSingularName: 'person',
            objectMetadataPluralName: 'people',
            gqlFields: 'id',
            filter: { id: { eq: ownedPersonId } },
          }),
        ),
      );

      expect(await readSoftDeletedPersonIds([ownedPersonId])).toEqual([
        ownedPersonId,
      ]);
    });

    // The refusals above mean nothing unless the same two writes go through on a
    // record the condition does not hold for
    it('lets a record the freeze does not cover be put away and brought back', async () => {
      await setJobTitleAsAdmin('NOT A DEAL');
      setOnemaAccessRulesForTesting(deletedAtFrozenRules());

      const softDeletion = await makeRequestAsJony(
        deleteManyOperationFactory({
          objectMetadataSingularName: 'person',
          objectMetadataPluralName: 'people',
          gqlFields: 'id',
          filter: { id: { eq: ownedPersonId } },
        }),
      );

      expect(softDeletion.body.errors).toBeUndefined();
      expect(await readSoftDeletedPersonIds([ownedPersonId])).toEqual([
        ownedPersonId,
      ]);

      setOnemaAccessRulesForTesting(deletedAtFrozenRules());

      const restoration = await makeRequestAsJony(
        restoreManyOperationFactory({
          objectMetadataSingularName: 'person',
          objectMetadataPluralName: 'people',
          gqlFields: 'id',
          filter: { id: { eq: ownedPersonId } },
        }),
      );

      expect(restoration.body.errors).toBeUndefined();
      expect(await readSoftDeletedPersonIds([ownedPersonId])).toEqual([]);
    });
  });

  // Б4, the other half, and what checking it turned up. The review read the
  // merge runner building its returning list out of the GraphQL selection and
  // called a false refusal possible; it is not, because `buildColumnsToSelect`
  // adds `id` to every selection it builds. So this passed before the id was
  // made part of the write path too — it is here as the regression test for the
  // path, not as proof of a bug. What does not rest on that upstream detail any
  // more is the invariant: `withOnemaReturnedIdColumn` puts the column in
  // whatever the caller asked for (with-onema-returned-id-column.util.spec.ts).
  it('checks a merge that asks the mutation for no id of its own', async () => {
    const MERGED_PERSON_JOB_TITLE = 'Onema write access (merged person)';

    setOnemaAccessRulesForTesting(undefined);

    const mergedPersonIds = [
      (
        await createFixturePerson({
          jobTitle: MERGED_PERSON_JOB_TITLE,
          companyId: ownedCompanyId,
        })
      ).id,
      (
        await createFixturePerson({
          jobTitle: MERGED_PERSON_JOB_TITLE,
          companyId: ownedCompanyId,
        })
      ).id,
    ];

    setOnemaAccessRulesForTesting(personFollowsItsCompanyRules());

    const merge = await makeRequestAsJony(
      mergeManyOperationFactory({
        objectMetadataPluralName: 'people',
        gqlFields: 'jobTitle',
        ids: mergedPersonIds,
        conflictPriorityIndex: 0,
      }),
    );

    expect(merge.body.errors).toBeUndefined();
    expect(merge.body.data.mergePeople.jobTitle).toBe(MERGED_PERSON_JOB_TITLE);

    const survivors = await readBehindTheRules<SeedPerson>({
      objectMetadataSingularName: 'person',
      objectMetadataPluralName: 'people',
      gqlFields: 'id jobTitle',
      filter: { jobTitle: { eq: MERGED_PERSON_JOB_TITLE } },
    });

    await destroyFixtureRecords({
      objectMetadataSingularName: 'person',
      recordIds: [
        ...new Set([...mergedPersonIds, ...survivors.map(({ id }) => id)]),
      ],
    });
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

  // hardening.md п. 3 (ONE-114), rls-design §12а Т-3/Т-7. `jobTitle` stands in
  // for an estimate's status field here, the same way it already stands in
  // for "DEAL" above (Т-2): the acceptance graph is
  // DRAFT → IN_REVIEW → CEO_APPROVED → SENT → ACCEPTED, with the three last
  // steps named to the application alone — this suite's human role can never
  // reach them, so what it proves is the refusal, not a pass-through it has
  // no way to perform over REST/GraphQL (the same posture the
  // writeProtectedFields tests above take for an application-only field).
  describe('a status field driven by a transition graph', () => {
    const estimateTransitionRules = (): OnemaAccessRules => ({
      application: APPLICATION_UNIVERSAL_IDENTIFIER,
      roles: { member: memberRoleUniversalIdentifier },
      objects: { person: { member: { all: true } } },
      transitions: {
        person: {
          field: 'jobTitle',
          rules: [
            { from: 'DRAFT', to: ['IN_REVIEW'], roleKeys: ['member'] },
            { from: 'IN_REVIEW', to: ['CEO_APPROVED', 'DRAFT'], roleKeys: [] },
            { from: 'CEO_APPROVED', to: ['SENT'], roleKeys: [] },
            { from: 'SENT', to: ['ACCEPTED'], roleKeys: [] },
          ],
        },
      },
    });

    const setJobTitleAsAdminForTransitions = (jobTitle: string) =>
      makeRequestAsAdmin(
        updateOneOperationFactory({
          objectMetadataSingularName: 'person',
          gqlFields: 'id jobTitle',
          recordId: ownedPersonId,
          data: { jobTitle },
        }),
      );

    // The task's own example: one PATCH from DRAFT to ACCEPTED must be refused
    // exactly as a PATCH that goes through REST without the server-side
    // transition command in front of it would be
    it('refuses jumping from DRAFT straight to ACCEPTED, skipping every required step', async () => {
      setOnemaAccessRulesForTesting(undefined);
      await setJobTitleAsAdminForTransitions('DRAFT');

      setOnemaAccessRulesForTesting(estimateTransitionRules());

      expectForbidden(
        await makeRequestAsJony(
          updateOneOperationFactory({
            objectMetadataSingularName: 'person',
            gqlFields: 'id jobTitle',
            recordId: ownedPersonId,
            data: { jobTitle: 'ACCEPTED' },
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
      ).toBe('DRAFT');
    });

    it('lets the one step the role is named for go through', async () => {
      setOnemaAccessRulesForTesting(undefined);
      await setJobTitleAsAdminForTransitions('DRAFT');

      setOnemaAccessRulesForTesting(estimateTransitionRules());

      const submission = await makeRequestAsJony(
        updateOneOperationFactory({
          objectMetadataSingularName: 'person',
          gqlFields: 'id jobTitle',
          recordId: ownedPersonId,
          data: { jobTitle: 'IN_REVIEW' },
        }),
      );

      expect(submission.body.errors).toBeUndefined();
      expect(submission.body.data.updatePerson.jobTitle).toBe('IN_REVIEW');
    });

    // The CEO decision is a server-side command (rls-design §12а Т-3), never a
    // PATCH under a role that merely holds "all" on the object
    it('refuses a role driving the step the graph hands to the application alone', async () => {
      setOnemaAccessRulesForTesting(undefined);
      await setJobTitleAsAdminForTransitions('IN_REVIEW');

      setOnemaAccessRulesForTesting(estimateTransitionRules());

      expectForbidden(
        await makeRequestAsJony(
          updateOneOperationFactory({
            objectMetadataSingularName: 'person',
            gqlFields: 'id jobTitle',
            recordId: ownedPersonId,
            data: { jobTitle: 'CEO_APPROVED' },
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
      ).toBe('IN_REVIEW');
    });

    // A value the graph never names in `from` has no edge at all, which is the
    // fail-closed default rather than a typo quietly opening every move
    it('refuses any move out of a status the graph does not know as a starting point', async () => {
      setOnemaAccessRulesForTesting(undefined);
      await setJobTitleAsAdminForTransitions('ACCEPTED');

      setOnemaAccessRulesForTesting(estimateTransitionRules());

      expectForbidden(
        await makeRequestAsJony(
          updateOneOperationFactory({
            objectMetadataSingularName: 'person',
            gqlFields: 'id jobTitle',
            recordId: ownedPersonId,
            data: { jobTitle: 'DRAFT' },
          }),
        ),
      );
    });
  });
});
