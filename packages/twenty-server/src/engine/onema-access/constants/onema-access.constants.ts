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

// A polymorphic hop (`anyParent`, `linked`) is our own indirection, not a level
// of the model: the attachment hangs off the card, it is not a thing between
// them. Keeping the limit at three would mean a card whose own rule already
// reaches three objects could never have its attachments ruled at all —
// attachment → person → company → opportunity is exactly that chain
// (access-matrix §1.2, §1.3). So a path that has taken a polymorphic hop gets
// one object more, and no more than one: the budget is raised once, not per hop.
export const ONEMA_MAX_RULE_DEPTH_THROUGH_POLYMORPHIC_TARGET = 4;

// An unbounded file is a way to make the database do unbounded work. The count
// bounds the file, not the query: the load-time walk sums the rules of every
// role of every object it reaches, while the compiler only ever expands the
// roles the caller actually holds. A polymorphic rule multiplies that walk by
// its targets, so the number is large; what bounds the work one row causes is
// the depth limit above.
export const ONEMA_MAX_CONDITIONS_PER_RULE = 1024;

// An update by filter can touch thousands of rows, and every one of their ids
// becomes a bind parameter of the check after the write. Postgres stops at 65535
// parameters per statement and plans an `IN` list of that size badly long before
// then, so the ids go in batches of this size instead of one statement.
export const ONEMA_RECORD_ID_BATCH_SIZE = 500;

export const ONEMA_ACCESS_LOGGER_CONTEXT = 'OnemaAccess';
