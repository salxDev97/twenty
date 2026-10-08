// No rules file configured means upstream Twenty behaviour, unchanged
export const ONEMA_ACCESS_RULES_PATH_ENVIRONMENT_VARIABLE =
  'ONEMA_ACCESS_RULES_PATH';

export const ONEMA_PARAMETER_PREFIX = 'onema';

// Namespaced so our mark never collides with the one upstream keeps per alias
export const ONEMA_ROW_ACCESS_MARK_PREFIX = 'onema:';

export const ONEMA_ALWAYS_FALSE_CONDITION = '1=0';

// A rule reaching further than three objects is a modelling mistake, not a need
export const ONEMA_MAX_RULE_DEPTH = 3;
