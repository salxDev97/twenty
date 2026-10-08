import { OnemaAccessException } from 'src/engine/onema-access/exceptions/onema-access.exception';
import { parseOnemaAccessRules } from 'src/engine/onema-access/utils/parse-onema-access-rules.util';

const SALES_ROLE_UNIVERSAL_IDENTIFIER = '00000000-0000-4000-8000-000000000005';
const CEO_ROLE_UNIVERSAL_IDENTIFIER = '00000000-0000-4000-8000-000000000001';

describe('parseOnemaAccessRules', () => {
  it('accepts a rules file using every condition of this release', () => {
    const rules = {
      roles: {
        ceo: CEO_ROLE_UNIVERSAL_IDENTIFIER,
        sales: SALES_ROLE_UNIVERSAL_IDENTIFIER,
      },
      requiredObjects: ['opportunity', 'task'],
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
        roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
        requiredObjects: [],
        objects: { opportunity: { sales: { anyParent: { fks: ['leadId'] } } } },
      }),
    ).toThrow(OnemaAccessException);
  });

  it('rejects a file that does not say which objects are required', () => {
    expect(() =>
      parseOnemaAccessRules({
        roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
        objects: { opportunity: { sales: { all: true } } },
      }),
    ).toThrow(OnemaAccessException);
  });

  it('rejects a required object that has no rule at all', () => {
    expect(() =>
      parseOnemaAccessRules({
        roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
        requiredObjects: ['opportunity', 'project'],
        objects: { opportunity: { sales: { all: true } } },
      }),
    ).toThrow(/"project" as required but declare no rule/);
  });

  it('rejects a required object whose rule names no role', () => {
    expect(() =>
      parseOnemaAccessRules({
        roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
        requiredObjects: ['project'],
        objects: { project: {} },
      }),
    ).toThrow(/"project" as required but its rule names no role/);
  });

  it('leaves an object nobody required free to have no rule', () => {
    expect(() =>
      parseOnemaAccessRules({
        roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
        requiredObjects: [],
        objects: { project: {} },
      }),
    ).not.toThrow();
  });

  it('rejects two role keys pointing at one role', () => {
    expect(() =>
      parseOnemaAccessRules({
        roles: {
          sales: SALES_ROLE_UNIVERSAL_IDENTIFIER,
          ceo: SALES_ROLE_UNIVERSAL_IDENTIFIER,
        },
        requiredObjects: [],
        objects: {
          opportunity: { ceo: { all: true }, sales: { eq: ['owner', '$me'] } },
        },
      }),
    ).toThrow(/several keys/);
  });

  it('rejects a role used on an object but never declared', () => {
    expect(() =>
      parseOnemaAccessRules({
        roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
        requiredObjects: [],
        objects: { opportunity: { projectManager: { all: true } } },
      }),
    ).toThrow(/without declaring its role id/);
  });

  it('rejects a cycle between parent rules', () => {
    expect(() =>
      parseOnemaAccessRules({
        roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
        requiredObjects: [],
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

  // The compiler ORs the rules of every role its subject holds, so a chain that
  // no single role closes on its own still closes in the generated SQL
  it('rejects a cycle that only closes across two roles', () => {
    expect(() =>
      parseOnemaAccessRules({
        roles: {
          sales: SALES_ROLE_UNIVERSAL_IDENTIFIER,
          ceo: CEO_ROLE_UNIVERSAL_IDENTIFIER,
        },
        requiredObjects: [],
        objects: {
          project: {
            sales: { parent: { foreignKey: 'task', object: 'task' } },
          },
          task: {
            ceo: { parent: { foreignKey: 'project', object: 'project' } },
          },
        },
      }),
    ).toThrow(/cycle/);
  });

  // The witness of an exists now carries the rule of its own object, so that
  // rule is part of the chain the depth limit measures
  it('counts the rule of the object an exists reaches towards the depth limit', () => {
    expect(() =>
      parseOnemaAccessRules({
        roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
        requiredObjects: [],
        objects: {
          dataRoomItem: {
            sales: {
              exists: {
                object: 'dataRoomShare',
                backForeignKey: 'dataRoomItem',
              },
            },
          },
          dataRoomShare: {
            sales: { parent: { foreignKey: 'project', object: 'project' } },
          },
          project: {
            sales: {
              parent: { foreignKey: 'opportunity', object: 'opportunity' },
            },
          },
        },
      }),
    ).toThrow(/nest deeper/);
  });

  it('rejects a chain of nested exists deeper than three objects', () => {
    expect(() =>
      parseOnemaAccessRules({
        roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
        requiredObjects: [],
        objects: {
          project: {
            sales: {
              exists: {
                object: 'projectMember',
                backForeignKey: 'project',
                where: {
                  exists: {
                    object: 'projectMemberShare',
                    backForeignKey: 'projectMember',
                    where: {
                      exists: {
                        object: 'projectMemberShareGrant',
                        backForeignKey: 'projectMemberShare',
                      },
                    },
                  },
                },
              },
            },
          },
        },
      }),
    ).toThrow(/nest deeper/);
  });

  it('rejects a mixed exists and parent chain past the same limit', () => {
    expect(() =>
      parseOnemaAccessRules({
        roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
        requiredObjects: [],
        objects: {
          dataRoomItem: {
            sales: {
              exists: {
                object: 'dataRoomShare',
                backForeignKey: 'dataRoomItem',
                where: { parent: { foreignKey: 'project', object: 'project' } },
              },
            },
          },
          project: {
            sales: {
              parent: { foreignKey: 'opportunity', object: 'opportunity' },
            },
          },
        },
      }),
    ).toThrow(/nest deeper/);
  });

  it('rejects an exists chain that comes back to an object it already joined', () => {
    expect(() =>
      parseOnemaAccessRules({
        roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
        requiredObjects: [],
        objects: {
          project: {
            sales: {
              exists: {
                object: 'projectMember',
                backForeignKey: 'project',
                where: {
                  exists: { object: 'project', backForeignKey: 'project' },
                },
              },
            },
          },
        },
      }),
    ).toThrow(/cycle/);
  });

  it('rejects a rule built from more conditions than the limit allows', () => {
    expect(() =>
      parseOnemaAccessRules({
        roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
        requiredObjects: [],
        objects: {
          opportunity: {
            sales: {
              or: Array.from({ length: 64 }, (_unused, index) => ({
                eq: ['stage', `stage-${index}`],
              })),
            },
          },
        },
      }),
    ).toThrow(/more than 32 conditions/);
  });

  it('rejects a parent chain deeper than three objects', () => {
    expect(() =>
      parseOnemaAccessRules({
        roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
        requiredObjects: [],
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
