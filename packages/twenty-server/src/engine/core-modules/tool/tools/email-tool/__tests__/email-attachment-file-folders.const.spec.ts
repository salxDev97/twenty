import { FileFolder } from 'twenty-shared/types';

import { EMAIL_ATTACHMENT_FILE_FOLDERS } from 'src/engine/core-modules/tool/tools/email-tool/constants/email-attachment-file-folders.const';

// Onema fork (ADR-003), rls-design §3.4 and the §11 row "S1 отправляет письмо с
// fileId чужого вложения". The email tool takes a file by id and never asks
// whose record it hangs on, so the allow-list is the whole of the answer: a
// folder added here is a folder whose files anybody holding an id can mail to
// themselves, access to the record or not.
describe('EMAIL_ATTACHMENT_FILE_FOLDERS', () => {
  it('names only folders that hold no record of their own', () => {
    expect(EMAIL_ATTACHMENT_FILE_FOLDERS).toEqual([
      FileFolder.Workflow,
      FileFolder.EmailAttachment,
    ]);
  });

  // Named rather than left to the list above: this is the one a rebase brings
  // back, since upstream has it there (rls-design §3.4)
  it('does not name the folder of a record file', () => {
    expect(EMAIL_ATTACHMENT_FILE_FOLDERS).not.toContain(FileFolder.FilesField);
  });
});
