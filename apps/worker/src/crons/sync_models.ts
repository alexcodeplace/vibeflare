import type { Env } from '../env';
import { disableDelistedModels, rearmDisabledModels, upsertModel } from '../db/queries';
import { fetchCloudflarePublicCatalog } from '../models/public_catalog';
import { modelRequiresPaid } from '../models/access';

/** How long a model stays disabled after its last failure before traffic is sent to it again. */
const FAILURE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * Sync the public Workers AI catalog without any account ID or API token.
 *
 * Cloudflare publishes the current catalog and per-model neuron pricing in its
 * public documentation. This keeps one-click VibeFlare installs zero-config
 * while still tracking model additions/removals over time.
 */
export async function syncModels(
  env: Env,
): Promise<{ count: number; delisted: number; rearmed: number }> {
  const syncedAt = Date.now();
  const models = await fetchCloudflarePublicCatalog();

  for (const model of models) {
    await upsertModel(env.DB, {
      name: model.name,
      task: model.task,
      description: null,
      properties: JSON.stringify({
        source: 'cloudflare-public-catalog',
        author: model.author,
        href: model.href,
        capabilities: model.capabilities,
        pricing: model.pricing,
        paid_required: model.paidRequired ?? modelRequiresPaid({ name: model.name, properties: null }),
      }),
      neurons_input: model.neuronsInput,
      neurons_output: model.neuronsOutput,
      neurons_flat: null,
      beta: 0,
      enabled: 1,
      synced_at: syncedAt,
    });
  }

  const rearmed = await rearmDisabledModels(env.DB, syncedAt, syncedAt - FAILURE_COOLDOWN_MS);
  const delisted = await disableDelistedModels(env.DB, syncedAt);
  return { count: models.length, delisted, rearmed };
}
