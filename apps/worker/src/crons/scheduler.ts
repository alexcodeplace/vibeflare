import type { Env } from '../env';
import { refreshModelCatalog } from '../models/catalog';
import { pruneExpired } from './prune';

const RUN_HOUR_UTC = 3;
const LAST_RUN_KEY = 'last_run';

export interface JobOutcome {
  ok: boolean;
  ms: number;
  result?: unknown;
  error?: string;
}

export interface LastRun {
  at: number;
  syncModels: JobOutcome;
  pruneExpired: JobOutcome;
}

export function nextRunAt(now: number): number {
  const d = new Date(now);
  d.setUTCHours(RUN_HOUR_UTC, 0, 0, 0);
  if (d.getTime() <= now) d.setUTCDate(d.getUTCDate() + 1);
  return d.getTime();
}

async function run<T>(job: () => Promise<T>): Promise<JobOutcome> {
  const started = Date.now();
  try {
    const result = await job();
    return { ok: true, ms: Date.now() - started, result };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, error: e instanceof Error ? e.message : String(e) };
  }
}

export class CronScheduler implements DurableObject {
  constructor(
    private state: DurableObjectState,
    private env: Env
  ) {}

  private async ensureAlarm(): Promise<number> {
    const existing = await this.state.storage.getAlarm();
    if (existing !== null) return existing;
    const at = nextRunAt(Date.now());
    await this.state.storage.setAlarm(at);
    return at;
  }

  async fetch(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);

    if (pathname === '/arm') {
      return Response.json({ next_run_at: await this.ensureAlarm() });
    }

    if (pathname === '/status') {
      return Response.json({
        next_run_at: await this.state.storage.getAlarm(),
        last_run: (await this.state.storage.get<LastRun>(LAST_RUN_KEY)) ?? null,
      });
    }

    return new Response('not found', { status: 404 });
  }

  async alarm(): Promise<void> {
    // Re-arm before doing work: a job that hangs or throws must not end the schedule.
    await this.state.storage.setAlarm(nextRunAt(Date.now()));

    const [sync, prune] = await Promise.all([
      run(() => refreshModelCatalog(this.env)),
      run(() => pruneExpired(this.env)),
    ]);

    if (!sync.ok) console.error('[cron] syncModels failed:', sync.error);
    if (!prune.ok) console.error('[cron] pruneExpired failed:', prune.error);

    await this.state.storage.put<LastRun>(LAST_RUN_KEY, {
      at: Date.now(),
      syncModels: sync,
      pruneExpired: prune,
    });
  }
}

/** Idempotent bootstrap/recovery hook for the Worker scheduled trigger. */
export async function ensureCronArmed(env: Env): Promise<void> {
  const stub = env.CRON.get(env.CRON.idFromName('singleton'));
  await stub.fetch('https://cron/arm');
}

export async function cronStatus(env: Env): Promise<unknown> {
  const stub = env.CRON.get(env.CRON.idFromName('singleton'));
  return (await stub.fetch('https://cron/status')).json();
}
