import { default as request } from 'supertest';
import {
  createFixtureCompany,
  destroyFixtureRecords,
} from 'test/integration/graphql/suites/onema-access/utils/onema-access-fixtures.util';
import { updateWorkflowVersionTrigger } from 'test/integration/graphql/suites/workflow/utils/update-workflow-version-trigger.util';
import {
  destroyWorkflowRun,
  runWorkflowVersion,
  waitForWorkflowCompletion,
} from 'test/integration/graphql/suites/workflow/utils/workflow-run-test.util';
import { v4 as uuidv4 } from 'uuid';

import { type OnemaAccessRules } from 'src/engine/onema-access/types/onema-access-rules.type';
import { setOnemaAccessRulesForTesting } from 'src/engine/onema-access/utils/load-onema-access-rules.util';
import { WORKSPACE_MEMBER_DATA_SEED_IDS } from 'src/engine/workspace-manager/dev-seeder/data/constants/workspace-member-data-seeds.constant';

const client = request(`http://localhost:${APP_PORT}`);

// A word of its own, so the step reads back the rows of this suite and nothing
// else the workspace happens to hold
const SUITE_TOKEN = 'onemaautomationpath';

const COMPANY_FIXTURES = [
  {
    name: `${SUITE_TOKEN} owned by the admin`,
    ownerId: WORKSPACE_MEMBER_DATA_SEED_IDS.JANE,
  },
  {
    name: `${SUITE_TOKEN} owned by the member`,
    ownerId: WORKSPACE_MEMBER_DATA_SEED_IDS.JONY,
  },
  {
    name: `${SUITE_TOKEN} owned by somebody else`,
    ownerId: WORKSPACE_MEMBER_DATA_SEED_IDS.PHIL,
  },
];

const postAsAdmin = (query: string, variables?: object) =>
  client
    .post('/graphql')
    .set('Authorization', `Bearer ${APPLE_JANE_ADMIN_ACCESS_TOKEN}`)
    .send({ query, variables });

