/**
 * Typed fetch wrappers for the VibeFlare API.
 * All calls use credentials: 'same-origin'.
 * On 401 → redirect to /login (browser only).
 * On 5xx → throw Error with message body.
 */

let loginRedirectStarted = false;

/**
 * Collapse simultaneous browser-auth failures into one navigation.
 * Authenticated pages often mount several API consumers at once; if their
 * session is gone they can all receive 401 together. Starting one redirect per
 * response races navigations and can abort otherwise-correct requests.
 */
export function redirectToLoginOnce(): void {
  if (typeof window === 'undefined' || loginRedirectStarted || window.location.pathname === '/login') return;
  loginRedirectStarted = true;
  window.location.replace('/login');
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', ...init });
  if (res.status === 401) {
    redirectToLoginOnce();
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? `Request failed (${res.status})`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface QuotaInfo {
  used: number;
  limit: number;
  day?: string;
}

export interface ModelInfo {
  id?: string;
  name: string;
  task: string;
  provider?: string;
  paid_required: boolean | null;
}

export interface ApiKey {
  id: string;
  prefix: string;
  label: string;
  is_admin: boolean;
  last_used_at: number | null;
  created_at: number;
  revoked_at: number | null;
}

export interface UsagePoint {
  ts: string;
  requests: number;
  neurons: number;
}

export interface UsageResponse {
  data: UsagePoint[];
  range: string;
  error_rate: number | null;
  top_model: string | null;
}

export interface AuditEntry {
  id: string;
  ts: string;
  endpoint: string;
  model: string;
  status: number;
  neurons: number;
  duration_ms: number;
  cached: boolean;
}

export interface FileRecord {
  id: string;
  name: string;
  size: number;
  mime: string;
  created_at: string;
}

export interface Credential {
  id: string;
  name: string;
  created_at: string;
}

export interface UserInfo {
  id: string;
  email: string;
  role: 'owner' | 'user';
}

export interface PromptRecord {
  id: string;
  label: string;
  content: string;
  created_at: string;
}

export interface Setting {
  key: string;
  value: string;
}

// ── Quota ────────────────────────────────────────────────────────────────────

export const QUOTA_CHANGED_EVENT = 'vibeflare:quota-changed';

export function notifyQuotaChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(QUOTA_CHANGED_EVENT));
}

export function getQuota(): Promise<QuotaInfo> {
  return apiFetch('/admin/quota', { cache: 'no-store' });
}

// A metadata-only refresh shared between tabs. No timer or inference probe.
export const MODELS_CHANGED_EVENT = 'vibeflare:models-changed';
export const MODEL_POLICY_STORAGE_KEY = 'vibeflare:model-policy-revision';
export function notifyModelsChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(MODELS_CHANGED_EVENT));
  try { window.localStorage.setItem(MODEL_POLICY_STORAGE_KEY, String(Date.now())); } catch { /* Private browsing may block storage. */ }
}

// ── Models ───────────────────────────────────────────────────────────────────

export async function listModels(task?: string): Promise<ModelInfo[]> {
  const qs = task ? `?task=${encodeURIComponent(task)}` : '';
  const r = await apiFetch<{ models: ModelInfo[] }>(`/admin/models${qs}`, { cache: 'no-store' });
  return r.models;
}

export async function syncModels(): Promise<{ synced: number }> {
  return apiFetch('/admin/models/sync', { method: 'POST' });
}

// ── Keys ─────────────────────────────────────────────────────────────────────

export async function listKeys(): Promise<ApiKey[]> {
  const r = await apiFetch<{ keys: ApiKey[] }>('/admin/keys');
  return r.keys;
}

export function createKey(label: string, isAdmin: boolean): Promise<ApiKey & { full: string }> {
  return apiFetch('/admin/keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label, is_admin: isAdmin }),
  });
}

