import { PaidModelExcludedError } from '../models/access';

/** Workers AI error code 4006: the account's neuron allocation for the day is spent. */
export function isUpstreamQuotaError(message: string): boolean {
  return message.includes('4006') || message.includes('daily free allocation');
}

/** Workers AI error code 5035: the selected model requires paid billing. */
export function isPaidPlanRequiredError(message: string): boolean {
  const lower = message.toLowerCase();
  return /\b5035\b/.test(message)
    || lower.includes('not available on the workers free plan')
    || lower.includes('requires a paid billing method')
    || lower.includes('requires a workers paid plan');
}

export type UpstreamFailure = {
  status: 403 | 429 | 500;
  type: 'paid_model_excluded' | 'paid_plan_required' | 'quota_exceeded' | 'server_error';
  message: string;
};

export function classifyUpstreamError(e: unknown): UpstreamFailure {
  const message = e instanceof Error ? e.message : String(e);
  if (e instanceof PaidModelExcludedError) {
    return { status: 403, type: 'paid_model_excluded', message };
  }
  if (isPaidPlanRequiredError(message)) {
    return { status: 403, type: 'paid_plan_required', message };
  }
  if (isUpstreamQuotaError(message)) {
    return { status: 429, type: 'quota_exceeded', message };
  }
  return { status: 500, type: 'server_error', message };
}
