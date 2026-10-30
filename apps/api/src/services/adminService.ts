/**
 * Admin operations: users (with Supabase Auth in live mode), territories, message templates, gate applicability,
 * rule-backed settings (work calendar, SLA), audit viewer, lead-source API keys and the demo reset.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  APPLICABILITIES, GATES, IMMUTABLE_TABLES, ROLE_LABEL, SEGMENTS, TABLE_NAMES, adminTemplateIssues, istDateString, splitRulePath,
  type Applicability, type AuditLog, type Gate, type GateApplicability, type Json, type LeadSource, type MessageTemplate, type PlatformRuleRow, type Profile, type RuleConfig,
  type Segment, type SourceApiKey, type Territory, type TableName, type TableRow,
} from '@solar/shared';
import { buildSeed } from '@solar/shared/seed';
import type { z } from 'zod';
import type {
  adminAuditQuerySchema, adminSlaUpdateSchema, adminTemplateCreateSchema, adminTemplateUpdateSchema, adminTerritoryCreateSchema, adminTerritoryUpdateSchema,
  adminUserCreateSchema, adminUserUpdateSchema, adminWorkCalendarUpdateSchema,
} from '@solar/shared';
import { isInternal } from '../auth/access';
import type { AppContext } from '../auth/context';
import { MemoryDb } from '../db/memory';
import type { Where } from '../db/types';
import type { AppDeps } from '../deps';
import { AppError, conflict, forbidden, guardBlocked, notFound } from '../http/errors';
import { audit, redactPii } from '../lib/audit';
import { DEFAULT_WORK_CALENDAR, istEndOfDay, istMidnight, type WorkCalendar } from '../lib/time';

/* ═════════════════════════ shared helpers ═════════════════════════ */
const invalid = (issues: { path: string; message: string }[]): AppError => new AppError(422, 'VALIDATION_ERROR', 'Please check the highlighted fields', issues);
const fieldError = (path: string, message: string): AppError => invalid([{ path, message }]);
const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];
async function rowsIn<K extends TableName>(ctx: AppContext, table: K, ids: string[], col = 'id'): Promise<TableRow<K>[]> {
  const list = uniq(ids);
  return list.length ? ctx.db.table(table).all({ [col]: list }) : [];
}

/* ═════════════════════════ Supabase Auth bridge (live mode) ═════════════════════════ */
export interface AuthAdmin {
  /** Creates the Auth user and returns its id (used as profiles.id). */
  createUser(input: { email: string; full_name: string; send_invite: boolean; password?: string }): Promise<{ id: string }>;
  deleteUser(id: string): Promise<void>;
  setBanned(id: string, banned: boolean): Promise<void>;
}

let clientCache: { key: string; client: SupabaseClient } | null = null;
function serviceClient(ctx: AppContext): SupabaseClient {
  const url = ctx.config.SUPABASE_URL;
  const key = ctx.config.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new AppError(500, 'INTERNAL', 'Authentication is not configured — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  if (!clientCache || clientCache.key !== `${url}|${key}`) {
    clientCache = { key: `${url}|${key}`, client: createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }) };
  }
  return clientCache.client;
}

const supabaseAuthAdmin = (ctx: AppContext): AuthAdmin => ({
  async createUser(i) {
    const admin = serviceClient(ctx).auth.admin;
    const meta = { full_name: i.full_name };
    const { data, error } = i.send_invite
      ? await admin.inviteUserByEmail(i.email, { data: meta })
      : await admin.createUser({ email: i.email, password: i.password, email_confirm: true, user_metadata: meta });
    if (error || !data.user) {
      if (error && /already|registered|exists/i.test(error.message)) throw conflict('A sign-in account with this e-mail already exists');
      throw new AppError(502, 'INTERNAL', `Could not create the sign-in account: ${error?.message ?? 'unknown error'}`);
    }
    return { id: data.user.id };
  },
  async deleteUser(id) { await serviceClient(ctx).auth.admin.deleteUser(id); },
  async setBanned(id, banned) { await serviceClient(ctx).auth.admin.updateUserById(id, { ban_duration: banned ? '876000h' : 'none' }); },
});

type AuthAdminFactory = (ctx: AppContext) => AuthAdmin | null;
let authAdminFactory: AuthAdminFactory = (ctx) => (ctx.config.demo ? null : supabaseAuthAdmin(ctx));
/** Tests (and alternative identity providers) can replace the Auth bridge. Return null to behave like demo mode. */
export function setAuthAdminFactory(fn: AuthAdminFactory | null): void { authAdminFactory = fn ?? ((ctx) => (ctx.config.demo ? null : supabaseAuthAdmin(ctx))); }

/* ═════════════════════════ users ═════════════════════════ */
export interface UserView extends Profile { role_label: string; distributor_name: string | null; dealer_name: string | null; territory_names: string[]; reports_to_name: string | null }

export async function hydrateUsers(ctx: AppContext, users: Profile[]): Promise<UserView[]> {
  const [dists, dealers, terrs, managers] = await Promise.all([
    rowsIn(ctx, 'distributors', users.map((u) => u.distributor_id).filter((x): x is string => !!x)),
    rowsIn(ctx, 'dealers', users.map((u) => u.dealer_id).filter((x): x is string => !!x)),
    rowsIn(ctx, 'territories', users.flatMap((u) => u.territory_ids)),
    rowsIn(ctx, 'profiles', users.map((u) => u.reports_to).filter((x): x is string => !!x)),
  ]);
  const name = <T extends { id: string }>(rows: T[], pick: (r: T) => string) => new Map(rows.map((r) => [r.id, pick(r)]));
  const dn = name(dists, (d) => d.legal_name), ln = name(dealers, (d) => d.legal_name), tn = name(terrs, (t) => t.name), mn = name(managers, (m) => m.full_name);
  return users.map((u) => ({
    ...u, role_label: ROLE_LABEL[u.role], distributor_name: u.distributor_id ? dn.get(u.distributor_id) ?? null : null, dealer_name: u.dealer_id ? ln.get(u.dealer_id) ?? null : null,
    territory_names: u.territory_ids.map((t) => tn.get(t)).filter((x): x is string => !!x), reports_to_name: u.reports_to ? mn.get(u.reports_to) ?? null : null,
  }));
}

