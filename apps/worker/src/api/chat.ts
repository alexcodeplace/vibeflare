import type { Context } from 'hono';
import type { Env, Variables } from '../env';
import { nanoid } from 'nanoid';
import { getModel } from '../db/queries';
import { peekQuota, chargeQuota } from '../quota/client';
import { audit } from '../audit/log';
import { estimateNeurons, estimateTokens } from '../ai/neurons';
import { chatToWai, waiToChat, waiStreamToOpenAISSE } from './translator';
import { runner } from '../ai/dispatch';
import { classifyUpstreamError } from '../ai/errors';
import { lookup, store } from '../cache/responses';
import { resolveSystemPrompt } from '../cache/prompts';
import type { ChatCompletionRequest } from './translator';

type C = Context<{ Bindings: Env; Variables: Variables }>;

export async function handle(c: C): Promise<Response> {
  const start = Date.now();
  const env = c.env;
  const userId = c.var.userId;
  const apiKeyId = c.var.apiKey?.id ?? null;

  // 1. Parse body
  let body: ChatCompletionRequest;
  try {
    body = await c.req.json<ChatCompletionRequest>();
  } catch {
    return c.json({ error: { type: 'invalid_request', message: 'invalid JSON body' } }, 400);
  }

  if (!body.model || !Array.isArray(body.messages) || body.messages.length === 0) {
    return c.json({ error: { type: 'invalid_request', message: 'model and messages required' } }, 400);
  }

  // 2. Model lookup
  const modelRow = await getModel(env.DB, body.model);
  if (!modelRow || modelRow.enabled === 0) {
    return c.json({ error: { type: 'not_found', message: `model '${body.model}' not found` } }, 404);
  }

  // 3. Resolve system_id
  if (body.system_id) {
    const resolved = await resolveSystemPrompt(
      env,
      userId,
      body.system_id,
      body.messages as { role: string; content: string }[]
    );
    body = { ...body, messages: resolved as ChatCompletionRequest['messages'] };
  }

  // 4. Response cache check
  if (body.cache === true) {
    const cached = await lookup(env, body.model, body as unknown as Record<string, unknown>);
    if (cached) {
      const response = JSON.parse(cached.response);
      const durationMs = Date.now() - start;
      await audit(env, {
        userId,
        apiKeyId,
        endpoint: '/v1/chat/completions',
        model: body.model,
        task: modelRow.task,
        status: 200,
        neurons: 0,
        durationMs,
        cached: true,
      });
      return c.json(response);
    }
  }

  // 5. Quota check
  const quota = await peekQuota(env);
  if (quota.used >= quota.limit) {
    await audit(env, {
      userId,
      apiKeyId,
      endpoint: '/v1/chat/completions',
      model: body.model,
      task: modelRow.task,
      status: 429,
      durationMs: Date.now() - start,
      error: 'quota_exceeded',
    });
    return c.json({ error: { type: 'quota_exceeded', message: 'daily quota exceeded' } }, 429);
  }

  // 6. Translate to WAI input
  let waiInput: Record<string, unknown>;
  try {
    waiInput = await chatToWai(body, modelRow.task);
  } catch (e: unknown) {
    return c.json({ error: { type: 'invalid_request', message: String(e) } }, 400);
  }

  // 7. Handle chat session
  const chatIdParam = c.req.query('chat_id');

  // 8. Streaming
  if (body.stream === true) {
    let aiStream: ReadableStream;
    try {
      aiStream = await runner(env, body.model, waiInput, { stream: true }) as ReadableStream;
    } catch (e: unknown) {
      const failure = classifyUpstreamError(e);
      await audit(env, {
        userId, apiKeyId,
        endpoint: '/v1/chat/completions',
        model: body.model, task: modelRow.task,
        status: failure.status, durationMs: Date.now() - start, error: failure.message,
      });
      return c.json({ error: { type: failure.type, message: failure.message } }, failure.status);
    }

    const completionId = `chatcmpl-${nanoid(12)}`;

    // Buffer content for post-stream hooks via a pass-through TransformStream
    let bufferedContent = '';
    const { readable: passthrough, writable } = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctrl) {
        const decoded = new TextDecoder().decode(chunk);
        // Extract content from SSE lines for buffering
        for (const line of decoded.split('\n')) {
          if (line.startsWith('data: ') && !line.includes('[DONE]')) {
            try {
              const parsed = JSON.parse(line.slice(6)) as {
                choices: { delta: { content?: string } }[];
              };
              bufferedContent += parsed.choices?.[0]?.delta?.content ?? '';
            } catch { /* ignore */ }
          }
        }
        ctrl.enqueue(chunk);
      },
    });

    let latestStreamUsage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; neurons?: number } | null = null;
    const sseStream = waiStreamToOpenAISSE(aiStream, body.model, completionId, (usage) => {
      latestStreamUsage = usage;
    });
    const writer = writable.getWriter();

    // Pipe SSE → passthrough.
    // executionCtx may be absent in test environments; only start async work when ctx available.
    let hasCtx = false;
    try { c.executionCtx; hasCtx = true; } catch { /* no ctx */ }

    // Always pipe SSE → passthrough (makes the response body work)
    const pipeWork = (async () => {
      const sseReader = sseStream.getReader();
      try {
        while (true) {
          const { done, value } = await sseReader.read();
          if (done) break;
          await writer.write(value);
        }
      } finally {
        await writer.close();
      }
    })();

    // Post-stream quota/audit/persist — only run when ExecutionContext available
    if (hasCtx) {
      const postWork = pipeWork.then(async () => {
        try {
          const usage = latestStreamUsage as { prompt_tokens?: number; completion_tokens?: number; neurons?: number } | null;
          const tokensOut = usage?.completion_tokens ?? estimateTokens(bufferedContent);
          const tokensIn = usage?.prompt_tokens ?? estimateTokens(
            body.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join(' ')
          );
          const neurons = typeof usage?.neurons === 'number'
            ? usage.neurons
            : estimateNeurons(modelRow, tokensIn, tokensOut);
          await chargeQuota(env, neurons);
          await audit(env, {
            userId, apiKeyId,
            endpoint: '/v1/chat/completions',
            model: body.model, task: modelRow.task,
            status: 200,
            tokensIn, tokensOut, neurons,
            durationMs: Date.now() - start,
            cached: false,
          });
          if (chatIdParam) {
            await persistChatMessage(env, chatIdParam, userId, body, bufferedContent, tokensIn, tokensOut, neurons);
          }
        } catch (e) {
          console.error('post-stream persist/audit failed', e);
        }
      });
      c.executionCtx.waitUntil(postWork);
    }

    return new Response(passthrough, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'x-completion-id': completionId,
      },
    });
  }

  // 9. Sync
  let aiOut: Record<string, unknown>;
  try {
    aiOut = await runner(env, body.model, waiInput) as Record<string, unknown>;
  } catch (e: unknown) {
    const failure = classifyUpstreamError(e);
    await audit(env, {
      userId, apiKeyId,
      endpoint: '/v1/chat/completions',
      model: body.model, task: modelRow.task,
      status: failure.status, durationMs: Date.now() - start, error: failure.message,
    });
    return c.json({ error: { type: failure.type, message: failure.message } }, failure.status);
  }

  const completionId = `chatcmpl-${nanoid(12)}`;
  const response = waiToChat(aiOut, body.model, completionId);

  const tokensIn = response.usage.prompt_tokens;
  const tokensOut = response.usage.completion_tokens;
  const neurons = typeof response.usage.neurons === 'number'
    ? response.usage.neurons
    : estimateNeurons(modelRow, tokensIn, tokensOut);

  await chargeQuota(env, neurons);
  await audit(env, {
    userId, apiKeyId,
    endpoint: '/v1/chat/completions',
    model: body.model, task: modelRow.task,
    status: 200,
    tokensIn, tokensOut, neurons,
    durationMs: Date.now() - start,
    cached: false,
  });

  if (chatIdParam) {
    await persistChatMessage(env, chatIdParam, userId, body, response.choices[0]?.message.content ?? '', tokensIn, tokensOut, neurons);
  }

  // Store in response cache if requested
  if (body.cache === true) {
    await store(env, body.model, body as unknown as Record<string, unknown>, JSON.stringify(response));
  }

  return c.json(response);
}