export function revokeKey(id: string): Promise<void> {
  return apiFetch(`/admin/keys/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// ── Auth methods (public) ─────────────────────────────────────────────────────

export interface AuthMethods {
  mode: 'standalone' | 'cf_access';
  passkey: boolean;
  github: boolean;
  github_flow: 'none' | 'device' | 'oauth' | 'bootstrap';
  cf_access: boolean;
  setup_required: boolean;
}

export async function getAuthMethods(): Promise<AuthMethods> {
  const res = await fetch('/auth/methods', { credentials: 'same-origin' });
  if (!res.ok) {
    return {
      mode: 'standalone',
      passkey: true,
      github: false,
      github_flow: 'none',
      cf_access: false,
      setup_required: false,
    };
  }
  return res.json() as Promise<AuthMethods>;
}

// ── Me ───────────────────────────────────────────────────────────────────────

export async function me(): Promise<UserInfo> {
  const result = await apiFetch<{ user: UserInfo }>('/admin/me');
  return result.user;
}

/** Public session probe for login/setup; unauthenticated is a normal 200 + null state. */
export async function meOrNull(): Promise<UserInfo | null> {
  const res = await fetch('/auth/session', { credentials: 'same-origin' });
  if (!res.ok) return null;
  const body = await res.json() as { user: UserInfo | null };
  return body.user;
}

// ── Credentials (WebAuthn) ────────────────────────────────────────────────────

export async function listCredentials(): Promise<Credential[]> {
  const r = await apiFetch<{ credentials: Credential[] }>('/admin/credentials');
  return r.credentials ?? [];
}

export function revokeCredential(id: string): Promise<void> {
  return apiFetch(`/admin/credentials/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// ── Usage ────────────────────────────────────────────────────────────────────

export async function getUsage(range: '24h' | '7d' | '30d' = '7d'): Promise<UsageResponse> {
  const r = await apiFetch<{ data: UsagePoint[] | unknown; range: string; error_rate: number | null; top_model: string | null }>(`/admin/usage?range=${range}`);
  return {
    data: Array.isArray(r.data) ? r.data as UsagePoint[] : [],
    range: r.range,
    error_rate: r.error_rate ?? null,
    top_model: r.top_model ?? null,
  };
}

// ── Audit ────────────────────────────────────────────────────────────────────

export async function recentAudit(limit = 50): Promise<AuditEntry[]> {
  const r = await apiFetch<{ events: Array<{
    id: string;
    endpoint: string;
    model: string | null;
    status: number;
    neurons: number | null;
    duration_ms: number | null;
    cached: number | boolean;
    created_at: number;
  }> }>(`/admin/audit?limit=${limit}`);
  return (r.events ?? []).map((event) => ({
    id: event.id,
    ts: new Date(event.created_at).toISOString(),
    endpoint: event.endpoint,
    model: event.model ?? '—',
    status: event.status,
    neurons: event.neurons ?? 0,
    duration_ms: event.duration_ms ?? 0,
    cached: Boolean(event.cached),
  }));
}

// ── Files ────────────────────────────────────────────────────────────────────

export async function listFiles(): Promise<FileRecord[]> {
  const r = await apiFetch<{ files: FileRecord[] }>('/admin/files');
  return r.files;
}

export function uploadFile(file: File): Promise<FileRecord> {
  const body = new FormData();
  body.append('file', file);
  return apiFetch('/admin/files', { method: 'POST', body });
}

export function deleteFile(id: string): Promise<void> {
  return apiFetch(`/admin/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function logout(): Promise<void> {
  return apiFetch('/auth/logout', { method: 'POST' });
}

// ── Chats ────────────────────────────────────────────────────────────────────

export interface ChatRecord {
  id: string;
  title: string;
  model: string;
  created_at: number;
  updated_at: number;
}

export async function listChats(): Promise<ChatRecord[]> {
  const r = await apiFetch<{ chats: ChatRecord[] }>('/admin/chats', { cache: 'no-store' });
  return r.chats;
}

/** Persist a conversation before inference so it appears in Workspace immediately. */
export async function createChat(title: string, model: string, signal?: AbortSignal): Promise<ChatRecord> {
  const result = await apiFetch<{ chat: ChatRecord }>('/admin/chats', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, model }), signal,
  });
  return result.chat;
}

export interface ChatMessageRecord {
  id: string;
  chat_id: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tokens_in: number | null;
  tokens_out: number | null;
  neurons: number | null;
  created_at: number;
}

export interface ChatDetail {
  chat: { id: string; title: string; model: string };
  messages: ChatMessageRecord[];
}

export async function getChatMessages(chatId: string): Promise<ChatDetail> {
  const r = await apiFetch<ChatDetail>(`/admin/chats/${encodeURIComponent(chatId)}/messages`);
  return r;
}

export function renameChat(id: string, title: string): Promise<{ ok: true }> {
  return apiFetch(`/admin/chats/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
}

export function deleteChat(id: string): Promise<void> {
  return apiFetch(`/admin/chats/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// ── Settings ─────────────────────────────────────────────────────────────────

export async function getSettings(): Promise<Setting[]> {
  const r = await apiFetch<{ settings: Record<string, string> }>('/admin/settings', { cache: 'no-store' });
  return Object.entries(r.settings ?? {}).map(([key, value]) => ({ key, value }));
}

export async function setSetting(key: string, value: string): Promise<void> {
  await apiFetch('/admin/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ [key]: value }),
  });
  if (key === 'models.exclude_paid') notifyModelsChanged();
}

// ── Prompts ──────────────────────────────────────────────────────────────────

export async function listPrompts(): Promise<PromptRecord[]> {
  const r = await apiFetch<{ data: PromptRecord[] }>('/admin/prompts');
  return r.data ?? [];
}

export function createPrompt(label: string, content: string): Promise<PromptRecord> {
  return apiFetch('/admin/prompts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label, content }),
  });
}

export function deletePrompt(id: string): Promise<void> {
  return apiFetch(`/admin/prompts/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// ── Zero-config GitHub setup ─────────────────────────────────────────────────

export interface GithubBootstrapStartResult {
  action: string;
  manifest: string;
}

export async function githubBootstrapStart(): Promise<GithubBootstrapStartResult> {
  const res = await fetch('/auth/setup/github/bootstrap/start', {
    method: 'POST',
    credentials: 'same-origin',
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`GitHub setup start failed: ${text}`);
  }
  return res.json() as Promise<GithubBootstrapStartResult>;
}

// ── GitHub Device Flow ────────────────────────────────────────────────────────

export interface GithubDeviceStartResult {
  device_id: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export type GithubDevicePollResult =
  | { status: 'pending' }
  | { status: 'slow_down'; interval: number }
  | { status: 'denied' }
  | { status: 'expired' }
  | { status: 'invite_required' }
  | { status: 'already_exists' }
  | { status: 'invite_consumed' }
  | { status: 'error' }
  | { status: 'ok' };

export async function githubDeviceStart(): Promise<GithubDeviceStartResult> {
  const res = await fetch('/auth/github/device/start', {
    method: 'POST',
    credentials: 'same-origin',
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`GitHub device start failed: ${text}`);
  }
  return res.json() as Promise<GithubDeviceStartResult>;
}

export async function githubDevicePoll(device_id: string): Promise<GithubDevicePollResult> {
  const res = await fetch('/auth/github/device/poll', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id }),
  });
  if (!res.ok && res.status !== 403) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`GitHub device poll failed: ${text}`);
  }
  if (res.status === 403) {
    try {
      const data = await res.json();
      if (data.error?.type === 'invite_required') return { status: 'invite_required' };
    } catch {
      // ignore parse errors
    }
    return { status: 'denied' };
  }
  return res.json() as Promise<GithubDevicePollResult>;
}

export async function githubSetupPoll(device_id: string): Promise<GithubDevicePollResult> {
  const res = await fetch('/auth/setup/github/poll', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id }),
  });
  if (!res.ok) {
    if (res.status === 403) return { status: 'already_exists' };
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`GitHub setup poll failed: ${text}`);
  }
  return res.json() as Promise<GithubDevicePollResult>;
}

