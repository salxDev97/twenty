import { isOnemaAccessPossiblyActive } from 'src/engine/onema-access/utils/resolve-onema-access.util';

// rls-design §3.2 point №4, Б4. The check after the write needs the ids of the
// rows the write touched, and it refuses a write that cannot name them. Some
// callers build the returning list out of the GraphQL selection — a merge that
// asks for `name` alone is a legitimate write whose list holds no `id` — so the
// column is added rather than demanded: the refusal in
// assert-onema-written-records-are-accessible.util.ts stays as the backstop for
// a path that never came through here.
//
// A no-op when no rules are configured, so a write returns exactly what upstream
// asked it to return.
export const withOnemaReturnedIdColumn = (
  columnsToReturn: string[],
): string[] =>
  !isOnemaAccessPossiblyActive() || columnsToReturn.includes('id')
    ? columnsToReturn
    : [...columnsToReturn, 'id'];
