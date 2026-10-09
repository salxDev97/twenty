import gql from 'graphql-tag';
import { uploadFileWithDirectUpload } from 'test/integration/graphql/utils/upload-file-with-direct-upload.util';
import { createOneFieldMetadata } from 'test/integration/metadata/suites/field-metadata/utils/create-one-field-metadata.util';
import { createOneObjectMetadata } from 'test/integration/metadata/suites/object-metadata/utils/create-one-object-metadata.util';
import { deleteOneObjectMetadata } from 'test/integration/metadata/suites/object-metadata/utils/delete-one-object-metadata.util';
import { updateOneObjectMetadata } from 'test/integration/metadata/suites/object-metadata/utils/update-one-object-metadata.util';
import { makeMetadataApiRequest } from 'test/integration/metadata/suites/utils/make-metadata-api-request.util';
import { getAppProviderByClassName } from 'test/integration/utils/get-app-provider-by-class-name.util';
import { EmailOperation, FieldMetadataType } from 'twenty-shared/types';

import { EmailComposerService } from 'src/engine/core-modules/tool/tools/email-tool/email-composer.service';

const WORKSPACE_ID = '20202020-1c25-4d02-bf25-6aeccf7ea419';
const PHIL_USER_WORKSPACE_ID = '20202020-7169-42cf-bc47-1cfef15264b1';
const JONY_CONNECTED_ACCOUNT_ID = '20202020-0cc8-4d60-a3a4-803245698908';

const RECORD_FILE_CONTENT = 'the contract of a lead this sender cannot see';
const MAILABLE_FILE_CONTENT = 'a file that belongs to no record';

const deleteFileMutation = gql`
  mutation DeleteFile($fileId: UUID!) {
    deleteFile(fileId: $fileId) {
      id
    }
  }
`;

const composeWithAttachment = (file: { id: string; name: string }) =>
  getAppProviderByClassName<EmailComposerService>(
    'EmailComposerService',
  ).composeEmail({
    parameters: {
      recipients: { to: 'customer@example.com' },
      subject: 'Subject',
      body: '<p>body</p>',
      files: [file],
      connectedAccountId: JONY_CONNECTED_ACCOUNT_ID,
    },
    context: {
      workspaceId: WORKSPACE_ID,
      userWorkspaceId: PHIL_USER_WORKSPACE_ID,
    },
    operation: EmailOperation.SEND,
  });

// Onema fork (ADR-003), rls-design §3.4 and the §11 row "S1 отправляет письмо с
// fileId чужого вложения". The tool takes a file by id and asks nothing about
// the record it hangs on, so a sender who remembers a fileId used to mail
// themselves the attachment of a lead they had lost. The allow-list is what
// closes it, and this is what proves the list is doing the closing rather than
// the test tripping over a file nobody could read anyway.
describe('Onema email attachment allow-list (integration)', () => {
  let createdObjectMetadataId = '';
  let recordFileId = '';
  let mailableFileId = '';

  beforeAll(async () => {
    jest.useRealTimers();

    const {
      data: {
        createOneObject: { id: objectMetadataId },
      },
    } = await createOneObjectMetadata({
      input: {
        nameSingular: 'onemaMailableFileTestObject',
        namePlural: 'onemaMailableFileTestObjects',
        labelSingular: 'Onema Mailable File Test Object',
        labelPlural: 'Onema Mailable File Test Objects',
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

    const recordFile = await uploadFileWithDirectUpload({
      filename: 'contract.txt',
      content: Buffer.from(RECORD_FILE_CONTENT),
      fileFolder: 'FilesField',
      fieldMetadataId: createdFieldMetadata.id,
    });

    recordFileId = recordFile.id;

    const mailableFile = await uploadFileWithDirectUpload({
      filename: 'brochure.txt',
      content: Buffer.from(MAILABLE_FILE_CONTENT),
      fileFolder: 'EmailAttachment',
    });

    mailableFileId = mailableFile.id;
  });

  afterAll(async () => {
    for (const fileId of [recordFileId, mailableFileId]) {
      await makeMetadataApiRequest({
        query: deleteFileMutation,
        variables: { fileId },
      });
    }

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

  it('refuses to attach a file that belongs to a record', async () => {
    await expect(
      composeWithAttachment({ id: recordFileId, name: 'contract.txt' }),
    ).rejects.toThrow(`Files not found: contract.txt (${recordFileId})`);
  });

  // The control: same sender, same call, a file of a folder that carries no
  // record. Without it the refusal above would also pass on a broken upload.
  it('attaches a file that belongs to no record', async () => {
    const result = await composeWithAttachment({
      id: mailableFileId,
      name: 'brochure.txt',
    });

    expect(result.success).toBe(true);
    expect(result.success && result.data.attachments).toHaveLength(1);
    expect(
      result.success && result.data.attachments[0].content.toString(),
    ).toBe(MAILABLE_FILE_CONTENT);
  });
});
