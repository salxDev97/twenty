import { default as request } from 'supertest';
import {
  createFixtureCompany,
  destroyFixtureRecords,
} from 'test/integration/graphql/suites/onema-access/utils/onema-access-fixtures.util';
import { getAppProviderByClassName } from 'test/integration/utils/get-app-provider-by-class-name.util';
import { getCoreRepository } from 'test/integration/utils/get-core-repository.util';

import { UserWorkspaceEntity } from 'src/engine/core-modules/user-workspace/user-workspace.entity';
import { type UserWorkspaceAuthContext } from 'src/engine/core-modules/auth/types/workspace-auth-context.type';
import { type OnemaAccessRules } from 'src/engine/onema-access/types/onema-access-rules.type';
import { setOnemaAccessRulesForTesting } from 'src/engine/onema-access/utils/load-onema-access-rules.util';
import { type WorkspaceRepository } from 'src/engine/twenty-orm/repository/workspace-repository';
import { WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { buildSystemAuthContext } from 'src/engine/twenty-orm/utils/build-system-auth-context.util';
import { SEED_APPLE_WORKSPACE_ID } from 'src/engine/workspace-manager/dev-seeder/core/constants/seeder-workspaces.constant';
import { USER_DATA_SEED_IDS } from 'src/engine/workspace-manager/dev-seeder/core/utils/seed-users.util';
import { WORKSPACE_MEMBER_DATA_SEED_IDS } from 'src/engine/workspace-manager/dev-seeder/data/constants/workspace-member-data-seeds.constant';

const client = request(`http://localhost:${APP_PORT}`);

type SeedCompany = { id: string; name: string; accountOwnerId: string | null };

// Б3, which the review would not take on a GraphQL `createMany(upsert: true)`
// alone: the native `WorkspaceRepository.upsert` with a conflict path that is
// not the id, resolving against a record the author cannot see.
//
// What the repository does with it, read from the code and pinned here: ORM v2
// emits no `ON CONFLICT DO UPDATE` at all (onema-raw-write-guard.spec.ts keeps
// it that way across the whole server). `upsert` resolves the conflict with its
// own SELECT, which deliberately bypasses every predicate, and then routes each
// entity to the ordinary insert or batch-update path. So the conflict *finds*
// the hidden record — and the update path then drops it, because the ids it may
// write are resolved under the predicate of point №1. The upsert comes back
// having done nothing: a `DO NOTHING` reached the long way round.
//
// That is the outcome worth pinning. The hidden record must not be taken over,
// and a silent no-op is the answer — not an error, and not an insert that would
// collide with it.
describe('onema upsert write access', () => {
  let memberRoleUniversalIdentifier: string;
  let jonyAuthContext: UserWorkspaceAuthContext;

  const companyOwnedByMeRules = (): OnemaAccessRules => ({
    roles: { member: memberRoleUniversalIdentifier },
    objects: { company: { member: { eq: ['accountOwner', '$me'] } } },
  });

  const workspaceOrmManager = () =>
    getAppProviderByClassName<WorkspaceOrmManager>('WorkspaceOrmManager');

  const upsertCompaniesAsJony = (
    companies: Record<string, unknown>[],
    conflictPaths: string[],
  ): Promise<unknown> =>
    workspaceOrmManager().executeInWorkspaceContext(
      () =>
        (
          workspaceOrmManager().getRepositoryWithContextPermissions(
            'company',
          ) as WorkspaceRepository
        ).upsert(companies, conflictPaths),
      jonyAuthContext,
    );

  // Read back as the system with the rules switched off: the question is what
  // the row holds, not who may see it
  const readCompaniesNamed = (name: string): Promise<SeedCompany[]> => {
    setOnemaAccessRulesForTesting(undefined);

    return workspaceOrmManager().executeInWorkspaceContext(
      () =>
        (
          workspaceOrmManager().getRepository('company', {
            shouldBypassPermissionChecks: true,
          }) as WorkspaceRepository
        ).find({ where: { name } }) as Promise<SeedCompany[]>,
      buildSystemAuthContext(SEED_APPLE_WORKSPACE_ID),
    );
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

    // The role of the subject is read from this userWorkspaceId, so it is
    // looked up rather than assumed
    const jonyUserWorkspace = await getCoreRepository<UserWorkspaceEntity>(
      UserWorkspaceEntity,
    ).findOne({
      where: {
        userId: USER_DATA_SEED_IDS.JONY,
        workspaceId: SEED_APPLE_WORKSPACE_ID,
      },
    });

    expect(jonyUserWorkspace).toBeDefined();

    jonyAuthContext = {
      type: 'user',
      workspace: { id: SEED_APPLE_WORKSPACE_ID },
      userWorkspaceId: jonyUserWorkspace?.id,
      workspaceMemberId: WORKSPACE_MEMBER_DATA_SEED_IDS.JONY,
      user: { id: USER_DATA_SEED_IDS.JONY },
      workspaceMember: { id: WORKSPACE_MEMBER_DATA_SEED_IDS.JONY },
    } as unknown as UserWorkspaceAuthContext;
  });

  afterEach(() => setOnemaAccessRulesForTesting(undefined));

  // Every test builds and destroys its own rows, so the order they run in says
  // nothing about whether they pass
  const withOwnCompanies = async (
    names: { name: string; accountOwnerId: string }[],
    work: (companyIds: string[]) => Promise<void>,
  ): Promise<void> => {
    setOnemaAccessRulesForTesting(undefined);

    const companyIds: string[] = [];

    try {
      for (const company of names) {
        companyIds.push((await createFixtureCompany(company)).id);
      }

      await work(companyIds);
    } finally {
      setOnemaAccessRulesForTesting(undefined);

      const leftovers = await readCompaniesNamed(names[0].name);

      await destroyFixtureRecords({
        objectMetadataSingularName: 'company',
        recordIds: [
          ...new Set([
            ...companyIds,
            ...leftovers.map((company) => company.id),
          ]),
        ],
      });
    }
  };

  it('leaves a record the author cannot see untouched when the conflict path matches it', async () => {
    const hiddenName = `Onema upsert (hidden ${Date.now()})`;

    await withOwnCompanies(
      [
        {
          name: hiddenName,
          accountOwnerId: WORKSPACE_MEMBER_DATA_SEED_IDS.PHIL,
        },
      ],
      async ([hiddenCompanyId]) => {
        setOnemaAccessRulesForTesting(companyOwnedByMeRules());

        await upsertCompaniesAsJony(
          [
            {
              name: hiddenName,
              accountOwnerId: WORKSPACE_MEMBER_DATA_SEED_IDS.JONY,
            },
          ],
          ['name'],
        );

        const companiesNamed = await readCompaniesNamed(hiddenName);

        // Not taken over, and not duplicated either: the conflict matched the
        // hidden row, so nothing was inserted beside it
        expect(companiesNamed).toHaveLength(1);
        expect(companiesNamed[0].id).toBe(hiddenCompanyId);
        expect(companiesNamed[0].accountOwnerId).toBe(
          WORKSPACE_MEMBER_DATA_SEED_IDS.PHIL,
        );
      },
    );
  });

  // The same call on a record the author does own goes through, so the test
  // above is proving a refusal rather than a path that never runs
  it('updates a record the author owns when the conflict path matches it', async () => {
    const ownedName = `Onema upsert (owned ${Date.now()})`;

    await withOwnCompanies(
      [
        {
          name: ownedName,
          accountOwnerId: WORKSPACE_MEMBER_DATA_SEED_IDS.JONY,
        },
      ],
      async ([ownedCompanyId]) => {
        setOnemaAccessRulesForTesting(companyOwnedByMeRules());

        await upsertCompaniesAsJony(
          [{ name: ownedName, employees: 42 }],
          ['name'],
        );

        const companiesNamed = await readCompaniesNamed(ownedName);

        expect(companiesNamed).toHaveLength(1);
        expect(companiesNamed[0].id).toBe(ownedCompanyId);
        expect(
          (companiesNamed[0] as unknown as { employees: number }).employees,
        ).toBe(42);
      },
    );
  });

  // A conflict that matches nothing is an insert, and the insert path carries
  // the owner default and the check after the write like any other creation
  it('refuses an insert the author would not be able to see afterwards', async () => {
    const createdName = `Onema upsert (created ${Date.now()})`;

    await withOwnCompanies(
      [
        {
          name: `${createdName} anchor`,
          accountOwnerId: WORKSPACE_MEMBER_DATA_SEED_IDS.JONY,
        },
      ],
      async () => {
        setOnemaAccessRulesForTesting(companyOwnedByMeRules());

        await expect(
          upsertCompaniesAsJony(
            [
              {
                name: createdName,
                accountOwnerId: WORKSPACE_MEMBER_DATA_SEED_IDS.PHIL,
              },
            ],
            ['name'],
          ),
        ).rejects.toThrow();

        expect(await readCompaniesNamed(createdName)).toEqual([]);
      },
    );
  });
});
