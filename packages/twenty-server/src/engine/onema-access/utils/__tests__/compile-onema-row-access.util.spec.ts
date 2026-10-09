import {
  buildTestTableShape,
  buildTestTableShapeRegistry,
} from 'src/engine/onema-access/__tests__/utils/build-test-table-shape.util';
import { OnemaAccessException } from 'src/engine/onema-access/exceptions/onema-access.exception';
import {
  type OnemaAccessRules,
  type OnemaAccessSubject,
} from 'src/engine/onema-access/types/onema-access-rules.type';
import {
  buildOnemaCompilationContext,
  compileOnemaRowAccess,
  compileOnemaWriteParentAccess,
  resetOnemaParameterNamespaceForTesting,
} from 'src/engine/onema-access/utils/compile-onema-row-access.util';

const SALES_ROLE_UNIVERSAL_IDENTIFIER = '00000000-0000-4000-8000-000000000005';
const PROJECT_MANAGER_ROLE_UNIVERSAL_IDENTIFIER =
  '00000000-0000-4000-8000-000000000006';
const CONTRACTOR_ROLE_UNIVERSAL_IDENTIFIER =
  '00000000-0000-4000-8000-000000000007';
const CEO_ROLE_UNIVERSAL_IDENTIFIER = '00000000-0000-4000-8000-000000000001';
const WORKSPACE_MEMBER_ID = '11111111-1111-4111-8111-111111111111';

const opportunityTableShape = buildTestTableShape({
  nameSingular: 'opportunity',
  columnNames: ['name'],
  joinColumnNameByFieldName: { owner: 'ownerId' },
});
const projectTableShape = buildTestTableShape({
  nameSingular: 'project',
  joinColumnNameByFieldName: {
    projectManager: 'projectManagerId',
    opportunity: 'opportunityId',
  },
});
const projectMemberTableShape = buildTestTableShape({
  nameSingular: 'projectMember',
  columnNames: ['isActive'],
  joinColumnNameByFieldName: { project: 'projectId', member: 'memberId' },
});
const taskTableShape = buildTestTableShape({
  nameSingular: 'task',
  columnNames: ['isUrgent'],
  joinColumnNameByFieldName: { project: 'projectId' },
});

const { objectIdByNameSingular, tableShapeByObjectMetadataId } =
  buildTestTableShapeRegistry([
    opportunityTableShape,
    projectTableShape,
    projectMemberTableShape,
    taskTableShape,
  ]);

const buildContext = ({
  rules,
  subject,
}: {
  rules: OnemaAccessRules;
  subject: OnemaAccessSubject;
}) =>
  buildOnemaCompilationContext({
    rules,
    subject,
    objectIdByNameSingular,
    tableShapeByObjectMetadataId,
  });

const salesSubject: OnemaAccessSubject = {
  workspaceMemberId: WORKSPACE_MEMBER_ID,
  roleUniversalIdentifiers: [SALES_ROLE_UNIVERSAL_IDENTIFIER],
};

const baseRoles = {
  ceo: CEO_ROLE_UNIVERSAL_IDENTIFIER,
  sales: SALES_ROLE_UNIVERSAL_IDENTIFIER,
  projectManager: PROJECT_MANAGER_ROLE_UNIVERSAL_IDENTIFIER,
  contractor: CONTRACTOR_ROLE_UNIVERSAL_IDENTIFIER,
};

