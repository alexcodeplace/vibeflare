import { describe, expect, it } from 'vitest';
import {
  API_KEY_LAST_USED_WRITE_INTERVAL_MS,
  apiKeyLastUsedNeedsWrite,
} from '../src/auth/apikey';
import { countUsers } from '../src/db/queries';

describe('Cloudflare resource efficiency', () => {
  it('coalesces API-key last-used writes without losing the first-use timestamp', () => {
    const now = Date.parse('2026-09-22T04:00:00Z');
    expect(apiKeyLastUsedNeedsWrite(null, now)).toBe(true);
    expect(apiKeyLastUsedNeedsWrite(now - API_KEY_LAST_USED_WRITE_INTERVAL_MS + 1, now)).toBe(false);
    expect(apiKeyLastUsedNeedsWrite(now - API_KEY_LAST_USED_WRITE_INTERVAL_MS, now)).toBe(true);
  });
  it('checks bootstrap user existence without scanning the whole auth table', async () => {
    const queries: string[] = [];
    const db = {
      prepare(query: string) {
        queries.push(query);
        return { first: async () => ({ n: 1 }) };
      },
    } as unknown as D1Database;

    await expect(countUsers(db)).resolves.toBe(1);
    expect(queries).toEqual(['SELECT 1 as n FROM auth_users LIMIT 1']);
    expect(queries[0]).not.toContain('COUNT(');
  });

});
