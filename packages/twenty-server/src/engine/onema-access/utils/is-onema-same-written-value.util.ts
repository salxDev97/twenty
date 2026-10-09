import { isDefined } from 'twenty-shared/utils';

// Shared by the freeze (Т-2) and the transition (Т-3/Т-7) checks: both compare
// a column's state before the write against something the write is about to
// set, and both need the same forgiveness — a client that sends a whole
// record back writes every field with the value it already holds, and that is
// not a change either check should ever refuse.
//
// Rewriting a field with the value it already holds is not a change, and
// anything the comparison cannot see through counts as different, so refusal
// is the default rather than the exception.
export const isOnemaSameWrittenValue = (
  before: unknown,
  written: unknown,
): boolean => {
  if (before === written) {
    return true;
  }

  if (!isDefined(before) && !isDefined(written)) {
    return true;
  }

  // One side of a timestamp comparison is a Date and the other a string often
  // enough that identity alone would refuse writes that change nothing
  if (before instanceof Date || written instanceof Date) {
    return toComparableDate(before) === toComparableDate(written);
  }

  if (typeof before !== 'object' || typeof written !== 'object') {
    return false;
  }

  return stableStringify(before) === stableStringify(written);
};

const toComparableDate = (value: unknown): number | undefined => {
  if (value instanceof Date) {
    return value.getTime();
  }

  if (typeof value === 'string') {
    const parsed = new Date(value).getTime();

    return Number.isNaN(parsed) ? undefined : parsed;
  }

  return undefined;
};

// Key order is not part of a jsonb value, and the row read back from Postgres
// has no reason to carry the order the client sent
const stableStringify = (value: unknown): string =>
  JSON.stringify(sortKeysDeeply(value));

const sortKeysDeeply = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeeply);
  }

  if (typeof value !== 'object' || !isDefined(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => [key, sortKeysDeeply(entryValue)]),
  );
};
