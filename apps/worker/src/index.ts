import { Hono, type Context } from 'hono';
import type { Env, Variables } from './env';
import authRoutes from './routes/auth';
import authInvite from './routes/auth.invite';
import adminRoutes from './routes/admin';
import v1Routes from './routes/v1';
import { ensureCronArmed } from './crons/scheduler';
import { requireApiKey } from './auth/apikey';
import { requireUserAuth, resolveUser } from './auth/middleware';
import { getFile } from './files/r2';
import { countUsers } from './db/queries';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/health', (c) => c.json({ ok: true, version: '0.9.6' }));

// Root routing happens at the Worker edge so the browser never loads /chat only
// to be bounced again by client-side auth. A fresh install goes straight to
// setup, an authenticated user goes straight to chat, and everyone else goes
// straight to login.
app.get('/', async (c) => {
  c.header('Cache-Control', 'private, no-store');
  if (await resolveUser(c)) return c.redirect('/chat', 302);
  return c.redirect((await countUsers(c.env.DB)) === 0 ? '/setup' : '/login', 302);
});

// Invite links must be handled at request time. The UI is statically built, so
// signup.astro cannot stash query tokens into an httpOnly cookie at runtime.
function serveSignup(c: Context<{ Bindings: Env; Variables: Variables }>) {
  const token = c.req.query('token');
  if (token) return c.redirect(`/auth/invite/stash?token=${encodeURIComponent(token)}`, 302);
  return c.env.ASSETS.fetch(c.req.raw);
}
app.get('/signup', serveSignup);
app.get('/signup/', serveSignup);

app.route('/auth/invite', authInvite);
app.route('/auth', authRoutes);
app.route('/admin', adminRoutes);

app.route('/v1', v1Routes);

// Serve R2-stored files (images, uploads) — accepts API key or session auth
app.get('/files/:key{.+}', async (c, next) => {
  if (c.req.header('Authorization')?.startsWith('Bearer ')) {
    return requireApiKey(c, next);
  }
  return requireUserAuth(c, next);
}, async (c) => {
  const key = decodeURIComponent(c.req.param('key'));
  const owned = await c.env.DB.prepare('SELECT id FROM files WHERE r2_key = ? AND user_id = ?').bind(key, c.get('userId')).first();
  if (!owned) return c.json({ error: { type: 'not_found', message: 'file not found' } }, 404);
  const obj = await getFile(c.env.R2, key);
  if (!obj) return c.json({ error: { type: 'not_found', message: 'file not found' } }, 404);
  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});

// Serve UI for non-API paths; return JSON 404 for API paths
app.notFound((c) => {
  const { pathname } = new URL(c.req.url);
  if (
    pathname.startsWith('/admin') ||
    pathname.startsWith('/v1') ||
    pathname.startsWith('/auth') ||
    pathname === '/health'
  ) {
    return c.json({ error: { type: 'not_found', message: 'route not found' } }, 404);
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

export { QuotaCounter } from './quota/do';
export { AuthRateLimiter } from './auth/ratelimit';
export { CronScheduler } from './crons/scheduler';

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    return app.fetch(req, env, ctx);
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(ensureCronArmed(env));
  },
} satisfies ExportedHandler<Env>;
