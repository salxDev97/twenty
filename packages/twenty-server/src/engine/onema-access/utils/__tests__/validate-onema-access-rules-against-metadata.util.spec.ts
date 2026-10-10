import {
  buildTestTableShape,
  buildTestTableShapeRegistry,
} from 'src/engine/onema-access/__tests__/utils/build-test-table-shape.util';
import { type OnemaAccessRules } from 'src/engine/onema-access/types/onema-access-rules.type';
import { validateOnemaAccessRulesAgainstMetadata } from 'src/engine/onema-access/utils/validate-onema-access-rules-against-metadata.util';

const SALES_ROLE_UNIVERSAL_IDENTIFIER = 'onema-sales';

const workspaceMemberTableShape = buildTestTableShape({
  nameSingular: 'workspaceMember',
});
const projectTableShape = buildTestTableShape({
  nameSingular: 'project',
  columnNames: ['status'],
  joinColumnNameByFieldName: { projectManager: 'projectManagerId' },
  relationTargetByFieldName: { projectManager: 'workspaceMember' },
});
const projectMemberTableShape = buildTestTableShape({
  nameSingular: 'projectMember',
  joinColumnNameByFieldName: { project: 'projectId', member: 'memberId' },
});
const taskTableShape = buildTestTableShape({
  nameSingular: 'task',
  joinColumnNameByFieldName: { project: 'projectId' },
});
const attachmentTableShape = buildTestTableShape({
  nameSingular: 'attachment',
  joinColumnNameByFieldName: {
    targetTask: 'targetTaskId',
    targetProject: 'targetProjectId',
  },
  relationTargetByFieldName: { targetTask: 'task', targetProject: 'project' },
});
const timelineActivityTableShape = buildTestTableShape({
  nameSingular: 'timelineActivity',
  columnNames: ['linkedObjectMetadataId', 'linkedRecordId'],
  joinColumnNameByFieldName: { targetTask: 'targetTaskId' },
  relationTargetByFieldName: { targetTask: 'task' },
});

const { objectIdByNameSingular, tableShapeByObjectMetadataId } =
  buildTestTableShapeRegistry([
    projectTableShape,
    projectMemberTableShape,
    taskTableShape,
    workspaceMemberTableShape,
    attachmentTableShape,
    timelineActivityTableShape,
  ]);

const metadata = {
  objectIdByNameSingular,
  tableShapeByObjectMetadataId,
  flatRoleMaps: {
    byUniversalIdentifier: {
      [SALES_ROLE_UNIVERSAL_IDENTIFIER]: { id: 'sales-role-id' },
    },
    universalIdentifierById: {
      'sales-role-id': SALES_ROLE_UNIVERSAL_IDENTIFIER,
    },
    universalIdentifiersByApplicationId: {},
  },
} as unknown as Parameters<
  typeof validateOnemaAccessRulesAgainstMetadata
>[0]['metadata'];

let nextRulesVersion = 0;

const validate = (rules: OnemaAccessRules) => {
  nextRulesVersion += 1;

  return validateOnemaAccessRulesAgainstMetadata({
    rules,
    rulesVersion: `version-${nextRulesVersion}`,
    flatObjectMetadataMaps: {},
    metadata,
  });
};

