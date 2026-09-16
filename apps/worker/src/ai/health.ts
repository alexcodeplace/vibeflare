import type { Env } from '../env';
import { markModelPaidRequired, recordModelSuccess, recordModelFailure } from '../db/queries';
import { isPaidPlanRequiredError, isUpstreamQuotaError } from './errors';

/** Consecutive upstream failures on real traffic before a model is taken out of the catalog. */
const FAILURE_THRESHOLD = 3;

export interface ModelHealthSignal {
  model?: string;
  status: number;
  cached?: boolean;
  error?: string;
}

/**
 * Derives model liveness from a request that was actually served, so no synthetic
 * inference is needed. Client errors and cache hits carry no evidence either way.
 */
export async function recordModelHealth(env: Env, signal: ModelHealthSignal): Promise<void> {
  if (!signal.model || signal.cached) return;

  const now = Date.now();
  const message = signal.error ?? `status ${signal.status}`;

  // 5035 is account-plan metadata, not a dead model. Learn it immediately from
  // the user's real request so future model lists can hide it without probing.
  if (signal.status >= 400 && isPaidPlanRequiredError(message)) {
    await markModelPaidRequired(env.DB, signal.model, message, now);
    return;
  }

  if (signal.status < 400) {
    await recordModelSuccess(env.DB, signal.model, now);
    return;
  }
  if (signal.status < 500) return;

  // A spent neuron allocation says nothing about the model.
  if (isUpstreamQuotaError(message)) return;

  await recordModelFailure(env.DB, signal.model, message, now, FAILURE_THRESHOLD);
}
