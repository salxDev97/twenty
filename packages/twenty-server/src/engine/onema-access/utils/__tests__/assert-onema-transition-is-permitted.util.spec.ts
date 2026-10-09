import {
  apiKeyAuthContext,
  APPLICATION_UNIVERSAL_IDENTIFIER,
  applicationAuthContext,
  buildTestAccessScope,
  ceoAuthContext,
  salesAuthContext,
  SALES_ROLE_UNIVERSAL_IDENTIFIER,
  systemAuthContext,
} from 'src/engine/onema-access/__tests__/utils/build-test-access-scope.util';
import { buildTestTableShape } from 'src/engine/onema-access/__tests__/utils/build-test-table-shape.util';
import { type OnemaAccessRules } from 'src/engine/onema-access/types/onema-access-rules.type';
import {
  assertOnemaTransitionIsPermitted,
  type OnemaTransitionUpdate,
} from 'src/engine/onema-access/utils/assert-onema-transition-is-permitted.util';
import { setOnemaAccessRulesForTesting } from 'src/engine/onema-access/utils/load-onema-access-rules.util';
import { type WorkspaceAuthContext } from 'src/engine/core-modules/auth/types/workspace-auth-context.type';

const estimateTableShape = buildTestTableShape({
  nameSingular: 'onemaEstimate',
  columnNames: ['name', 'status'],
});

// hardening.md п. 3: the acceptance graph behind the scenario the task names —
// DRAFT → IN_REVIEW → CEO_APPROVED → SENT → ACCEPTED, with the three last
// steps driven by the application alone (CEO decision, sending, client
// acceptance) and only the first step open to a human role
const estimateTransitionRules: OnemaAccessRules = {
  application: APPLICATION_UNIVERSAL_IDENTIFIER,
  roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
  objects: { onemaEstimate: { sales: { all: true } } },
  transitions: {
    onemaEstimate: {
      field: 'status',
      rules: [
        { from: null, to: ['DRAFT'], roleKeys: ['sales'] },
        { from: 'DRAFT', to: ['IN_REVIEW'], roleKeys: ['sales'] },
        { from: 'IN_REVIEW', to: ['CEO_APPROVED', 'DRAFT'], roleKeys: [] },
        { from: 'CEO_APPROVED', to: ['SENT'], roleKeys: [] },
        { from: 'SENT', to: ['ACCEPTED'], roleKeys: [] },
      ],
    },
  },
};

const assertPermitted = ({
  updates,
  authContext = salesAuthContext,
}: {
  updates: OnemaTransitionUpdate[];
  authContext?: WorkspaceAuthContext;
}) =>
  assertOnemaTransitionIsPermitted({
    scope: buildTestAccessScope({
      tableShape: estimateTableShape,
      authContext,
    }),
    updates,
  });

const estimateAt = (status: string | null) => ({
  id: 'estimate-1',
  name: 'Onema transition test',
  status,
});

