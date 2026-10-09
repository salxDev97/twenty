import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { Logger } from '@nestjs/common';
import { isNonEmptyString } from '@sniptt/guards';
import { isDefined } from 'twenty-shared/utils';

import { NodeEnvironment } from 'src/engine/core-modules/twenty-config/interfaces/node-environment.interface';
import {
  ONEMA_ACCESS_ENFORCE_ENABLED_VALUE,
  ONEMA_ACCESS_ENFORCE_ENVIRONMENT_VARIABLE,
  ONEMA_ACCESS_LOGGER_CONTEXT,
  ONEMA_ACCESS_RULES_PATH_ENVIRONMENT_VARIABLE,
  ONEMA_ACCESS_RULES_RELOAD_INTERVAL_MS,
} from 'src/engine/onema-access/constants/onema-access.constants';
import {
  OnemaAccessException,
  OnemaAccessExceptionCode,
} from 'src/engine/onema-access/exceptions/onema-access.exception';
import { type OnemaAccessRules } from 'src/engine/onema-access/types/onema-access-rules.type';
import { parseOnemaAccessRules } from 'src/engine/onema-access/utils/parse-onema-access-rules.util';

const logger = new Logger(ONEMA_ACCESS_LOGGER_CONTEXT);

// `failed` is not `absent`: a file that stopped parsing must close access, never
// fall back to upstream-only permissions (ADR-003: closed by default)
export type OnemaAccessRulesState =
  | { kind: 'absent' }
  | {
      kind: 'loaded';
      rules: OnemaAccessRules;
      contentHash: string;
      isTestingOverride: boolean;
    }
  | { kind: 'failed'; reason: string; isTestingOverride: boolean };

// The repository is built per request from a plain options object, not from the
// Nest container, so the rules live in a cache instead of a provider.
type OnemaAccessRulesCache = {
  state: OnemaAccessRulesState;
  checkedAtMs: number;
  testingOverrideSignature?: string;
};

const ONEMA_ACCESS_RULES_CACHE_KEY = Symbol.for('onema.accessRulesCache');

const getCache = (): OnemaAccessRulesCache => {
  const globalScope = globalThis as unknown as Record<symbol, unknown>;

  globalScope[ONEMA_ACCESS_RULES_CACHE_KEY] ??= {
    state: { kind: 'absent' },
    checkedAtMs: 0,
  } satisfies OnemaAccessRulesCache;

  return globalScope[ONEMA_ACCESS_RULES_CACHE_KEY] as OnemaAccessRulesCache;
};

// Integration tests boot the app in Jest's globalSetup and drive it from a
// test file; Jest runs each in its own vm context, so they don't share
// `globalThis` (nor even `process`) despite being the same OS process. The
// filesystem is the one thing both sides actually share, so the testing
// override rides on a file instead of the in-memory cache above.
//
// Undefined outside NODE_ENV=test, so the bridge does not exist at all in a
// deployment: a file in the temp directory must never outrank the configured
// rules file, and nothing outside a test may write one. The name carries the
// pid for the same reason — a path shared by every process on the host would
// let one test run (or anything else writing there) set another run's rules.
const getTestingOverridePath = (): string | undefined => {
  if (process.env.NODE_ENV !== NodeEnvironment.TEST) {
    return undefined;
  }

  return path.join(
    os.tmpdir(),
    `onema-access-rules.testing-override.${process.pid}.json`,
  );
};

export const isOnemaAccessEnforced = (): boolean =>
  process.env[ONEMA_ACCESS_ENFORCE_ENVIRONMENT_VARIABLE] ===
  ONEMA_ACCESS_ENFORCE_ENABLED_VALUE;

// Nanoseconds and size, not whole-millisecond mtime: a test that swaps the
// override twice in a row must never be served the first version
const readTestingOverrideSignature = (
  overridePath: string,
): string | undefined => {
  const stats = fs.statSync(overridePath, {
    bigint: true,
    throwIfNoEntry: false,
  });

  return isDefined(stats) ? `${stats.mtimeNs}:${stats.size}` : undefined;
};

export const getOnemaAccessRulesState = (): OnemaAccessRulesState => {
  const cache = getCache();
  const overridePath = getTestingOverridePath();

  if (isDefined(overridePath)) {
    // Every suite of the repository runs with NODE_ENV=test and almost none of
    // them install an override, so this path pays one stat and nothing else
    const signature = readTestingOverrideSignature(overridePath);

    if (isDefined(signature)) {
      // A test changes the rules between two assertions, so its override never
      // waits for the reload interval — but an unchanged file is not re-read
      // and re-hashed on every single query either
      if (
        cache.state.kind !== 'absent' &&
        cache.state.isTestingOverride &&
        cache.testingOverrideSignature === signature
      ) {
        return cache.state;
      }

      cache.testingOverrideSignature = signature;

      return refresh({
        cache,
        rulesPath: overridePath,
        isTestingOverride: true,
      });
    }

    cache.testingOverrideSignature = undefined;

    // The override is gone and the cache still holds what it said: the
    // configured file has to be read back now, not after the reload interval
    if (cache.state.kind !== 'absent' && cache.state.isTestingOverride) {
      cache.checkedAtMs = 0;
    }
  }

  const rulesPath =
    process.env[ONEMA_ACCESS_RULES_PATH_ENVIRONMENT_VARIABLE] ?? '';

  if (!isNonEmptyString(rulesPath)) {
    cache.state = { kind: 'absent' };
    cache.checkedAtMs = Date.now();

    return cache.state;
  }

  if (Date.now() - cache.checkedAtMs < ONEMA_ACCESS_RULES_RELOAD_INTERVAL_MS) {
    return cache.state;
  }

  return refresh({ cache, rulesPath, isTestingOverride: false });
};

