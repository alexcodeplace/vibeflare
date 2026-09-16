import { Hono } from 'hono';
import type { Env, Variables } from '../env';
import { requireUserAuth, requireOwner } from '../auth/middleware';
import { peekQuota } from '../quota/client';
import { sha256 } from '../util/hash';
import { newId, newApiKey } from '../util/id';
import {
  getUserById,
  listApiKeys,
  insertApiKey,
  revokeApiKey,
  getCredentialsByUserId,
  revokeCredential,
  listUsers,
  deleteUser,
  listModels,
  getModel,
  getAllSettings,
  setSetting,
  recentAuditEvents,
  listChatsByUser,
  getChatMessages,
  renameChat,
  deleteChat,
  usageByRange,
  usageSummary,
} from '../db/queries';
import { createPrompt, getPrompt, listPrompts, deletePrompt } from '../cache/prompts';
import { putFile, getFile, deleteFile as deleteR2File } from '../files/r2';
import { withCache } from '../lib/cache';
import { ensureModelCatalog, refreshModelCatalog } from '../models/catalog';
import { EXCLUDE_PAID_MODELS_SETTING, excludePaidModelsEnabled, filterPaidModels } from '../models/access';
import adminInvites from './admin.invites';
import { startRegistration, finishRegistration } from '../auth/passkey';
import { GITHUB_PRIVATE_SETTING_KEYS, isPrivateGithubSettingKey } from '../auth/github_web';

type HonoApp = { Bindings: Env; Variables: Variables };

export const PRIVATE_SETTING_KEYS = new Set<string>([
  'system.session_secret',
  'models.catalog.ready',
  'system.model_catalog_ready',
  'system.model_catalog_synced_at',
  'system.builtin_model_catalog_version',
  ...GITHUB_PRIVATE_SETTING_KEYS,
]);

export function publicSettingsObject(
  settings: Array<{ key: string; value: string }>,
): Record<string, string> {
  const visible: Record<string, string> = {};
  for (const row of settings) {
    if (!PRIVATE_SETTING_KEYS.has(row.key) && !isPrivateGithubSettingKey(row.key)) visible[row.key] = row.value;
  }
  return visible;
}

const admin = new Hono<HonoApp>();

// All admin routes require session auth
admin.use('*', (c, next) => requireUserAuth(c, next));

// ── Sub-routers ───────────────────────────────────────────────────────────────

admin.route('/invites', adminInvites);

// ── GET /admin/me ─────────────────────────────────────────────────────────────

admin.get('/me', async (c) => {
  const userId = c.get('userId');
  const user = await getUserById(c.env.DB, userId);
  if (!user) return c.json({ error: { type: 'not_found', message: 'user not found' } }, 404);
  return c.json({ user: { id: user.id, email: user.email, role: user.role }, authMethod: c.get('authMethod') });
});

// ── GET /admin/keys ───────────────────────────────────────────────────────────

admin.get('/keys', async (c) => {
  const userId = c.get('userId');
  const keys = await listApiKeys(c.env.DB, userId);
  // Never return key_hash
  const safe = keys.map(({ id, prefix, label, is_admin, created_at, last_used_at, revoked_at }) => ({
    id, prefix, label, is_admin, created_at, last_used_at, revoked_at,
  }));
  return withCache(c, { keys: safe }, 'private, no-cache');
});

// ── POST /admin/keys ──────────────────────────────────────────────────────────

admin.post('/keys', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json<{ label?: string; is_admin?: boolean }>();
  const label = body.label ?? 'API Key';

  // is_admin only allowed for owner
  let isAdmin = 0;
  if (body.is_admin) {
    const user = await getUserById(c.env.DB, userId);
    if (!user || user.role !== 'owner') {
      return c.json({ error: { type: 'forbidden', message: 'only owner can create admin keys' } }, 403);
    }
    isAdmin = 1;
  }

  const { full, prefix } = newApiKey();
  const keyHash = await sha256(full);
  const id = newId();
  const now = Date.now();

  await insertApiKey(c.env.DB, {
    id,
    user_id: userId,
    key_hash: keyHash,
    prefix,
    label,
    is_admin: isAdmin,
    created_at: now,
  });

  return c.json({ id, label, full, prefix }, 201);
});

