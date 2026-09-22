import { supportsAudioFile, LIVE_AUDIO_MESSAGE } from '@vibeflare/shared';
import { estimateTokens } from '../ai/neurons';
import { arrayBufferToBase64, base64ToArrayBuffer } from '../util/base64';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | { type: string; text?: string; image_url?: { url: string } }[];
  tool_calls?: unknown[];
  tool_call_id?: string;
  name?: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  tools?: unknown[];
  tool_choice?: unknown;
  cache?: boolean;
  chat_id?: string;
  system_id?: string;
  [key: string]: unknown;
}

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: {
    index: number;
    message: { role: 'assistant'; content: string | null; tool_calls?: unknown[] };
    finish_reason: string;
  }[];
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number; neurons?: number };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function imageUrlToBytes(url: string): Promise<ArrayBuffer> {
  if (url.startsWith('data:')) {
    // data:<mime>;base64,<data>
    const comma = url.indexOf(',');
    const b64 = url.slice(comma + 1);
    return base64ToArrayBuffer(b64);
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`image fetch failed: ${res.status}`);
  return res.arrayBuffer();
}

function extractTextContent(msg: ChatMessage): string {
  if (typeof msg.content === 'string') return msg.content;
  return msg.content
    .filter((p) => p.type === 'text')
    .map((p) => p.text ?? '')
    .join('');
}

// ── Chat ─────────────────────────────────────────────────────────────────────

export async function chatToWai(
  req: ChatCompletionRequest,
  modelTask: string
): Promise<Record<string, unknown>> {
  if (modelTask === 'image-to-text') {
    // Find first image_url part across all messages
    for (const msg of req.messages) {
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'image_url' && part.image_url) {
            const image = await imageUrlToBytes(part.image_url.url);
            const prompt = req.messages
              .map(extractTextContent)
              .filter(Boolean)
              .join('\n');
            return { image: [...new Uint8Array(image)], prompt };
          }
        }
      }
    }
  }

  // Standard text-generation
  const messages = req.messages.map((m) => ({
    role: m.role,
    content: extractTextContent(m),
  }));

  const input: Record<string, unknown> = { messages };
  if (req.temperature != null) input.temperature = req.temperature;
  if (req.top_p != null) input.top_p = req.top_p;
  if (req.max_tokens != null) input.max_tokens = req.max_tokens;
  // Workers AI text-generation models do not support tool calling;
  // strip tools/tool_choice so clients (e.g. OpenCode) fall back to plain text
  return input;
}

export function waiToChat(
  out: Record<string, unknown>,
  model: string,
  completionId: string
): ChatCompletionResponse {
  // Newer Workers AI models return a full OpenAI-format response object
  // instead of { response: "..." }. Detect and unwrap both content and finish_reason.
  type OaiMessage = { content?: unknown; reasoning?: unknown };
  type OaiChoices = Array<{ message?: OaiMessage; finish_reason?: string }>;
  const oaiChoices = Array.isArray(out.choices) ? (out.choices as OaiChoices) : null;
  const oaiMessage = oaiChoices?.[0]?.message;

  const content: string =
    typeof out.response === 'string'
      ? out.response
      : typeof out.description === 'string'
        ? out.description
        : oaiMessage?.content != null
          ? String(oaiMessage.content)
          : typeof oaiMessage?.reasoning === 'string'
            ? oaiMessage.reasoning
            : JSON.stringify(out);

  const finishReason =
    oaiChoices?.[0]?.finish_reason ??
    (out.stop_reason as string | undefined) ??
    'stop';

  const usage = out.usage as Record<string, number> | undefined;
  const promptTokens = usage?.prompt_tokens ?? estimateTokens(content);
  const completionTokens = usage?.completion_tokens ?? estimateTokens(content);
  const neurons = typeof usage?.neurons === 'number' && Number.isFinite(usage.neurons)
    ? usage.neurons
    : undefined;

  return {
    id: completionId,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      ...(neurons != null ? { neurons } : {}),
    },
  };
}