interface UserShape { role: Profile['role']; distributor_id: string | null; dealer_id: string | null; territory_ids: string[]; reports_to: string | null }

/** Checks role/party/territory consistency and returns the normalised party ids. */
async function validateUserShape(ctx: AppContext, s: UserShape, selfId?: string): Promise<{ distributor_id: string | null; dealer_id: string | null }> {
  let distributor_id = s.distributor_id;
  const dealer_id = s.dealer_id;
  if (s.role === 'distributor_user') {
    if (!distributor_id) throw fieldError('distributor_id', 'A distributor user must belong to a distributor');
    if (!(await ctx.db.table('distributors').get(distributor_id))) throw fieldError('distributor_id', 'That distributor does not exist');
    if (dealer_id) throw fieldError('dealer_id', 'A distributor user is not linked to a dealer');
  } else if (s.role === 'dealer_user') {
    if (!dealer_id) throw fieldError('dealer_id', 'A dealer user must belong to a dealer');
    const dealer = await ctx.db.table('dealers').get(dealer_id);
    if (!dealer) throw fieldError('dealer_id', 'That dealer does not exist');
    if (distributor_id && distributor_id !== dealer.distributor_id) throw fieldError('distributor_id', 'That dealer belongs to a different distributor');
    distributor_id = dealer.distributor_id;
  } else if (distributor_id || dealer_id) {
    throw fieldError(distributor_id ? 'distributor_id' : 'dealer_id', 'Internal roles are not linked to a distributor or dealer');
  }
  if (s.territory_ids.length) {
    const found = new Set((await rowsIn(ctx, 'territories', s.territory_ids)).map((t) => t.id));
    const missing = s.territory_ids.filter((t) => !found.has(t));
    if (missing.length) throw fieldError('territory_ids', 'One or more territories do not exist');
  }
  if (s.reports_to) {
    if (s.reports_to === selfId) throw fieldError('reports_to', 'A user cannot report to themselves');
    const boss = await ctx.db.table('profiles').get(s.reports_to);
    if (!boss || !boss.active) throw fieldError('reports_to', 'The manager must be an active user');
  }
  return { distributor_id, dealer_id };
}

async function syncUserTerritories(ctx: AppContext, userId: string, territoryIds: string[]): Promise<void> {
  const want = new Set(territoryIds);
  const existing = await ctx.db.table('user_territories').all({ user_id: userId });
  for (const e of existing) if (!want.has(e.territory_id)) await ctx.db.table('user_territories').delete(e.id);
  const have = new Set(existing.map((e) => e.territory_id));
  for (const t of want) if (!have.has(t)) await ctx.db.table('user_territories').insert({ user_id: userId, territory_id: t, created_by: ctx.user.id });
}

async function otherActiveAdmins(ctx: AppContext, exceptId: string): Promise<number> {
  const admins = await ctx.db.table('profiles').all({ role: 'admin', active: true });
  return admins.filter((a) => a.id !== exceptId).length;
}

export async function createUser(ctx: AppContext, input: z.output<typeof adminUserCreateSchema>): Promise<UserView> {
  const email = input.email.toLowerCase();
  if (await ctx.db.table('profiles').one({ email })) throw conflict('A user with this e-mail already exists');
  const party = await validateUserShape(ctx, { role: input.role, distributor_id: input.distributor_id ?? null, dealer_id: input.dealer_id ?? null, territory_ids: input.territory_ids, reports_to: input.reports_to ?? null });
  const bridge = authAdminFactory(ctx);
  let id: string = randomUUID();
  if (bridge) id = (await bridge.createUser({ email, full_name: input.full_name, send_invite: input.send_invite, password: input.password })).id;
  let row: Profile;
  try {
    row = await ctx.db.table('profiles').insert({
      id, full_name: input.full_name, email, phone: input.phone ?? null, role: input.role, designation: input.designation ?? null, distributor_id: party.distributor_id, dealer_id: party.dealer_id,
      territory_ids: input.territory_ids, reports_to: input.reports_to ?? null, language: input.language, active: true, created_by: ctx.user.id,
    });
  } catch (e) {
    if (bridge) await bridge.deleteUser(id).catch((err: unknown) => ctx.log.error({ err }, 'could not roll back the sign-in account after a failed profile insert'));
    throw e;
  }
  await syncUserTerritories(ctx, row.id, input.territory_ids);
  await audit(ctx, { action: 'user.create', table: 'profiles', record_id: row.id, new: row as unknown as Json, detail: { live_auth: !!bridge, invited: !!bridge && input.send_invite } });
  return (await hydrateUsers(ctx, [row]))[0]!;
}

