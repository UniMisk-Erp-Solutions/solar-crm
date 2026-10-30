import { INTERNAL_ROLES, entityPath, type AppRole } from '@solar/shared';
import type { AppContext } from '../auth/context';
import type { NotifyInput, NotifyService } from './contracts';

export function createNotifyService(ctx: AppContext): NotifyService {
  return {
    async notify(input: NotifyInput): Promise<number> {
      const ids = new Set<string>(input.user_ids ?? []);
      if (input.roles?.length) {
        const users = await ctx.db.table('profiles').all({ active: true, role: input.roles as AppRole[] });
        for (const u of users) {
          const external = !INTERNAL_ROLES.includes(u.role);
          if (external && input.distributor_id && u.distributor_id !== input.distributor_id) continue;
          if (external && !input.distributor_id) continue;
          ids.add(u.id);
        }
      }
      let created = 0;
      for (const userId of ids) {
        if (input.entity_id) {
          // do not repeat an identical unread notification (clock ticks run every minute)
          const dup = await ctx.db.table('notifications').one({ user_id: userId, kind: input.kind, entity_id: input.entity_id, read_at: null });
          if (dup) continue;
        }
        await ctx.db.table('notifications').insert({
          user_id: userId, target_role: null, kind: input.kind, title: input.title, body: input.body ?? null, severity: input.severity ?? 'info',
          link: input.link ?? (input.entity_type && input.entity_id ? entityPath(input.entity_type, input.entity_id) : null),
          entity_type: input.entity_type ?? null, entity_id: input.entity_id ?? null, read_at: null,
        });
        created++;
      }
      return created;
    },
  };
}
