import { FileFolder } from 'twenty-shared/types';

// Onema fork, rls-design §3.4: a file of this folder belongs to a record, and
// the tool takes it by id without ever asking whether the sender may still see
// that record. Anyone who remembers a fileId could mail themselves an
// attachment of a lead they have lost access to, so record files are not
// mailable at all; the folders left here hold no record of their own.
export const EMAIL_ATTACHMENT_FILE_FOLDERS = [
  FileFolder.Workflow,
  FileFolder.EmailAttachment,
];
