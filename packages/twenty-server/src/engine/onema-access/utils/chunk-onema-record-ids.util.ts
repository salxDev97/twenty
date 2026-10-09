// An update by filter is bounded by QUERY_MAX_RECORDS upstream, but a delete or
// a restore is not, and every id of the result becomes a bind parameter here
export const chunkOnemaRecordIds = (
  recordIds: string[],
  batchSize: number,
): string[][] => {
  const batches: string[][] = [];

  for (let cursor = 0; cursor < recordIds.length; cursor += batchSize) {
    batches.push(recordIds.slice(cursor, cursor + batchSize));
  }

  return batches;
};