// ── DELETE /admin/keys/:id ────────────────────────────────────────────────────

admin.delete('/keys/:id', async (c) => {
  const userId = c.get('userId');
  const keyId = c.req.param('id');
  const keys = await listApiKeys(c.env.DB, userId);
  const owned = keys.find((k) => k.id === keyId);
  if (!owned) {
    return c.json({ error: { type: 'not_found', message: 'key not found' } }, 404);
  }
  await revokeApiKey(c.env.DB, keyId, Date.now());
  return c.json({ ok: true });
});

// ── POST /admin/credentials/register/options ──────────────────────────────────

admin.post('/credentials/register/options', async (c) => {
  const userId = c.get('userId');
  const options = await startRegistration(c.env, userId, 'passkey', c.req.url);
  return c.json(options);
});

// ── POST /admin/credentials/register/verify ───────────────────────────────────

admin.post('/credentials/register/verify', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json<unknown>();
  const result = await finishRegistration(
    c.env,
    userId,
    'passkey',
    body as Parameters<typeof finishRegistration>[3],
    'user',
    undefined,
    c.req.url,
  );
  if (!result.ok) {
    return c.json({ error: { type: 'auth', message: result.message } }, result.status as 400 | 409);
  }
  return c.json({ ok: true });
});

// ── GET /admin/credentials ────────────────────────────────────────────────────

admin.get('/credentials', async (c) => {
  const userId = c.get('userId');
  const creds = await getCredentialsByUserId(c.env.DB, userId);
  const safe = creds.map(({ id, device_label, created_at, last_used_at }) => ({
    id, label: device_label, created_at, last_used_at,
  }));
  return c.json({ credentials: safe });
});

// ── DELETE /admin/credentials/:id ─────────────────────────────────────────────

admin.delete('/credentials/:id', async (c) => {
  const userId = c.get('userId');
  const credId = c.req.param('id');
  const creds = await getCredentialsByUserId(c.env.DB, userId);
  const owned = creds.find((k) => k.id === credId);
  if (!owned) {
    return c.json({ error: { type: 'not_found', message: 'credential not found' } }, 404);
  }
  await revokeCredential(c.env.DB, credId);
  return c.json({ ok: true });
});

// ── GET /admin/users (owner only) ─────────────────────────────────────────────

admin.get('/users', (c, next) => requireOwner(c, next), async (c) => {
  const users = await listUsers(c.env.DB);
  return c.json({ users });
});

// ── DELETE /admin/users/:id (owner only) ──────────────────────────────────────

admin.delete('/users/:id', (c, next) => requireOwner(c, next), async (c) => {
  const id = c.req.param('id');
  await deleteUser(c.env.DB, id);
  return c.json({ ok: true });
});

// ── GET /admin/quota ──────────────────────────────────────────────────────────

admin.get('/quota', async (c) => {
  const quota = await peekQuota(c.env);
  return c.json(quota, 200, { 'Cache-Control': 'private, no-store' });
});

// ── GET /admin/models ─────────────────────────────────────────────────────────