export function waiStreamToOpenAISSE(
  stream: ReadableStream,
  model: string,
  completionId: string,
  onUsage?: (usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; neurons?: number }) => void,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const created = Math.floor(Date.now() / 1000);

  function chunk(delta: { content?: string }, finishReason: string | null): string {
    const payload = {
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    return `data: ${JSON.stringify(payload)}\n\n`;
  }

  // Workers AI may return a Response (with .body) or a ReadableStream directly
  const aiBody: ReadableStream<Uint8Array> =
    (stream as unknown as Response).body instanceof ReadableStream
      ? (stream as unknown as Response).body!
      : (stream as ReadableStream<Uint8Array>);

  let reader: ReadableStreamDefaultReader<Uint8Array | string>;
  let started = false;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      reader = aiBody.getReader();

      async function pump() {
        let buffer = '';
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            // WAI may yield string chunks or Uint8Array chunks
            buffer += typeof value === 'string' ? value : decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            // WAI streams SSE format: "data: {...}" or raw JSON lines
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              const isSSE = trimmed.startsWith('data: ');
              const jsonStr = isSSE ? trimmed.slice(6) : trimmed;
              if (jsonStr === '[DONE]') continue;
              let content = '';
              try {
                const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
                if (parsed.usage && typeof parsed.usage === 'object') {
                  onUsage?.(parsed.usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; neurons?: number });
                }
                if (typeof parsed.response === 'string') {
                  content = parsed.response;
                } else if (Array.isArray(parsed.choices)) {
                  type StreamChoice = {
                    delta?: { content?: string; reasoning?: string };
                    message?: { content?: string; reasoning?: string };
                  };
                  const c = (parsed.choices as StreamChoice[])[0];
                  const delta =
                    c?.delta?.content ?? c?.delta?.reasoning ?? c?.message?.content ?? c?.message?.reasoning;
                  if (typeof delta === 'string') content = delta;
                }
              } catch {
                // non-SSE raw text chunk
                if (!isSSE) content = trimmed;
              }
              if (!content) continue;
              if (!started) started = true;
              controller.enqueue(encoder.encode(chunk({ content }, null)));
            }
          }
          // Terminal chunks
          controller.enqueue(encoder.encode(chunk({}, 'stop')));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        } catch (e) {
          // Emit terminal chunks so client gets a clean close even on error
          try {
            controller.enqueue(encoder.encode(chunk({}, 'stop')));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          } catch {
            controller.error(e);
          }
        }
      }

      pump();
    },
    cancel() {
      reader?.cancel();
    },
  });
}

// ── Embeddings ───────────────────────────────────────────────────────────────

export interface EmbeddingRequest {
  model: string;
  input: string | string[];
  encoding_format?: string;
}

export function embedToWai(req: EmbeddingRequest): Record<string, unknown> {
  const text = Array.isArray(req.input) ? req.input : [req.input];
  return { text };
}

export function embedToOpenAI(
  out: Record<string, unknown>,
  model: string,
  offset = 0
): object {
  const data = out.data as number[][] | undefined;
  const embeddings = data ?? [out.result as number[]];
  return {
    object: 'list',
    model,
    data: embeddings.map((vec, i) => ({
      object: 'embedding',
      index: offset + i,
      embedding: vec,
    })),
    usage: { prompt_tokens: 0, total_tokens: 0 },
  };
}

// ── Images ───────────────────────────────────────────────────────────────────

export interface ImageRequest {
  model: string;
  prompt: string;
  n?: number;
  size?: string;
  response_format?: 'url' | 'b64_json';
}

export function imageReqToWai(req: ImageRequest): Record<string, unknown> {
  const input: Record<string, unknown> = { prompt: req.prompt };
  if (req.size) {
    const [w, h] = req.size.split('x');
    if (w && h) {
      input.width = parseInt(w);
      input.height = parseInt(h);
    }
  }
  return input;
}

export async function extractImageBuffer(out: unknown): Promise<ArrayBuffer> {
  let buf: ArrayBuffer;

  if (out instanceof ArrayBuffer) {
    buf = out;
  } else if (out instanceof ReadableStream) {
    buf = await new Response(out as ReadableStream).arrayBuffer();
  } else {
    const rec = out as Record<string, unknown> | null | undefined;
    const raw = rec?.image;
    if (typeof raw === 'string') {
      buf = base64ToArrayBuffer(raw);
    } else if (raw instanceof ArrayBuffer) {
      buf = raw;
    } else {
      throw new Error(`unrecognized image output shape: ${typeof out}`);
    }
  }

  if (buf.byteLength === 0) {
    throw new Error('image model returned empty buffer');
  }

  return buf;
}

