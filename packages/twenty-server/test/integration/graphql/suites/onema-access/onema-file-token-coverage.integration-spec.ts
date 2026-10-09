import gql from 'graphql-tag';
import { default as request } from 'supertest';
import { createOneOperationFactory } from 'test/integration/graphql/utils/create-one-operation-factory.util';
import { destroyOneOperationFactory } from 'test/integration/graphql/utils/destroy-one-operation-factory.util';
import { findManyOperationFactory } from 'test/integration/graphql/utils/find-many-operation-factory.util';
import { makeGraphqlApiRequest } from 'test/integration/graphql/utils/make-graphql-api-request.util';
import { uploadFileWithDirectUpload } from 'test/integration/graphql/utils/upload-file-with-direct-upload.util';
import { createOneFieldMetadata } from 'test/integration/metadata/suites/field-metadata/utils/create-one-field-metadata.util';
import { createOneObjectMetadata } from 'test/integration/metadata/suites/object-metadata/utils/create-one-object-metadata.util';
import { deleteOneObjectMetadata } from 'test/integration/metadata/suites/object-metadata/utils/delete-one-object-metadata.util';
import { updateOneObjectMetadata } from 'test/integration/metadata/suites/object-metadata/utils/update-one-object-metadata.util';
import { makeMetadataApiRequest } from 'test/integration/metadata/suites/utils/make-metadata-api-request.util';
import { FieldMetadataType } from 'twenty-shared/types';

import { setOnemaAccessRulesForTesting } from 'src/engine/onema-access/utils/load-onema-access-rules.util';
import { WORKSPACE_MEMBER_DATA_SEED_IDS } from 'src/engine/workspace-manager/dev-seeder/data/constants/workspace-member-data-seeds.constant';

const client = request(`http://localhost:${APP_PORT}`);

const OBJECT_NAME_SINGULAR = 'onemaFileTokenTestObject';
const OBJECT_NAME_PLURAL = 'onemaFileTokenTestObjects';
const FILE_CONTENT = 'the data room item of a project this member has left';

const deleteFileMutation = gql`
  mutation DeleteFile($fileId: UUID!) {
    deleteFile(fileId: $fileId) {
      id
    }
  }
`;

