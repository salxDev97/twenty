import fs from 'fs';

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
// Nest container, so the rules live in a module-level cache instead of a provider
let cachedRules: OnemaAccessRules | undefined;
let areRulesLoaded = false;

export const loadOnemaAccessRules = (): OnemaAccessRules | undefined => {
  if (areRulesLoaded) {
    return cachedRules;
  }

  const rulesPath =
    process.env[ONEMA_ACCESS_RULES_PATH_ENVIRONMENT_VARIABLE] ?? '';

  if (!isNonEmptyString(rulesPath)) {
    areRulesLoaded = true;
    cachedRules = undefined;

    return undefined;
  }

  cachedRules = parseOnemaAccessRules(readRulesFile(rulesPath));
  areRulesLoaded = true;

  return cachedRules;
};

// Passing undefined clears the cache, so the next load reads the environment again
export const setOnemaAccessRulesForTesting = (
  rules: OnemaAccessRules | undefined,
): void => {
  cachedRules = rules;
  areRulesLoaded = isDefined(rules);
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