async function persistChatMessage(
  env: Env,
  chatId: string,
  userId: string,
  body: ChatCompletionRequest,
  assistantContent: string,
  tokensIn: number,
  tokensOut: number,
  neurons: number
): Promise<void> {
  const now = Date.now();
  const lastUser = [...body.messages].reverse().find((m) => m.role === 'user');
  const lastUserText = lastUser
    ? (typeof lastUser.content === 'string' ? lastUser.content : JSON.stringify(lastUser.content))
    : '';

  // Ensure chat exists
  const chat = await env.DB.prepare('SELECT id FROM chats WHERE id = ? AND user_id = ?')
    .bind(chatId, userId)
    .first<{ id: string }>();
  if (!chat) {
    const TITLE_MAX = 60;
    const cleaned = lastUserText.replace(/\s+/g, ' ').trim();
    const title = cleaned.length > TITLE_MAX ? cleaned.slice(0, TITLE_MAX).trimEnd() + '…' : (cleaned || null);
    await env.DB.prepare(
      'INSERT INTO chats (id, user_id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(chatId, userId, title, body.model, now, now).run();
  } else {
    await env.DB.prepare('UPDATE chats SET updated_at = ?, model = ? WHERE id = ? AND user_id = ?').bind(now, body.model, chatId, userId).run();
  }

  // Persist last user message
  if (lastUser) {
    await env.DB.prepare(
      'INSERT INTO chat_messages (id, chat_id, role, content, tokens_in, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(nanoid(12), chatId, 'user', typeof lastUser.content === 'string' ? lastUser.content : JSON.stringify(lastUser.content), tokensIn, now).run();
  }

  // Persist assistant message
  await env.DB.prepare(
    'INSERT INTO chat_messages (id, chat_id, role, content, tokens_out, neurons, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(nanoid(12), chatId, 'assistant', assistantContent, tokensOut, neurons, now).run();
}