describe('validateOnemaAccessRulesAgainstMetadata', () => {
  it('accepts rules every object, field and relation of which exists', () => {
    expect(
      validate({
        roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
        objects: {
          project: {
            sales: {
              or: [
                { eq: ['projectManager', '$me'] },
                {
                  exists: {
                    object: 'projectMember',
                    backForeignKey: 'project',
                    where: { eq: ['member', '$me'] },
                  },
                },
              ],
            },
          },
          task: {
            sales: { parent: { foreignKey: 'project', object: 'project' } },
          },
        },
      }),
    ).toEqual({ kind: 'valid' });
  });

  it('rejects a mistyped object instead of leaving the real one unprotected', () => {
    const validation = validate({
      roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
      objects: { projetc: { sales: { all: true } } },
    });

    expect(validation.kind).toBe('invalid');
    expect(validation.kind === 'invalid' && validation.problems.join()).toMatch(
      /"projetc" is not an object/,
    );
  });

  it('rejects a field the object does not have', () => {
    const validation = validate({
      roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
      objects: { project: { sales: { eq: ['accountManager', '$me'] } } },
    });

    expect(validation.kind === 'invalid' && validation.problems.join()).toMatch(
      /"accountManager" is no field of "project"/,
    );
  });

  it('rejects a back foreign key that points somewhere else', () => {
    const validation = validate({
      roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
      objects: {
        project: {
          sales: {
            exists: { object: 'projectMember', backForeignKey: 'member' },
          },
        },
      },
    });

    expect(validation.kind === 'invalid' && validation.problems.join()).toMatch(
      /points at another object than "project"/,
    );
  });

  it('rejects a parent foreign key that is not a relation', () => {
    const validation = validate({
      roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
      objects: {
        task: {
          sales: { parent: { foreignKey: 'projectId', object: 'project' } },
        },
      },
    });

    expect(validation.kind === 'invalid' && validation.problems.join()).toMatch(
      /"projectId" is no relation of "task"/,
    );
  });

  it('accepts polymorphic targets and a linked pair that exist', () => {
    expect(
      validate({
        roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
        objects: {
          task: { sales: { all: true } },
          project: { sales: { all: true } },
          attachment: {
            sales: {
              anyParent: {
                parents: [
                  { foreignKey: 'targetTask', object: 'task' },
                  { foreignKey: 'targetProject', object: 'project' },
                ],
              },
            },
          },
          timelineActivity: {
            sales: {
              linked: {
                objectIdField: 'linkedObjectMetadataId',
                recordIdField: 'linkedRecordId',
                objects: ['task'],
              },
            },
          },
        },
      }),
    ).toEqual({ kind: 'valid' });
  });

  it('rejects an anyParent target whose foreign key points elsewhere', () => {
    const validation = validate({
      roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
      objects: {
        project: { sales: { all: true } },
        attachment: {
          sales: {
            anyParent: {
              parents: [{ foreignKey: 'targetTask', object: 'project' }],
            },
          },
        },
      },
    });

    expect(validation.kind === 'invalid' && validation.problems.join()).toMatch(
      /anyParent\.foreignKey "targetTask" of "attachment" points at another object than "project"/,
    );
  });

  // The two fields hold bare identifiers; a relation there would compile into a
  // join column compared against an object metadata id and match nothing
  it('rejects a linked field that is a relation rather than an identifier', () => {
    const validation = validate({
      roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
      objects: {
        task: { sales: { all: true } },
        timelineActivity: {
          sales: {
            linked: {
              objectIdField: 'targetTask',
              recordIdField: 'linkedRecordId',
              objects: ['task'],
            },
          },
        },
      },
    });

    expect(validation.kind === 'invalid' && validation.problems.join()).toMatch(
      /"targetTask" of "timelineActivity" is a relation, not an identifier column/,
    );
  });

  it('rejects a linked pair and an object this workspace does not have', () => {
    const validation = validate({
      roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
      objects: {
        timelineActivity: {
          sales: {
            linked: {
              objectIdField: 'linkedObjectMetadatId',
              recordIdField: 'linkedRecordId',
              objects: ['tsak'],
            },
          },
        },
      },
    });

    expect(validation.kind === 'invalid' && validation.problems.join()).toMatch(
      /"linkedObjectMetadatId" is no field of "timelineActivity"/,
    );
    expect(validation.kind === 'invalid' && validation.problems.join()).toMatch(
      /linked names no object of this workspace \("tsak"\)/,
    );
  });

  it('rejects a role this workspace does not have', () => {
    const validation = validate({
      roles: { sales: 'onema-sales-renamed' },
      objects: { project: { sales: { all: true } } },
    });

    expect(validation.kind === 'invalid' && validation.problems.join()).toMatch(
      /names no role of this workspace/,
    );
  });

  it('validates one version of the rules once', () => {
    const rules: OnemaAccessRules = {
      roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
      objects: { project: { sales: { all: true } } },
    };
    const flatObjectMetadataMaps = {};
    const first = validateOnemaAccessRulesAgainstMetadata({
      rules,
      rulesVersion: 'stable-version',
      flatObjectMetadataMaps,
      metadata,
    });

    expect(
      validateOnemaAccessRulesAgainstMetadata({
        rules,
        rulesVersion: 'stable-version',
        flatObjectMetadataMaps,
        metadata,
      }),
    ).toBe(first);
  });

  it('accepts protected fields and a freeze rule that exist', () => {
    expect(
      validate({
        application: 'onema-application',
        roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
        objects: { task: { sales: { all: true } } },
        writeProtectedFields: { task: { project: [] } },
        freezeWhen: {
          task: [{ field: 'id', equals: 'frozen', fields: ['project'] }],
        },
      }),
    ).toEqual({ kind: 'valid' });
  });

  // A mistyped protected field protects nothing, and nothing else in the file
  // says it was meant to be protected at all
  it('rejects a protected field this workspace does not have', () => {
    const validation = validate({
      application: 'onema-application',
      roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
      objects: { task: { sales: { all: true } } },
      writeProtectedFields: { task: { onemaApprovalDecison: [] } },
      freezeWhen: {},
    });

    expect(validation.kind).toBe('invalid');
    expect(
      validation.kind === 'invalid' && validation.problems.join('; '),
    ).toMatch(/writeProtectedFields: "onemaApprovalDecison" is no field/);
  });

  it('accepts a write-parent link whose foreign key points at that object', () => {
    expect(
      validate({
        roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
        objects: { project: { sales: { all: true } } },
        writeRequiresParentAccess: {
          projectMember: [{ foreignKey: 'project', object: 'project' }],
        },
      }),
    ).toEqual({ kind: 'valid' });
  });

  // A mistyped foreign key here leaves the access-granting link wide open
  it('rejects a write-parent link whose foreign key points somewhere else', () => {
    const validation = validate({
      roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
      objects: { project: { sales: { all: true } } },
      writeRequiresParentAccess: {
        projectMember: [{ foreignKey: 'member', object: 'project' }],
      },
    });

    expect(validation.kind).toBe('invalid');
    expect(
      validation.kind === 'invalid' && validation.problems.join('; '),
    ).toMatch(
      /writeRequiresParentAccess: "member" of "projectMember" points at another object than "project"/,
    );
  });

  it('accepts a writeFrozenByParent rule whose link and field both exist', () => {
    expect(
      validate({
        roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
        objects: { project: { sales: { all: true } } },
        writeFrozenByParent: {
          task: [
            {
              foreignKey: 'project',
              object: 'project',
              field: 'status',
              equals: 'ARCHIVED',
            },
          ],
        },
      }),
    ).toEqual({ kind: 'valid' });
  });

  it('rejects a writeFrozenByParent rule naming no object of this workspace', () => {
    const validation = validate({
      roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
      objects: { project: { sales: { all: true } } },
      writeFrozenByParent: {
        onemaDataroomItem: [
          {
            foreignKey: 'dataroom',
            object: 'project',
            field: 'status',
            equals: 'ARCHIVED',
          },
        ],
      },
    });

    expect(validation.kind).toBe('invalid');
    expect(
      validation.kind === 'invalid' && validation.problems.join('; '),
    ).toMatch(
      /writeFrozenByParent names no object of this workspace \("onemaDataroomItem"\)/,
    );
  });

  // A mistyped foreign key here leaves the child writable regardless of its
  // parent's state — the same slip collectWriteParentProblems already guards
  // against for writeRequiresParentAccess
  it('rejects a writeFrozenByParent rule whose foreign key points somewhere else', () => {
    const validation = validate({
      roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
      objects: { project: { sales: { all: true } } },
      writeFrozenByParent: {
        task: [
          {
            foreignKey: 'id',
            object: 'project',
            field: 'status',
            equals: 'ARCHIVED',
          },
        ],
      },
    });

    expect(validation.kind).toBe('invalid');
    expect(
      validation.kind === 'invalid' && validation.problems.join('; '),
    ).toMatch(/writeFrozenByParent: "id" is no relation of "task"/);
  });

  it('rejects a writeFrozenByParent rule whose field is not a field of the parent', () => {
    const validation = validate({
      roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
      objects: { project: { sales: { all: true } } },
      writeFrozenByParent: {
        task: [
          {
            foreignKey: 'project',
            object: 'project',
            field: 'archivalState',
            equals: 'ARCHIVED',
          },
        ],
      },
    });

    expect(validation.kind).toBe('invalid');
    expect(
      validation.kind === 'invalid' && validation.problems.join('; '),
    ).toMatch(
      /writeFrozenByParent: "archivalState" is no single-column field of "project"/,
    );
  });

  it('accepts an owner default on a relation to workspaceMember', () => {
    expect(
      validate({
        roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
        objects: { project: { sales: { eq: ['projectManager', '$me'] } } },
        ownerDefaults: { project: { sales: 'projectManager' } },
      }),
    ).toEqual({ kind: 'valid' });
  });

  // The substituted value is a workspaceMember id, so a default on a relation
  // to anything else writes an id of the wrong object and the rule reading it
  // then matches nothing at all
  it('rejects an owner default on a relation that is not a workspaceMember', () => {
    const validation = validate({
      roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
      objects: { task: { sales: { eq: ['project', '$me'] } } },
      ownerDefaults: { task: { sales: 'project' } },
    });

    expect(validation.kind).toBe('invalid');
    expect(
      validation.kind === 'invalid' && validation.problems.join('; '),
    ).toMatch(
      /ownerDefaults: "project" of "task" points at another object than "workspaceMember"/,
    );
  });

  it('rejects a freeze rule naming a field this workspace does not have', () => {
    const validation = validate({
      roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
      objects: { task: { sales: { all: true } } },
      freezeWhen: {
        task: [{ field: 'onemaStage', equals: 'DEAL', fields: ['project'] }],
      },
    });

    expect(validation.kind).toBe('invalid');
    expect(
      validation.kind === 'invalid' && validation.problems.join('; '),
    ).toMatch(/freezeWhen: "onemaStage" is no single-column field/);
  });

  it('accepts a transition graph naming a real single-column field', () => {
    expect(
      validate({
        application: 'onema-application',
        roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
        objects: { task: { sales: { all: true } } },
        transitions: {
          task: {
            field: 'id',
            rules: [{ from: null, to: ['DRAFT'], roleKeys: ['sales'] }],
          },
        },
      }),
    ).toEqual({ kind: 'valid' });
  });

  it('rejects a transition graph naming an object this workspace does not have', () => {
    const validation = validate({
      application: 'onema-application',
      roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
      objects: { task: { sales: { all: true } } },
      transitions: {
        onemaEstimate: {
          field: 'status',
          rules: [{ from: null, to: ['DRAFT'], roleKeys: ['sales'] }],
        },
      },
    });

    expect(validation.kind).toBe('invalid');
    expect(
      validation.kind === 'invalid' && validation.problems.join('; '),
    ).toMatch(
      /transitions names no object of this workspace \("onemaEstimate"\)/,
    );
  });

  // A composite field has no single stored value a graph edge could compare
  it('rejects a transition graph naming a field this workspace does not have', () => {
    const validation = validate({
      application: 'onema-application',
      roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
      objects: { task: { sales: { all: true } } },
      transitions: {
        task: {
          field: 'onemaStage',
          rules: [{ from: null, to: ['DRAFT'], roleKeys: ['sales'] }],
        },
      },
    });

    expect(validation.kind).toBe('invalid');
    expect(
      validation.kind === 'invalid' && validation.problems.join('; '),
    ).toMatch(/transitions: "onemaStage" is no single-column field of "task"/);
  });
});