admin.get('/models', async (c) => {
  const task = c.req.query('task');
  try {
    await ensureModelCatalog(c.env);
    const models = await listModels(c.env.DB, task);
    const excludePaid = await excludePaidModelsEnabled(c.env.DB);
    return c.json({
      models: filterPaidModels(models, excludePaid),
      exclude_paid: excludePaid,
    }, 200, { 'Cache-Control': 'private, no-store' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'model discovery failed';
    console.error('[models/bootstrap] error:', error);
    return c.json({ error: { type: 'sync_failed', message } }, 502);
  }
});

// ── POST /admin/models/sync ───────────────────────────────────────────────────

admin.post('/models/sync', async (c) => {
  try {
    const result = await refreshModelCatalog(c.env);
    return c.json({ synced: result.count, delisted: result.delisted, rearmed: result.rearmed });
  } catch (e) {
    console.error('[models/sync] error:', e);
    const message = e instanceof Error ? e.message : 'sync failed';
    const status = 502;
    return c.json({ error: { type: 'sync_failed', message } }, status);
  }
});

// ── GET /admin/cron ───────────────────────────────────────────────────────────

admin.get('/cron', requireOwner, async (c) => {
  const { cronStatus } = await import('../crons/scheduler');
  return c.json(await cronStatus(c.env));
});

// ── GET /admin/settings ───────────────────────────────────────────────────────

admin.get('/settings', async (c) => {
  const settings = await getAllSettings(c.env.DB);
  const visible = publicSettingsObject(settings);
  visible[EXCLUDE_PAID_MODELS_SETTING] ??= '1';
  return c.json({ settings: visible }, 200, { 'Cache-Control': 'private, no-store' });
});

// ── PUT /admin/settings ───────────────────────────────────────────────────────

admin.put('/settings', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return c.json({ error: { type: 'invalid_request', message: 'Expected a setting-name/value object' } }, 400);
  }
  // This policy applies to the entire installation and must not be relaxed by a member.
  if (EXCLUDE_PAID_MODELS_SETTING in body) {
    const user = await getUserById(c.env.DB, c.get('userId'));
    if (user?.role !== 'owner') return c.json({ error: { type: 'forbidden', message: 'owner role required' } }, 403);
    if (!['0', '1'].includes(String(body[EXCLUDE_PAID_MODELS_SETTING])) || typeof body[EXCLUDE_PAID_MODELS_SETTING] !== 'string') {
      return c.json({ error: { type: 'invalid_request', message: 'models.exclude_paid must be "0" or "1"' } }, 400);
    }
  }
  const now = Date.now();
  for (const [key, value] of Object.entries(body)) {
    if (typeof value !== 'string' || PRIVATE_SETTING_KEYS.has(key) || isPrivateGithubSettingKey(key)) continue;
    await setSetting(c.env.DB, key, value, now);
  }
  return c.json({ ok: true });
});

// ── GET /admin/audit ──────────────────────────────────────────────────────────

admin.get('/audit', async (c) => {
  const userId = c.get('userId');
  const limit = Math.min(Number(c.req.query('limit') ?? '50'), 200);
  const events = await recentAuditEvents(c.env.DB, userId, limit);
  return withCache(c, { events }, 'private, no-cache');
});

// ── GET /admin/usage ──────────────────────────────────────────────────────────

admin.get('/usage', async (c) => {
  const userId = c.get('userId');
  const range = c.req.query('range') ?? '24h';
  const msMap: Record<string, number> = {
    '24h': 24 * 60 * 60 * 1000,
    '7d':  7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
  };
  const sinceMs = Date.now() - (msMap[range] ?? 24 * 60 * 60 * 1000);
  const [rows, summary] = await Promise.all([
    usageByRange(c.env.DB, userId, sinceMs),
    usageSummary(c.env.DB, userId, sinceMs),
  ]);
  const data = rows.map(r => ({ ts: new Date(r.ts).toISOString(), neurons: r.neurons, requests: r.requests }));
  return withCache(c, { data, range, error_rate: summary.error_rate, top_model: summary.top_model }, 'private, no-cache');
});

// ── GET /admin/chats ──────────────────────────────────────────────────────────

admin.get('/chats', async (c) => {
  const userId = c.get('userId');
  const chats = await listChatsByUser(c.env.DB, userId);
  return c.json({ chats }, 200, { 'Cache-Control': 'private, no-store' });
});

