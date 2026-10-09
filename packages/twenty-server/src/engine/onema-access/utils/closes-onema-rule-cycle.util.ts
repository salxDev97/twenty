// Whether a rule reaching `objectName` from `objectPath` is walking in a circle.
//
// The exempt object is the one the chain was seeded with, and only a chain
// seeded by a written row has one (rls-design §5, Б5): `projectMember → project
// → projectMember` reads *other* membership rows under their own rule, which is
// how a contractor sees the project at all, so refusing it as a cycle took away
// the membership they were entitled to create.
//
// The exemption buys exactly the one return the seed caused. A second
// (`… → projectMember → project → projectMember`) is a loop that nests another
// subquery over the same table per level and reaches nothing new. Today
// `ONEMA_MAX_RULE_DEPTH` already cuts the walk before a second return can be
// asked for; counting the visits here means the invariant holds whatever that
// limit is set to next, rather than resting on it.
export const closesOnemaRuleCycle = ({
  objectPath,
  objectName,
  cycleExemptObjectName,
}: {
  objectPath: string[];
  objectName: string;
  cycleExemptObjectName?: string;
}): boolean => {
  const visitCount = objectPath.filter(
    (visitedObjectName) => visitedObjectName === objectName,
  ).length;

  if (visitCount === 0) {
    return false;
  }

  return !(visitCount === 1 && objectName === cycleExemptObjectName);
};