// rls-design §11, the two file rows: "Файл D2 по id без токена → 401" and
// "Файл вложения A2 по токену после потери доступа → ≤ FILE_TOKEN_EXPIRES_IN".
//
// Our rules live in the ORM, and the file endpoint is not an ORM read: it
// resolves a signed token and streams bytes off the storage driver. So the
// second row is not a gap to be closed by this PR but a window to be measured,
// and a window nobody has measured is indistinguishable from a leak. This suite
// is what makes it a number: a link handed out while the record was visible
// keeps working, for exactly as long as the token lives, and the record going
// out of sight does not shorten it.
describe('onemaFileTokenCoverage', () => {
  let createdObjectMetadataId = '';
  let createdRecordId = '';
  let fileId = '';
  let filePathname = '';
  let fileSearch = '';
  let memberRoleUniversalIdentifier: string;

  const findRecordsAsMember = async (): Promise<string[]> => {
    const response = await makeGraphqlApiRequest(
      findManyOperationFactory({
        objectMetadataSingularName: OBJECT_NAME_SINGULAR,
        objectMetadataPluralName: OBJECT_NAME_PLURAL,
        gqlFields: 'id',
        filter: { id: { eq: createdRecordId } },
      }),
      APPLE_JONY_MEMBER_ACCESS_TOKEN,
    );

    expect(response.body.errors).toBeUndefined();

    return response.body.data[OBJECT_NAME_PLURAL].edges.map(
      (edge: { node: { id: string } }) => edge.node.id,
    );
  };

  const closeTheObjectForTheMember = () =>
    // The object is named and the role of the member is not, which the rules
    // read as closed by default (README, "Умолчания")
    setOnemaAccessRulesForTesting({
      roles: { member: memberRoleUniversalIdentifier },
      objects: { [OBJECT_NAME_SINGULAR]: {} },
    });

  beforeAll(async () => {
    jest.useRealTimers();

    const rolesResponse = await client
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

    memberRoleUniversalIdentifier = rolesResponse.body.data.getRoles.find(
      (role: { workspaceMembers?: { id: string }[] }) =>
        role.workspaceMembers?.some(
          (workspaceMember) =>
            workspaceMember.id === WORKSPACE_MEMBER_DATA_SEED_IDS.JONY,
        ),
    ).universalIdentifier;

    expect(memberRoleUniversalIdentifier).toBeDefined();

    setOnemaAccessRulesForTesting(undefined);

    const {
      data: {
        createOneObject: { id: objectMetadataId },
      },
    } = await createOneObjectMetadata({
      input: {
        nameSingular: OBJECT_NAME_SINGULAR,
        namePlural: OBJECT_NAME_PLURAL,
        labelSingular: 'Onema File Token Test Object',
        labelPlural: 'Onema File Token Test Objects',
        icon: 'IconFile',
      },
    });

    createdObjectMetadataId = objectMetadataId;

    const {
      data: { createOneField: createdFieldMetadata },
    } = await createOneFieldMetadata({
      input: {
        name: 'filesField',
        label: 'Files Field',
        type: FieldMetadataType.FILES,
        objectMetadataId: createdObjectMetadataId,
        settings: { maxNumberOfValues: 5 },
      },
      gqlFields: `
        id
        name
      `,
    });

    const uploadedFile = await uploadFileWithDirectUpload({
      filename: 'data-room-item.txt',
      content: Buffer.from(FILE_CONTENT),
      fileFolder: 'FilesField',
      fieldMetadataId: createdFieldMetadata.id,
    });

    fileId = uploadedFile.id;

    const { pathname, search } = new URL(uploadedFile.url);

    filePathname = pathname;
    fileSearch = search;

    expect(fileSearch).toContain('token=');

    const createRecordResponse = await makeGraphqlApiRequest(
      createOneOperationFactory({
        objectMetadataSingularName: OBJECT_NAME_SINGULAR,
        gqlFields: 'id',
        data: { name: 'Onema file token test record' },
      }),
    );

    expect(createRecordResponse.body.errors).toBeUndefined();

    createdRecordId =
      createRecordResponse.body.data[
        `create${OBJECT_NAME_SINGULAR[0].toUpperCase()}${OBJECT_NAME_SINGULAR.slice(1)}`
      ].id;
  });

  afterAll(async () => {
    setOnemaAccessRulesForTesting(undefined);

    await makeGraphqlApiRequest(
      destroyOneOperationFactory({
        objectMetadataSingularName: OBJECT_NAME_SINGULAR,
        gqlFields: 'id',
        recordId: createdRecordId,
      }),
    );

    await makeMetadataApiRequest({
      query: deleteFileMutation,
      variables: { fileId },
    });

    await updateOneObjectMetadata({
      expectToFail: false,
      input: {
        idToUpdate: createdObjectMetadataId,
        updatePayload: { isActive: false },
      },
    });
    await deleteOneObjectMetadata({
      input: { idToDelete: createdObjectMetadataId },
    });

    jest.useFakeTimers();
  });

  afterEach(() => setOnemaAccessRulesForTesting(undefined));

  // rls-design §11 writes this row as "401"; the fork's file API exception
  // filter answers FileExceptionCode.UNAUTHENTICATED with 403
  // (file-api-exception.filter.ts), and that is the status every other
  // unauthenticated-file path in the fork already gets, not something this
  // PR changes. The matrix line should read 403 — flagged in the handover.
  it('refuses a file asked for by id without a token', async () => {
    const response = await request(global.app.getHttpServer()).get(
      filePathname,
    );

    expect(response.status).toBe(403);
  });

  it('serves the file to the holder of its token', async () => {
    const response = await request(global.app.getHttpServer()).get(
      `${filePathname}${fileSearch}`,
    );

    expect(response.status).toBe(200);
    expect(response.text).toBe(FILE_CONTENT);
  });

  // The window §11 asks for a number on: the record is gone from every read
  // path of the member, and the link they were handed before that still works.
  // The token is the whole authority here — no Authorization header is sent —
  // so nothing about the member is asked again until the token expires
  it('keeps serving a token handed out before the record went out of sight', async () => {
    expect(await findRecordsAsMember()).toEqual([createdRecordId]);

    closeTheObjectForTheMember();

    expect(await findRecordsAsMember()).toEqual([]);

    const response = await request(global.app.getHttpServer()).get(
      `${filePathname}${fileSearch}`,
    );

    expect(response.status).toBe(200);
    expect(response.text).toBe(FILE_CONTENT);
  });
});
