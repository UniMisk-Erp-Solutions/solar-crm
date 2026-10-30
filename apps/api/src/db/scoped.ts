import type { TableName, TableRow } from '@solar/shared';
import { AppError } from '../http/errors';
import type { Db, ListOpts, ListResult, Repo, Where } from './types';

type Row = Record<string, unknown> & { id: string };

/**
 * Wraps a Db so every read/write is pinned to one organisation (multi-tenant guard — defence in depth
 * on top of Postgres RLS). `organizations` is addressed by id instead of org_id.
 */
export function scopeDb(db: Db, orgId: string): Db {
  return {
    table<K extends TableName>(name: K): Repo<TableRow<K>> {
      const repo = db.table(name) as unknown as Repo<Row>;
      const key = name === 'organizations' ? 'id' : 'org_id';
      const pin = (where?: Where): Where => ({ ...(where ?? {}), [key]: orgId });
      const inOrg = (row: Row | null): boolean => !!row && row[key] === orgId;
      const stripOrg = (patch: Partial<Row>): Partial<Row> => { const { org_id: _o, ...rest } = patch; return rest; };
      const scoped: Repo<Row> = {
        list: (opts?: ListOpts): Promise<ListResult<Row>> => repo.list({ ...opts, where: pin(opts?.where) }),
        all: (where, opts) => repo.all(pin(where), opts),
        get: async (id) => { const r = await repo.get(id); return inOrg(r) ? r : null; },
        getOrThrow: async (id) => {
          const r = await repo.get(id);
          if (!r || !inOrg(r)) throw new AppError(404, 'NOT_FOUND', `${name} not found`);
          return r;
        },
        one: (where) => repo.one(pin(where)),
        count: (where) => repo.count(pin(where)),
        insert: (row) => repo.insert(name === 'organizations' ? row : { ...row, org_id: orgId }),
        insertMany: (rows) => repo.insertMany(rows.map((r) => (name === 'organizations' ? r : { ...r, org_id: orgId }))),
        update: async (id, patch) => {
          const cur = await repo.get(id);
          if (!cur || !inOrg(cur)) throw new AppError(404, 'NOT_FOUND', `${name} not found`);
          return repo.update(id, stripOrg(patch));
        },
        updateWhere: (where, patch) => repo.updateWhere(pin(where), stripOrg(patch)),
        delete: async (id) => {
          const cur = await repo.get(id);
          if (!cur || !inOrg(cur)) return;
          await repo.delete(id);
        },
      };
      return scoped as unknown as Repo<TableRow<K>>;
    },
  };
}
