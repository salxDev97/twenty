import { isDefined } from 'twenty-shared/utils';

import { type WorkspaceTableShape } from 'src/engine/twenty-orm/table-shape/types/workspace-table-shape.type';

// A rules file names fields, a write names columns, and the two are not one to
// one: a relation is a join column, and a composite field is several columns at
// once (`onemaContractFiles` is not the whole of what a FILES field writes). A
// check that looked at the field name alone would miss every write that uses
// another spelling of the same field.
export const resolveOnemaFieldColumnNames = ({
  tableShape,
  fieldName,
}: {
  tableShape: WorkspaceTableShape;
  fieldName: string;
}): string[] => {
  const joinColumnName =
    tableShape.relationShapeByFieldName[fieldName]?.joinColumnName;

  if (isDefined(joinColumnName)) {
    return [joinColumnName];
  }

  return Object.values(tableShape.columnShapeByColumnName)
    .filter(
      (columnShape) =>
        columnShape.columnName === fieldName ||
        columnShape.fieldName === fieldName ||
        columnShape.compositeParentFieldName === fieldName,
    )
    .map((columnShape) => columnShape.columnName);
};
