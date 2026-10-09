import gql from 'graphql-tag';
import { default as request } from 'supertest';
import {
  createFixtureCompany,
  destroyFixtureRecords,
} from 'test/integration/graphql/suites/onema-access/utils/onema-access-fixtures.util';
import { createOneOperationFactory } from 'test/integration/graphql/utils/create-one-operation-factory.util';
import { findManyOperationFactory } from 'test/integration/graphql/utils/find-many-operation-factory.util';
import { makeGraphqlApiRequest as makeRequestAsAdmin } from 'test/integration/graphql/utils/make-graphql-api-request.util';
import { makeGraphqlApiRequestWithMemberRole as makeRequestAsJony } from 'test/integration/graphql/utils/make-graphql-api-request-with-member-role.util';
import { updateOneOperationFactory } from 'test/integration/graphql/utils/update-one-operation-factory.util';

import {
  type OnemaAccessRules,
  type OnemaCondition,
} from 'src/engine/onema-access/types/onema-access-rules.type';
import { setOnemaAccessRulesForTesting } from 'src/engine/onema-access/utils/load-onema-access-rules.util';
import { WORKSPACE_MEMBER_DATA_SEED_IDS } from 'src/engine/workspace-manager/dev-seeder/data/constants/workspace-member-data-seeds.constant';

const client = request(`http://localhost:${APP_PORT}`);

const OWNED_COMPANY_NAME = 'Onema polymorphic (owned)';
const SECOND_OWNED_COMPANY_NAME = 'Onema polymorphic (owned, second)';
const FOREIGN_COMPANY_NAME = 'Onema polymorphic (foreign)';
const SUITE_TAG = 'Onema polymorphic';

type RecordNode = { id: string };

const createAsAdmin = async ({
  objectMetadataSingularName,
  data,
}: {
  objectMetadataSingularName: string;
  data: object;
}): Promise<string> => {
  const response = await makeRequestAsAdmin(
    createOneOperationFactory({
      objectMetadataSingularName,
      gqlFields: 'id',
      data,
    }),
  );

  expect(response.body.errors).toBeUndefined();

  return response.body.data[
    `create${objectMetadataSingularName[0].toUpperCase()}${objectMetadataSingularName.slice(1)}`
  ].id;
};

const findAsJony = async ({
  objectMetadataSingularName,
  objectMetadataPluralName,
  filter,
}: {
  objectMetadataSingularName: string;
  objectMetadataPluralName: string;
  filter: object;
}): Promise<string[]> => {
  const response = await makeRequestAsJony(
    findManyOperationFactory({
      objectMetadataSingularName,
      objectMetadataPluralName,
      gqlFields: 'id',
      filter,
      first: 200,
    }),
  );

  expect(response.body.errors).toBeUndefined();

  return response.body.data[objectMetadataPluralName].edges.map(
    (edge: { node: RecordNode }) => edge.node.id,
  );
};

// Attaching a polymorphic child to a record the caller cannot write is refused
// by upstream before the check after the write is reached — upstream asks
// whether the target is writable, and that question goes through the predicate
// our rules add. So the message is upstream's, the reason is ours, and the
// check after the write (ONE-111) stays the backstop for whatever upstream
// does not ask about. Each test below proves the refusal is ours by showing
// the same write going through once the rules are off or once the target is a
// record the member owns.
const expectRefused = (response: { body: { errors?: unknown[] } }): void => {
  const error = response.body.errors?.[0] as
    | { message: string; extensions: { code: string } }
    | undefined;

  expect(error?.extensions.code).toBe('FORBIDDEN');
};

const anyParentOnCompany: OnemaCondition = {
  anyParent: {
    parents: [{ foreignKey: 'targetCompany', object: 'company' }],
  },
};

