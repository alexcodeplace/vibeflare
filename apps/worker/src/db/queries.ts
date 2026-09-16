import type { User, ApiKey, Credential, ModelInfo, AuditEvent, Invite } from '@vibeflare/shared';

// ── Users ────────────────────────────────────────────────────────────────────

export async function getUserById(db: D1Database, id: string): Promise<User | null> {
  return db.prepare('SELECT * FROM auth_users WHERE id = ?').bind(id).first<User>();
}

export async function getUserByCredentialId(
  db: D1Database,
  credentialId: string
): Promise<User | null> {
  return db
    .prepare(
      'SELECT u.* FROM auth_users u JOIN auth_credentials c ON c.user_id = u.id WHERE c.credential_id = ?'
    )
    .bind(credentialId)
    .first<User>();
}

export async function getUserByGithubLogin(
  db: D1Database,
  githubLogin: string
): Promise<User | null> {
  return db
    .prepare('SELECT * FROM auth_users WHERE github_login = ?')
    .bind(githubLogin)
    .first<User>();
}

export async function getUserByAccessSub(db: D1Database, accessSub: string): Promise<User | null> {
  return db.prepare('SELECT * FROM auth_users WHERE access_sub = ?').bind(accessSub).first<User>();
}

/** Binds a verified Cloudflare Access identity to an app user. No-op if either side is already linked. */
export async function linkAccessSub(
  db: D1Database,
  userId: string,
  accessSub: string
): Promise<void> {
  await db
    .prepare(
      'UPDATE auth_users SET access_sub = ? WHERE id = ? AND access_sub IS NULL' +
        ' AND NOT EXISTS (SELECT 1 FROM auth_users WHERE access_sub = ?)'
    )
    .bind(accessSub, userId, accessSub)
    .run();
}

export async function insertUser(
  db: D1Database,
  user: {
    id: string;
    email: string | null;
    github_login: string | null;
    access_sub?: string | null;
    role: 'owner' | 'user';
    created_at: number;
  }
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO auth_users (id, email, github_login, access_sub, role, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING'
    )
    .bind(user.id, user.email, user.github_login, user.access_sub ?? null, user.role, user.created_at)
    .run();
}

export async function countUsers(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) as n FROM auth_users').first<{ n: number }>();
  return row?.n ?? 0;
}

// ── Credentials ───────────────────────────────────────────────────────────────

