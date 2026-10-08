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

export type OnemaAccessRules = {
  roles: Record<OnemaRoleKey, string>;
  objects: Record<string, Partial<Record<OnemaRoleKey, OnemaCondition>>>;
};

export type OnemaAccessSubject = {
  // Undefined for API keys and applications: `$me` can then match nothing
  workspaceMemberId: string | undefined;
  roleIds: string[];
};

export type OnemaRowAccess =
  | { kind: 'open' }
  | { kind: 'denied' }
  | { kind: 'gated'; condition: SqlCondition };