describe('assertOnemaTransitionIsPermitted', () => {
  afterEach(() => setOnemaAccessRulesForTesting(undefined));

  it('changes nothing while no rules file is configured', () => {
    setOnemaAccessRulesForTesting(undefined);

    expect(() =>
      assertPermitted({
        updates: [
          {
            rawRecordBefore: estimateAt('DRAFT'),
            setColumns: { status: 'ACCEPTED' },
          },
        ],
      }),
    ).not.toThrow();
  });

  it('allows a field the rules do not gate by transition', () => {
    setOnemaAccessRulesForTesting(estimateTransitionRules);

    expect(() =>
      assertPermitted({
        updates: [
          {
            rawRecordBefore: estimateAt('DRAFT'),
            setColumns: { name: 'Renamed' },
          },
        ],
      }),
    ).not.toThrow();
  });

  it('allows rewriting the status field with the value it already holds', () => {
    setOnemaAccessRulesForTesting(estimateTransitionRules);

    expect(() =>
      assertPermitted({
        updates: [
          {
            rawRecordBefore: estimateAt('DRAFT'),
            setColumns: { status: 'DRAFT' },
          },
        ],
      }),
    ).not.toThrow();
  });

  // The task's own example: DRAFT → ACCEPTED over one PATCH must be refused,
  // skipping every step the graph actually requires
  it('refuses jumping straight from DRAFT to ACCEPTED', () => {
    setOnemaAccessRulesForTesting(estimateTransitionRules);

    expect(() =>
      assertPermitted({
        updates: [
          {
            rawRecordBefore: estimateAt('DRAFT'),
            setColumns: { status: 'ACCEPTED' },
          },
        ],
      }),
    ).toThrow(
      /"onemaEstimate\.status" may not move from "DRAFT" to "ACCEPTED"/,
    );
  });

  it('refuses a move the graph never names, even by a role with "all"', () => {
    setOnemaAccessRulesForTesting(estimateTransitionRules);

    expect(() =>
      assertPermitted({
        updates: [
          {
            rawRecordBefore: estimateAt('ACCEPTED'),
            setColumns: { status: 'DRAFT' },
          },
        ],
      }),
    ).toThrow(
      /"onemaEstimate\.status" has no transition starting from "ACCEPTED"/,
    );
  });

  it('lets the role the graph names drive the one edge it owns', () => {
    setOnemaAccessRulesForTesting(estimateTransitionRules);

    expect(() =>
      assertPermitted({
        updates: [
          {
            rawRecordBefore: estimateAt('DRAFT'),
            setColumns: { status: 'IN_REVIEW' },
          },
        ],
      }),
    ).not.toThrow();
  });

  it('refuses a human role driving an edge the graph gives to the application alone', () => {
    setOnemaAccessRulesForTesting(estimateTransitionRules);

    expect(() =>
      assertPermitted({
        updates: [
          {
            rawRecordBefore: estimateAt('IN_REVIEW'),
            setColumns: { status: 'CEO_APPROVED' },
          },
        ],
        authContext: ceoAuthContext,
      }),
    ).toThrow(/is driven by the application only/);
  });

  it('lets the application drive every application-only edge of the chain', () => {
    setOnemaAccessRulesForTesting(estimateTransitionRules);

    for (const [from, to] of [
      ['IN_REVIEW', 'CEO_APPROVED'],
      ['CEO_APPROVED', 'SENT'],
      ['SENT', 'ACCEPTED'],
    ] as const) {
      expect(() =>
        assertPermitted({
          updates: [
            { rawRecordBefore: estimateAt(from), setColumns: { status: to } },
          ],
          authContext: applicationAuthContext,
        }),
      ).not.toThrow();
    }
  });

  // Our own application is named by its universalIdentifier (rls-design
  // §12а), not by carrying a system auth context — a different application's
  // token proves nothing about this one
  it('refuses another application acting under its own token', () => {
    setOnemaAccessRulesForTesting(estimateTransitionRules);

    expect(() =>
      assertPermitted({
        updates: [
          {
            rawRecordBefore: estimateAt('IN_REVIEW'),
            setColumns: { status: 'CEO_APPROVED' },
          },
        ],
        authContext: {
          type: 'application',
          application: { universalIdentifier: 'somebody-elses-application' },
        } as unknown as WorkspaceAuthContext,
      }),
    ).toThrow(/is driven by the application only/);
  });

  // An API key carries the role of whoever created it, the same restriction
  // assertOnemaProtectedFieldsAreWritable makes for Т-1 — a key is never let
  // through by a role on the graph
  it('refuses an API key even when it was minted under the named role', () => {
    setOnemaAccessRulesForTesting(estimateTransitionRules);

    expect(() =>
      assertPermitted({
        updates: [
          {
            rawRecordBefore: estimateAt('DRAFT'),
            setColumns: { status: 'IN_REVIEW' },
          },
        ],
        authContext: apiKeyAuthContext,
      }),
    ).toThrow(/"onemaEstimate\.status" from "DRAFT" is driven only by roles/);
  });

  it('refuses a worker holding the bypass just the same (Б2)', () => {
    setOnemaAccessRulesForTesting(estimateTransitionRules);

    expect(() =>
      assertOnemaTransitionIsPermitted({
        scope: buildTestAccessScope({
          tableShape: estimateTableShape,
          authContext: systemAuthContext,
          shouldBypassPermissionChecks: true,
        }),
        updates: [
          {
            rawRecordBefore: estimateAt('DRAFT'),
            setColumns: { status: 'ACCEPTED' },
          },
        ],
      }),
    ).toThrow(/may not move from "DRAFT" to "ACCEPTED"/);
  });

  // The border of the graph: `from: null` is the record being born, and only
  // this exact value lets the row be created already in that status
  describe('the insert path, where there is no row before the write', () => {
    it('lets a record be created directly in a state the graph lists for birth', () => {
      setOnemaAccessRulesForTesting(estimateTransitionRules);

      expect(() =>
        assertPermitted({
          updates: [
            { rawRecordBefore: undefined, setColumns: { status: 'DRAFT' } },
          ],
        }),
      ).not.toThrow();
    });

    it('refuses creating a record already past the state the graph lists for birth', () => {
      setOnemaAccessRulesForTesting(estimateTransitionRules);

      expect(() =>
        assertPermitted({
          updates: [
            {
              rawRecordBefore: undefined,
              setColumns: { status: 'ACCEPTED' },
            },
          ],
        }),
      ).toThrow(
        /"onemaEstimate\.status" may not move from "null" to "ACCEPTED"/,
      );
    });

    // A graph that names no birth state at all for the field has nothing to
    // say about it, and that silence is a refusal — the same posture as any
    // value the graph never names in `from`
    it('refuses creating a record in a status no edge names as a birth state', () => {
      setOnemaAccessRulesForTesting({
        ...estimateTransitionRules,
        transitions: {
          onemaEstimate: {
            field: 'status',
            rules: [{ from: 'DRAFT', to: ['IN_REVIEW'], roleKeys: ['sales'] }],
          },
        },
      });

      expect(() =>
        assertPermitted({
          updates: [
            { rawRecordBefore: undefined, setColumns: { status: 'DRAFT' } },
          ],
        }),
      ).toThrow(
        /"onemaEstimate\.status" has no transition starting from "null"/,
      );
    });

    it('leaves a record with no status column written alone', () => {
      setOnemaAccessRulesForTesting(estimateTransitionRules);

      expect(() =>
        assertPermitted({
          updates: [
            { rawRecordBefore: undefined, setColumns: { name: 'Draft one' } },
          ],
        }),
      ).not.toThrow();
    });
  });

  it('refuses every write while the rules file is unusable', () => {
    setOnemaAccessRulesForTesting({
      roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
      objects: { onemaEstimat: { sales: { all: true } } },
    });

    expect(() =>
      assertPermitted({
        updates: [
          {
            rawRecordBefore: estimateAt('DRAFT'),
            setColumns: { status: 'IN_REVIEW' },
          },
        ],
      }),
    ).toThrow(/Onema access rules refuse this write/);
  });
});