export async function insertCredential(
  db: D1Database,
  cred: {
    id: string;
    user_id: string;
    credential_id: string;
    public_key: ArrayBuffer;
    counter: number;
    device_label: string | null;
    transports: string | null;
    created_at: number;
  }
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO auth_credentials (id, user_id, credential_id, public_key, counter, device_label, transports, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .bind(
      cred.id,
      cred.user_id,
      cred.credential_id,
      cred.public_key,
      cred.counter,
      cred.device_label,
      cred.transports,
      cred.created_at
    )
    .run();
}

export async function getCredentialsByUserId(
  db: D1Database,
  userId: string
): Promise<Credential[]> {
  const result = await db
    .prepare('SELECT * FROM auth_credentials WHERE user_id = ?')
    .bind(userId)
    .all<Credential>();
  return result.results;
}

export async function getCredentialById(
  db: D1Database,
  id: string
): Promise<Credential | null> {
  return db.prepare('SELECT * FROM auth_credentials WHERE id = ?').bind(id).first<Credential>();
}

export async function getCredentialByCredentialId(
  db: D1Database,
  credentialId: string
): Promise<Credential | null> {
  return db
    .prepare('SELECT * FROM auth_credentials WHERE credential_id = ?')
    .bind(credentialId)
    .first<Credential>();
}

export async function incrementCredentialCounter(
  db: D1Database,
  id: string,
  counter: number,
  lastUsedAt: number
): Promise<void> {
  await db
    .prepare(
      'UPDATE auth_credentials SET counter = ?, last_used_at = ? WHERE id = ?'
    )
    .bind(counter, lastUsedAt, id)
    .run();
}

// ── API Keys ──────────────────────────────────────────────────────────────────

export async function getApiKeyByHash(
  db: D1Database,
  keyHash: string
): Promise<ApiKey | null> {
  return db
    .prepare('SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL')
    .bind(keyHash)
    .first<ApiKey>();
}

export async function insertApiKey(
  db: D1Database,
  key: {
    id: string;
    user_id: string;
    key_hash: string;
    prefix: string;
    label: string;
    is_admin: number;
    created_at: number;
  }
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO api_keys (id, user_id, key_hash, prefix, label, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .bind(key.id, key.user_id, key.key_hash, key.prefix, key.label, key.is_admin, key.created_at)
    .run();
}

export async function revokeApiKey(
  db: D1Database,
  id: string,
  revokedAt: number
): Promise<void> {
  await db
    .prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ?')
    .bind(revokedAt, id)
    .run();
}

export async function touchApiKeyLastUsed(
  db: D1Database,
  id: string,
  ts: number,
): Promise<void> {
  await db
    .prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?')
    .bind(ts, id)
    .run();
}

export async function listApiKeys(db: D1Database, userId: string): Promise<ApiKey[]> {
  const result = await db
    .prepare(
      'SELECT * FROM api_keys WHERE user_id = ? ORDER BY created_at DESC'
    )
    .bind(userId)
    .all<ApiKey>();
  return result.results;
}

// ── Models ────────────────────────────────────────────────────────────────────

export async function upsertModel(
  db: D1Database,
  model: Omit<ModelInfo, 'probed_at' | 'probe_error' | 'fail_streak'>
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO models (name, task, description, properties, neurons_input, neurons_output, neurons_flat, beta, enabled, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         task = excluded.task,
         description = excluded.description,
         properties = CASE
           WHEN json_extract(CASE WHEN json_valid(models.properties) THEN models.properties ELSE '{}' END, '$.paid_observed') = 1
           THEN json_patch(CASE WHEN json_valid(excluded.properties) THEN excluded.properties ELSE '{}' END, '{"paid_required":true,"paid_observed":true}')
           WHEN json_type(CASE WHEN json_valid(excluded.properties) THEN excluded.properties ELSE '{}' END, '$.paid_required') = 'null'
           THEN json_patch(CASE WHEN json_valid(models.properties) THEN models.properties ELSE '{}' END,
                           json_remove(excluded.properties, '$.paid_required'))
           ELSE excluded.properties END,
         neurons_input = excluded.neurons_input,
         neurons_output = excluded.neurons_output,
         neurons_flat = excluded.neurons_flat,
         beta = excluded.beta,
         synced_at = excluded.synced_at`
    )
    .bind(
      model.name,
      model.task,
      model.description,
      model.properties,
      model.neurons_input,
      model.neurons_output,
      model.neurons_flat,
      model.beta,
      model.enabled,
      model.synced_at
    )
    .run();
}

export async function countModels(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM models').first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export async function listModels(db: D1Database, task?: string): Promise<ModelInfo[]> {
  const result = task
    ? await db
        .prepare('SELECT * FROM models WHERE task = ? AND enabled = 1 ORDER BY name')
        .bind(task)
        .all<ModelInfo>()
    : await db
        .prepare('SELECT * FROM models WHERE enabled = 1 ORDER BY name')
        .all<ModelInfo>();
  return result.results;
}

export async function getModel(db: D1Database, name: string): Promise<ModelInfo | null> {
  return db.prepare('SELECT * FROM models WHERE name = ?').bind(name).first<ModelInfo>();
}

export async function setModelEnabled(db: D1Database, name: string, enabled: 0 | 1): Promise<void> {
  await db.prepare('UPDATE models SET enabled = ? WHERE name = ?').bind(enabled, name).run();
}

/** A served request proves the model is alive: clear the failure streak and lift any auto-disable. */
export async function recordModelSuccess(
  db: D1Database,
  name: string,
  at: number
): Promise<void> {
  await db
    .prepare(
      'UPDATE models SET fail_streak = 0, probe_error = NULL, probed_at = ?, enabled = 1 WHERE name = ?'
    )
    .bind(at, name)
    .run();
}

/** Disables the model once `threshold` consecutive upstream failures accumulate. */
export async function recordModelFailure(
  db: D1Database,
  name: string,
  error: string,
  at: number,
  threshold: number
): Promise<void> {
  await db
    .prepare(
      `UPDATE models SET
         fail_streak = fail_streak + 1,
         probe_error = ?,
         probed_at = ?,
         enabled = CASE WHEN fail_streak + 1 >= ? THEN 0 ELSE enabled END
       WHERE name = ?`
    )
    .bind(error, at, threshold, name)
    .run();
}

/** Mark a model as requiring paid billing after real traffic proves it. */
export async function markModelPaidRequired(
  db: D1Database,
  name: string,
  error: string,
  at: number
): Promise<void> {
  await db.prepare(`UPDATE models SET
    properties = json_patch(
      CASE WHEN json_valid(properties) AND json_type(properties) = 'object' THEN properties ELSE '{}' END,
      '{"paid_required":true,"paid_observed":true}'),
    probe_error = ?, probed_at = ? WHERE name = ?`
  ).bind(error, at, name).run();
}

/**
 * Gives a disabled-but-still-listed model another chance once its last failure has aged out,
 * so a model taken down by a transient upstream fault is not disabled forever.
 */
export async function rearmDisabledModels(
  db: D1Database,
  syncedAt: number,
  failureCutoff: number
): Promise<number> {
  const res = await db
    .prepare(
      `UPDATE models SET enabled = 1, fail_streak = 0, probe_error = NULL
       WHERE synced_at = ? AND enabled = 0 AND (probed_at IS NULL OR probed_at < ?)`
    )
    .bind(syncedAt, failureCutoff)
    .run();
  return res.meta.changes ?? 0;
}

/** Rows the latest catalog sync did not touch are no longer offered upstream. */
export async function disableDelistedModels(db: D1Database, syncedAt: number): Promise<number> {
  const res = await db
    .prepare(
      "UPDATE models SET enabled = 0, probe_error = 'delisted from catalog' WHERE synced_at < ? AND enabled = 1"
    )
    .bind(syncedAt)
    .run();
  return res.meta.changes ?? 0;
}

// ── Audit Events ──────────────────────────────────────────────────────────────

export async function insertAuditEvent(
  db: D1Database,
  event: {
    id: string;
    user_id: string | null;
    api_key_id: string | null;
    endpoint: string;
    model?: string;
    task?: string;
    status: number;
    tokens_in?: number;
    tokens_out?: number;
    neurons?: number;
    duration_ms: number;
    cached?: boolean;
    error?: string | null;
    created_at: number;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit_events (id, user_id, api_key_id, endpoint, model, task, status, tokens_in, tokens_out, neurons, duration_ms, cached, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      event.id,
      event.user_id,
      event.api_key_id,
      event.endpoint,
      event.model ?? null,
      event.task ?? null,
      event.status,
      event.tokens_in ?? null,
      event.tokens_out ?? null,
      event.neurons ?? null,
      event.duration_ms,
      event.cached ? 1 : 0,
      event.error ?? null,
      event.created_at
    )
    .run();
}

export async function recentAuditEvents(
  db: D1Database,
  userId: string,
  limit: number
): Promise<AuditEvent[]> {
  const result = await db
    .prepare(
      'SELECT * FROM audit_events WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'
    )
    .bind(userId, limit)
    .all<AuditEvent>();
  return result.results;
}

export async function usageByRange(
  db: D1Database,
  userId: string,
  sinceMs: number
): Promise<Array<{ ts: number; requests: number; neurons: number }>> {
  const result = await db
    .prepare(
      `SELECT (created_at / 3600000) * 3600000 AS ts,
              COUNT(*) AS requests,
              COALESCE(SUM(neurons), 0) AS neurons
       FROM audit_events
       WHERE user_id = ? AND created_at > ?
       GROUP BY ts
       ORDER BY ts ASC`
    )
    .bind(userId, sinceMs)
    .all<{ ts: number; requests: number; neurons: number }>();
  return result.results;
}

export async function usageSummary(
  db: D1Database,
  userId: string,
  sinceMs: number
): Promise<{ error_rate: number | null; top_model: string | null }> {
  const [totals, top] = await Promise.all([
    db.prepare(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN status != 200 THEN 1 ELSE 0 END) AS errors
       FROM audit_events WHERE user_id = ? AND created_at > ?`
    ).bind(userId, sinceMs).first<{ total: number; errors: number }>(),
    db.prepare(
      `SELECT model FROM audit_events
       WHERE user_id = ? AND created_at > ? AND model IS NOT NULL
       GROUP BY model ORDER BY COUNT(*) DESC LIMIT 1`
    ).bind(userId, sinceMs).first<{ model: string }>(),
  ]);
  return {
    error_rate: totals && totals.total > 0 ? totals.errors / totals.total : null,
    top_model: top?.model ?? null,
  };
}