export function imageOutToOpenAI(
  out: Record<string, unknown>,
  _model: string,
  url?: string,
  b64?: string
): object {
  if (url) return { url };
  if (b64) return { b64_json: b64 };
  // out.image is ArrayBuffer
  const buf = out.image as ArrayBuffer;
  return { b64_json: arrayBufferToBase64(buf) };
}

// ── STT ──────────────────────────────────────────────────────────────────────

export function sttReqToWai(audio: ArrayBuffer, model = '', mime = 'audio/wav'): Record<string, unknown> {
  if (!supportsAudioFile(model)) throw new Error(LIVE_AUDIO_MESSAGE);
  // Nova-3's HTTP binding requires a binary body + content type, not Whisper's
  // base64/byte-array payload. See Cloudflare's workers-ai-partner-models example.
  if (model === '@cf/deepgram/nova-3') {
    return { audio: { body: new Blob([audio], { type: mime }).stream(), contentType: mime }, detect_language: true };
  }
  if (model === '@cf/openai/whisper-large-v3-turbo') {
    return { audio: arrayBufferToBase64(audio), task: 'transcribe' };
  }
  return { audio: [...new Uint8Array(audio)] };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function normalizeTranscription(out: Record<string, unknown>): { text: string; language?: string; duration?: number; segments?: unknown[] } {
  const info = record(out.transcription_info) ?? record(out.metadata) ?? out;
  let text: string;
  if (typeof out.text === 'string') text = out.text;
  else {
    const channels = record(out.results)?.channels;
    if (!Array.isArray(channels) || channels.length === 0) throw new Error('The model returned an invalid transcript. Try another audio model.');
    text = channels.map(channel => {
      const alternatives = record(channel)?.alternatives;
      const transcript = Array.isArray(alternatives) ? record(alternatives[0])?.transcript : undefined;
      if (typeof transcript !== 'string') throw new Error('The model returned an invalid transcript. Try another audio model.');
      return transcript;
    }).join('\n');
  }
  return {
    text,
    ...(typeof info.language === 'string' ? { language: info.language } : {}),
    ...(typeof info.duration === 'number' && Number.isFinite(info.duration) ? { duration: info.duration } : {}),
    ...(Array.isArray(out.segments) ? { segments: out.segments } : {}),
  };
}

export function sttOutToOpenAI(out: Record<string, unknown>, format: string = 'json'): object {
  const result = normalizeTranscription(out);
  if (format === 'text') return result.text as unknown as object;
  if (format === 'verbose_json') return { task: 'transcribe', language: result.language ?? 'en', duration: result.duration ?? 0, text: result.text, segments: result.segments ?? [] };
  return { text: result.text };
}

// ── TTS ──────────────────────────────────────────────────────────────────────

export interface TtsRequest {
  model: string;
  input: string;
  voice?: string;
  response_format?: string;
  speed?: number;
}

export function ttsReqToWai(req: TtsRequest): Record<string, unknown> {
  const isDeepgram = req.model.includes('aura') || req.model.includes('deepgram');
  const input: Record<string, unknown> = isDeepgram ? { text: req.input } : { prompt: req.input };
  if (req.voice) input.voice = req.voice;
  if (req.speed) input.speed = req.speed;
  return input;
}

export async function ttsOutToBinary(out: unknown): Promise<ArrayBuffer> {
  if (out instanceof ArrayBuffer) return out;
  if (out instanceof ReadableStream) return new Response(out).arrayBuffer();
  if (out instanceof Uint8Array) return out.slice().buffer;

  const record = (out ?? {}) as Record<string, unknown>;
  const audio = record.audio;
  if (audio instanceof ArrayBuffer) return audio;
  if (audio instanceof ReadableStream) return new Response(audio).arrayBuffer();
  if (audio instanceof Uint8Array) return audio.slice().buffer;
  if (typeof audio === 'string') return base64ToArrayBuffer(audio);
  if (Array.isArray(audio) && audio.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)) {
    return new Uint8Array(audio as number[]).buffer;
  }
  throw new Error('unexpected TTS output shape');
}
