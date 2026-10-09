import { FieldMetadataType } from 'twenty-shared/types';

import { RelationType } from 'src/engine/metadata-modules/field-metadata/interfaces/relation-type.interface';
import { type WorkspaceTableShape } from 'src/engine/twenty-orm/table-shape/types/workspace-table-shape.type';

export const buildTestTableShape = ({
  nameSingular,
  columnNames = [],
  joinColumnNameByFieldName = {},
  relationTargetByFieldName = {},
  compositeParentFieldNameByColumnName = {},
  hasDeletedAtColumn = true,
}: {
  nameSingular: string;
  columnNames?: string[];
  joinColumnNameByFieldName?: Record<string, string>;
  // Which object a relation points at, when it is not the one the field is
  // named after — `accountOwner` points at `workspaceMember`
  relationTargetByFieldName?: Record<string, string>;
  // A composite field is several columns, each naming the field it belongs to
  compositeParentFieldNameByColumnName?: Record<string, string>;
  hasDeletedAtColumn?: boolean;
}): WorkspaceTableShape => {
  const allColumnNames = [
    'id',
    ...columnNames,
    ...Object.values(joinColumnNameByFieldName),
    ...Object.keys(compositeParentFieldNameByColumnName),
    ...(hasDeletedAtColumn ? ['deletedAt'] : []),
  ];

  return {
    objectMetadataId: `object-metadata-id-${nameSingular}`,
    nameSingular,
    schemaName: 'workspace_test',
    tableName: `_${nameSingular}`,
    columnShapeByColumnName: Object.fromEntries(
      allColumnNames.map((columnName) => [
        columnName,
        {
          columnName,
          fieldMetadataId: `field-metadata-id-${nameSingular}-${columnName}`,
          fieldName: columnName,
          fieldMetadataType: FieldMetadataType.TEXT,
          compositeParentFieldName:
            compositeParentFieldNameByColumnName[columnName],
        },
      ]),
    ),
    columnNames: allColumnNames,
    relationShapeByFieldName: Object.fromEntries(
      Object.entries(joinColumnNameByFieldName).map(
        ([fieldName, joinColumnName]) => [
          fieldName,
          {
            fieldName,
            fieldMetadataId: `field-metadata-id-${nameSingular}-${fieldName}`,
            relationType: RelationType.MANY_TO_ONE,
            targetObjectMetadataId: `object-metadata-id-${
              relationTargetByFieldName[fieldName] ?? fieldName
            }`,
            targetFieldMetadataId: null,
            joinColumnName,
          },
        ],
      ),
    ),
    hasDeletedAtColumn,
  };
};

export const buildTestTableShapeRegistry = (
  tableShapes: WorkspaceTableShape[],
) => {
  const tableShapeByObjectMetadataId = Object.fromEntries(
    tableShapes.map((tableShape) => [tableShape.objectMetadataId, tableShape]),
  );

  return {
    objectIdByNameSingular: Object.fromEntries(
      tableShapes.map((tableShape) => [
        tableShape.nameSingular,
        tableShape.objectMetadataId,
      ]),
    ),
    tableShapeByObjectMetadataId: (objectMetadataId: string) =>
      tableShapeByObjectMetadataId[objectMetadataId],
  };
};