export async function updateUser(ctx: AppContext, id: string, patch: z.output<typeof adminUserUpdateSchema>): Promise<UserView> {
  const before = await ctx.db.table('profiles').get(id);
  if (!before) throw notFound('User');
  const role = patch.role ?? before.role;
  const roleChanged = role !== before.role;
  // moving to an internal role clears any party link unless the caller says otherwise
  const internalNow = isInternal(role);
  const merged: UserShape = {
    role,
    distributor_id: patch.distributor_id !== undefined ? patch.distributor_id : internalNow && roleChanged ? null : before.distributor_id,
    dealer_id: patch.dealer_id !== undefined ? patch.dealer_id : internalNow && roleChanged ? null : role === 'distributor_user' && roleChanged ? null : before.dealer_id,
    territory_ids: patch.territory_ids ?? before.territory_ids,
    reports_to: patch.reports_to !== undefined ? patch.reports_to : before.reports_to,
  };
  if (before.role === 'admin' && role !== 'admin' && before.active && (await otherActiveAdmins(ctx, id)) === 0) {
    throw guardBlocked('This is the last active administrator — make someone else an admin first');
  }
  const party = await validateUserShape(ctx, merged, id);
  const next: Partial<Profile> = { role, distributor_id: party.distributor_id, dealer_id: party.dealer_id, territory_ids: merged.territory_ids, reports_to: merged.reports_to };
  if (patch.full_name !== undefined) next.full_name = patch.full_name;
  if (patch.phone !== undefined) next.phone = patch.phone;
  if (patch.designation !== undefined) next.designation = patch.designation;
  if (patch.language !== undefined) next.language = patch.language;
  const row = await ctx.db.table('profiles').update(id, next);
  if (patch.territory_ids) await syncUserTerritories(ctx, id, patch.territory_ids);
  await audit(ctx, { action: 'user.update', table: 'profiles', record_id: id, old: before as unknown as Json, new: row as unknown as Json });
  return (await hydrateUsers(ctx, [row]))[0]!;
}

export async function setUserActive(ctx: AppContext, id: string, active: boolean, reason?: string): Promise<UserView> {
  const before = await ctx.db.table('profiles').get(id);
  if (!before) throw notFound('User');
  if (!active) {
    if (before.id === ctx.user.id) throw guardBlocked('You cannot deactivate your own account');
    if (before.role === 'admin' && before.active && (await otherActiveAdmins(ctx, id)) === 0) throw guardBlocked('This is the last active administrator and cannot be deactivated');
  }
  const row = await ctx.db.table('profiles').update(id, { active });
  const bridge = authAdminFactory(ctx);
  if (bridge) await bridge.setBanned(id, !active).catch((err: unknown) => ctx.log.error({ err, user: id }, 'could not update the sign-in ban flag'));
  await audit(ctx, { action: active ? 'user.activate' : 'user.deactivate', table: 'profiles', record_id: id, detail: { reason: reason ?? null } });
  return (await hydrateUsers(ctx, [row]))[0]!;
}

/* ═════════════════════════ territories ═════════════════════════ */
export interface TerritoryView extends Territory { discom_name: string | null; dsm_name: string | null; user_count: number }

export async function hydrateTerritories(ctx: AppContext, rows: Territory[]): Promise<TerritoryView[]> {
  const [discoms, dsms, links] = await Promise.all([
    rowsIn(ctx, 'discoms', rows.map((r) => r.discom_id).filter((x): x is string => !!x)),
    rowsIn(ctx, 'profiles', rows.map((r) => r.dsm_id).filter((x): x is string => !!x)),
    rows.length ? ctx.db.table('user_territories').all({ territory_id: rows.map((r) => r.id) }) : Promise.resolve([]),
  ]);
  return rows.map((r) => ({
    ...r, discom_name: discoms.find((d) => d.id === r.discom_id)?.name ?? null, dsm_name: dsms.find((d) => d.id === r.dsm_id)?.full_name ?? null,
    user_count: links.filter((l) => l.territory_id === r.id).length,
  }));
}

const overlaps = (a: { from: string; to: string }, b: { from: string; to: string }): boolean => a.from <= b.to && b.from <= a.to;

async function checkTerritoryRefs(ctx: AppContext, t: { discom_id?: string | null; dsm_id?: string | null }): Promise<void> {
  if (t.discom_id && !(await ctx.db.table('discoms').get(t.discom_id))) throw fieldError('discom_id', 'That DISCOM does not exist');
  if (t.dsm_id) {
    const dsm = await ctx.db.table('profiles').get(t.dsm_id);
    if (!dsm || !dsm.active || !isInternal(dsm.role)) throw fieldError('dsm_id', 'The DSM must be an active internal user');
  }
}

async function checkTerritoryOverlap(ctx: AppContext, ranges: Territory['pincode_ranges'], selfId?: string): Promise<void> {
  if (!ranges.length) return;
  const others = (await ctx.db.table('territories').all({ active: true })).filter((t) => t.id !== selfId);
  const clashes = uniq(others.filter((t) => t.pincode_ranges.some((o) => ranges.some((r) => overlaps(r, o)))).map((t) => t.name));
  if (clashes.length) throw new AppError(409, 'CONFLICT', `These pincode ranges overlap with ${clashes.join(', ')}. Adjust them, or confirm the overlap on purpose.`, { overlapping_territories: clashes });
}

export async function createTerritory(ctx: AppContext, input: z.output<typeof adminTerritoryCreateSchema>): Promise<TerritoryView> {
  if (await ctx.db.table('territories').one({ name: input.name })) throw conflict('A territory with this name already exists');
  await checkTerritoryRefs(ctx, input);
  if (!input.allow_overlap) await checkTerritoryOverlap(ctx, input.pincode_ranges);
  const row = await ctx.db.table('territories').insert({
    name: input.name, state: input.state, district: input.district ?? null, pincode_ranges: input.pincode_ranges, discom_id: input.discom_id ?? null, dsm_id: input.dsm_id ?? null, active: input.active, created_by: ctx.user.id,
  });
  await audit(ctx, { action: 'territory.create', table: 'territories', record_id: row.id, new: row as unknown as Json });
  return (await hydrateTerritories(ctx, [row]))[0]!;
}

