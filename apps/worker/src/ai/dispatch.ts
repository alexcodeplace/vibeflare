import type { Env } from '../env';
import { assertModelAllowed } from '../models/access';

/**
 * Run a Workers AI model. Extracted so tests can vi.mock this module.
 * @param env  Worker environment
 * @param model  Model name, e.g. '@cf/meta/llama-3-8b-instruct'
 * @param input  WAI-shaped input object
 * @param options  Additional options (e.g. {stream: true})
 */
export async function runner(
  env: Env,
  model: string,
  input: Record<string, unknown>,
  options?: { stream?: boolean }
): Promise<unknown> {
  await assertModelAllowed(env, model);
  // stream: true goes in the input object (not the 3rd options arg, which is AI Gateway config)
  const mergedInput = options?.stream ? { ...input, stream: true } : input;
  return env.AI.run(model, mergedInput);
}
