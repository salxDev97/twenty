import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  ONEMA_ACCESS_ENFORCE_ENABLED_VALUE,
  ONEMA_ACCESS_ENFORCE_ENVIRONMENT_VARIABLE,
  ONEMA_ACCESS_RULES_PATH_ENVIRONMENT_VARIABLE,
  ONEMA_ACCESS_RULES_RELOAD_INTERVAL_MS,
} from 'src/engine/onema-access/constants/onema-access.constants';
import { OnemaAccessException } from 'src/engine/onema-access/exceptions/onema-access.exception';
import {
  getOnemaAccessRulesState,
  isOnemaAccessEnforced,
  loadOnemaAccessRulesOrThrow,
  setOnemaAccessRulesForTesting,
} from 'src/engine/onema-access/utils/load-onema-access-rules.util';

const SALES_ROLE_UNIVERSAL_IDENTIFIER = '00000000-0000-4000-8000-000000000005';

const validRules = {
  roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
  objects: { opportunity: { sales: { eq: ['owner', '$me'] } } },
};

describe('getOnemaAccessRulesState', () => {
  let temporaryDirectory: string;

  beforeEach(() => {
    temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'onema-access-rules-'),
    );
    setOnemaAccessRulesForTesting(undefined);
    delete process.env[ONEMA_ACCESS_RULES_PATH_ENVIRONMENT_VARIABLE];
    delete process.env[ONEMA_ACCESS_ENFORCE_ENVIRONMENT_VARIABLE];
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    setOnemaAccessRulesForTesting(undefined);
    delete process.env[ONEMA_ACCESS_RULES_PATH_ENVIRONMENT_VARIABLE];
    delete process.env[ONEMA_ACCESS_ENFORCE_ENVIRONMENT_VARIABLE];
  });

  const writeRulesFile = (content: string): string => {
    const rulesPath = path.join(temporaryDirectory, 'access-rules.json');

    fs.writeFileSync(rulesPath, content);

    return rulesPath;
  };

  const skipReloadInterval = (): void => {
    const nowMs = Date.now();

    jest
      .spyOn(Date, 'now')
      .mockReturnValue(nowMs + ONEMA_ACCESS_RULES_RELOAD_INTERVAL_MS + 1);
  };

  it('reports no rules when no file is configured', () => {
    expect(getOnemaAccessRulesState()).toEqual({ kind: 'absent' });
  });

  it('reads and parses the configured rules file', () => {
    process.env[ONEMA_ACCESS_RULES_PATH_ENVIRONMENT_VARIABLE] = writeRulesFile(
      JSON.stringify(validRules),
    );

    const state = getOnemaAccessRulesState();

    expect(state.kind).toBe('loaded');
    expect(state.kind === 'loaded' && state.rules).toEqual(validRules);
  });

  it('keeps serving the parsed rules without re-reading within the interval', () => {
    const rulesPath = writeRulesFile(JSON.stringify(validRules));

    process.env[ONEMA_ACCESS_RULES_PATH_ENVIRONMENT_VARIABLE] = rulesPath;

    const firstState = getOnemaAccessRulesState();

    fs.rmSync(rulesPath);

    expect(getOnemaAccessRulesState()).toBe(firstState);
  });

  it('picks up an edited file once the reload interval has passed', () => {
    const rulesPath = writeRulesFile(JSON.stringify(validRules));

    process.env[ONEMA_ACCESS_RULES_PATH_ENVIRONMENT_VARIABLE] = rulesPath;

    getOnemaAccessRulesState();

    fs.writeFileSync(
      rulesPath,
      JSON.stringify({
        roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
        objects: { opportunity: {} },
      }),
    );

    skipReloadInterval();

    const state = getOnemaAccessRulesState();

    expect(state.kind === 'loaded' && state.rules.objects.opportunity).toEqual(
      {},
    );
  });

  it('fails closed, not open, when a loaded file stops parsing', () => {
    const rulesPath = writeRulesFile(JSON.stringify(validRules));

    process.env[ONEMA_ACCESS_RULES_PATH_ENVIRONMENT_VARIABLE] = rulesPath;

    expect(getOnemaAccessRulesState().kind).toBe('loaded');

    fs.writeFileSync(rulesPath, '{ not json');

    skipReloadInterval();

    expect(getOnemaAccessRulesState().kind).toBe('failed');
  });

  it('fails when the configured file is missing', () => {
    process.env[ONEMA_ACCESS_RULES_PATH_ENVIRONMENT_VARIABLE] = path.join(
      temporaryDirectory,
      'absent.json',
    );

    expect(getOnemaAccessRulesState().kind).toBe('failed');
  });

  it('parses the example rules file shipped with the fork', () => {
    process.env[ONEMA_ACCESS_RULES_PATH_ENVIRONMENT_VARIABLE] = path.join(
      __dirname,
      '../../../../../onema/access-rules.example.json',
    );

    const state = getOnemaAccessRulesState();

    expect(
      state.kind === 'loaded' && state.rules.objects.opportunity,
    ).toBeDefined();
  });
});

describe('loadOnemaAccessRulesOrThrow', () => {
  let temporaryDirectory: string;

  beforeEach(() => {
    temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'onema-access-rules-'),
    );
    setOnemaAccessRulesForTesting(undefined);
    delete process.env[ONEMA_ACCESS_RULES_PATH_ENVIRONMENT_VARIABLE];
    delete process.env[ONEMA_ACCESS_ENFORCE_ENVIRONMENT_VARIABLE];
  });

  afterEach(() => {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    setOnemaAccessRulesForTesting(undefined);
    delete process.env[ONEMA_ACCESS_RULES_PATH_ENVIRONMENT_VARIABLE];
    delete process.env[ONEMA_ACCESS_ENFORCE_ENVIRONMENT_VARIABLE];
  });

  it('lets an unconfigured process start', () => {
    expect(loadOnemaAccessRulesOrThrow()).toEqual({ kind: 'absent' });
  });

  it('stops the process when the file cannot be used', () => {
    process.env[ONEMA_ACCESS_RULES_PATH_ENVIRONMENT_VARIABLE] = path.join(
      temporaryDirectory,
      'absent.json',
    );

    expect(() => loadOnemaAccessRulesOrThrow()).toThrow(OnemaAccessException);
  });

  it('stops the process when enforcement is asked for without a rules file', () => {
    process.env[ONEMA_ACCESS_ENFORCE_ENVIRONMENT_VARIABLE] =
      ONEMA_ACCESS_ENFORCE_ENABLED_VALUE;

    expect(() => loadOnemaAccessRulesOrThrow()).toThrow(
      /enforcement was asked for/,
    );
  });

  it('loads the rules without enforcing them until the gate is open', () => {
    const rulesPath = path.join(temporaryDirectory, 'access-rules.json');

    fs.writeFileSync(rulesPath, JSON.stringify(validRules));
    process.env[ONEMA_ACCESS_RULES_PATH_ENVIRONMENT_VARIABLE] = rulesPath;

    expect(loadOnemaAccessRulesOrThrow().kind).toBe('loaded');
    expect(isOnemaAccessEnforced()).toBe(false);

    process.env[ONEMA_ACCESS_ENFORCE_ENVIRONMENT_VARIABLE] =
      ONEMA_ACCESS_ENFORCE_ENABLED_VALUE;

    expect(isOnemaAccessEnforced()).toBe(true);
  });
});