export async function updateTerritory(ctx: AppContext, id: string, patch: z.output<typeof adminTerritoryUpdateSchema>): Promise<TerritoryView> {
  const before = await ctx.db.table('territories').get(id);
  if (!before) throw notFound('Territory');
  if (patch.name && patch.name !== before.name && (await ctx.db.table('territories').one({ name: patch.name }))) throw conflict('A territory with this name already exists');
  await checkTerritoryRefs(ctx, patch);
  const ranges = patch.pincode_ranges ?? before.pincode_ranges;
  const active = patch.active ?? before.active;
  if (!patch.allow_overlap && active && (patch.pincode_ranges || (patch.active && !before.active))) await checkTerritoryOverlap(ctx, ranges, id);
  const next: Partial<Territory> = {};
  for (const k of ['name', 'state', 'district', 'pincode_ranges', 'discom_id', 'dsm_id', 'active'] as const) {
    if (patch[k] !== undefined) (next as Record<string, unknown>)[k] = patch[k];
  }
  const row = await ctx.db.table('territories').update(id, next);
  await audit(ctx, { action: 'territory.update', table: 'territories', record_id: id, old: before as unknown as Json, new: row as unknown as Json });
  return (await hydrateTerritories(ctx, [row]))[0]!;
}

export async function deleteTerritory(ctx: AppContext, id: string): Promise<{ id: string }> {
  const before = await ctx.db.table('territories').get(id);
  if (!before) throw notFound('Territory');
  const [leads, dealers, distributors, users] = await Promise.all([
    ctx.db.table('leads').count({ territory_id: id }), ctx.db.table('dealers').count({ territory_id: id }),
    ctx.db.table('distributors').count({ territory_ids: { contains: [id] } }), ctx.db.table('profiles').count({ territory_ids: { contains: [id] } }),
  ]);
  if (leads + dealers + distributors + users > 0) {
    throw new AppError(409, 'CONFLICT', 'This territory is in use — deactivate it instead of deleting it', { leads, dealers, distributors, users });
  }
  for (const l of await ctx.db.table('user_territories').all({ territory_id: id })) await ctx.db.table('user_territories').delete(l.id);
  await ctx.db.table('territories').delete(id);
  await audit(ctx, { action: 'territory.delete', table: 'territories', record_id: id, old: before as unknown as Json });
  return { id };
}

export async function getTerritoryUsers(ctx: AppContext, id: string): Promise<Profile[]> {
  if (!(await ctx.db.table('territories').get(id))) throw notFound('Territory');
  const links = await ctx.db.table('user_territories').all({ territory_id: id });
  return rowsIn(ctx, 'profiles', links.map((l) => l.user_id));
}

/** Replaces the set of users assigned to a territory (user_territories + profiles.territory_ids stay in step). */
export async function setTerritoryUsers(ctx: AppContext, id: string, userIds: string[]): Promise<Profile[]> {
  if (!(await ctx.db.table('territories').get(id))) throw notFound('Territory');
  const want = uniq(userIds);
  const users = await rowsIn(ctx, 'profiles', want);
  if (users.length !== want.length) throw fieldError('user_ids', 'One or more users do not exist');
  if (users.some((u) => !isInternal(u.role))) throw fieldError('user_ids', 'Distributor and dealer users are scoped by their party, not by territory');
  const existing = await ctx.db.table('user_territories').all({ territory_id: id });
  const wanted = new Set(want);
  const removed = existing.filter((e) => !wanted.has(e.user_id));
  for (const e of removed) {
    await ctx.db.table('user_territories').delete(e.id);
    const p = await ctx.db.table('profiles').get(e.user_id);
    if (p) await ctx.db.table('profiles').update(p.id, { territory_ids: p.territory_ids.filter((t) => t !== id) });
  }
  const have = new Set(existing.map((e) => e.user_id));
  for (const u of users) {
    if (!have.has(u.id)) await ctx.db.table('user_territories').insert({ user_id: u.id, territory_id: id, created_by: ctx.user.id });
    if (!u.territory_ids.includes(id)) await ctx.db.table('profiles').update(u.id, { territory_ids: [...u.territory_ids, id] });
  }
  await audit(ctx, { action: 'territory.users', table: 'territories', record_id: id, detail: { added: want.filter((u) => !have.has(u)).length, removed: removed.length } });
  return rowsIn(ctx, 'profiles', want);
}

/* ═════════════════════════ message templates (versioned) ═════════════════════════ */
type TemplateCreate = z.output<typeof adminTemplateCreateSchema>;
type TemplateUpdate = z.output<typeof adminTemplateUpdateSchema>;
const familyOf = (ctx: AppContext, t: Pick<MessageTemplate, 'key' | 'channel' | 'language'>) => ctx.db.table('message_templates').all({ key: t.key, channel: t.channel, language: t.language }, { orderBy: { col: 'version', dir: 'desc' } });

