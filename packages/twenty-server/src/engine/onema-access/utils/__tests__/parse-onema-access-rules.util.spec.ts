import { ONEMA_MAX_CONDITIONS_PER_RULE } from 'src/engine/onema-access/constants/onema-access.constants';
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
      writeProtectedFields: {},
      writeRequiresParentAccess: {},
      freezeWhen: {},
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
        writeProtectedFields: {},
        writeRequiresParentAccess: {},
        freezeWhen: {},
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
        writeProtectedFields: {},
        writeRequiresParentAccess: {},
        freezeWhen: {},
        objects: { opportunity: { sales: { all: true } } },
      }),
    ).toThrow(/"project" as required but declare no rule/);
  });

  it('rejects a required object whose rule names no role', () => {
    expect(() =>
      parseOnemaAccessRules({
        roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
        requiredObjects: ['project'],
        writeProtectedFields: {},
        writeRequiresParentAccess: {},
        freezeWhen: {},
        objects: { project: {} },
      }),
    ).toThrow(/"project" as required but its rule names no role/);
  });

  it('leaves an object nobody required free to have no rule', () => {
    expect(() =>
      parseOnemaAccessRules({
        roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
        requiredObjects: [],
        writeProtectedFields: {},
        writeRequiresParentAccess: {},
        freezeWhen: {},
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
        writeProtectedFields: {},
        writeRequiresParentAccess: {},
        freezeWhen: {},
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
        writeProtectedFields: {},
        writeRequiresParentAccess: {},
        freezeWhen: {},
        objects: { opportunity: { projectManager: { all: true } } },
      }),
    ).toThrow(/without declaring its role id/);
  });

  it('rejects a cycle between parent rules', () => {
    expect(() =>
      parseOnemaAccessRules({
        roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
        requiredObjects: [],
        writeProtectedFields: {},
        writeRequiresParentAccess: {},
        freezeWhen: {},
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

  // The bug ONE-112 found in this check. The write-parent chain starts at the
  // row being written, not at a rule, so the parent's rule coming back to that
  // object reads *other* rows of it under their own rule. Refusing it as a cycle
  // took away the membership a contractor is entitled to create — `projectMember
  // -> project -> projectMember` is how they see the project at all.
  it('accepts a write-parent link whose parent rule leads back to the written object', () => {
    const rules = {
      roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
      requiredObjects: [],
      writeProtectedFields: {},
      writeRequiresParentAccess: {
        projectMember: [{ foreignKey: 'project', object: 'project' }],
      },
      freezeWhen: {},
      objects: {
        project: {
          sales: {
            exists: {
              object: 'projectMember',
              backForeignKey: 'project',
              where: { eq: ['member', '$me'] },
            },
          },
        },
      },
    };

    expect(parseOnemaAccessRules(rules)).toEqual(rules);
  });

  // The exemption is for the object the chain was seeded with and nothing else:
  // any other object coming round twice is still the unbounded join it was
  it('rejects a write-parent link whose parent rules cycle among themselves', () => {
    expect(() =>
      parseOnemaAccessRules({
        roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
        requiredObjects: [],
        writeProtectedFields: {},
        writeRequiresParentAccess: {
          dataRoomItem: [{ foreignKey: 'project', object: 'project' }],
        },
        freezeWhen: {},
        objects: {
          project: {
            sales: { parent: { foreignKey: 'company', object: 'company' } },
          },
          company: {
            sales: { parent: { foreignKey: 'project', object: 'project' } },
          },
        },
      }),
    ).toThrow(/cycle/);
  });

  // A link too deep used to become a silent `denied` at compile time, and a
  // silent `denied` on the write side reads as "this foreign key must stay
  // empty" — the author is told their row may hang on nothing at all
  it('refuses the file when a write-parent link nests deeper than the limit', () => {
    expect(() =>
      parseOnemaAccessRules({
        roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
        requiredObjects: [],
        writeProtectedFields: {},
        writeRequiresParentAccess: {
          dataRoomItem: [{ foreignKey: 'project', object: 'project' }],
        },
        freezeWhen: {},
        objects: {
          project: {
            sales: { parent: { foreignKey: 'company', object: 'company' } },
          },
          company: {
            sales: {
              parent: { foreignKey: 'opportunity', object: 'opportunity' },
            },
          },
          opportunity: {
            sales: { parent: { foreignKey: 'lead', object: 'lead' } },
          },
          lead: { sales: { eq: ['owner', '$me'] } },
        },
      }),
    ).toThrow(/nest deeper than/);
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
        writeProtectedFields: {},
        writeRequiresParentAccess: {},
        freezeWhen: {},
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
        writeProtectedFields: {},
        writeRequiresParentAccess: {},
        freezeWhen: {},
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
        writeProtectedFields: {},
        writeRequiresParentAccess: {},
        freezeWhen: {},
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
        writeProtectedFields: {},
        writeRequiresParentAccess: {},
        freezeWhen: {},
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
        writeProtectedFields: {},
        writeRequiresParentAccess: {},
        freezeWhen: {},
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
        writeProtectedFields: {},
        writeRequiresParentAccess: {},
        freezeWhen: {},
        objects: {
          opportunity: {
            sales: {
              or: Array.from(
                { length: ONEMA_MAX_CONDITIONS_PER_RULE + 1 },
                (_unused, index) => ({
                  eq: ['stage', `stage-${index}`],
                }),
              ),
            },
          },
        },
      }),
    ).toThrow(
      new RegExp(`more than ${ONEMA_MAX_CONDITIONS_PER_RULE} conditions`),
    );
  });

  it('rejects a parent chain deeper than three objects', () => {
    expect(() =>
      parseOnemaAccessRules({
        roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
        requiredObjects: [],
        writeProtectedFields: {},
        writeRequiresParentAccess: {},
        freezeWhen: {},
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

  it('accepts a polymorphic chain one object deeper than a plain one', () => {
    const rules = {
      roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
      requiredObjects: [],
      writeProtectedFields: {},
      freezeWhen: {},
      objects: {
        attachment: {
          sales: {
            anyParent: {
              parents: [{ foreignKey: 'targetPerson', object: 'person' }],
            },
          },
        },
        person: {
          sales: { parent: { foreignKey: 'company', object: 'company' } },
        },
        company: {
          sales: {
            parent: { foreignKey: 'opportunity', object: 'opportunity' },
          },
        },
        opportunity: { sales: { eq: ['owner', '$me'] } },
      },
    };

    expect(parseOnemaAccessRules(rules)).toEqual(rules);
  });

  it('rejects a polymorphic chain that reaches a fifth object', () => {
    expect(() =>
      parseOnemaAccessRules({
        roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
        requiredObjects: [],
        writeProtectedFields: {},
        freezeWhen: {},
        objects: {
          attachment: {
            sales: {
              anyParent: {
                parents: [{ foreignKey: 'targetNote', object: 'note' }],
              },
            },
          },
          note: {
            sales: { parent: { foreignKey: 'person', object: 'person' } },
          },
          person: {
            sales: { parent: { foreignKey: 'company', object: 'company' } },
          },
          company: {
            sales: {
              parent: { foreignKey: 'opportunity', object: 'opportunity' },
            },
          },
          opportunity: { sales: { eq: ['owner', '$me'] } },
        },
      }),
    ).toThrow(/nest deeper/);
  });

  // The branches of a polymorphic condition are alternatives joined by OR, so
  // one target without a rule of its own opens every record hanging off it
  it('rejects an anyParent target the file declares no rule for', () => {
    expect(() =>
      parseOnemaAccessRules({
        roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
        requiredObjects: [],
        writeProtectedFields: {},
        freezeWhen: {},
        objects: {
          attachment: {
            sales: {
              anyParent: {
                parents: [
                  { foreignKey: 'targetOpportunity', object: 'opportunity' },
                  { foreignKey: 'targetDashboard', object: 'dashboard' },
                ],
              },
            },
          },
          opportunity: { sales: { eq: ['owner', '$me'] } },
        },
      }),
    ).toThrow(/"dashboard" through a polymorphic target/);
  });

  it('rejects a linked object the file declares no rule for', () => {
    expect(() =>
      parseOnemaAccessRules({
        roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
        requiredObjects: [],
        writeProtectedFields: {},
        freezeWhen: {},
        objects: {
          timelineActivity: {
            sales: {
              linked: {
                objectIdField: 'linkedObjectMetadataId',
                recordIdField: 'linkedRecordId',
                objects: ['opportunity', 'workflow'],
              },
            },
          },
          opportunity: { sales: { eq: ['owner', '$me'] } },
        },
      }),
    ).toThrow(/"workflow" through a polymorphic target/);
  });

  it('rejects a cycle a polymorphic target closes', () => {
    expect(() =>
      parseOnemaAccessRules({
        roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
        requiredObjects: [],
        writeProtectedFields: {},
        freezeWhen: {},
        objects: {
          note: {
            sales: {
              anyParent: {
                parents: [{ foreignKey: 'targetTask', object: 'task' }],
              },
            },
          },
          task: {
            sales: {
              anyParent: {
                parents: [{ foreignKey: 'targetNote', object: 'note' }],
              },
            },
          },
        },
      }),
    ).toThrow(/cycle/);
  });

  it('accepts protected fields and a freeze rule', () => {
    const rules = {
      application: 'onema-application',
      roles: { ceo: CEO_ROLE_UNIVERSAL_IDENTIFIER },
      requiredObjects: [],
      objects: { opportunity: { ceo: { all: true } } },
      writeProtectedFields: {
        opportunity: { onemaPaymentConfirmation: [], orgRole: ['ceo'] },
      },
      writeRequiresParentAccess: {},
      freezeWhen: {
        opportunity: [
          { field: 'onemaStage', equals: 'DEAL', fields: ['company'] },
        ],
      },
    };

    expect(parseOnemaAccessRules(rules)).toEqual(rules);
  });

  it('rejects a file that does not say which fields are protected', () => {
    expect(() =>
      parseOnemaAccessRules({
        roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
        requiredObjects: [],
        freezeWhen: {},
        objects: { opportunity: { sales: { all: true } } },
      }),
    ).toThrow(/writeProtectedFields/);
  });

  // Nothing could ever write such a field, so the file describes a rule it
  // cannot have meant
  it('rejects protected fields without an application to write them', () => {
    expect(() =>
      parseOnemaAccessRules({
        roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
        requiredObjects: [],
        writeProtectedFields: { opportunity: { onemaPaymentConfirmation: [] } },
        writeRequiresParentAccess: {},
        freezeWhen: {},
        objects: { opportunity: { sales: { all: true } } },
      }),
    ).toThrow(/declare no "application"/);
  });

  it('rejects a protected field given to a role nobody declared', () => {
    expect(() =>
      parseOnemaAccessRules({
        application: 'onema-application',
        roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
        requiredObjects: [],
        writeProtectedFields: { opportunity: { orgRole: ['ceo'] } },
        writeRequiresParentAccess: {},
        freezeWhen: {},
        objects: { opportunity: { sales: { all: true } } },
      }),
    ).toThrow(/without declaring its role id/);
  });

  it('accepts an owner default on the role whose rule reads that very field', () => {
    const rules = {
      roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
      requiredObjects: [],
      writeProtectedFields: {},
      writeRequiresParentAccess: {},
      freezeWhen: {},
      objects: { opportunity: { sales: { eq: ['owner', '$me'] } } },
      ownerDefaults: { opportunity: { sales: 'owner' } },
    };

    expect(parseOnemaAccessRules(rules)).toEqual(rules);
  });

  // С1: filling a field no rule reads as "mine" hands out ownership the file
  // never asked for — `assignee` and `projectManager` are written like owners
  it('rejects an owner default on a field the rule of that role does not read', () => {
    expect(() =>
      parseOnemaAccessRules({
        roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
        requiredObjects: [],
        writeProtectedFields: {},
        writeRequiresParentAccess: {},
        freezeWhen: {},
        objects: { opportunity: { sales: { eq: ['owner', '$me'] } } },
        ownerDefaults: { opportunity: { sales: 'assignee' } },
      }),
    ).toThrow(/whose rule is not "assignee is \$me"/);
  });

  it('rejects an owner default for a role nobody declared', () => {
    expect(() =>
      parseOnemaAccessRules({
        roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
        requiredObjects: [],
        writeProtectedFields: {},
        writeRequiresParentAccess: {},
        freezeWhen: {},
        objects: { opportunity: { sales: { eq: ['owner', '$me'] } } },
        ownerDefaults: { opportunity: { ceo: 'owner' } },
      }),
    ).toThrow(/without declaring its role id/);
  });

  it('rejects an object listed under freezeWhen with no rule', () => {
    expect(() =>
      parseOnemaAccessRules({
        roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
        requiredObjects: [],
        writeProtectedFields: {},
        writeRequiresParentAccess: {},
        freezeWhen: { opportunity: [] },
        objects: { opportunity: { sales: { all: true } } },
      }),
    ).toThrow(/freezeWhen/);
  });

  it('rejects a latch that also names its own condition field', () => {
    expect(() =>
      parseOnemaAccessRules({
        roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
        requiredObjects: [],
        writeProtectedFields: {},
        writeRequiresParentAccess: {},
        freezeWhen: {
          opportunity: [
            {
              field: 'onemaStage',
              equals: 'DEAL',
              fields: ['company', 'onemaStage'],
              isIrreversible: true,
            },
          ],
        },
        objects: { opportunity: { sales: { all: true } } },
      }),
    ).toThrow(/"isIrreversible" already does it/);
  });

  it('rejects a freeze rule naming one field twice', () => {
    expect(() =>
      parseOnemaAccessRules({
        roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
        requiredObjects: [],
        writeProtectedFields: {},
        writeRequiresParentAccess: {},
        freezeWhen: {
          opportunity: [
            {
              field: 'onemaStage',
              equals: 'DEAL',
              fields: ['company', 'company'],
            },
          ],
        },
        objects: { opportunity: { sales: { all: true } } },
      }),
    ).toThrow(/twice in one rule/);
  });
});
