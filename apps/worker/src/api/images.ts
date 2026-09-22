import { historyTarget, storeHistoryFile, saveHistoryTurn, discardHistoryFiles, type StoredHistoryFile } from './history';
import type { Context } from 'hono';
import type { Env, Variables } from '../env';
import { nanoid } from 'nanoid';
import { getModel } from '../db/queries';
import { peekQuota, chargeQuota } from '../quota/client';
import { audit } from '../audit/log';
import { actualNeuronsFromOutput, estimateNeurons } from '../ai/neurons';
import { imageReqToWai, extractImageBuffer } from './translator';
import { runner } from '../ai/dispatch';
import { classifyUpstreamError } from '../ai/errors';
import { putFile } from '../files/r2';
import { newId } from '../util/id';
import { arrayBufferToBase64 } from '../util/base64';

type C = Context<{ Bindings: Env; Variables: Variables }>;

const INLINE_SIZE_LIMIT = 100 * 1024; // 100KB

export async function handle(c: C): Promise<Response> {
  const start = Date.now();
  const env = c.env;
  const userId = c.var.userId;
  const apiKeyId = c.var.apiKey?.id ?? null;

  let body: {
    model: string;
    prompt: string;
    n?: number;
    size?: string;
    response_format?: 'url' | 'b64_json';
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { type: 'invalid_request', message: 'invalid JSON' } }, 400);
  }

  if (!body || typeof body.model !== 'string' || typeof body.prompt !== 'string' || !body.prompt.trim() || (body.n !== undefined && (!Number.isInteger(body.n) || body.n < 1 || body.n > 10))) {
    return c.json({ error: { type: 'invalid_request', message: 'model and prompt required' } }, 400);
  }

  const modelRow = await getModel(env.DB, body.model);
  if (!modelRow || modelRow.enabled === 0) {
    return c.json({ error: { type: 'not_found', message: `model '${body.model}' not found` } }, 404);
  }

  const chatId = await historyTarget(c);
  if (chatId instanceof Response) return chatId;

  const quota = await peekQuota(env);
  if (quota.used >= quota.limit) {
    return c.json({ error: { type: 'quota_exceeded', message: 'daily quota exceeded' } }, 429);
  }

  const n = Math.max(1, body.n ?? 1);
  const waiInput = imageReqToWai(body);
  const host = new URL(c.req.url).host;

  const results: { url?: string; b64_json?: string }[] = [];
  const saved: StoredHistoryFile[] = [];
  let measuredNeurons = 0;
  let hasMeasuredNeurons = true;

  try {
    for (let i = 0; i < n; i++) {
      const out = await runner(env, body.model, waiInput);
      const measured = actualNeuronsFromOutput(out);
      if (measured == null) hasMeasuredNeurons = false;
      else measuredNeurons += measured;
      const imgBuf = await extractImageBuffer(out);

      const forceUrl = body.response_format === 'url' || imgBuf.byteLength > INLINE_SIZE_LIMIT;

      if (chatId) {
        const stored = await storeHistoryFile(env, userId, 'image', `${nanoid(8)}.png`, 'image/png', imgBuf);
        saved.push(stored);
        results.push(body.response_format === 'b64_json'
          ? { b64_json: arrayBufferToBase64(imgBuf) }
          : { url: `${new URL(c.req.url).origin}/v1/files/${stored.file.id}` });
      } else if (forceUrl) {
        const filename = `${nanoid(8)}.png`;
        const { key } = await putFile(env.R2, userId, filename, 'image/png', imgBuf);
        const fileId = newId();
        const expiresAt = Date.now() + 14 * 24 * 60 * 60 * 1000;
        await env.DB.prepare(
          'INSERT INTO files (id, user_id, r2_key, filename, mime, size, purpose, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(fileId, userId, key, filename, 'image/png', imgBuf.byteLength, 'image-gen', Date.now(), expiresAt).run();
        results.push({ url: `https://${host}/v1/files/${fileId}` });
      } else {
        results.push({ b64_json: arrayBufferToBase64(imgBuf) });
      }
    }
  } catch (e) {
    await discardHistoryFiles(env, userId, saved);
    const failure = classifyUpstreamError(e);
    await audit(env, {
      userId, apiKeyId,
      endpoint: '/v1/images/generations',
      model: body.model, task: modelRow.task,
      status: failure.status, durationMs: Date.now() - start,
      error: failure.message,
    });
    return c.json({ error: { type: failure.type, message: failure.message } }, failure.status);
  }

  const neurons = hasMeasuredNeurons
    ? measuredNeurons
    : estimateNeurons(modelRow, Math.ceil(body.prompt.length / 4), 0) * n;
  await chargeQuota(env, neurons);
  await audit(env, {
    userId, apiKeyId,
    endpoint: '/v1/images/generations',
    model: body.model, task: modelRow.task,
    status: 200, neurons,
    durationMs: Date.now() - start,
  });

  if (chatId) {
    try {
      await saveHistoryTurn(env, userId, chatId, { model: body.model, userText: body.prompt, assistantText: `Generated ${saved.length} image${saved.length === 1 ? '' : 's'}.`, metadata: { version: 1, task: 'text-to-image', files: saved.map(item => item.file) }, neurons });
    } catch (error) {
      await discardHistoryFiles(env, userId, saved);
      throw error;
    }
  }

  return c.json({ created: Math.floor(Date.now() / 1000), data: results });
}
