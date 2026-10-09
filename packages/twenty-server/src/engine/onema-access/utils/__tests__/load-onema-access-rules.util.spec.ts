import fs from 'fs';
import os from 'os';
import path from 'path';

import { NodeEnvironment } from 'src/engine/core-modules/twenty-config/interfaces/node-environment.interface';
import {
  ONEMA_ACCESS_ENFORCE_ENABLED_VALUE,
  ONEMA_ACCESS_ENFORCE_ENVIRONMENT_VARIABLE,
  ONEMA_ACCESS_RULES_PATH_ENVIRONMENT_VARIABLE,
  ONEMA_ACCESS_RULES_RELOAD_INTERVAL_MS,
} from 'src/engine/onema-access/constants/onema-access.constants';
import { OnemaAccessException } from 'src/engine/onema-access/exceptions/onema-access.exception';
import { type OnemaAccessRules } from 'src/engine/onema-access/types/onema-access-rules.type';
import {
  getOnemaAccessRulesState,
  isOnemaAccessEnforced,
  loadOnemaAccessRulesOrThrow,
  setOnemaAccessRulesForTesting,
} from 'src/engine/onema-access/utils/load-onema-access-rules.util';

const SALES_ROLE_UNIVERSAL_IDENTIFIER = '00000000-0000-4000-8000-000000000005';

const validRules: OnemaAccessRules = {
  roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
  requiredObjects: [],
  objects: { opportunity: { sales: { eq: ['owner', '$me'] } } },
  writeProtectedFields: {},
  writeRequiresParentAccess: {},
  freezeWhen: {},
  transitions: {},
};

const testingOverridePath = path.join(
  os.tmpdir(),
  `onema-access-rules.testing-override.${process.pid}.json`,
);

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
    process.env.NODE_ENV = NodeEnvironment.TEST;
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

  // Written straight to disk, not through setOnemaAccessRulesForTesting: that
  // helper also clears the cache, which is exactly what the app process cannot
  // do when the test driving it lives in another vm context
  const writeTestingOverrideFile = (rules: OnemaAccessRules): void => {
    fs.writeFileSync(
      testingOverridePath,
      JSON.stringify({
        ...rules,
        requiredObjects: rules.requiredObjects ?? [],
        writeProtectedFields: rules.writeProtectedFields ?? {},
        writeRequiresParentAccess: rules.writeRequiresParentAccess ?? {},
        freezeWhen: rules.freezeWhen ?? {},
        transitions: rules.transitions ?? {},
      }),
    );
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
        requiredObjects: [],
        objects: { opportunity: {} },
        writeProtectedFields: {},
        writeRequiresParentAccess: {},
        freezeWhen: {},
        transitions: {},
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

  it('serves the testing override ahead of the configured file while testing', () => {
    process.env[ONEMA_ACCESS_RULES_PATH_ENVIRONMENT_VARIABLE] = writeRulesFile(
      JSON.stringify(validRules),
    );

    setOnemaAccessRulesForTesting({
      roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
      objects: { project: { sales: { all: true } } },
    });

    const state = getOnemaAccessRulesState();

    expect(state.kind === 'loaded' && state.isTestingOverride).toBe(true);
    expect(
      state.kind === 'loaded' && state.rules.objects.project,
    ).toBeDefined();
  });

  // The bridge is consulted on every query of every suite of the repository,
  // so an override nobody touched must not cost a read and a hash each time
  it('does not re-read an unchanged testing override', () => {
    writeTestingOverrideFile({
      roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
      objects: { project: { sales: { all: true } } },
    });

    getOnemaAccessRulesState();

    const readFileSyncSpy = jest.spyOn(fs, 'readFileSync');

    getOnemaAccessRulesState();
    getOnemaAccessRulesState();

    expect(readFileSyncSpy).not.toHaveBeenCalled();
  });

  // The app and the test that drives it do not share the cache, only the file,
  // so a swap has to be seen on the next query and not after the interval
  it('picks up a testing override replaced in place at once', () => {
    writeTestingOverrideFile({
      roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
      objects: { project: { sales: { all: true } } },
    });

    expect(getOnemaAccessRulesState().kind).toBe('loaded');

    writeTestingOverrideFile({
      roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
      objects: { opportunity: { sales: { eq: ['owner', '$me'] } } },
    });

    const state = getOnemaAccessRulesState();

    expect(
      state.kind === 'loaded' && state.rules.objects.project,
    ).toBeUndefined();
    expect(
      state.kind === 'loaded' && state.rules.objects.opportunity,
    ).toBeDefined();
  });

  it('falls back to the configured file as soon as the override is removed', () => {
    process.env[ONEMA_ACCESS_RULES_PATH_ENVIRONMENT_VARIABLE] = writeRulesFile(
      JSON.stringify(validRules),
    );

    writeTestingOverrideFile({
      roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
      objects: { project: { sales: { all: true } } },
    });

    expect(getOnemaAccessRulesState().kind).toBe('loaded');

    // Removed behind the cache's back, the way the app process sees a test
    // clearing its override from the other vm context
    fs.rmSync(testingOverridePath);

    const state = getOnemaAccessRulesState();

    expect(state.kind === 'loaded' && state.isTestingOverride).toBe(false);
    expect(state.kind === 'loaded' && state.rules).toEqual(validRules);
  });

  it('ignores a leftover testing override outside the test environment', () => {
    setOnemaAccessRulesForTesting({
      roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
      objects: { project: { sales: { all: true } } },
    });

    process.env[ONEMA_ACCESS_RULES_PATH_ENVIRONMENT_VARIABLE] = writeRulesFile(
      JSON.stringify(validRules),
    );
    process.env.NODE_ENV = NodeEnvironment.PRODUCTION;

    const state = getOnemaAccessRulesState();

    expect(state.kind === 'loaded' && state.isTestingOverride).toBe(false);
    expect(state.kind === 'loaded' && state.rules).toEqual(validRules);
  });

  it('serves no rules at all outside the test environment when only the override exists', () => {
    setOnemaAccessRulesForTesting({
      roles: { sales: SALES_ROLE_UNIVERSAL_IDENTIFIER },
      objects: { project: { sales: { all: true } } },
    });

    process.env.NODE_ENV = NodeEnvironment.PRODUCTION;

    expect(getOnemaAccessRulesState()).toEqual({ kind: 'absent' });
  });

  it('writes the testing override to a path of its own process', () => {
    setOnemaAccessRulesForTesting(validRules);

    expect(
      fs.existsSync(
        path.join(
          os.tmpdir(),
          `onema-access-rules.testing-override.${process.pid}.json`,
        ),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(os.tmpdir(), 'onema-access-rules.testing-override.json'),
      ),
    ).toBe(false);
  });

  it('refuses to install a testing override outside the test environment', () => {
    process.env.NODE_ENV = NodeEnvironment.PRODUCTION;

    expect(() => setOnemaAccessRulesForTesting(validRules)).toThrow(
      OnemaAccessException,
    );
  });

  it('parses the example rules file shipped with the fork', () => {
    process.env[ONEMA_ACCESS_RULES_PATH_ENVIRONMENT_VARIABLE] = path.join(
      __dirname,
      '../../../../../onema/access-rules.example.json',
    );

    const state = getOnemaAccessRulesState();

    // "loaded" asserted on its own: a `failed` state would make every `&&`
    // below short-circuit to false, which `toBeDefined` happily accepts
    expect(state.kind).toBe('loaded');
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