// ── Audio transcription ───────────────────────────────────────────────────────

export interface TranscriptionResult {
  text: string;
}

export async function transcribeAudio(form: FormData): Promise<TranscriptionResult> {
  const res = await fetch('/v1/audio/transcriptions', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'x-vf-browser': '1' },
    body: form,
  });
  if (res.status === 401) {
    redirectToLoginOnce();
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Transcription failed: ${text}`);
  }
  return res.json() as Promise<TranscriptionResult>;
}

// ── Invites ───────────────────────────────────────────────────────────────────

export interface InviteRecord {
  id: string;
  prefix: string;
  label: string | null;
  created_by: string;
  created_at: number;
  expires_at: number;
  used_at: number | null;
  used_by: string | null;
  revoked_at: number | null;
}

export interface CreatedInviteResponse {
  id: string;
  full: string;
  prefix: string;
  label: string | null;
  expires_at: number;
}

export function createInvite(label: string | null, expiresInSec: number): Promise<CreatedInviteResponse> {
  return apiFetch('/admin/invites', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label, expires_in_sec: expiresInSec }),
  });
}

export async function listInvites(): Promise<InviteRecord[]> {
  const r = await apiFetch<{ invites: InviteRecord[] }>('/admin/invites');
  return r.invites;
}

export function revokeInvite(id: string): Promise<void> {
  return apiFetch(`/admin/invites/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export type ValidateInviteResult =
  | { ok: true; expires_at: number }
  | { ok: false; reason: string };

export async function validateInvite(): Promise<ValidateInviteResult> {
  const res = await fetch('/auth/invite/validate', {
    method: 'POST',
    credentials: 'same-origin',
  });
  if (res.ok) return res.json() as Promise<ValidateInviteResult>;
  const body = await res.json().catch(() => ({})) as { error?: { type?: string } };
  return { ok: false, reason: body?.error?.type ?? 'unknown' };
}

export async function inviteRedeemGithubStart(): Promise<GithubDeviceStartResult> {
  const res = await fetch('/auth/invite/redeem/github/start', {
    method: 'POST',
    credentials: 'same-origin',
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Invite GitHub start failed: ${text}`);
  }
  return res.json() as Promise<GithubDeviceStartResult>;
}

export async function inviteRedeemGithubPoll(device_id: string): Promise<GithubDevicePollResult> {
  const res = await fetch('/auth/invite/redeem/github/poll', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id }),
  });
  if (res.status === 403) {
    try {
      const data = await res.json();
      if (data.error?.type === 'invite_required') return { status: 'invite_required' };
    } catch {
      // ignore parse errors
    }
    return { status: 'denied' };
  }
  if (res.status === 409) return { status: 'already_exists' };
  if (res.status === 410) return { status: 'invite_consumed' };
  if (!res.ok) return { status: 'error' };
  return res.json() as Promise<GithubDevicePollResult>;
}