export async function createTemplate(ctx: AppContext, input: TemplateCreate): Promise<MessageTemplate> {
  const issues = adminTemplateIssues({ ...input, subject: input.subject ?? null });
  if (issues.length) throw invalid(issues);
  if ((await familyOf(ctx, input)).length) throw conflict('A template with this key, channel and language already exists — edit it to create a new version');
  const row = await ctx.db.table('message_templates').insert({
    key: input.key, channel: input.channel, category: input.category, purpose: input.purpose, language: input.language, subject: input.subject ?? null, body: input.body,
    dlt_template_id: input.dlt_template_id ?? null, dlt_header: input.dlt_header ?? null, whatsapp_template_name: input.whatsapp_template_name ?? null, version: 1, active: input.active, created_by: ctx.user.id,
  });
  await audit(ctx, { action: 'template.create', table: 'message_templates', record_id: row.id, new: row as unknown as Json });
  return row;
}

/** Editing never overwrites: it inserts version + 1 (active when the edited version was) and then retires the old one. */
export async function reviseTemplate(ctx: AppContext, id: string, patch: TemplateUpdate): Promise<MessageTemplate> {
  const cur = await ctx.db.table('message_templates').get(id);
  if (!cur) throw notFound('Template');
  const family = await familyOf(ctx, cur);
  const latest = family[0]!;
  if (cur.version !== latest.version) throw conflict(`Version ${latest.version} is the latest — edit that one`, { latest_id: latest.id, latest_version: latest.version });
  const merged = {
    channel: cur.channel, category: patch.category ?? cur.category, purpose: patch.purpose ?? cur.purpose, subject: patch.subject !== undefined ? patch.subject : cur.subject, body: patch.body ?? cur.body,
    dlt_template_id: patch.dlt_template_id !== undefined ? patch.dlt_template_id : cur.dlt_template_id, dlt_header: patch.dlt_header !== undefined ? patch.dlt_header : cur.dlt_header,
    whatsapp_template_name: patch.whatsapp_template_name !== undefined ? patch.whatsapp_template_name : cur.whatsapp_template_name,
  };
  const issues = adminTemplateIssues(merged);
  if (issues.length) throw invalid(issues);
  const unchanged = (['category', 'purpose', 'subject', 'body', 'dlt_template_id', 'dlt_header', 'whatsapp_template_name'] as const).every((k) => merged[k] === cur[k]);
  if (unchanged) return cur;
  const next = await ctx.db.table('message_templates').insert({
    key: cur.key, channel: cur.channel, language: cur.language, category: merged.category, purpose: merged.purpose, subject: merged.subject, body: merged.body,
    dlt_template_id: merged.dlt_template_id, dlt_header: merged.dlt_header, whatsapp_template_name: merged.whatsapp_template_name, version: cur.version + 1, active: cur.active, created_by: ctx.user.id,
  });
  await ctx.db.table('message_templates').update(cur.id, { active: false });
  await audit(ctx, { action: 'template.revise', table: 'message_templates', record_id: next.id, old: cur as unknown as Json, new: next as unknown as Json, detail: { from_version: cur.version, to_version: next.version } });
  return next;
}

/** Activates one version (rollback included) and retires every other version of the same template. */
export async function setTemplateActive(ctx: AppContext, id: string, active: boolean): Promise<MessageTemplate> {
  const cur = await ctx.db.table('message_templates').get(id);
  if (!cur) throw notFound('Template');
  const row = await ctx.db.table('message_templates').update(id, { active });
  if (active) for (const other of await familyOf(ctx, cur)) if (other.id !== id && other.active) await ctx.db.table('message_templates').update(other.id, { active: false });
  await audit(ctx, { action: active ? 'template.activate' : 'template.deactivate', table: 'message_templates', record_id: id, detail: { version: cur.version } });
  return row;
}

export async function templateHistory(ctx: AppContext, id: string): Promise<MessageTemplate[]> {
  const cur = await ctx.db.table('message_templates').get(id);
  if (!cur) throw notFound('Template');
  return familyOf(ctx, cur);
}

/* ═════════════════════════ gate applicability ═════════════════════════ */
export interface GateCellView { gate: Gate; segment: Segment; applicability: Applicability; note: string | null; id: string | null; defaulted: boolean }
export interface GateMatrix { gates: readonly Gate[]; segments: readonly Segment[]; applicabilities: readonly Applicability[]; cells: GateCellView[]; matrix: Record<string, Record<string, GateCellView>> }

/** Missing cells default to `applies` (the compliance engine treats an absent row the same way). */
export async function gateMatrix(ctx: AppContext): Promise<GateMatrix> {
  const rows = await ctx.db.table('gate_applicability').all();
  const cells: GateCellView[] = [];
  const matrix: GateMatrix['matrix'] = {};
  for (const gate of GATES) {
    matrix[gate] = {};
    for (const segment of SEGMENTS) {
      const r = rows.find((x) => x.gate === gate && x.segment === segment);
      const cell: GateCellView = { gate, segment, applicability: r?.applicability ?? 'applies', note: r?.note ?? null, id: r?.id ?? null, defaulted: !r };
      cells.push(cell);
      matrix[gate]![segment] = cell;
    }
  }
  return { gates: GATES, segments: SEGMENTS, applicabilities: APPLICABILITIES, cells, matrix };
}

export async function setGateCell(ctx: AppContext, input: { gate: Gate; segment: Segment; applicability: Applicability; note?: string | null }): Promise<GateCellView> {
  const existing = await ctx.db.table('gate_applicability').one({ gate: input.gate, segment: input.segment });
  let row: GateApplicability;
  if (existing) {
    row = await ctx.db.table('gate_applicability').update(existing.id, { applicability: input.applicability, note: input.note ?? null });
    await audit(ctx, { action: 'gate_applicability.update', table: 'gate_applicability', record_id: row.id, old: existing as unknown as Json, new: row as unknown as Json });
  } else {
    row = await ctx.db.table('gate_applicability').insert({ gate: input.gate, segment: input.segment, applicability: input.applicability, note: input.note ?? null, created_by: ctx.user.id });
    await audit(ctx, { action: 'gate_applicability.create', table: 'gate_applicability', record_id: row.id, new: row as unknown as Json });
  }
  return { gate: row.gate, segment: row.segment, applicability: row.applicability, note: row.note, id: row.id, defaulted: false };
}

