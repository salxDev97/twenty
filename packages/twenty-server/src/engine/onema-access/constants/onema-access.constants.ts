// No rules file configured means upstream Twenty behaviour, unchanged
export const ONEMA_ACCESS_RULES_PATH_ENVIRONMENT_VARIABLE =
  'ONEMA_ACCESS_RULES_PATH';

// Release gate (ADR-003): reading rules alone leaves the write side open until
// ONE-111 lands, so enforcement stays behind a second, explicit switch
export const ONEMA_ACCESS_ENFORCE_ENVIRONMENT_VARIABLE = 'ONEMA_ACCESS_ENFORCE';

export const ONEMA_ACCESS_ENFORCE_ENABLED_VALUE = '1';

// Every process re-reads the rules file on this interval and swaps the parsed
// result in one assignment, so a revocation reaches running servers and workers
// without a coordinated restart
export const ONEMA_ACCESS_RULES_RELOAD_INTERVAL_MS = 5_000;

export const ONEMA_PARAMETER_PREFIX = 'onema';

// Namespaced so our mark never collides with the one upstream keeps per alias
export const ONEMA_ROW_ACCESS_MARK_PREFIX = 'onema:';

export const ONEMA_ALWAYS_FALSE_CONDITION = '1=0';

// A rule reaching further than three objects is a modelling mistake, not a need
export const ONEMA_MAX_RULE_DEPTH = 3;

// A correlated subquery per condition: a rule this wide is a modelling mistake
// too, and an unbounded one is a way to make the database do unbounded work
export const ONEMA_MAX_CONDITIONS_PER_RULE = 32;

// An update by filter can touch thousands of rows, and every one of their ids
// becomes a bind parameter of the check after the write. Postgres stops at 65535
// parameters per statement and plans an `IN` list of that size badly long before
// then, so the ids go in batches of this size instead of one statement.
export const ONEMA_RECORD_ID_BATCH_SIZE = 500;

export const ONEMA_ACCESS_LOGGER_CONTEXT = 'OnemaAccess';