// rls-design §11, the row "Workflow, ручной запуск S1, Search Records lead → L1".
// A workflow step reads records through a repository of its own, built inside a
// job rather than inside the request that asked for the run. If that repository
// carried the roles of nobody, the step would read either everything or nothing,
// and neither answer is the one the person who pressed the button is owed.
describe('onemaAutomationPathCoverage', () => {
  let adminRoleUniversalIdentifier: string;
  let companyNameFieldMetadataId: string;
  let workflowId: string;
  let workflowVersionId: string;
  let findRecordsStepId: string;
  let companyIdsUnderTest: string[] = [];
  const workflowRunIds: string[] = [];

  const findAdminRoleUniversalIdentifier = async () => {
    const response = await client
      .post('/metadata')
      .set('Authorization', `Bearer ${APPLE_JANE_ADMIN_ACCESS_TOKEN}`)
      .send({
        query: `
          query GetRoles {
            getRoles {
              universalIdentifier
              workspaceMembers {
                id
              }
            }
          }
        `,
      });

    return response.body.data.getRoles.find(
      (role: { workspaceMembers?: { id: string }[] }) =>
        role.workspaceMembers?.some(
          (workspaceMember) =>
            workspaceMember.id === WORKSPACE_MEMBER_DATA_SEED_IDS.JANE,
        ),
    ).universalIdentifier;
  };

  const findCompanyNameFieldMetadataId = async () => {
    const response = await client
      .post('/metadata')
      .set('Authorization', `Bearer ${APPLE_JANE_ADMIN_ACCESS_TOKEN}`)
      .send({
        query: `
          query GetObjects {
            objects(paging: { first: 1000 }) {
              edges {
                node {
                  nameSingular
                  fieldsList {
                    id
                    name
                  }
                }
              }
            }
          }
        `,
      });

    const companyObject = response.body.data.objects.edges
      .map((edge: { node: unknown }) => edge.node)
      .find(
        (object: { nameSingular: string }) => object.nameSingular === 'company',
      );

    return companyObject.fieldsList.find(
      (field: { name: string }) => field.name === 'name',
    ).id;
  };

  const buildWorkflowFindingTheCompaniesOfTheSuite = async () => {
    const createWorkflowResponse = await postAsAdmin(`
      mutation CreateWorkflow {
        createWorkflow(data: { name: "Onema automation path coverage" }) {
          id
        }
      }
    `);

    expect(createWorkflowResponse.body.errors).toBeUndefined();

    workflowId = createWorkflowResponse.body.data.createWorkflow.id;

    const workflowResponse = await postAsAdmin(
      `
        query GetWorkflow($id: UUID!) {
          workflow(filter: { id: { eq: $id } }) {
            versions {
              edges {
                node {
                  id
                }
              }
            }
          }
        }
      `,
      { id: workflowId },
    );

    workflowVersionId =
      workflowResponse.body.data.workflow.versions.edges[0].node.id;

    await updateWorkflowVersionTrigger({
      workflowVersionId,
      trigger: {
        name: 'Manual Trigger',
        type: 'MANUAL',
        settings: { outputSchema: {} },
        nextStepIds: [],
        position: { x: 0, y: 0 },
      },
    });

    const createStepResponse = await postAsAdmin(
      `
        mutation CreateWorkflowVersionStep($input: CreateWorkflowVersionStepInput!) {
          createWorkflowVersionStep(input: $input) {
            stepsDiff
          }
        }
      `,
      {
        input: {
          workflowVersionId,
          stepType: 'FIND_RECORDS',
          parentStepId: 'trigger',
          position: { x: 200, y: 0 },
        },
      },
    );

    expect(createStepResponse.body.errors).toBeUndefined();

    const versionResponse = await postAsAdmin(
      `
        query GetWorkflowVersion($id: UUID!) {
          workflowVersion(filter: { id: { eq: $id } }) {
            steps
          }
        }
      `,
      { id: workflowVersionId },
    );

    const findRecordsStep =
      versionResponse.body.data.workflowVersion.steps.find(
        (step: { type: string }) => step.type === 'FIND_RECORDS',
      );

    expect(findRecordsStep).toBeDefined();

    findRecordsStepId = findRecordsStep.id;

    const recordFilterGroupId = uuidv4();

    const updateStepResponse = await postAsAdmin(
      `
        mutation UpdateWorkflowVersionStep($input: UpdateWorkflowVersionStepInput!) {
          updateWorkflowVersionStep(input: $input) {
            id
          }
        }
      `,
      {
        input: {
          workflowVersionId,
          step: {
            ...findRecordsStep,
            settings: {
              ...findRecordsStep.settings,
              input: {
                ...findRecordsStep.settings.input,
                objectName: 'company',
                limit: 25,
                filter: {
                  recordFilters: [
                    {
                      id: uuidv4(),
                      type: 'TEXT',
                      label: 'Name',
                      value: SUITE_TOKEN,
                      operand: 'CONTAINS',
                      displayValue: SUITE_TOKEN,
                      fieldMetadataId: companyNameFieldMetadataId,
                      recordFilterGroupId,
                    },
                  ],
                  recordFilterGroups: [
                    { id: recordFilterGroupId, logicalOperator: 'AND' },
                  ],
                },
              },
            },
          },
        },
      },
    );

    expect(updateStepResponse.body.errors).toBeUndefined();

    const activateResponse = await postAsAdmin(
      `
        mutation ActivateWorkflowVersion($workflowVersionId: UUID!) {
          activateWorkflowVersion(workflowVersionId: $workflowVersionId)
        }
      `,
      { workflowVersionId },
    );

    expect(activateResponse.body.errors).toBeUndefined();
  };

  const runByHandAndReadTheStep = async (): Promise<string[]> => {
    const workflowRunId = await runWorkflowVersion({ workflowVersionId });

    workflowRunIds.push(workflowRunId);

    const workflowRun = await waitForWorkflowCompletion(workflowRunId);

    expect(workflowRun?.status).toBe('COMPLETED');
    expect(workflowRun?.state?.stepInfos?.[findRecordsStepId]?.status).toBe(
      'SUCCESS',
    );

    const result = workflowRun?.state?.stepInfos?.[findRecordsStepId]
      ?.result as { all?: { name: string }[] } | undefined;

    return (result?.all ?? [])
      .map((record) => record.name)
      .filter((name) => name.startsWith(SUITE_TOKEN))
      .sort();
  };

  beforeAll(async () => {
    jest.useRealTimers();

    adminRoleUniversalIdentifier = await findAdminRoleUniversalIdentifier();
    companyNameFieldMetadataId = await findCompanyNameFieldMetadataId();

    expect(adminRoleUniversalIdentifier).toBeDefined();
    expect(companyNameFieldMetadataId).toBeDefined();

    setOnemaAccessRulesForTesting(undefined);

    const createdCompanies = [];

    for (const { name, ownerId } of COMPANY_FIXTURES) {
      createdCompanies.push(
        await createFixtureCompany({ name, accountOwnerId: ownerId }),
      );
    }

    companyIdsUnderTest = createdCompanies.map((company) => company.id);

    await buildWorkflowFindingTheCompaniesOfTheSuite();
  });

  afterAll(async () => {
    setOnemaAccessRulesForTesting(undefined);

    for (const workflowRunId of workflowRunIds) {
      await destroyWorkflowRun(workflowRunId);
    }

    await postAsAdmin(
      `mutation DestroyWorkflow($id: ID!) { destroyWorkflow(id: $id) { id } }`,
      { id: workflowId },
    );

    await destroyFixtureRecords({
      objectMetadataSingularName: 'company',
      recordIds: companyIdsUnderTest,
    });

    jest.useFakeTimers();
  });

  afterEach(() => setOnemaAccessRulesForTesting(undefined));

  it('finds every company of the suite while no rules file is configured', async () => {
    expect(await runByHandAndReadTheStep()).toHaveLength(
      COMPANY_FIXTURES.length,
    );
  });

  // The run is started by hand by the admin, and the rule is written for the
  // role the admin holds: the step is owed the rows of the person who pressed
  // the button, not the rows of the job that carried the press
  it('finds only the company of whoever started the run', async () => {
    const rules: OnemaAccessRules = {
      roles: { admin: adminRoleUniversalIdentifier },
      objects: {
        company: { admin: { eq: ['accountOwner', '$me'] } },
      },
    };

    setOnemaAccessRulesForTesting(rules);

    expect(await runByHandAndReadTheStep()).toEqual([COMPANY_FIXTURES[0].name]);
  });
});