// Create a lightweight conversation row, with no AI calls or generated titles.
admin.post('/chats', async (c) => {
  const body = await c.req.json<{ title?: unknown; model?: unknown }>().catch(() => null);
  if (!body || typeof body.title !== 'string' || !body.title.trim() || typeof body.model !== 'string') {
    return c.json({ error: { type: 'invalid_request', message: 'title and model are required' } }, 400);
  }
  const model = await getModel(c.env.DB, body.model);
  if (!model || model.enabled === 0) return c.json({ error: { type: 'not_found', message: 'model not found' } }, 404);
  const normalized = body.title.replace(/\s+/g, ' ').trim();
  const title = normalized.length > 60 ? normalized.slice(0, 60).trimEnd() + '…' : normalized;
  const now = Date.now();
  const chat = { id: newId(), title, model: body.model, created_at: now, updated_at: now };
  await c.env.DB.prepare('INSERT INTO chats (id, user_id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(chat.id, c.get('userId'), title, chat.model, now, now).run();
  return c.json({ chat }, 201, { 'Cache-Control': 'private, no-store' });
});

// ── GET /admin/chats/:id/messages ─────────────────────────────────────────────

admin.get('/chats/:id/messages', async (c) => {
  const userId = c.get('userId');
  const chatId = c.req.param('id');
  const chat = await c.env.DB.prepare(
    'SELECT id, title, model FROM chats WHERE id = ? AND user_id = ?'
  ).bind(chatId, userId).first<{ id: string; title: string; model: string }>();
  if (!chat) return c.json({ error: { type: 'not_found', message: 'Chat not found' } }, 404);

  const messages = await getChatMessages(c.env.DB, chatId, userId);
  return c.json({
    chat: { id: chat.id, title: chat.title, model: chat.model },
    messages: messages.map(m => ({
      id: m.id,
      chat_id: m.chat_id,
      role: m.role,
      content: m.content,
      tokens_in: m.tokens_in,
      tokens_out: m.tokens_out,
      neurons: m.neurons,
      created_at: m.created_at,
    })),
  });
});

// ── PATCH /admin/chats/:id ────────────────────────────────────────────────────

admin.patch('/chats/:id', async (c) => {
  const userId = c.get('userId');
  const chatId = c.req.param('id');
  const body = await c.req.json<{ title: string }>();
  if (!body.title || typeof body.title !== 'string' || body.title.trim().length === 0) {
    return c.json({ error: { type: 'invalid_request', message: 'title is required' } }, 400);
  }
  const title = body.title.trim().slice(0, 200);
  const ok = await renameChat(c.env.DB, chatId, userId, title);
  if (!ok) return c.json({ error: { type: 'not_found', message: 'Chat not found' } }, 404);
  return c.json({ ok: true });
});

// ── DELETE /admin/chats/:id ───────────────────────────────────────────────────

admin.delete('/chats/:id', async (c) => {
  const userId = c.get('userId');
  const chatId = c.req.param('id');
  const ok = await deleteChat(c.env.DB, chatId, userId);
  if (!ok) return c.json({ error: { type: 'not_found', message: 'Chat not found' } }, 404);
  return c.json({ ok: true });
});

// ── Prompt cache CRUD ────────────────────────────────────────────────────────

admin.get('/prompts', requireUserAuth, async (c) => {
  const userId = c.var.userId;
  const prompts = await listPrompts(c.env, userId);
  return c.json({ data: prompts });
});

admin.post('/prompts', requireUserAuth, async (c) => {
  const body = await c.req.json<{ label: string; content: string }>();
  if (!body.label || !body.content) {
    return c.json({ error: { type: 'invalid_request', message: 'label and content required' } }, 400);
  }
  const prompt = await createPrompt(c.env, c.var.userId, body.label, body.content);
  return c.json(prompt, 201);
});

admin.get('/prompts/:id', requireUserAuth, async (c) => {
  const id = c.req.param('id');
  if (!id) return c.json({ error: { type: 'invalid_request', message: 'missing id' } }, 400);
  const prompt = await getPrompt(c.env, c.var.userId, id);
  if (!prompt) return c.json({ error: { type: 'not_found', message: 'prompt not found' } }, 404);
  return c.json(prompt);
});

admin.delete('/prompts/:id', requireUserAuth, async (c) => {
  const id = c.req.param('id');
  if (!id) return c.json({ error: { type: 'invalid_request', message: 'missing id' } }, 400);
  const deleted = await deletePrompt(c.env, c.var.userId, id);
  if (!deleted) return c.json({ error: { type: 'not_found', message: 'prompt not found' } }, 404);
  return c.json({ deleted: true });
});

// ── GET /admin/files ──────────────────────────────────────────────────────────

admin.get('/files', async (c) => {
  const userId = c.get('userId');
  const rows = await c.env.DB.prepare(
    'SELECT id, filename, mime, size, created_at FROM files WHERE user_id = ? ORDER BY created_at DESC'
  ).bind(userId).all<{ id: string; filename: string; mime: string; size: number; created_at: number }>();
  const files = rows.results.map(r => ({ id: r.id, name: r.filename, mime: r.mime, size: r.size, created_at: r.created_at }));
  return withCache(c, { files }, 'private, no-cache');
});

// ── POST /admin/files ─────────────────────────────────────────────────────────

admin.post('/files', async (c) => {
  const userId = c.get('userId');
  const form = await c.req.formData();
  const blob = form.get('file');
  if (!blob || typeof blob === 'string') {
    return c.json({ error: { type: 'invalid_request', message: 'file required' } }, 400);
  }
  const filename = blob.name || 'upload';
  const mime = blob.type || 'application/octet-stream';
  const buffer = await blob.arrayBuffer();
  const { key } = await putFile(c.env.R2, userId, filename, mime, buffer);
  const id = newId();
  const now = Date.now();
  const expires_at = now + 14 * 24 * 60 * 60 * 1000;
  await c.env.DB.prepare(
    'INSERT INTO files (id, user_id, r2_key, filename, mime, size, purpose, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, userId, key, filename, mime, buffer.byteLength, 'upload', now, expires_at).run();
  return c.json({ id, name: filename, mime, size: buffer.byteLength, created_at: now }, 201);
});

// ── DELETE /admin/files/:id ───────────────────────────────────────────────────

admin.delete('/files/:id', async (c) => {
  const userId = c.get('userId');
  const fileId = c.req.param('id');
  const row = await c.env.DB.prepare(
    'SELECT r2_key FROM files WHERE id = ? AND user_id = ?'
  ).bind(fileId, userId).first<{ r2_key: string }>();
  if (!row) return c.json({ error: { type: 'not_found', message: 'file not found' } }, 404);
  await deleteR2File(c.env.R2, row.r2_key);
  await c.env.DB.prepare('DELETE FROM files WHERE id = ?').bind(fileId).run();
  return c.json({ ok: true });
});

// ── GET /admin/files/:id/thumbnail ─────────────────────────────────────────────

admin.get('/files/:id/thumbnail', async (c) => {
  const userId = c.get('userId');
  const fileId = c.req.param('id');
  const row = await c.env.DB.prepare(
    'SELECT r2_key, filename, mime FROM files WHERE id = ? AND user_id = ?'
  ).bind(fileId, userId).first<{ r2_key: string; filename: string; mime: string }>();
  if (!row) return c.json({ error: { type: 'not_found', message: 'file not found' } }, 404);
  const obj = await getFile(c.env.R2, row.r2_key);
  if (!obj) return c.json({ error: { type: 'not_found', message: 'file not in storage' } }, 404);
  return new Response(obj.body, {
    headers: {
      'Content-Type': row.mime,
      'Cache-Control': 'private, max-age=3600',
    },
  });
});

// ── GET /admin/files/:id/download ─────────────────────────────────────────────

admin.get('/files/:id/download', async (c) => {
  const userId = c.get('userId');
  const fileId = c.req.param('id');
  const row = await c.env.DB.prepare(
    'SELECT r2_key, filename, mime FROM files WHERE id = ? AND user_id = ?'
  ).bind(fileId, userId).first<{ r2_key: string; filename: string; mime: string }>();
  if (!row) return c.json({ error: { type: 'not_found', message: 'file not found' } }, 404);
  const obj = await getFile(c.env.R2, row.r2_key);
  if (!obj) return c.json({ error: { type: 'not_found', message: 'file not in storage' } }, 404);
  return new Response(obj.body, {
    headers: {
      'Content-Type': row.mime,
      'Content-Disposition': `attachment; filename="${row.filename}"`,
    },
  });
});

// ── Response cache management ────────────────────────────────────────────────

admin.get('/cache', async (c) => {
  const entries = await c.env.DB.prepare(
    'SELECT hash, model, hit_count, expires_at FROM response_cache ORDER BY expires_at DESC LIMIT 200'
  ).all<{ hash: string; model: string; hit_count: number; expires_at: number }>();
  return c.json({ entries: entries.results });
});

admin.delete('/cache', async (c) => {
  const result = await c.env.DB.prepare('DELETE FROM response_cache').run();
  return c.json({ deleted: result.meta.changes ?? 0 });
});

export default admin;