/* ═════════════════════════ rule views and rule-backed settings ═════════════════════════ */
/** The version of a rule in force on `on` — the same choice ruleService.get makes (latest start date, active wins a tie). */
export function pickInForce(versions: RuleConfig[], on: string): RuleConfig | null {
  const live = versions.filter((r) => r.effective_from <= on && (!r.effective_to || r.effective_to >= on));
  live.sort((a, b) => (a.effective_from === b.effective_from ? Number(b.is_active) - Number(a.is_active) : a.effective_from < b.effective_from ? 1 : -1));
  return live[0] ?? null;
}

export function toRuleRows(rules: RuleConfig[], on: string): PlatformRuleRow[] {
  const groups = new Map<string, RuleConfig[]>();
  for (const r of rules) groups.set(`${r.category}\u0000${r.key}`, [...(groups.get(`${r.category}\u0000${r.key}`) ?? []), r]);
  const winners = new Set<string>();
  for (const g of groups.values()) { const w = pickInForce(g, on); if (w) winners.add(w.id); }
  return rules.map((r) => ({ ...r, path: `${r.category}.${r.key}`, in_force: winners.has(r.id), advisory: r.status !== 'verified' || !r.is_active }));
}

interface RuleWrite { effective_from?: string; source_name?: string; source_ref: string; notes?: string | null }

/** Writes a setting through the rule service: edits the version starting that day, otherwise adds a new effective-dated version that inherits status, confidence and activity. */
export async function writeRuleValue(ctx: AppContext, path: string, value: Json, opts: RuleWrite): Promise<RuleConfig> {
  const { category, key } = splitRulePath(path);
  const on = opts.effective_from ?? istDateString(ctx.now());
  const same = (await ctx.svc.rules.history(category, key)).find((r) => r.effective_from === on);
  if (same) return ctx.svc.rules.update(same.id, { value, source_ref: opts.source_ref, ...(opts.source_name ? { source_name: opts.source_name } : {}), ...(opts.notes !== undefined ? { notes: opts.notes } : {}) });
  const current = await ctx.svc.rules.get(category, key, on);
  return ctx.svc.rules.createVersion({
    category, key, value, effective_from: on, source_name: opts.source_name ?? current?.source.name ?? 'Future Solar operating setting', source_ref: opts.source_ref,
    confidence: current?.confidence ?? 'high', status: current?.status ?? 'verified', is_active: current?.isActive ?? true, max_severity: current?.maxSeverity, enforce_hard_stop: current?.enforceHardStop,
    notes: opts.notes !== undefined ? opts.notes : current?.notes ?? null,
  });
}

/* ── work calendar ── */
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
function parseHours(v: unknown): Pick<WorkCalendar, 'days' | 'start' | 'end'> | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as { days?: unknown; start?: unknown; end?: unknown };
  if (!Array.isArray(o.days) || !o.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) return null;
  if (typeof o.start !== 'string' || typeof o.end !== 'string' || !HHMM.test(o.start) || !HHMM.test(o.end)) return null;
  return { days: o.days as number[], start: o.start, end: o.end };
}
function parseHolidays(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((h) => (typeof h === 'string' ? h : h && typeof h === 'object' && typeof (h as { date?: unknown }).date === 'string' ? (h as { date: string }).date : '')).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
}

/** The working calendar SLA arithmetic uses on `ref`: the active `work_calendar.*` rules, falling back to the kernel default. Shared helper for other modules. */
export async function loadWorkCalendar(ctx: AppContext, ref?: Date | string): Promise<WorkCalendar> {
  const hours = parseHours(await ctx.svc.rules.value('work_calendar.hours', ref));
  const holidays = parseHolidays(await ctx.svc.rules.value('work_calendar.holidays', ref));
  return { ...DEFAULT_WORK_CALENDAR, ...(hours ?? {}), holidays };
}

export interface WorkCalendarView {
  hours: { days: number[]; start: string; end: string };
  holidays: { date: string; name: string | null }[];
  effective: WorkCalendar;
  rules: { hours: RuleConfig | null; holidays: RuleConfig | null; holiday_names: RuleConfig | null };
  history: { hours: RuleConfig[]; holidays: RuleConfig[] };
}

export async function getWorkCalendar(ctx: AppContext): Promise<WorkCalendarView> {
  const [hoursRule, holidaysRule, namesRule, effective, hHist, dHist] = await Promise.all([
    ctx.svc.rules.get('work_calendar', 'hours'), ctx.svc.rules.get('work_calendar', 'holidays'), ctx.svc.rules.get('work_calendar', 'holiday_names'),
    loadWorkCalendar(ctx), ctx.svc.rules.history('work_calendar', 'hours'), ctx.svc.rules.history('work_calendar', 'holidays'),
  ]);
  const names = namesRule && namesRule.value && typeof namesRule.value === 'object' && !Array.isArray(namesRule.value) ? (namesRule.value as Record<string, Json>) : {};
  const hours = parseHours(hoursRule?.value) ?? { days: DEFAULT_WORK_CALENDAR.days, start: DEFAULT_WORK_CALENDAR.start, end: DEFAULT_WORK_CALENDAR.end };
  const holidays = parseHolidays(holidaysRule?.value).sort().map((date) => ({ date, name: typeof names[date] === 'string' ? (names[date] as string) : null }));
  const row = async (r: { id: string } | null) => (r ? ctx.db.table('rule_config').get(r.id) : null);
  return { hours, holidays, effective, rules: { hours: await row(hoursRule), holidays: await row(holidaysRule), holiday_names: await row(namesRule) }, history: { hours: hHist, holidays: dHist } };
}

