import { isPlainObject } from 'twenty-shared/utils';

import {
  type OnemaConditionValue,
  type OnemaRoleKey,
  type OnemaTransitionRule,
  type OnemaTransitionTarget,
} from 'src/engine/onema-access/types/onema-access-rules.type';

type OnemaNamedTransitionTarget = Exclude<
  OnemaTransitionTarget,
  OnemaConditionValue
>;

// A value of the graph is never an object, so the shape alone tells the two
// readings of one `to` entry apart
const isNamedTransitionTarget = (
  target: OnemaTransitionTarget,
): target is OnemaNamedTransitionTarget => isPlainObject(target);

// ONE-203. The two readings in one place: the loader, the metadata check and
// the hook all have to agree on which of a bare value and a named target they
// are looking at.
export const readOnemaTransitionTargetValue = (
  target: OnemaTransitionTarget,
): OnemaConditionValue =>
  isNamedTransitionTarget(target) ? target.value : target;

// A target that names nobody falls back to the edge: that is what the whole
// format did before per-target roles existed, and it is still how a graph
// whose every move is open to the same people is written
export const readOnemaTransitionTargetRoleKeys = ({
  target,
  edge,
}: {
  target: OnemaTransitionTarget;
  edge: OnemaTransitionRule;
}): OnemaRoleKey[] =>
  isNamedTransitionTarget(target) ? target.roleKeys : edge.roleKeys;
