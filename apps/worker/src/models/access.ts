import type { Env } from '../env';
import type { ModelInfo } from '@vibeflare/shared';
import { getModel, getSetting } from '../db/queries';

export const EXCLUDE_PAID_MODELS_SETTING = 'models.exclude_paid';

// Snapshot of Cloudflare's explicit paid-billing list, verified 2026-09-12:
// https://developers.cloudflare.com/workers-ai/platform/pricing/
// Used only when live/legacy metadata cannot classify a model. A parsed false
// from newer authoritative metadata takes precedence over this snapshot.
export const KNOWN_PAID_REQUIRED_MODELS = new Set([
  '@cf/moonshotai/kimi-k2.6',
  '@cf/moonshotai/kimi-k2.7-code',
  '@cf/zai-org/glm-5.2',
  '@cf/zai-org/glm-5.3',
  '@cf/zai-org/glm-5.3-flash',
  '@cf/deepseek-ai/deepseek-v4-flash-0731',
  '@cf/deepseek-ai/deepseek-v4-pro-0813',
]);

// Small documented fallback for offline first-run defaults. Dollar-denominated
// pricing by itself does not mean paid-only: these support the free allocation.
const KNOWN_FREE_COMPATIBLE_MODELS = new Set([
  '@cf/meta/llama-3.2-3b-instruct',
  '@cf/meta/llama-3.1-8b-instruct-fp8',
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/openai/gpt-oss-20b',
  '@cf/qwen/qwen2.5-coder-32b-instruct',
  '@cf/black-forest-labs/flux-1-schnell',
  '@cf/openai/whisper',
]);

export type ModelWithAccess = ModelInfo & { paid_required: boolean | null };

/** Null means unknown, not a claim that the model is free-compatible. */
export function modelRequiresPaid(model: Pick<ModelInfo, 'name' | 'properties'>): boolean | null {
  if (model.properties) {
    try {
      const p = JSON.parse(model.properties) as Record<string, unknown> | null;
      if (p?.paid_observed === true) return true;
      if (typeof p?.paid_required === 'boolean') return p.paid_required;
    } catch {
      // Fall back for legacy/malformed metadata; never infer paid-only from price.
    }
  }
  if (KNOWN_PAID_REQUIRED_MODELS.has(model.name)) return true;
  if (KNOWN_FREE_COMPATIBLE_MODELS.has(model.name)) return false;
  return null;
}

export function withModelAccess(model: ModelInfo): ModelWithAccess {
  return { ...model, paid_required: modelRequiresPaid(model) };
}

export async function excludePaidModelsEnabled(db: D1Database): Promise<boolean> {
  const value = await getSetting(db, EXCLUDE_PAID_MODELS_SETTING);
  return value === null || !['0', 'false', 'off', 'no'].includes(value.trim().toLowerCase());
}

export function filterPaidModels(models: ModelInfo[], excludePaid: boolean): ModelWithAccess[] {
  const decorated = models.map(withModelAccess);
  return excludePaid ? decorated.filter((model) => model.paid_required !== true) : decorated;
}

export class PaidModelExcludedError extends Error {
  constructor() {
    super('Paid models are excluded. The owner can change this in Settings > Models.');
    this.name = 'PaidModelExcludedError';
  }
}

/** Guard actual inference too, including stale tabs and direct API requests. */
export async function assertModelAllowed(env: Env, name: string): Promise<void> {
  const model = await getModel(env.DB, name);
  if (model && modelRequiresPaid(model) === true && await excludePaidModelsEnabled(env.DB)) {
    throw new PaidModelExcludedError();
  }
}