export async function updateWorkCalendar(ctx: AppContext, input: z.output<typeof adminWorkCalendarUpdateSchema>): Promise<WorkCalendarView> {
  const base: RuleWrite = { effective_from: input.effective_from, source_name: input.source_name, source_ref: input.source_ref };
  if (input.hours) await writeRuleValue(ctx, 'work_calendar.hours', input.hours, base);
  if (input.holidays) {
    const list = input.holidays.map((h) => (typeof h === 'string' ? { date: h, name: undefined } : h));
    const dates = uniq(list.map((h) => h.date)).sort();
    await writeRuleValue(ctx, 'work_calendar.holidays', dates, base);
    const names: Record<string, Json> = {};
    for (const h of list) if (h.name) names[h.date] = h.name;
    await writeRuleValue(ctx, 'work_calendar.holiday_names', names, base);
  }
  return getWorkCalendar(ctx);
}

/* ── SLA settings ── */
export interface SlaSetting {
  key: string; path: string; value: Json; rule_id: string; status: RuleConfig['status']; confidence: RuleConfig['confidence']; is_active: boolean;
  effective_from: string; effective_to: string | null; source_name: string; source_ref: string; notes: string | null; versions: number; next_version_from: string | null;
}

export async function listSla(ctx: AppContext): Promise<SlaSetting[]> {
  const all = await ctx.svc.rules.list({ category: 'sla' });
  const today = istDateString(ctx.now());
  const groups = new Map<string, RuleConfig[]>();
  for (const r of all) groups.set(r.key, [...(groups.get(r.key) ?? []), r]);
  const out: SlaSetting[] = [];
  for (const [key, versions] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const cur = pickInForce(versions, today) ?? versions.sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1))[0]!;
    const future = versions.filter((v) => v.effective_from > today).sort((a, b) => (a.effective_from < b.effective_from ? -1 : 1))[0];
    out.push({
      key, path: `sla.${key}`, value: cur.value, rule_id: cur.id, status: cur.status, confidence: cur.confidence, is_active: cur.is_active, effective_from: cur.effective_from, effective_to: cur.effective_to,
      source_name: cur.source_name, source_ref: cur.source_ref, notes: cur.notes, versions: versions.length, next_version_from: future?.effective_from ?? null,
    });
  }
  return out;
}

const kindOf = (v: Json): string => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);

export async function updateSla(ctx: AppContext, input: z.output<typeof adminSlaUpdateSchema>): Promise<SlaSetting[]> {
  const known = (await listSla(ctx)).find((s) => s.key === input.key);
  if (!known) throw new AppError(404, 'NOT_FOUND', `There is no SLA setting "sla.${input.key}"`);
  if (kindOf(known.value) !== kindOf(input.value)) throw fieldError('value', `This setting holds ${kindOf(known.value)} data — send the same kind of value`);
  const numbers = Array.isArray(input.value) ? input.value : [input.value];
  if (numbers.some((n) => typeof n === 'number' && (!Number.isFinite(n) || n < 0))) throw fieldError('value', 'Durations cannot be negative');
  await writeRuleValue(ctx, `sla.${input.key}`, input.value, { effective_from: input.effective_from, source_name: input.source_name, source_ref: input.source_ref });
  return listSla(ctx);
}

/* ═════════════════════════ audit viewer ═════════════════════════ */
export interface AuditView extends Omit<AuditLog, 'old_data' | 'new_data'> { actor_name: string | null; actor_role: string | null; changed_fields: string[] }

function boundary(value: string, edge: 'start' | 'end', field: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return (edge === 'start' ? istMidnight(value) : istEndOfDay(value)).toISOString();
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw fieldError(field, 'Use YYYY-MM-DD or an ISO date-time');
  return d.toISOString();
}
const clean = (s: string): string => s.replace(/[%_\\]/g, '');

function changedFields(r: AuditLog): string[] {
  const o = r.old_data, n = r.new_data;
  if (!o || !n || typeof o !== 'object' || typeof n !== 'object' || Array.isArray(o) || Array.isArray(n)) return [];
  const keys = uniq([...Object.keys(o), ...Object.keys(n)]);
  return keys.filter((k) => !['updated_at'].includes(k) && JSON.stringify((o as Record<string, Json>)[k]) !== JSON.stringify((n as Record<string, Json>)[k]));
}

export async function queryAudit(ctx: AppContext, q: z.output<typeof adminAuditQuerySchema>): Promise<{ rows: AuditView[]; total: number }> {
  const where: Where = {};
  if (q.actor) where['actor_id'] = q.actor;
  if (q.action && clean(q.action)) where['action'] = { ilike: `%${clean(q.action)}%` };
  if (q.table) where['table_name'] = q.table;
  if (q.record) where['record_id'] = q.record;
  if (q.source) where['source'] = q.source;
  if (q.from || q.to) where['created_at'] = { ...(q.from ? { gte: boundary(q.from, 'start', 'from') } : {}), ...(q.to ? { lte: boundary(q.to, 'end', 'to') } : {}) };
  const { rows, total } = await ctx.db.table('audit_log').list({
    where, orderBy: { col: 'created_at', dir: 'desc' }, limit: q.limit, offset: q.offset, search: q.q ? { cols: ['action', 'table_name', 'record_id'], text: clean(q.q) } : undefined,
  });
  const actors = new Map((await rowsIn(ctx, 'profiles', rows.map((r) => r.actor_id).filter((x): x is string => !!x))).map((p) => [p.id, p]));
  return {
    total,
    rows: rows.map(({ old_data: _o, new_data: _n, ...r }, i) => ({ ...r, actor_name: r.actor_id ? actors.get(r.actor_id)?.full_name ?? null : null, actor_role: r.actor_id ? actors.get(r.actor_id)?.role ?? null : null, changed_fields: changedFields(rows[i]!) })),
  };
}

