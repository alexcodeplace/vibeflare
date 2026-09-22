import type { Context, Next } from 'hono';
import type { Env, Variables } from '../env';
import { sha256 } from '../util/hash';
import { getApiKeyByHash, touchApiKeyLastUsed } from '../db/queries';
import { readSession } from './session';
import { verifyAccessJWT } from './access';

export const API_KEY_LAST_USED_WRITE_INTERVAL_MS = 60 * 60 * 1000;

export function apiKeyLastUsedNeedsWrite(lastUsedAt: number | null, now: number): boolean {
  return lastUsedAt === null || now - lastUsedAt >= API_KEY_LAST_USED_WRITE_INTERVAL_MS;
}

export async function requireApiKey(c: Context<{ Bindings: Env; Variables: Variables }>, next: Next) {
  // Same-origin browser requests may use session cookies instead of an API key.
  // They must send the x-vf-browser: 1 header.
  // On the CF Access domain, no vg_sess cookie is issued — fall back to the
  // cf-access-jwt-assertion header that CF injects on every request.
  if (c.req.header('x-vf-browser') === '1') {
    const sess = await readSession(c);
    if (sess) {
      c.set('userId', sess.sub);
      c.set('authMethod', 'session');
      return await next();
    }
    const accessJwt = c.req.header('cf-access-jwt-assertion');
    if (accessJwt) {
      const claims = await verifyAccessJWT(c.env, accessJwt);
      if (claims) {
        c.set('userId', claims.sub);
        c.set('authMethod', 'cf_access');
        return await next();
      }
    }
    return c.json({ error: { type: 'auth', message: 'session required' } }, 401);
  }

  const auth = c.req.header('authorization') ?? '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) {
    return c.json({ error: { type: 'auth', message: 'missing bearer token' } }, 401);
  }
  const token = m[1]!;
  if (!token.startsWith('vf-')) {
    return c.json({ error: { type: 'auth', message: 'malformed api key' } }, 401);
  }
  const hash = await sha256(token);
  const row = await getApiKeyByHash(c.env.DB, hash);
  if (!row) {
    return c.json({ error: { type: 'auth', message: 'invalid api key' } }, 401);
  }
  c.set('apiKey', row);
  c.set('userId', row.user_id);
  const now = Date.now();
  if (apiKeyLastUsedNeedsWrite(row.last_used_at, now)) {
    c.executionCtx.waitUntil(touchApiKeyLastUsed(c.env.DB, row.id, now));
  }
  await next();
}