// ── Settings ──────────────────────────────────────────────────────────────────

export async function setSetting(
  db: D1Database,
  key: string,
  value: string,
  updatedAt: number
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    )
    .bind(key, value, updatedAt)
    .run();
}

export async function getSetting(
  db: D1Database,
  key: string
): Promise<string | null> {
  const row = await db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function getAllSettings(
  db: D1Database
): Promise<Array<{ key: string; value: string; updated_at: number }>> {
  const result = await db
    .prepare('SELECT key, value, updated_at FROM settings ORDER BY key')
    .all<{ key: string; value: string; updated_at: number }>();
  return result.results;
}

// ── Admin: Users ──────────────────────────────────────────────────────────────

export async function listUsers(db: D1Database): Promise<User[]> {
  const result = await db
    .prepare('SELECT * FROM auth_users ORDER BY created_at ASC')
    .all<User>();
  return result.results;
}

export async function deleteUser(db: D1Database, id: string): Promise<void> {
  await db.batch([
    // Keep consumed invites consumed while releasing their historical FK to the
    // account being deleted. `used_at` remains authoritative for replay denial.
    db.prepare('UPDATE auth_invites SET used_by = NULL WHERE used_by = ?').bind(id),
    db.prepare('DELETE FROM auth_users WHERE id = ?').bind(id),
  ]);
}

// ── Admin: Credentials ────────────────────────────────────────────────────────

export async function revokeCredential(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM auth_credentials WHERE id = ?').bind(id).run();
}

// ── Chats ─────────────────────────────────────────────────────────────────────

export interface Chat {
  id: string;
  user_id: string;
  title: string;
  model: string;
  created_at: number;
  updated_at: number;
}

export async function listChatsByUser(db: D1Database, userId: string): Promise<Chat[]> {
  const result = await db
    .prepare('SELECT * FROM chats WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100')
    .bind(userId)
    .all<Chat>();
  return result.results;
}

export interface ChatMessageRow {
  id: string;
  chat_id: string;
  role: string;
  content: string;
  tokens_in: number | null;
  tokens_out: number | null;
  neurons: number | null;
  created_at: number;
}

export async function getChatMessages(
  db: D1Database,
  chatId: string,
  userId: string
): Promise<ChatMessageRow[]> {
  const result = await db
    .prepare(
      `SELECT cm.* FROM chat_messages cm
       JOIN chats c ON c.id = cm.chat_id
       WHERE cm.chat_id = ? AND c.user_id = ?
       ORDER BY cm.created_at ASC`
    )
    .bind(chatId, userId)
    .all<ChatMessageRow>();
  return result.results;
}

export async function renameChat(
  db: D1Database,
  chatId: string,
  userId: string,
  title: string
): Promise<boolean> {
  const result = await db
    .prepare('UPDATE chats SET title = ? WHERE id = ? AND user_id = ?')
    .bind(title, chatId, userId)
    .run();
  return result.meta.changes > 0;
}

export async function deleteChat(
  db: D1Database,
  chatId: string,
  userId: string
): Promise<boolean> {
  const result = await db
    .prepare('DELETE FROM chats WHERE id = ? AND user_id = ?')
    .bind(chatId, userId)
    .run();
  return result.meta.changes > 0;
}

// ── Invites ──────────────────────────────────────────────────────────────────

export async function insertInvite(
  db: D1Database,
  inv: {
    id: string;
    token_hash: string;
    prefix: string;
    label: string | null;
    created_by: string;
    created_at: number;
    expires_at: number;
  }
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO auth_invites (id, token_hash, prefix, label, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .bind(inv.id, inv.token_hash, inv.prefix, inv.label, inv.created_by, inv.created_at, inv.expires_at)
    .run();
}

export async function listInvites(db: D1Database): Promise<Invite[]> {
  const result = await db
    .prepare('SELECT * FROM auth_invites ORDER BY created_at DESC')
    .all<Invite>();
  return result.results;
}

export async function getInviteById(db: D1Database, id: string): Promise<Invite | null> {
  return db.prepare('SELECT * FROM auth_invites WHERE id = ?').bind(id).first<Invite>();
}

export async function getInviteByHash(db: D1Database, hash: string): Promise<Invite | null> {
  return db.prepare('SELECT * FROM auth_invites WHERE token_hash = ?').bind(hash).first<Invite>();
}

export async function revokeInvite(db: D1Database, id: string, now: number): Promise<void> {
  await db
    .prepare('UPDATE auth_invites SET revoked_at = ? WHERE id = ?')
    .bind(now, id)
    .run();
}
