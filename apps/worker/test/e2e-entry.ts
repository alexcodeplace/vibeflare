import worker, { AuthRateLimiter, CronScheduler, QuotaCounter } from '../src/index';
import { sign } from 'hono/jwt';
import type { Env } from '../src/env';
import { MODEL_CATALOG_READY_KEY, MODEL_CATALOG_SYNCED_AT_KEY } from '../src/models/catalog';
import { resolveSessionSecret } from '../src/auth/session';
import { setSetting } from '../src/db/queries';

const RESET_TABLES = [
  'chat_messages',
  'chats',
  'auth_credentials',
  'api_keys',
  'files',
  'prompt_cache',
  'audit_events',
  'auth_invites',
  'device_codes',
  'auth_users',
  'response_cache',
  'settings',
  'models',
] as const;

const encoder = new TextEncoder();
const fakeAI = {
  async run(_model: string, input: Record<string, unknown>) {
    if (input.stream === true) {
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"response":"Hello from VibeFlare E2E"}\n\n'));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
    }
    return {
      response: 'Hello from VibeFlare E2E',
      usage: { prompt_tokens: 4, completion_tokens: 5 },
    };
  },
} as unknown as Env['AI'];

function e2eEnv(env: Env): Env {
  return new Proxy(env, {
    get(target, prop, receiver) {
      if (prop === 'AI') return fakeAI;
      return Reflect.get(target, prop, receiver);
    },
  });
}

async function reset(env: Env) {
  for (const table of RESET_TABLES) await env.DB.prepare(`DELETE FROM ${table}`).run();
  // Browser journeys stay hermetic: production empty-catalog bootstrap is
  // covered by model_catalog.test.ts, while E2E starts with one deterministic
  // Workers AI model instead of reaching the external Cloudflare catalog.
  await env.QUOTA.get(env.QUOTA.idFromName('global')).fetch('https://q/reset', { method: 'POST' });
  await seedModel(env, { name: '@cf/meta/e2e-chat', task: 'text-generation' });
  const now = Date.now();
  await setSetting(env.DB, MODEL_CATALOG_READY_KEY, '1', now);
  await setSetting(env.DB, MODEL_CATALOG_SYNCED_AT_KEY, String(now), now);
}

async function seedSession(env: Env, role: 'owner' | 'user') {
  const userId = `matrix-${role}`;
  const nowMs = Date.now();
  await env.DB.prepare(
    `INSERT INTO auth_users (id, email, github_login, role, created_at)
     VALUES (?, ?, NULL, ?, ?)
     ON CONFLICT(id) DO UPDATE SET role=excluded.role`,
  ).bind(userId, `${role}@example.test`, role, nowMs).run();

  const now = Math.floor(nowMs / 1000);
  const token = await sign({ sub: userId, role, iat: now, exp: now + 3600 }, await resolveSessionSecret(env));
  return new Response(JSON.stringify({ userId, role }), {
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': `vf_sess=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=3600`,
    },
  });
}

async function seedModel(env: Env, body: { name?: string; task?: string; paid_required?: boolean }) {
  const name = body.name ?? '@cf/meta/e2e-chat';
  const task = body.task ?? 'text-generation';
  const properties = JSON.stringify({ paid_required: body.paid_required === true });
  await env.DB.prepare(
    `INSERT INTO models (name, task, description, properties, neurons_input, neurons_output, neurons_flat, beta, enabled, synced_at)
     VALUES (?, ?, 'E2E model', ?, 1, 1, 1, 0, 1, ?)
     ON CONFLICT(name) DO UPDATE SET task=excluded.task, properties=excluded.properties, enabled=1, synced_at=excluded.synced_at`,
  ).bind(name, task, properties, Date.now()).run();
  return { name, task, paid_required: body.paid_required === true };
}

export { AuthRateLimiter, CronScheduler, QuotaCounter };

export default {
  async fetch(req: Request, rawEnv: Env, ctx: ExecutionContext) {
    const env = e2eEnv(rawEnv);
    const url = new URL(req.url);
    const testMode = (env as Env & { E2E_TEST_MODE?: string }).E2E_TEST_MODE === '1';

    if (testMode && req.method === 'POST' && url.pathname === '/__e2e/reset') {
      await reset(env);
      return Response.json({ ok: true });
    }
    if (testMode && req.method === 'POST' && url.pathname === '/__e2e/session') {
      const body = await req.json<{ role?: string }>().catch((): { role?: string } => ({}));
      if (body.role !== 'owner' && body.role !== 'user') {
        return Response.json({ error: 'role must be owner or user' }, { status: 400 });
      }
      return seedSession(env, body.role);
    }
    if (testMode && req.method === 'POST' && url.pathname === '/__e2e/seed-model') {
      const body = await req.json<{ name?: string; task?: string; paid_required?: boolean }>().catch(() => ({}));
      return Response.json(await seedModel(env, body));
    }
    if (testMode && req.method === 'POST' && url.pathname === '/__e2e/seed-audit') {
      const body = await req.json<{ userId: string; model?: string; status?: number }>();
      const id = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO audit_events (id, user_id, api_key_id, endpoint, model, task, status, tokens_in, tokens_out, neurons, duration_ms, cached, error, created_at)
         VALUES (?, ?, NULL, '/v1/chat/completions', ?, 'text-generation', ?, 4, 5, 9, 12, 0, NULL, ?)`,
      ).bind(id, body.userId, body.model ?? '@cf/meta/e2e-chat', body.status ?? 200, Date.now()).run();
      return Response.json({ id });
    }
    if (testMode && req.method === 'GET' && url.pathname === '/__e2e/state') {
      const counts: Record<string, number> = {};
      for (const table of RESET_TABLES) {
        const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
        counts[table] = row?.n ?? 0;
      }
      return Response.json({ counts });
    }

    return worker.fetch(req, env, ctx);
  },
};