describe('compileOnemaRowAccess', () => {
  beforeEach(() => resetOnemaParameterNamespaceForTesting());

  it('leaves an object that no rule mentions to upstream permissions', () => {
    const context = buildContext({
      rules: {
        roles: baseRoles,
        objects: { project: { sales: { all: true } } },
      },
      subject: salesSubject,
    });

    expect(
      compileOnemaRowAccess({
        tableShape: opportunityTableShape,
        tableAlias: 'opportunity',
        context,
      }),
    ).toEqual({ kind: 'open' });
  });

  it('denies an object whose rules do not name the role of the member', () => {
    const context = buildContext({
      rules: {
        roles: baseRoles,
        objects: { opportunity: { ceo: { all: true } } },
      },
      subject: salesSubject,
    });

    expect(
      compileOnemaRowAccess({
        tableShape: opportunityTableShape,
        tableAlias: 'opportunity',
        context,
      }),
    ).toEqual({ kind: 'denied' });
  });

  it('opens an object the role may see entirely', () => {
    const context = buildContext({
      rules: {
        roles: baseRoles,
        objects: { opportunity: { sales: { all: true } } },
      },
      subject: salesSubject,
    });

    expect(
      compileOnemaRowAccess({
        tableShape: opportunityTableShape,
        tableAlias: 'opportunity',
        context,
      }),
    ).toEqual({ kind: 'open' });
  });

  it('compiles "$me" against the join column of the relation', () => {
    const context = buildContext({
      rules: {
        roles: baseRoles,
        objects: { opportunity: { sales: { eq: ['owner', '$me'] } } },
      },
      subject: salesSubject,
    });

    expect(
      compileOnemaRowAccess({
        tableShape: opportunityTableShape,
        tableAlias: 'opportunity',
        context,
      }),
    ).toEqual({
      kind: 'gated',
      condition: {
        sql: '"opportunity"."ownerId" = :onema_0_opportunity_p0',
        parameters: { onema_0_opportunity_p0: WORKSPACE_MEMBER_ID },
      },
    });
  });

  it('denies "$me" when the caller is not a workspace member', () => {
    const context = buildContext({
      rules: {
        roles: baseRoles,
        objects: { opportunity: { sales: { eq: ['owner', '$me'] } } },
      },
      subject: {
        workspaceMemberId: undefined,
        roleUniversalIdentifiers: [SALES_ROLE_UNIVERSAL_IDENTIFIER],
      },
    });

    expect(
      compileOnemaRowAccess({
        tableShape: opportunityTableShape,
        tableAlias: 'opportunity',
        context,
      }),
    ).toEqual({ kind: 'denied' });
  });

  it('compiles a plain column value and a null check', () => {
    const context = buildContext({
      rules: {
        roles: baseRoles,
        objects: {
          task: {
            sales: {
              and: [{ eq: ['isUrgent', true] }, { eq: ['projectId', null] }],
            },
          },
        },
      },
      subject: salesSubject,
    });

    expect(
      compileOnemaRowAccess({
        tableShape: taskTableShape,
        tableAlias: 'task',
        context,
      }),
    ).toEqual({
      kind: 'gated',
      condition: {
        sql: '(("task"."isUrgent" = :onema_0_task_p0) AND ("task"."projectId" IS NULL))',
        parameters: { onema_0_task_p0: true },
      },
    });
  });

  it('joins the conditions of every role the member holds with OR', () => {
    const context = buildContext({
      rules: {
        roles: baseRoles,
        objects: {
          project: {
            sales: { eq: ['projectManager', '$me'] },
            contractor: {
              exists: {
                object: 'projectMember',
                backForeignKey: 'project',
                where: { eq: ['member', '$me'] },
              },
            },
          },
        },
      },
      subject: {
        workspaceMemberId: WORKSPACE_MEMBER_ID,
        roleUniversalIdentifiers: [
          SALES_ROLE_UNIVERSAL_IDENTIFIER,
          CONTRACTOR_ROLE_UNIVERSAL_IDENTIFIER,
        ],
      },
    });

    const rowAccess = compileOnemaRowAccess({
      tableShape: projectTableShape,
      tableAlias: 'project',
      context,
    });

    expect(rowAccess).toEqual({
      kind: 'gated',
      condition: {
        sql:
          '(("project"."projectManagerId" = :onema_0_project_p0) OR ' +
          '(EXISTS (SELECT 1 FROM "workspace_test"."_projectMember" AS "onema_0_project_t1" ' +
          'WHERE "onema_0_project_t1"."projectId" = "project"."id" ' +
          'AND "onema_0_project_t1"."deletedAt" IS NULL ' +
          'AND ("onema_0_project_t1"."memberId" = :onema_0_project_p2))))',
        parameters: {
          onema_0_project_p0: WORKSPACE_MEMBER_ID,
          onema_0_project_p2: WORKSPACE_MEMBER_ID,
        },
      },
    });
  });

  it('requires the parent to be visible to the same role', () => {
    const context = buildContext({
      rules: {
        roles: baseRoles,
        objects: {
          project: { projectManager: { eq: ['projectManager', '$me'] } },
          task: {
            projectManager: {
              parent: { foreignKey: 'project', object: 'project' },
            },
          },
        },
      },
      subject: {
        workspaceMemberId: WORKSPACE_MEMBER_ID,
        roleUniversalIdentifiers: [PROJECT_MANAGER_ROLE_UNIVERSAL_IDENTIFIER],
      },
    });

    expect(
      compileOnemaRowAccess({
        tableShape: taskTableShape,
        tableAlias: 'task',
        context,
      }),
    ).toEqual({
      kind: 'gated',
      condition: {
        sql:
          'EXISTS (SELECT 1 FROM "workspace_test"."_project" AS "onema_0_task_t0" ' +
          'WHERE "onema_0_task_t0"."id" = "task"."projectId" ' +
          'AND "onema_0_task_t0"."deletedAt" IS NULL ' +
          'AND ("onema_0_task_t0"."projectManagerId" = :onema_0_task_p1))',
        parameters: { onema_0_task_p1: WORKSPACE_MEMBER_ID },
      },
    });
  });

  it('denies a record whose parent object is closed to the role', () => {
    const context = buildContext({
      rules: {
        roles: baseRoles,
        objects: {
          project: { ceo: { all: true } },
          task: {
            projectManager: {
              parent: { foreignKey: 'project', object: 'project' },
            },
          },
        },
      },
      subject: {
        workspaceMemberId: WORKSPACE_MEMBER_ID,
        roleUniversalIdentifiers: [PROJECT_MANAGER_ROLE_UNIVERSAL_IDENTIFIER],
      },
    });

    expect(
      compileOnemaRowAccess({
        tableShape: taskTableShape,
        tableAlias: 'task',
        context,
      }),
    ).toEqual({ kind: 'denied' });
  });

  it('still requires the parent row to exist when the parent is unrestricted', () => {
    const context = buildContext({
      rules: {
        roles: baseRoles,
        objects: {
          project: { projectManager: { all: true } },
          task: {
            projectManager: {
              parent: { foreignKey: 'project', object: 'project' },
            },
          },
        },
      },
      subject: {
        workspaceMemberId: WORKSPACE_MEMBER_ID,
        roleUniversalIdentifiers: [PROJECT_MANAGER_ROLE_UNIVERSAL_IDENTIFIER],
      },
    });

    expect(
      compileOnemaRowAccess({
        tableShape: taskTableShape,
        tableAlias: 'task',
        context,
      }),
    ).toEqual({
      kind: 'gated',
      condition: {
        sql:
          'EXISTS (SELECT 1 FROM "workspace_test"."_project" AS "onema_0_task_t0" ' +
          'WHERE "onema_0_task_t0"."id" = "task"."projectId" ' +
          'AND "onema_0_task_t0"."deletedAt" IS NULL)',
        parameters: {},
      },
    });
  });

  // Two aliases sanitize to one name, so without a namespace both would write
  // :onema_task_owner_p0 and the later setParameters() would overwrite the first
  it('keeps the parameters of two aliases that sanitize to one name apart', () => {
    const context = buildContext({
      rules: {
        roles: baseRoles,
        objects: { opportunity: { sales: { eq: ['owner', '$me'] } } },
      },
      subject: salesSubject,
    });
    const first = compileOnemaRowAccess({
      tableShape: opportunityTableShape,
      tableAlias: 'task-owner',
      context,
    });
    const second = compileOnemaRowAccess({
      tableShape: opportunityTableShape,
      tableAlias: 'task_owner',
      context,
    });

    expect(
      first.kind === 'gated' &&
        second.kind === 'gated' &&
        Object.keys(first.condition.parameters)[0] !==
          Object.keys(second.condition.parameters)[0],
    ).toBe(true);
  });

  // Without this, a rule could name as its witness an object the role is not
  // allowed to read and borrow the rows it cannot see directly
  it('makes the witness of an exists obey the rule of its own object', () => {
    const context = buildContext({
      rules: {
        roles: baseRoles,
        objects: {
          projectMember: { contractor: { eq: ['member', '$me'] } },
          project: {
            contractor: {
              exists: {
                object: 'projectMember',
                backForeignKey: 'project',
                where: { eq: ['isActive', true] },
              },
            },
          },
        },
      },
      subject: {
        workspaceMemberId: WORKSPACE_MEMBER_ID,
        roleUniversalIdentifiers: [CONTRACTOR_ROLE_UNIVERSAL_IDENTIFIER],
      },
    });

    expect(
      compileOnemaRowAccess({
        tableShape: projectTableShape,
        tableAlias: 'project',
        context,
      }),
    ).toEqual({
      kind: 'gated',
      condition: {
        sql:
          'EXISTS (SELECT 1 FROM "workspace_test"."_projectMember" AS "onema_0_project_t0" ' +
          'WHERE "onema_0_project_t0"."projectId" = "project"."id" ' +
          'AND "onema_0_project_t0"."deletedAt" IS NULL ' +
          'AND ("onema_0_project_t0"."memberId" = :onema_0_project_p1) ' +
          'AND ("onema_0_project_t0"."isActive" = :onema_0_project_p2))',
        parameters: {
          onema_0_project_p1: WORKSPACE_MEMBER_ID,
          onema_0_project_p2: true,
        },
      },
    });
  });

  it('denies an exists whose target object is closed to the role', () => {
    const context = buildContext({
      rules: {
        roles: baseRoles,
        objects: {
          projectMember: { ceo: { all: true } },
          project: {
            contractor: {
              exists: {
                object: 'projectMember',
                backForeignKey: 'project',
                where: { eq: ['member', '$me'] },
              },
            },
          },
        },
      },
      subject: {
        workspaceMemberId: WORKSPACE_MEMBER_ID,
        roleUniversalIdentifiers: [CONTRACTOR_ROLE_UNIVERSAL_IDENTIFIER],
      },
    });

    expect(
      compileOnemaRowAccess({
        tableShape: projectTableShape,
        tableAlias: 'project',
        context,
      }),
    ).toEqual({ kind: 'denied' });
  });

  it('denies an exists chain that reaches past the depth limit', () => {
    const context = buildContext({
      rules: {
        roles: baseRoles,
        objects: {
          project: {
            sales: {
              exists: {
                object: 'projectMember',
                backForeignKey: 'project',
                where: {
                  exists: {
                    object: 'task',
                    backForeignKey: 'project',
                    where: {
                      exists: {
                        object: 'opportunity',
                        backForeignKey: 'owner',
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      subject: salesSubject,
    });

    expect(
      compileOnemaRowAccess({
        tableShape: projectTableShape,
        tableAlias: 'project',
        context,
      }),
    ).toEqual({ kind: 'denied' });
  });

  it('throws on a field no column or relation of the object matches', () => {
    const context = buildContext({
      rules: {
        roles: baseRoles,
        objects: { opportunity: { sales: { eq: ['accountManager', '$me'] } } },
      },
      subject: salesSubject,
    });

    expect(() =>
      compileOnemaRowAccess({
        tableShape: opportunityTableShape,
        tableAlias: 'opportunity',
        context,
      }),
    ).toThrow(OnemaAccessException);
  });

  it('throws on an object the workspace does not have', () => {
    const context = buildContext({
      rules: {
        roles: baseRoles,
        objects: {
          task: {
            projectManager: {
              parent: { foreignKey: 'project', object: 'programme' },
            },
          },
        },
      },
      subject: {
        workspaceMemberId: WORKSPACE_MEMBER_ID,
        roleUniversalIdentifiers: [PROJECT_MANAGER_ROLE_UNIVERSAL_IDENTIFIER],
      },
    });

    expect(() =>
      compileOnemaRowAccess({
        tableShape: taskTableShape,
        tableAlias: 'task',
        context,
      }),
    ).toThrow(OnemaAccessException);
  });
});

describe('compileOnemaWriteParentAccess', () => {
  beforeEach(() => resetOnemaParameterNamespaceForTesting());

  const contractorSubject: OnemaAccessSubject = {
    workspaceMemberId: WORKSPACE_MEMBER_ID,
    roleUniversalIdentifiers: [CONTRACTOR_ROLE_UNIVERSAL_IDENTIFIER],
  };

  // The ONE-111 bug ONE-112 found. The chain starts at the `projectMember` row
  // being written, not at a rule of `projectMember`, so `project`'s own rule
  // coming back to `projectMember` reads *other* membership rows under their own
  // rule. Refusing that as a cycle compiled to `denied`, which on the write side
  // means "this foreign key must stay empty" — it silently took away the
  // membership a contractor is entitled to create.
  it('lets the parent rule reach the written object again', () => {
    const context = buildContext({
      rules: {
        roles: baseRoles,
        objects: {
          project: {
            contractor: {
              exists: {
                object: 'projectMember',
                backForeignKey: 'project',
                where: { eq: ['member', '$me'] },
              },
            },
          },
        },
        writeRequiresParentAccess: {
          projectMember: [{ foreignKey: 'project', object: 'project' }],
        },
      },
      subject: contractorSubject,
    });

    const rowAccess = compileOnemaWriteParentAccess({
      tableShape: projectMemberTableShape,
      tableAlias: 'projectMember',
      parents: [{ foreignKey: 'project', object: 'project' }],
      context,
    });

    expect(rowAccess.kind).toBe('gated');

    if (rowAccess.kind !== 'gated') {
      return;
    }

    expect(rowAccess.condition.sql).toContain('"projectMember"."projectId"');
    expect(rowAccess.condition.sql).toContain('"projectMember"');
    expect(Object.values(rowAccess.condition.parameters)).toContain(
      WORKSPACE_MEMBER_ID,
    );
  });

  // The exemption covers the written object alone. Anything else coming round
  // twice is the unbounded join the limit exists for, and the write-parent check
  // reads the same `denied` as before.
  it('still denies a parent chain that cycles among the parents', () => {
    const context = buildContext({
      rules: {
        roles: baseRoles,
        objects: {
          project: {
            contractor: {
              parent: { foreignKey: 'opportunity', object: 'opportunity' },
            },
          },
          opportunity: {
            contractor: {
              exists: { object: 'project', backForeignKey: 'opportunity' },
            },
          },
        },
        writeRequiresParentAccess: {
          projectMember: [{ foreignKey: 'project', object: 'project' }],
        },
      },
      subject: contractorSubject,
    });

    expect(
      compileOnemaWriteParentAccess({
        tableShape: projectMemberTableShape,
        tableAlias: 'projectMember',
        parents: [{ foreignKey: 'project', object: 'project' }],
        context,
      }),
    ).toEqual({
      kind: 'gated',
      condition: { sql: '"projectMember"."projectId" IS NULL', parameters: {} },
    });
  });

  // The exemption buys the one return the seed causes, and the compiled
  // condition says so: one subquery over the written object's table, not one per
  // level of a walk that keeps coming back. What decides where the walk stops is
  // unit-tested on its own (closes-onema-rule-cycle.util.spec.ts); here it is
  // the shape of the SQL that is pinned.
  it('reaches the written object once in the compiled condition', () => {
    const context = buildContext({
      rules: {
        roles: baseRoles,
        objects: {
          project: {
            contractor: {
              exists: {
                object: 'projectMember',
                backForeignKey: 'project',
                where: { eq: ['member', '$me'] },
              },
            },
          },
          projectMember: {
            contractor: {
              or: [
                { eq: ['member', '$me'] },
                { exists: { object: 'task', backForeignKey: 'project' } },
              ],
            },
          },
          task: {
            contractor: {
              or: [
                { eq: ['isUrgent', true] },
                {
                  exists: {
                    object: 'projectMember',
                    backForeignKey: 'project',
                  },
                },
              ],
            },
          },
        },
        writeRequiresParentAccess: {
          projectMember: [{ foreignKey: 'project', object: 'project' }],
        },
      },
      subject: contractorSubject,
    });

    const rowAccess = compileOnemaWriteParentAccess({
      tableShape: projectMemberTableShape,
      tableAlias: 'projectMember',
      parents: [{ foreignKey: 'project', object: 'project' }],
      context,
    });

    expect(rowAccess.kind).toBe('gated');

    if (rowAccess.kind !== 'gated') {
      return;
    }

    expect(
      rowAccess.condition.sql.match(/"_projectMember"/g) ?? [],
    ).toHaveLength(1);
  });

  // A plain read keeps the old answer: nothing seeds an exemption there, so a
  // rule that walks back to its own object is still the cycle it always was
  it('keeps denying a cycle when the same rules are compiled for a read', () => {
    const context = buildContext({
      rules: {
        roles: baseRoles,
        objects: {
          projectMember: {
            contractor: {
              parent: { foreignKey: 'project', object: 'project' },
            },
          },
          project: {
            contractor: {
              exists: {
                object: 'projectMember',
                backForeignKey: 'project',
                where: { eq: ['member', '$me'] },
              },
            },
          },
        },
      },
      subject: contractorSubject,
    });

    const rowAccess = compileOnemaRowAccess({
      tableShape: projectMemberTableShape,
      tableAlias: 'projectMember',
      context,
    });

    expect(rowAccess.kind).toBe('denied');
  });
});
