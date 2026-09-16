import type { Context } from 'hono';
import type { Env, Variables } from '../env';
import { listModels, getModel } from '../db/queries';
import { ensureModelCatalog } from '../models/catalog';
import { excludePaidModelsEnabled, filterPaidModels, withModelAccess, type ModelWithAccess } from '../models/access';

type C = Context<{ Bindings: Env; Variables: Variables }>;

function toOpenAIModel(m: ModelWithAccess) {
  return {
    id: m.name,
    object: 'model',
    created: m.synced_at ? Math.floor(m.synced_at / 1000) : 0,
    owned_by: 'cloudflare',
    task: m.task,
    'x-neurons-input': m.neurons_input,
    'x-neurons-output': m.neurons_output,
    'x-neurons-flat': m.neurons_flat,
    'x-paid-required': m.paid_required,
  };
}

export async function listHandler(c: C): Promise<Response> {
  const task = c.req.query('task');
  try {
    await ensureModelCatalog(c.env);
    const models = await listModels(c.env.DB, task);
    const excludePaid = await excludePaidModelsEnabled(c.env.DB);
    return c.json({
      object: 'list',
      data: filterPaidModels(models, excludePaid).map(toOpenAIModel),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'model discovery failed';
    console.error('[models/bootstrap] error:', error);
    return c.json({ error: { type: 'sync_failed', message } }, 502);
  }
}

export async function getHandler(c: C): Promise<Response> {
  const id = c.req.param('id');
  if (!id) return c.json({ error: { type: 'invalid_request', message: 'missing id' } }, 400);
  const model = await getModel(c.env.DB, id);
  if (!model || model.enabled === 0 || (withModelAccess(model).paid_required === true && await excludePaidModelsEnabled(c.env.DB))) {
    return c.json({ error: { type: 'not_found', message: `model '${id}' not found` } }, 404);
  }
  return c.json(toOpenAIModel(withModelAccess(model)));
}
