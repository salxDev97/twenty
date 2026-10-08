import { OnemaAccessException } from 'src/engine/onema-access/exceptions/onema-access.exception';
import { parseOnemaAccessRules } from 'src/engine/onema-access/utils/parse-onema-access-rules.util';

const SALES_ROLE_ID = '00000000-0000-4000-8000-000000000005';
const CEO_ROLE_ID = '00000000-0000-4000-8000-000000000001';

describe('parseOnemaAccessRules', () => {
  it('accepts a rules file using every condition of this release', () => {
    const rules = {
      roles: { ceo: CEO_ROLE_ID, sales: SALES_ROLE_ID },
      objects: {
        opportunity: {
          ceo: { all: true },
          sales: {
            or: [
              { eq: ['owner', '$me'] },
              {
                exists: {
                  object: 'opportunityWatcher',
                  backForeignKey: 'opportunity',
                  where: { eq: ['member', '$me'] },
                },
              },
            ],
          },
        },
        task: {
          sales: {
            and: [
              { eq: ['isArchived', false] },
              { parent: { foreignKey: 'opportunity', object: 'opportunity' } },
            ],
          },
        },
      },
    };

    expect(parseOnemaAccessRules(rules)).toEqual(rules);
  });

  it('rejects a condition the schema does not know', () => {
    expect(() =>
      parseOnemaAccessRules({
        roles: { sales: SALES_ROLE_ID },
        objects: { opportunity: { sales: { anyParent: { fks: ['leadId'] } } } },
      }),
    ).toThrow(OnemaAccessException);
  });

  it('rejects a role id that is not a uuid', () => {
    expect(() =>
      parseOnemaAccessRules({
        roles: { sales: 'sales-role' },
        objects: { opportunity: { sales: { all: true } } },
      }),
    ).toThrow(OnemaAccessException);
  });

  it('rejects a role used on an object but never declared', () => {
    expect(() =>
      parseOnemaAccessRules({
        roles: { sales: SALES_ROLE_ID },
        objects: { opportunity: { projectManager: { all: true } } },
      }),
    ).toThrow(/without declaring its role id/);
  });

  it('rejects a cycle between parent rules', () => {
    expect(() =>
      parseOnemaAccessRules({
        roles: { sales: SALES_ROLE_ID },
        objects: {
          project: {
            sales: { parent: { foreignKey: 'task', object: 'task' } },
          },
          task: {
            sales: { parent: { foreignKey: 'project', object: 'project' } },
          },
        },
      }),
    ).toThrow(/cycle/);
  });

  it('rejects a parent chain deeper than three objects', () => {
    expect(() =>
      parseOnemaAccessRules({
        roles: { sales: SALES_ROLE_ID },
        objects: {
          dataRoomItem: {
            sales: { parent: { foreignKey: 'task', object: 'task' } },
          },
          task: {
            sales: { parent: { foreignKey: 'project', object: 'project' } },
          },
          project: {
            sales: {
              parent: { foreignKey: 'opportunity', object: 'opportunity' },
            },
          },
          opportunity: { sales: { eq: ['owner', '$me'] } },
        },
      }),
    ).toThrow(/nest deeper/);
  });
});
