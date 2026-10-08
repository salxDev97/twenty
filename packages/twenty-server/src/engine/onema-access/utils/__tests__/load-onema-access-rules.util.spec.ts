import fs from 'fs';
import os from 'os';
import path from 'path';

import { ONEMA_ACCESS_RULES_PATH_ENVIRONMENT_VARIABLE } from 'src/engine/onema-access/constants/onema-access.constants';
import { OnemaAccessException } from 'src/engine/onema-access/exceptions/onema-access.exception';
import {
  loadOnemaAccessRules,
  setOnemaAccessRulesForTesting,
} from 'src/engine/onema-access/utils/load-onema-access-rules.util';

const SALES_ROLE_ID = '00000000-0000-4000-8000-000000000005';

describe('loadOnemaAccessRules', () => {
  let temporaryDirectory: string;

  beforeEach(() => {
    temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'onema-access-rules-'),
    );
    setOnemaAccessRulesForTesting(undefined);
    delete process.env[ONEMA_ACCESS_RULES_PATH_ENVIRONMENT_VARIABLE];
  });

  afterEach(() => {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    setOnemaAccessRulesForTesting(undefined);
    delete process.env[ONEMA_ACCESS_RULES_PATH_ENVIRONMENT_VARIABLE];
  });

  const writeRulesFile = (content: string): string => {
    const rulesPath = path.join(temporaryDirectory, 'access-rules.json');

    fs.writeFileSync(rulesPath, content);

    return rulesPath;
  };

  it('returns nothing when no rules file is configured', () => {
    expect(loadOnemaAccessRules()).toBeUndefined();
  });

  it('reads and parses the configured rules file once', () => {
    const rulesPath = writeRulesFile(
      JSON.stringify({
        roles: { sales: SALES_ROLE_ID },
        objects: { opportunity: { sales: { eq: ['owner', '$me'] } } },
      }),
    );

    process.env[ONEMA_ACCESS_RULES_PATH_ENVIRONMENT_VARIABLE] = rulesPath;

    expect(loadOnemaAccessRules()).toEqual({
      roles: { sales: SALES_ROLE_ID },
      objects: { opportunity: { sales: { eq: ['owner', '$me'] } } },
    });

    fs.rmSync(rulesPath);

    expect(loadOnemaAccessRules()).toBeDefined();
  });

  it('throws when the configured file is missing', () => {
    process.env[ONEMA_ACCESS_RULES_PATH_ENVIRONMENT_VARIABLE] = path.join(
      temporaryDirectory,
      'absent.json',
    );

    expect(() => loadOnemaAccessRules()).toThrow(OnemaAccessException);
  });

  it('throws when the configured file is not valid JSON', () => {
    process.env[ONEMA_ACCESS_RULES_PATH_ENVIRONMENT_VARIABLE] =
      writeRulesFile('{ not json');

    expect(() => loadOnemaAccessRules()).toThrow(/not valid JSON/);
  });

  it('parses the example rules file shipped with the fork', () => {
    process.env[ONEMA_ACCESS_RULES_PATH_ENVIRONMENT_VARIABLE] = path.join(
      __dirname,
      '../../../../../onema/access-rules.example.json',
    );

    expect(loadOnemaAccessRules()?.objects.opportunity).toBeDefined();
  });
});
