import fs from 'fs';
import os from 'os';
import path from 'path';

import { isNonEmptyString } from '@sniptt/guards';
import { isDefined } from 'twenty-shared/utils';

import { ONEMA_ACCESS_RULES_PATH_ENVIRONMENT_VARIABLE } from 'src/engine/onema-access/constants/onema-access.constants';
import {
  OnemaAccessException,
  OnemaAccessExceptionCode,
} from 'src/engine/onema-access/exceptions/onema-access.exception';
import { type OnemaAccessRules } from 'src/engine/onema-access/types/onema-access-rules.type';
import { parseOnemaAccessRules } from 'src/engine/onema-access/utils/parse-onema-access-rules.util';

// The repository is built per request from a plain options object, not from the
// Nest container, so the rules live in a cache instead of a provider.
type OnemaAccessRulesCache = {
  rules: OnemaAccessRules | undefined;
  areRulesLoaded: boolean;
};

const ONEMA_ACCESS_RULES_CACHE_KEY = Symbol.for('onema.accessRulesCache');

const getCache = (): OnemaAccessRulesCache => {
  const globalScope = globalThis as unknown as Record<symbol, unknown>;

  globalScope[ONEMA_ACCESS_RULES_CACHE_KEY] ??= {
    rules: undefined,
    areRulesLoaded: false,
  } satisfies OnemaAccessRulesCache;

  return globalScope[ONEMA_ACCESS_RULES_CACHE_KEY] as OnemaAccessRulesCache;
};

// Integration tests boot the app in Jest's globalSetup and drive it from a
// test file; Jest runs each in its own vm context, so they don't share
// `globalThis` (nor even `process`) despite being the same OS process. The
// filesystem is the one thing both sides actually share, so the testing
// override rides on a file instead of the in-memory cache above.
const getTestingOverridePath = (): string =>
  path.join(os.tmpdir(), 'onema-access-rules.testing-override.json');

export const loadOnemaAccessRules = (): OnemaAccessRules | undefined => {
  const overridePath = getTestingOverridePath();

  if (fs.existsSync(overridePath)) {
    return parseOnemaAccessRules(readRulesFile(overridePath));
  }

  const cache = getCache();

  if (cache.areRulesLoaded) {
    return cache.rules;
  }

  const rulesPath =
    process.env[ONEMA_ACCESS_RULES_PATH_ENVIRONMENT_VARIABLE] ?? '';

  if (!isNonEmptyString(rulesPath)) {
    cache.rules = undefined;
    cache.areRulesLoaded = true;

    return undefined;
  }

  cache.rules = parseOnemaAccessRules(readRulesFile(rulesPath));
  cache.areRulesLoaded = true;

  return cache.rules;
};

// Passing undefined clears the cache and removes the testing override file,
// so the next load reads the environment again
export const setOnemaAccessRulesForTesting = (
  rules: OnemaAccessRules | undefined,
): void => {
  const cache = getCache();

  cache.rules = rules;
  cache.areRulesLoaded = isDefined(rules);

  const overridePath = getTestingOverridePath();

  if (isDefined(rules)) {
    fs.writeFileSync(overridePath, JSON.stringify(rules));
  } else if (fs.existsSync(overridePath)) {
    fs.rmSync(overridePath);
  }
};

const readRulesFile = (rulesPath: string): unknown => {
  let fileContent: string;

  try {
    fileContent = fs.readFileSync(rulesPath, 'utf-8');
  } catch (error) {
    throw new OnemaAccessException(
      `Onema access rules file "${rulesPath}" cannot be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
      OnemaAccessExceptionCode.INVALID_RULES,
    );
  }

  try {
    return JSON.parse(fileContent);
  } catch (error) {
    throw new OnemaAccessException(
      `Onema access rules file "${rulesPath}" is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
      OnemaAccessExceptionCode.INVALID_RULES,
    );
  }
};
