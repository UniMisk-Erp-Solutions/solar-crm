import type { TableName, TableRow } from '@solar/shared';

export type Primitive = string | number | boolean;
export interface OpObject {
  eq?: Primitive | null; neq?: Primitive | null; gt?: Primitive; gte?: Primitive; lt?: Primitive; lte?: Primitive;
  in?: Primitive[]; nin?: Primitive[]; like?: string; ilike?: string;
  /** array column contains ALL of these values */
  contains?: Primitive[];
  /** array column overlaps ANY of these values */
  overlaps?: Primitive[];
  is_null?: boolean;
}
/**
 * Column filters, ANDed. A bare primitive means equality, an array means "in", `null` means IS NULL,
 * and an object uses the operators above, e.g. { due_at: { lte: iso }, status: ['a', 'b'], deleted_at: null }.
 */
export type Where = Record<string, Primitive | Primitive[] | null | OpObject | undefined>;
export interface OrderBy { col: string; dir?: 'asc' | 'desc' }
export interface ListOpts {
  where?: Where;
  /** case-insensitive substring search across columns (OR) */
  search?: { cols: string[]; text: string };
  orderBy?: OrderBy | OrderBy[];
  limit?: number;
  offset?: number;
}
export interface ListResult<T> { rows: T[]; total: number }

export interface Repo<T> {
  list(opts?: ListOpts): Promise<ListResult<T>>;
  all(where?: Where, opts?: Omit<ListOpts, 'where' | 'limit' | 'offset'>): Promise<T[]>;
  get(id: string): Promise<T | null>;
  getOrThrow(id: string): Promise<T>;
  one(where: Where): Promise<T | null>;
  count(where?: Where): Promise<number>;
  insert(row: Partial<T>): Promise<T>;
  insertMany(rows: Partial<T>[]): Promise<T[]>;
  update(id: string, patch: Partial<T>): Promise<T>;
  updateWhere(where: Where, patch: Partial<T>): Promise<T[]>;
  delete(id: string): Promise<void>;
}

export interface Db {
  table<K extends TableName>(name: K): Repo<TableRow<K>>;
}
