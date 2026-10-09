import { type SqlCondition } from 'src/engine/twenty-orm/types/row-access-policy.type';

// Who may see which records, as data: the rules file ships in the repository
// and is reviewed like code (ADR-004 П-5), never edited through the product UI.
export type OnemaCondition =
  | { all: true }
  | { eq: [string, OnemaConditionValue] }
  | { exists: OnemaExistsCondition }
  | { parent: OnemaParentCondition }
  | { anyParent: OnemaAnyParentCondition }
  | { linked: OnemaLinkedCondition }
  | { and: OnemaCondition[] }
  | { or: OnemaCondition[] };

export type OnemaConditionValue = string | number | boolean | null;

export type OnemaExistsCondition = {
  object: string;
  backForeignKey: string;
  where?: OnemaCondition;
};

export type OnemaParentCondition = {
  foreignKey: string;
  object: string;
};

// rls-design §3.1, §5. A polymorphic link is not one foreign key but a set of
// `target*Id` columns of which at most one is filled, so the record follows
// whichever parent it actually has. Every parent is spelled out — the object as
// well as the key — because the load-time cycle and depth checks run on the
// file alone, before any workspace metadata is in hand.
export type OnemaAnyParentCondition = {
  parents: OnemaParentCondition[];
};

// rls-design §3.1, §5. `timelineActivity` points at its source record by
// object metadata id plus record id, so the branch is picked by comparing the
// stored metadata id against the one each named object has in this workspace.
export type OnemaLinkedCondition = {
  objectIdField: string;
  recordIdField: string;
  objects: string[];
};

export type OnemaRoleKey = string;

// rls-design §12а Т-2: a field that stops being writable once the record itself
// says so — the company and the contract file of a lead that reached "Сделка"
export type OnemaFreezeRule = {
  field: string;
  equals: OnemaConditionValue;
  fields: string[];
  // A latch: the condition field freezes itself too, so the state it names is
  // never left. Without it a freeze is only a speed bump — "Сделка" → другая
  // стадия → подмена компании → обратно в "Сделку" clears the condition on the
  // middle write and nothing of the rule ever sees it (rls-design §12а Т-2)
  isIrreversible?: boolean;
};

// rls-design §12а Т-1: fields the product logic rests on. Keyed by object and
// field, the value is the role keys allowed to write it on top of the
// application — `[]` means the application alone.
export type OnemaWriteProtectedFields = Record<
  string,
  Record<string, OnemaRoleKey[]>
>;

// rls-design §3.3 point №5: which relation holds "the owner" of an object, per
// role, spelled out. Reading it off any `eq [field, '$me']` instead would fill
// `assignee`, `projectManager` or whatever service field is written like that
// next, silently and with the current participant.
export type OnemaOwnerDefaults = Record<string, Record<OnemaRoleKey, string>>;

// rls-design §5, the other side of every `exists` and `parent` link. Access to a
// project is granted by a row of `projectMember`, and that row is not itself a
// project: the check after the write asks whether the membership is visible to
// its author, which it trivially is, and never asks whose project it joins.
// Naming the link here makes writing the child a write on the parent too.
export type OnemaWriteRequiresParentAccess = Record<
  string,
  OnemaParentCondition[]
>;

// rls-design §12а Т-3/Т-7 (hardening.md п. 3): one edge of the status graph of
// an object — a single starting value and the values it may move to from
// there, plus who besides the application may drive it. `null` in `from`
// means "the field has never been set" (the row the insert path is about to
// create), so the graph also names the states a record is allowed to be born
// into. `roleKeys: []` means the edge belongs to the application alone — a
// serverside command such as the CEO decision or the client acceptance, never
// a role writing the status field itself over REST or GraphQL.
export type OnemaTransitionRule = {
  from: OnemaConditionValue;
  to: OnemaConditionValue[];
  roleKeys: OnemaRoleKey[];
};

// Keyed by object, then naming one status field of it. Only one field per
// object is supported on purpose: a second status field of the same object
// wants its own entry, and nothing here guesses which of two fields an edge
// without a name belongs to.
export type OnemaObjectTransitionRules = {
  field: string;
  rules: OnemaTransitionRule[];
};

export type OnemaTransitionRules = Record<string, OnemaObjectTransitionRules>;

export type OnemaAccessRules = {
  // Role key of the rules file to the universalIdentifier of the Twenty role:
  // stable across reinstalls and renames, unlike a role id or a UI label
  roles: Record<OnemaRoleKey, string>;
  // universalIdentifier of the application whose logic functions may write the
  // protected fields; demanded as soon as writeProtectedFields names one
  application?: string;
  // Objects that must have a non-empty rule, or the file is refused whole.
  // The schema makes the key mandatory in a file; optional here because rules
  // built in memory (tests, the testing bridge) have no file to forget it in
  requiredObjects?: string[];
  objects: Record<string, Partial<Record<OnemaRoleKey, OnemaCondition>>>;
  // Mandatory in a file for the same reason as requiredObjects: a forgotten key
  // would read exactly like a deliberate "nothing is protected"
  writeProtectedFields?: OnemaWriteProtectedFields;
  freezeWhen?: Record<string, OnemaFreezeRule[]>;
  // Mandatory in a file for the same reason as writeProtectedFields: a forgotten
  // key leaves every access-granting link open, and reads exactly like a
  // deliberate "no link grants anybody access"
  writeRequiresParentAccess?: OnemaWriteRequiresParentAccess;
  // Mandatory in a file for the same reason as writeProtectedFields and
  // writeRequiresParentAccess: a forgotten key would leave every status
  // transition of every object open, indistinguishable from "this object has
  // no guarded status field"
  transitions?: OnemaTransitionRules;
  ownerDefaults?: OnemaOwnerDefaults;
};

export type OnemaAccessSubject = {
  // Undefined for API keys and applications: `$me` can then match nothing
  workspaceMemberId: string | undefined;
  roleUniversalIdentifiers: string[];
};

export type OnemaRowAccess =
  | { kind: 'open' }
  | { kind: 'denied' }
  | { kind: 'gated'; condition: SqlCondition };
