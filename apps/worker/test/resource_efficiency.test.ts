import { describe, expect, it } from 'vitest';
import {
  API_KEY_LAST_USED_WRITE_INTERVAL_MS,
  apiKeyLastUsedNeedsWrite,
} from '../src/auth/apikey';

describe('Cloudflare resource efficiency', () => {
  it('coalesces API-key last-used writes without losing the first-use timestamp', () => {
    const now = Date.parse('2026-09-22T04:00:00Z');
    expect(apiKeyLastUsedNeedsWrite(null, now)).toBe(true);
    expect(apiKeyLastUsedNeedsWrite(now - API_KEY_LAST_USED_WRITE_INTERVAL_MS + 1, now)).toBe(false);
    expect(apiKeyLastUsedNeedsWrite(now - API_KEY_LAST_USED_WRITE_INTERVAL_MS, now)).toBe(true);
  });
});