/** One audit entry with before/after snapshots. Personal fields are masked unless `reveal` is set — which is itself audited. */
export async function getAuditEntry(ctx: AppContext, id: string, reveal: boolean): Promise<AuditLog & { actor_name: string | null; changed_fields: string[]; revealed: boolean }> {
  const r = await ctx.db.table('audit_log').get(id);
  if (!r) throw notFound('Audit entry');
  const actor = r.actor_id ? await ctx.db.table('profiles').get(r.actor_id) : null;
  if (reveal) await audit(ctx, { action: 'audit.reveal', table: 'audit_log', record_id: id, detail: { source_action: r.action } });
  return {
    ...r, old_data: reveal ? r.old_data : (redactPii(r.old_data ?? undefined) ?? null), new_data: reveal ? r.new_data : (redactPii(r.new_data ?? undefined) ?? null),
    actor_name: actor?.full_name ?? null, changed_fields: changedFields(r), revealed: reveal,
  };
}

/* ═════════════════════════ lead-source API keys ═════════════════════════ */
/** SHA-256 hex of the plaintext key — what `source_api_keys.key_hash` stores and what the public lead endpoints compare against. */
export const hashApiKey = (key: string): string => createHash('sha256').update(key, 'utf8').digest('hex');

export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const key = `fsk_${randomBytes(24).toString('base64url')}`;
  return { key, prefix: key.slice(0, 10), hash: hashApiKey(key) };
}

export type ApiKeyView = Omit<SourceApiKey, 'key_hash'>;
export const apiKeyView = ({ key_hash: _h, ...rest }: SourceApiKey): ApiKeyView => rest;

export async function createApiKey(ctx: AppContext, input: { source: LeadSource; label: string }): Promise<ApiKeyView & { key: string }> {
  const gen = generateApiKey();
  const row = await ctx.db.table('source_api_keys').insert({ source: input.source, label: input.label, key_hash: gen.hash, key_prefix: gen.prefix, active: true, last_used_at: null, created_by: ctx.user.id });
  await audit(ctx, { action: 'api_key.create', table: 'source_api_keys', record_id: row.id, detail: { source: row.source, label: row.label, prefix: row.key_prefix } });
  return { ...apiKeyView(row), key: gen.key };
}

export async function revokeApiKey(ctx: AppContext, id: string): Promise<ApiKeyView> {
  const cur = await ctx.db.table('source_api_keys').get(id);
  if (!cur) throw notFound('API key');
  const row = cur.active ? await ctx.db.table('source_api_keys').update(id, { active: false }) : cur;
  await audit(ctx, { action: 'api_key.revoke', table: 'source_api_keys', record_id: id, detail: { source: cur.source, prefix: cur.key_prefix } });
  return apiKeyView(row);
}

/** Issues a replacement key for the same source and label, then revokes the old one. The new plaintext is returned once. */
export async function rotateApiKey(ctx: AppContext, id: string): Promise<ApiKeyView & { key: string }> {
  const cur = await ctx.db.table('source_api_keys').get(id);
  if (!cur) throw notFound('API key');
  const fresh = await createApiKey(ctx, { source: cur.source, label: cur.label });
  await revokeApiKey(ctx, id);
  return fresh;
}

/* ═════════════════════════ demo reset ═════════════════════════ */
export async function resetDemo(ctx: AppContext, deps: AppDeps | null): Promise<{ mode: 'memory-reset' | 'repository-reset'; tables_loaded: number }> {
  if (!ctx.config.demo) throw forbidden('The demo reset is available in demo mode only');
  const seed = buildSeed(ctx.now());
  const rows = seed as Record<string, { id: string }[] | undefined>;
  if (deps?.db instanceof MemoryDb) {
    deps.db.reset(seed);
    await audit(ctx, { action: 'demo.reset', detail: { mode: 'memory-reset' } });
    return { mode: 'memory-reset', tables_loaded: TABLE_NAMES.filter((t) => rows[t]?.length).length };
  }
  // No handle on the unscoped store: rebuild through the repositories. Append-only ledgers cannot be emptied and are left alone.
  let loaded = 0;
  for (const t of TABLE_NAMES) {
    if (t === 'organizations') continue;
    const repo = ctx.db.table(t) as unknown as { all(): Promise<{ id: string }[]>; delete(id: string): Promise<void>; insert(r: object): Promise<unknown> };
    if (IMMUTABLE_TABLES.includes(t)) continue;
    for (const r of await repo.all()) await repo.delete(r.id);
  }
  for (const t of TABLE_NAMES) {
    if (t === 'organizations' || IMMUTABLE_TABLES.includes(t)) continue;
    const repo = ctx.db.table(t) as unknown as { insert(r: object): Promise<unknown> };
    const list = rows[t] ?? [];
    for (const r of list) await repo.insert(r);
    if (list.length) loaded++;
  }
  await audit(ctx, { action: 'demo.reset', detail: { mode: 'repository-reset' } });
  return { mode: 'repository-reset', tables_loaded: loaded };
}

