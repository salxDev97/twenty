import { type SqlCondition } from 'src/engine/twenty-orm/types/row-access-policy.type';

// Who may see which records, as data: the rules file ships in the repository
// and is reviewed like code (ADR-004 П-5), never edited through the product UI.
export type OnemaCondition =
  | { all: true }
  | { eq: [string, OnemaConditionValue] }
  | { exists: OnemaExistsCondition }
  | { parent: OnemaParentCondition }
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

export type OnemaRoleKey = string;

// rls-design §12а Т-2: a field that stops being writable once the record itself
// says so — the company and the contract file of a lead that reached "Сделка"
export type OnemaFreezeRule = {
  field: string;
  equals: OnemaConditionValue;
  fields: string[];
};

// rls-design §12а Т-1: fields the product logic rests on. Keyed by object and
// field, the value is the role keys allowed to write it on top of the
// application — `[]` means the application alone.
export type OnemaWriteProtectedFields = Record<
  string,
  Record<string, OnemaRoleKey[]>
>;

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
