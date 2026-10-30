import type { TableName } from '../enums';
import type { TableRowMap } from '../rows';

/** Every table's seed rows. Missing tables are simply empty. */
export type SeedData = { [K in TableName]?: TableRowMap[K][] };
