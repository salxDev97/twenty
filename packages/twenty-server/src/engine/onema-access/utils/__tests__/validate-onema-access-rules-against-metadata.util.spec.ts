import {
  buildTestTableShape,
  buildTestTableShapeRegistry,
} from 'src/engine/onema-access/__tests__/utils/build-test-table-shape.util';
import { type OnemaAccessRules } from 'src/engine/onema-access/types/onema-access-rules.type';
import { validateOnemaAccessRulesAgainstMetadata } from 'src/engine/onema-access/utils/validate-onema-access-rules-against-metadata.util';

const SALES_ROLE_UNIVERSAL_IDENTIFIER = 'onema-sales';

const projectTableShape = buildTestTableShape({
  nameSingular: 'project',
  joinColumnNameByFieldName: { projectManager: 'projectManagerId' },
});
const projectMemberTableShape = buildTestTableShape({
  nameSingular: 'projectMember',
  joinColumnNameByFieldName: { project: 'projectId', member: 'memberId' },
});
const taskTableShape = buildTestTableShape({
  nameSingular: 'task',
  joinColumnNameByFieldName: { project: 'projectId' },
});

const { objectIdByNameSingular, tableShapeByObjectMetadataId } =
  buildTestTableShapeRegistry([
    projectTableShape,
    projectMemberTableShape,
    taskTableShape,
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
});
