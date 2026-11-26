export { DbfTable, DbfError, decodeCell, encodeCell } from "./table.js";
export type { DbfValue, DbfField, DbfFieldSpec } from "./table.js";
export { diffSchemas, sameSchema, shapeOf } from "./schema.js";
export type { FieldShape, SchemaDiff } from "./schema.js";
export { decodeCp866, encodeCp866, unencodableCp866 } from "./cp866.js";