// Startup check for the server and the worker: a rules file that cannot be used
// must stop the process rather than let it serve a half-configured deployment
export const loadOnemaAccessRulesOrThrow = (): OnemaAccessRulesState => {
  const state = getOnemaAccessRulesState();

  if (state.kind === 'failed') {
    throw new OnemaAccessException(
      state.reason,
      OnemaAccessExceptionCode.INVALID_RULES,
    );
  }

  if (state.kind === 'absent') {
    if (isOnemaAccessEnforced()) {
      throw new OnemaAccessException(
        `${ONEMA_ACCESS_ENFORCE_ENVIRONMENT_VARIABLE} is set without ${ONEMA_ACCESS_RULES_PATH_ENVIRONMENT_VARIABLE}: enforcement was asked for with nothing to enforce`,
        OnemaAccessExceptionCode.INVALID_RULES,
      );
    }

    return state;
  }

  if (!isOnemaAccessEnforced()) {
    logger.warn(
      `Onema access rules loaded (${state.contentHash.slice(0, 12)}) but NOT enforced: set ${ONEMA_ACCESS_ENFORCE_ENVIRONMENT_VARIABLE}=${ONEMA_ACCESS_ENFORCE_ENABLED_VALUE} to apply them`,
    );

    return state;
  }

  logger.log(
    `Onema access rules enforced, version ${state.contentHash.slice(0, 12)}`,
  );

  return state;
};

// Passing undefined clears the cache and removes the testing override file,
// so the next load reads the environment again
export const setOnemaAccessRulesForTesting = (
  rules: OnemaAccessRules | undefined,
): void => {
  const cache = getCache();
  const overridePath = getTestingOverridePath();

  // Refusing is the point: reached outside a test, this call would otherwise
  // look like it installed rules that nothing will ever read
  if (!isDefined(overridePath)) {
    throw new OnemaAccessException(
      `setOnemaAccessRulesForTesting is a test-only bridge, and NODE_ENV is "${process.env.NODE_ENV}"`,
      OnemaAccessExceptionCode.INVALID_RULES,
    );
  }

  cache.state = { kind: 'absent' };
  cache.checkedAtMs = 0;

  if (isDefined(rules)) {
    // The file goes back through the schema, which demands the key a test has
    // no reason to spell out: a test states what it is testing, and nothing of
    // it is "required" in the sense the real file means
    fs.writeFileSync(
      overridePath,
      JSON.stringify({
        ...rules,
        requiredObjects: rules.requiredObjects ?? [],
        writeProtectedFields: rules.writeProtectedFields ?? {},
        freezeWhen: rules.freezeWhen ?? {},
        writeRequiresParentAccess: rules.writeRequiresParentAccess ?? {},
        transitions: rules.transitions ?? {},
      }),
      { mode: 0o600 },
    );

    return;
  }

  if (fs.existsSync(overridePath)) {
    fs.rmSync(overridePath);
  }
};

// Parse-then-swap: the next state is fully built before a single assignment
// replaces the current one, so a concurrent reader sees either version whole
const refresh = ({
  cache,
  rulesPath,
  isTestingOverride,
}: {
  cache: OnemaAccessRulesCache;
  rulesPath: string;
  isTestingOverride: boolean;
}): OnemaAccessRulesState => {
  cache.checkedAtMs = Date.now();

  let fileContent: string;

  try {
    fileContent = fs.readFileSync(rulesPath, 'utf-8');
  } catch (error) {
    return fail({
      cache,
      isTestingOverride,
      reason: `Onema access rules file "${rulesPath}" cannot be read: ${describeError(error)}`,
    });
  }

  const contentHash = crypto
    .createHash('sha256')
    .update(fileContent)
    .digest('hex');

  if (
    cache.state.kind === 'loaded' &&
    cache.state.contentHash === contentHash
  ) {
    return cache.state;
  }

  let rules: OnemaAccessRules;

  try {
    rules = parseOnemaAccessRules(JSON.parse(fileContent));
  } catch (error) {
    return fail({
      cache,
      isTestingOverride,
      reason: `Onema access rules file "${rulesPath}" is unusable: ${describeError(error)}`,
    });
  }

  cache.state = { kind: 'loaded', rules, contentHash, isTestingOverride };

  logger.log(
    `Onema access rules loaded from "${rulesPath}", version ${contentHash.slice(0, 12)}`,
  );

  return cache.state;
};

const fail = ({
  cache,
  reason,
  isTestingOverride,
}: {
  cache: OnemaAccessRulesCache;
  reason: string;
  isTestingOverride: boolean;
}): OnemaAccessRulesState => {
  if (cache.state.kind !== 'failed' || cache.state.reason !== reason) {
    logger.error(`${reason} — every record is hidden until this is fixed`);
  }

  cache.state = { kind: 'failed', reason, isTestingOverride };

  return cache.state;
};

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
