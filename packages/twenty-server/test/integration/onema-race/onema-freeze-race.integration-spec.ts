import { default as request } from 'supertest';
import {
  createFixtureCompany,
  createFixturePerson,
  destroyFixtureRecords,
} from 'test/integration/graphql/suites/onema-access/utils/onema-access-fixtures.util';
import { findManyOperationFactory } from 'test/integration/graphql/utils/find-many-operation-factory.util';
import { makeGraphqlApiRequest as makeRequestAsAdmin } from 'test/integration/graphql/utils/make-graphql-api-request.util';
import { makeGraphqlApiRequestWithMemberRole as makeRequestAsJony } from 'test/integration/graphql/utils/make-graphql-api-request-with-member-role.util';
import { updateOneOperationFactory } from 'test/integration/graphql/utils/update-one-operation-factory.util';

import { type OnemaAccessRules } from 'src/engine/onema-access/types/onema-access-rules.type';
import { setOnemaAccessRulesForTesting } from 'src/engine/onema-access/utils/load-onema-access-rules.util';
import { WORKSPACE_MEMBER_DATA_SEED_IDS } from 'src/engine/workspace-manager/dev-seeder/data/constants/workspace-member-data-seeds.constant';

// rls-design §12а Т-2, the race itself. This suite is deliberately outside the
// mandatory run: it issues nine concurrent mutations against one row and reads
// what the scheduler did with them, so it is a probabilistic test. With the row
// lock taken out it came back red in two runs out of three — useful, and not
// something a required check may hang on.
//
// It runs under its own jest config instead:
//   npx nx run twenty-server:test:integration:onema-race
//
// What the mandatory run keeps is the deterministic half of the same question —
// that the pre-image of the freeze is read under `SELECT … FOR UPDATE` inside
// the transaction that is about to write (onema-write-access.integration-spec.ts,
// "reads the pre-image of the freeze under a row lock…"), plus the unit test on
// the lock itself.
const client = request(`http://localhost:${APP_PORT}`);

const OWNED_COMPANY_NAME = 'Onema freeze race (owned)';
const SECOND_OWNED_COMPANY_NAME = 'Onema freeze race (owned, second)';
const RACED_PERSON_JOB_TITLE = 'Onema freeze race (person)';

type SeedPerson = {
  id: string;
  jobTitle: string | null;
  company?: { id: string } | null;
};

describe('onema freeze race', () => {
  let memberRoleUniversalIdentifier: string;
  let ownedCompanyId: string;
  let secondOwnedCompanyId: string;
  let racedPersonId: string;

  // Read back with the rules switched off and as the admin: the question is what
  // the row holds, not who may see it
  const readPersonBehindTheRules = async (): Promise<SeedPerson> => {
    setOnemaAccessRulesForTesting(undefined);

    const response = await makeRequestAsAdmin(
      findManyOperationFactory({
        objectMetadataSingularName: 'person',
        objectMetadataPluralName: 'people',
        gqlFields: 'id jobTitle company { id }',
        filter: { id: { eq: racedPersonId } },
        first: 1,
      }),
    );

    expect(response.body.errors).toBeUndefined();

    return response.body.data.people.edges[0].node;
  };

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
    racedPersonId = (
      await createFixturePerson({
        jobTitle: RACED_PERSON_JOB_TITLE,
        companyId: ownedCompanyId,
      })
    ).id;
  });

  afterAll(async () => {
    setOnemaAccessRulesForTesting(undefined);

    await destroyFixtureRecords({
      objectMetadataSingularName: 'person',
      recordIds: [racedPersonId],
    });
    await destroyFixtureRecords({
      objectMetadataSingularName: 'company',
      recordIds: [ownedCompanyId, secondOwnedCompanyId],
    });
  });

  afterEach(() => setOnemaAccessRulesForTesting(undefined));

  // The race itself, with no freeze in place when it starts: "the lead becomes a
  // DEAL" against "the lead changes company", issued together.
  //
  // Both racers write `jobTitle`, which is what makes the race observable at all.
  // The latch says the stage is reached and never left, so in every legitimate
  // serial order the row ends on DEAL. Without the lock a company racer that
  // read "PROPOSAL" before the DEAL committed still writes afterwards, puts
  // `jobTitle` back to PROPOSAL and leaves the row in a state no serial order
  // could reach — which is exactly what this asserts against.
  //
  // Which side loses is up to the scheduler and is not asserted: a company
  // change that commits before the DEAL is a legitimate order. What is asserted
  // is that the outcome agrees with the answers the racers were given.
  //
  // Verified by taking the lock out: the row came back on PROPOSAL, which no
  // serial order reaches. Being a real race it caught that in two runs out of
  // three, which is why there are eight company racers rather than one — and why
  // this suite is not part of the mandatory run.
  it('settles a freeze racing the write that creates it', async () => {
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

    setOnemaAccessRulesForTesting(undefined);
    await makeRequestAsAdmin(
      updateOneOperationFactory({
        objectMetadataSingularName: 'person',
        gqlFields: 'id jobTitle company { id }',
        recordId: racedPersonId,
        data: { jobTitle: 'PROPOSAL', companyId: ownedCompanyId },
      }),
    );

    setOnemaAccessRulesForTesting(latchedRules);

    const [dealRacer, ...companyRacers] = await Promise.all([
      makeRequestAsJony(
        updateOneOperationFactory({
          objectMetadataSingularName: 'person',
          gqlFields: 'id jobTitle',
          recordId: racedPersonId,
          data: { jobTitle: 'DEAL' },
        }),
      ),
      // The shape a form submits: the company the user picked, and the stage
      // the record showed when the form was opened
      ...[0, 1, 2, 3, 4, 5, 6, 7].map(() =>
        makeRequestAsJony(
          updateOneOperationFactory({
            objectMetadataSingularName: 'person',
            gqlFields: 'id jobTitle company { id }',
            recordId: racedPersonId,
            data: { jobTitle: 'PROPOSAL', companyId: secondOwnedCompanyId },
          }),
        ),
      ),
    ]);

    // Nothing freezes the move *into* the stage, so this one always holds
    expect(dealRacer.body.errors).toBeUndefined();

    for (const companyRacer of companyRacers) {
      if (companyRacer.body.errors !== undefined) {
        expect(
          (
            companyRacer.body.errors?.[0] as {
              extensions: { code: string };
            }
          ).extensions.code,
        ).toBe('FORBIDDEN');
      }
    }

    const settled = await readPersonBehindTheRules();

    expect(settled.jobTitle).toBe('DEAL');

    // A racer that was told its write went through has to be the state the row
    // is in; one that was refused must have changed nothing
    const hasCommittedCompanyChange = companyRacers.some(
      (companyRacer) => companyRacer.body.errors === undefined,
    );

    expect(settled.company?.id).toBe(
      hasCommittedCompanyChange ? secondOwnedCompanyId : ownedCompanyId,
    );
  });
});