describe('onemaPolymorphicAccess', () => {
  let memberRoleUniversalIdentifier: string;
  let noteObjectMetadataId: string;
  let timelineActivityTypeId: string;

  let ownedCompanyId: string;
  // A note target is unique per (note, target), so the lawful control write of
  // the write tests needs a second record the member owns
  let secondOwnedCompanyId: string;
  let foreignCompanyId: string;
  let ownedAttachmentId: string;
  let foreignAttachmentId: string;
  let orphanAttachmentId: string;
  let ownedNoteId: string;
  let foreignNoteId: string;
  let ownedNoteTargetId: string;
  let foreignNoteTargetId: string;
  let ownedTaskTargetId: string;
  let foreignTaskTargetId: string;
  let ownedActivityId: string;
  let foreignActivityId: string;
  let movedActivityId: string;
  const createdTaskIds: string[] = [];
  const createdNoteIdsOfJony: string[] = [];
  const createdNoteTargetIdsOfJony: string[] = [];

  // Every rule of this suite hangs on one visible card, so the whole file reads
  // as "what else does that card open, and what does it not"
  const polymorphicRules = (): OnemaAccessRules => ({
    roles: { member: memberRoleUniversalIdentifier },
    objects: {
      company: { member: { eq: ['accountOwner', '$me'] } },
      attachment: { member: anyParentOnCompany },
      noteTarget: { member: anyParentOnCompany },
      taskTarget: { member: anyParentOnCompany },
      note: {
        member: {
          exists: { object: 'noteTarget', backForeignKey: 'note' },
        },
      },
      timelineActivity: {
        member: {
          and: [
            anyParentOnCompany,
            {
              or: [
                { eq: ['linkedObjectMetadataId', null] },
                {
                  linked: {
                    objectIdField: 'linkedObjectMetadataId',
                    recordIdField: 'linkedRecordId',
                    objects: ['company', 'note'],
                  },
                },
              ],
            },
          ],
        },
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

    const objectsResponse = await client
      .post('/metadata')
      .set('Authorization', `Bearer ${APPLE_JANE_ADMIN_ACCESS_TOKEN}`)
      .send({
        query: `
          query GetObjects {
            objects(paging: { first: 1000 }) {
              edges {
                node {
                  id
                  nameSingular
                }
              }
            }
          }
        `,
      });

    noteObjectMetadataId = objectsResponse.body.data.objects.edges.find(
      (edge: { node: { nameSingular: string } }) =>
        edge.node.nameSingular === 'note',
    ).node.id;

    const timelineActivityTypesResponse = await client
      .post('/metadata')
      .set('Authorization', `Bearer ${APPLE_JANE_ADMIN_ACCESS_TOKEN}`)
      .send({
        query: `
          query GetTimelineActivityTypes {
            timelineActivityTypes {
              id
            }
          }
        `,
      });

    timelineActivityTypeId =
      timelineActivityTypesResponse.body.data.timelineActivityTypes[0].id;

    expect(timelineActivityTypeId).toBeDefined();

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

    ownedAttachmentId = await createAsAdmin({
      objectMetadataSingularName: 'attachment',
      data: {
        name: `${SUITE_TAG} owned attachment`,
        targetCompanyId: ownedCompanyId,
      },
    });
    foreignAttachmentId = await createAsAdmin({
      objectMetadataSingularName: 'attachment',
      data: {
        name: `${SUITE_TAG} foreign attachment`,
        targetCompanyId: foreignCompanyId,
      },
    });
    // Every target column empty: nothing says whose record this file belongs to
    orphanAttachmentId = await createAsAdmin({
      objectMetadataSingularName: 'attachment',
      data: { name: `${SUITE_TAG} orphan attachment` },
    });

    ownedNoteId = await createAsAdmin({
      objectMetadataSingularName: 'note',
      data: { title: `${SUITE_TAG} owned note` },
    });
    foreignNoteId = await createAsAdmin({
      objectMetadataSingularName: 'note',
      data: { title: `${SUITE_TAG} foreign note` },
    });
    ownedNoteTargetId = await createAsAdmin({
      objectMetadataSingularName: 'noteTarget',
      data: { noteId: ownedNoteId, targetCompanyId: ownedCompanyId },
    });
    foreignNoteTargetId = await createAsAdmin({
      objectMetadataSingularName: 'noteTarget',
      data: { noteId: foreignNoteId, targetCompanyId: foreignCompanyId },
    });

    const ownedTaskId = await createAsAdmin({
      objectMetadataSingularName: 'task',
      data: { title: `${SUITE_TAG} owned task` },
    });
    const foreignTaskId = await createAsAdmin({
      objectMetadataSingularName: 'task',
      data: { title: `${SUITE_TAG} foreign task` },
    });

    ownedTaskTargetId = await createAsAdmin({
      objectMetadataSingularName: 'taskTarget',
      data: { taskId: ownedTaskId, targetCompanyId: ownedCompanyId },
    });
    foreignTaskTargetId = await createAsAdmin({
      objectMetadataSingularName: 'taskTarget',
      data: { taskId: foreignTaskId, targetCompanyId: foreignCompanyId },
    });

    createdTaskIds.push(ownedTaskId, foreignTaskId);

    // The history of the card itself: no linked record, so only the feed it
    // hangs on decides who may read the diff it carries
    ownedActivityId = await createAsAdmin({
      objectMetadataSingularName: 'timelineActivity',
      data: {
        timelineActivityTypeId,
        happensAt: '2026-01-01T10:00:00.000Z',
        targetCompanyId: ownedCompanyId,
      },
    });
    foreignActivityId = await createAsAdmin({
      objectMetadataSingularName: 'timelineActivity',
      data: {
        timelineActivityTypeId,
        happensAt: '2026-01-01T11:00:00.000Z',
        targetCompanyId: foreignCompanyId,
      },
    });
    // An event about the note of the foreign company, routed onto the feed of
    // the company the member owns: rls-design §3.1, throughRules
    movedActivityId = await createAsAdmin({
      objectMetadataSingularName: 'timelineActivity',
      data: {
        timelineActivityTypeId,
        happensAt: '2026-01-01T12:00:00.000Z',
        targetCompanyId: ownedCompanyId,
        linkedObjectMetadataId: noteObjectMetadataId,
        linkedRecordId: foreignNoteId,
      },
    });
  });

  afterAll(async () => {
    setOnemaAccessRulesForTesting(undefined);

    await destroyFixtureRecords({
      objectMetadataSingularName: 'timelineActivity',
      recordIds: [ownedActivityId, foreignActivityId, movedActivityId],
    });
    await destroyFixtureRecords({
      objectMetadataSingularName: 'attachment',
      recordIds: [ownedAttachmentId, foreignAttachmentId, orphanAttachmentId],
    });
    await destroyFixtureRecords({
      objectMetadataSingularName: 'noteTarget',
      recordIds: [
        ownedNoteTargetId,
        foreignNoteTargetId,
        ...createdNoteTargetIdsOfJony,
      ],
    });
    await destroyFixtureRecords({
      objectMetadataSingularName: 'taskTarget',
      recordIds: [ownedTaskTargetId, foreignTaskTargetId],
    });
    await destroyFixtureRecords({
      objectMetadataSingularName: 'note',
      recordIds: [ownedNoteId, foreignNoteId, ...createdNoteIdsOfJony],
    });
    await destroyFixtureRecords({
      objectMetadataSingularName: 'task',
      recordIds: createdTaskIds,
    });
    await destroyFixtureRecords({
      objectMetadataSingularName: 'company',
      recordIds: [ownedCompanyId, secondOwnedCompanyId, foreignCompanyId],
    });
  });

  afterEach(() => setOnemaAccessRulesForTesting(undefined));

  const findAttachments = () =>
    findAsJony({
      objectMetadataSingularName: 'attachment',
      objectMetadataPluralName: 'attachments',
      filter: {
        id: {
          in: [ownedAttachmentId, foreignAttachmentId, orphanAttachmentId],
        },
      },
    });

  // rls-design §11: "вложение A2 (на чужом лиде)" — the attachment of a record
  // the role cannot see must not come back, and the file token with it.
  // The attachment with no target at all never reaches this role even without
  // our rules, so the baseline is what the role sees, not what exists: an
  // orphan is closed by upstream here, and by `anyParent` having no branch to
  // satisfy once the rules are on (compile-onema-row-access.util.spec.ts).
  it('shows an attachment of a visible record and hides the one of a foreign record', async () => {
    setOnemaAccessRulesForTesting(undefined);

    expect((await findAttachments()).sort()).toEqual(
      [ownedAttachmentId, foreignAttachmentId].sort(),
    );

    setOnemaAccessRulesForTesting(polymorphicRules());

    expect(await findAttachments()).toEqual([ownedAttachmentId]);
  });

  // rls-design §11: "note/noteTarget N2". The note itself carries the text, so
  // both the join row and the note behind it have to close
  it('hides the note and the note target of a foreign record', async () => {
    setOnemaAccessRulesForTesting(polymorphicRules());

    expect(
      await findAsJony({
        objectMetadataSingularName: 'noteTarget',
        objectMetadataPluralName: 'noteTargets',
        filter: { id: { in: [ownedNoteTargetId, foreignNoteTargetId] } },
      }),
    ).toEqual([ownedNoteTargetId]);

    expect(
      await findAsJony({
        objectMetadataSingularName: 'note',
        objectMetadataPluralName: 'notes',
        filter: { id: { in: [ownedNoteId, foreignNoteId] } },
      }),
    ).toEqual([ownedNoteId]);
  });

  it('hides the task target of a foreign record', async () => {
    setOnemaAccessRulesForTesting(polymorphicRules());

    expect(
      await findAsJony({
        objectMetadataSingularName: 'taskTarget',
        objectMetadataPluralName: 'taskTargets',
        filter: { id: { in: [ownedTaskTargetId, foreignTaskTargetId] } },
      }),
    ).toEqual([ownedTaskTargetId]);
  });

  // rls-design §11: "timelineActivity по L2 (в т.ч. через чужую ленту)". The
  // row carries the diff of the record it is about, so the feed it hangs on is
  // not enough — the event moved onto a visible feed stays closed because the
  // record behind it is not visible
  it('hides a timeline activity of a foreign record, moved onto a visible feed or not', async () => {
    setOnemaAccessRulesForTesting(undefined);

    const everyActivityId = [
      ownedActivityId,
      foreignActivityId,
      movedActivityId,
    ];
    const findActivities = () =>
      findAsJony({
        objectMetadataSingularName: 'timelineActivity',
        objectMetadataPluralName: 'timelineActivities',
        filter: { id: { in: everyActivityId } },
      });

    expect((await findActivities()).sort()).toEqual(
      [...everyActivityId].sort(),
    );

    setOnemaAccessRulesForTesting(polymorphicRules());

    expect(await findActivities()).toEqual([ownedActivityId]);
  });

  // The note is created before anything points at it, so a rule made only of
  // `exists noteTarget` would refuse the creation it is supposed to protect
  it('lets the author of a note see it before any target points at it', async () => {
    setOnemaAccessRulesForTesting({
      roles: { member: memberRoleUniversalIdentifier },
      objects: {
        company: { member: { eq: ['accountOwner', '$me'] } },
        noteTarget: { member: anyParentOnCompany },
        note: {
          member: {
            or: [
              { exists: { object: 'noteTarget', backForeignKey: 'note' } },
              { eq: ['createdByWorkspaceMemberId', '$me'] },
            ],
          },
        },
      },
    });

    const creation = await makeRequestAsJony(
      createOneOperationFactory({
        objectMetadataSingularName: 'note',
        gqlFields: 'id',
        data: { title: `${SUITE_TAG} note of its author` },
      }),
    );

    expect(creation.body.errors).toBeUndefined();

    createdNoteIdsOfJony.push(creation.body.data.createNote.id);
  });

  // rls-design §11, "C1 создаёт attachment на L2". The control comes first: the
  // very same write goes through while the rules are off, so the refusal that
  // follows is the rules talking and not a permission the member never had
  it('refuses an attachment created on a record its author cannot see', async () => {
    setOnemaAccessRulesForTesting(undefined);

    const createAttachmentOnTheForeignCompany = () =>
      makeRequestAsJony(
        createOneOperationFactory({
          objectMetadataSingularName: 'attachment',
          gqlFields: 'id',
          data: {
            name: `${SUITE_TAG} refused attachment`,
            targetCompanyId: foreignCompanyId,
          },
        }),
      );

    const withoutRules = await createAttachmentOnTheForeignCompany();

    expect(withoutRules.body.errors).toBeUndefined();

    await destroyFixtureRecords({
      objectMetadataSingularName: 'attachment',
      recordIds: [withoutRules.body.data.createAttachment.id],
    });

    setOnemaAccessRulesForTesting(polymorphicRules());

    expectRefused(await createAttachmentOnTheForeignCompany());

    setOnemaAccessRulesForTesting(undefined);

    const response = await makeRequestAsAdmin(
      findManyOperationFactory({
        objectMetadataSingularName: 'attachment',
        objectMetadataPluralName: 'attachments',
        gqlFields: 'id',
        filter: { name: { eq: `${SUITE_TAG} refused attachment` } },
      }),
    );

    expect(response.body.data.attachments.edges).toEqual([]);
  });

  // "Refused" means nothing until the same rule lets the lawful write through,
  // so the control runs in the same test
  it('refuses a note target pointed at a foreign record and allows the owned one', async () => {
    setOnemaAccessRulesForTesting(polymorphicRules());

    expectRefused(
      await makeRequestAsJony(
        createOneOperationFactory({
          objectMetadataSingularName: 'noteTarget',
          gqlFields: 'id',
          data: { noteId: ownedNoteId, targetCompanyId: foreignCompanyId },
        }),
      ),
    );

    const allowed = await makeRequestAsJony(
      createOneOperationFactory({
        objectMetadataSingularName: 'noteTarget',
        gqlFields: 'id',
        data: { noteId: ownedNoteId, targetCompanyId: secondOwnedCompanyId },
      }),
    );

    expect(allowed.body.errors).toBeUndefined();

    createdNoteTargetIdsOfJony.push(allowed.body.data.createNoteTarget.id);
  });

  // Moving the target of a row the role may see into a record it may not is the
  // same hole as creating it there, and it is the one point №1 cannot close
  it('refuses moving a note target onto a foreign record', async () => {
    setOnemaAccessRulesForTesting(polymorphicRules());

    expectRefused(
      await makeRequestAsJony(
        updateOneOperationFactory({
          objectMetadataSingularName: 'noteTarget',
          gqlFields: 'id',
          recordId: ownedNoteTargetId,
          data: { targetCompanyId: foreignCompanyId },
        }),
      ),
    );

    setOnemaAccessRulesForTesting(undefined);

    const response = await makeRequestAsAdmin({
      query: gql`
        query NoteTargetAfterRefusedMove($filter: NoteTargetFilterInput) {
          noteTargets(filter: $filter) {
            edges {
              node {
                id
                targetCompanyId
              }
            }
          }
        }
      `,
      variables: { filter: { id: { eq: ownedNoteTargetId } } },
    });

    expect(response.body.data.noteTargets.edges[0].node.targetCompanyId).toBe(
      ownedCompanyId,
    );
  });
});
