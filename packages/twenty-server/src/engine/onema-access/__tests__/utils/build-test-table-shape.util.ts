import { FieldMetadataType } from 'twenty-shared/types';

import { RelationType } from 'src/engine/metadata-modules/field-metadata/interfaces/relation-type.interface';
import { type WorkspaceTableShape } from 'src/engine/twenty-orm/table-shape/types/workspace-table-shape.type';

export const buildTestTableShape = ({
  nameSingular,
  columnNames = [],
  joinColumnNameByFieldName = {},
  hasDeletedAtColumn = true,
}: {
  nameSingular: string;
  columnNames?: string[];
  joinColumnNameByFieldName?: Record<string, string>;
  hasDeletedAtColumn?: boolean;
}): WorkspaceTableShape => {
  const allColumnNames = [
    'id',
    ...columnNames,
    ...Object.values(joinColumnNameByFieldName),
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
            targetObjectMetadataId: `object-metadata-id-${fieldName}`,
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
