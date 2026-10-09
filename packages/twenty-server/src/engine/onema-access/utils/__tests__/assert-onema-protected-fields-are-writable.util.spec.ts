import {
  apiKeyAuthContext,
  APPLICATION_UNIVERSAL_IDENTIFIER,
  applicationAuthContext,
  buildTestAccessScope,
  CEO_ROLE_UNIVERSAL_IDENTIFIER,
  ceoApiKeyAuthContext,
  ceoAuthContext,
  otherApplicationAuthContext,
  SALES_ROLE_UNIVERSAL_IDENTIFIER,
} from 'src/engine/onema-access/__tests__/utils/build-test-access-scope.util';
import { buildTestTableShape } from 'src/engine/onema-access/__tests__/utils/build-test-table-shape.util';
import { type OnemaAccessRules } from 'src/engine/onema-access/types/onema-access-rules.type';
import { assertOnemaProtectedFieldsAreWritable } from 'src/engine/onema-access/utils/assert-onema-protected-fields-are-writable.util';
import { setOnemaAccessRulesForTesting } from 'src/engine/onema-access/utils/load-onema-access-rules.util';
import { type WorkspaceAuthContext } from 'src/engine/core-modules/auth/types/workspace-auth-context.type';

const opportunityTableShape = buildTestTableShape({
  nameSingular: 'opportunity',
  columnNames: ['name', 'onemaPaymentConfirmation', 'orgRole'],
  joinColumnNameByFieldName: { onemaApprovalDecider: 'onemaApprovalDeciderId' },
  compositeParentFieldNameByColumnName: {
    onemaApprovalSnapshotPrimaryLinkUrl: 'onemaApprovalSnapshot',
    onemaApprovalSnapshotPrimaryLinkLabel: 'onemaApprovalSnapshot',
  },
});

const protectedRules: OnemaAccessRules = {
  application: APPLICATION_UNIVERSAL_IDENTIFIER,
  roles: {
    sales: SALES_ROLE_UNIVERSAL_IDENTIFIER,
    ceo: CEO_ROLE_UNIVERSAL_IDENTIFIER,
  },
  objects: { opportunity: { sales: { all: true }, ceo: { all: true } } },
  writeProtectedFields: {
    opportunity: {
      onemaPaymentConfirmation: [],
      onemaApprovalSnapshot: [],
      onemaApprovalDecider: [],
      orgRole: ['ceo'],
    },
  },
};

const assertWritable = ({
  updatedColumns,
  authContext,
}: {
  updatedColumns: string[];
  authContext?: WorkspaceAuthContext;
}) =>
  assertOnemaProtectedFieldsAreWritable({
    scope: buildTestAccessScope({
      tableShape: opportunityTableShape,
      authContext,
    }),
    updatedColumns,
  });

describe('assertOnemaProtectedFieldsAreWritable', () => {
  afterEach(() => setOnemaAccessRulesForTesting(undefined));

  it('changes nothing while no rules file is configured', () => {
    setOnemaAccessRulesForTesting(undefined);

    expect(() =>
      assertWritable({ updatedColumns: ['onemaPaymentConfirmation'] }),
    ).not.toThrow();
  });

  it('lets anybody write a field the rules do not protect', () => {
    setOnemaAccessRulesForTesting(protectedRules);

    expect(() => assertWritable({ updatedColumns: ['name'] })).not.toThrow();
  });

  // The hole rls-design §12а Т-1 names: the field is hidden in the interface but
  // a PATCH under a sales role used to go straight through
  it('refuses a protected field written by a person', () => {
    setOnemaAccessRulesForTesting(protectedRules);

    expect(() =>
      assertWritable({ updatedColumns: ['name', 'onemaPaymentConfirmation'] }),
    ).toThrow(/opportunity\.onemaPaymentConfirmation/);
  });

  it('refuses a protected field written under an API key', () => {
    setOnemaAccessRulesForTesting(protectedRules);

    expect(() =>
      assertWritable({
        updatedColumns: ['onemaPaymentConfirmation'],
        authContext: apiKeyAuthContext,
      }),
    ).toThrow(/written by the application only/);
  });

  it('lets our application write a protected field', () => {
    setOnemaAccessRulesForTesting(protectedRules);

    expect(() =>
      assertWritable({
        updatedColumns: ['onemaPaymentConfirmation'],
        authContext: applicationAuthContext,
      }),
    ).not.toThrow();
  });

  it('refuses another application, however installed', () => {
    setOnemaAccessRulesForTesting(protectedRules);

    expect(() =>
      assertWritable({
        updatedColumns: ['onemaPaymentConfirmation'],
        authContext: otherApplicationAuthContext,
      }),
    ).toThrow(/written by the application only/);
  });

  it('lets a role the file names write the field it names', () => {
    setOnemaAccessRulesForTesting(protectedRules);

    expect(() =>
      assertWritable({
        updatedColumns: ['orgRole'],
        authContext: ceoAuthContext,
      }),
    ).not.toThrow();

    expect(() => assertWritable({ updatedColumns: ['orgRole'] })).toThrow(
      /opportunity\.orgRole/,
    );
  });

  // An API key is created under somebody's role and then outlives them, so the
  // role exception is a human one: a CEO key would otherwise be a standing PATCH
  // channel into the field the product rule rests on
  it('refuses the role exception to an API key holding that very role', () => {
    setOnemaAccessRulesForTesting(protectedRules);

    expect(() =>
      assertWritable({
        updatedColumns: ['orgRole'],
        authContext: ceoApiKeyAuthContext,
      }),
    ).toThrow(/opportunity\.orgRole/);
  });

  // The rules name the relation, the write names the join column
  it('refuses a protected relation written by its join column', () => {
    setOnemaAccessRulesForTesting(protectedRules);

    expect(() =>
      assertWritable({ updatedColumns: ['onemaApprovalDeciderId'] }),
    ).toThrow(/opportunity\.onemaApprovalDecider/);
  });

  // A composite field is several columns, and writing any one of them is
  // writing the field
  it('refuses one column of a protected composite field', () => {
    setOnemaAccessRulesForTesting(protectedRules);

    expect(() =>
      assertWritable({
        updatedColumns: ['onemaApprovalSnapshotPrimaryLinkUrl'],
      }),
    ).toThrow(/opportunity\.onemaApprovalSnapshot/);
  });

  it('refuses every write while the rules file is unusable', () => {
    setOnemaAccessRulesForTesting({
      roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
      objects: { opportuntiy: { sales: { all: true } } },
    });

    expect(() => assertWritable({ updatedColumns: ['name'] })).toThrow(
      /Onema access rules refuse this write/,
    );
  });

  it('does nothing for a caller holding the explicit bypass', () => {
    setOnemaAccessRulesForTesting(protectedRules);

    expect(() =>
      assertOnemaProtectedFieldsAreWritable({
        scope: buildTestAccessScope({
          tableShape: opportunityTableShape,
          shouldBypassPermissionChecks: true,
        }),
        updatedColumns: ['onemaPaymentConfirmation'],
      }),
    ).not.toThrow();
  });
});
