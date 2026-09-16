export const CLOUDFLARE_MODELS_URL = 'https://developers.cloudflare.com/workers-ai/models/';
export const CLOUDFLARE_PRICING_URL = 'https://developers.cloudflare.com/workers-ai/platform/pricing/index.md';

export interface PublicCatalogModel {
  name: string;
  task: string;
  author: string | null;
  href: string | null;
  capabilities: string[];
  pricing: string | null;
  neuronsInput: number | null;
  neuronsOutput: number | null;
  paidRequired: boolean | null;
}

function decodeHtml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCharCode(Number(code)));
}

function attr(source: string, name: string): string | null {
  const match = source.match(new RegExp(`data-${name}="([^"]*)"`));
  return match ? decodeHtml(match[1]!) : null;
}

export function normalizeCloudflareTask(task: string): string {
  return task.trim().toLowerCase().replace(/\s+/g, '-');
}

interface TokenNeuronRates {
  input: number | null;
  output: number | null;
  raw: string;
}

/**
 * Cloudflare explicitly lists models that require a paid billing method in the
 * public pricing markdown. Reading this metadata is free and avoids synthetic
 * inference probes that would consume neurons.
 */
export function parsePaidRequiredModels(markdown: string): Set<string> {
  const result = new Set<string>();
  const paragraph = markdown.replace(/\r\n/g, '\n').match(/Some\s+models\s+require\s+a\s+paid\s+billing\s+method\.[\s\S]*?(?=\n\s*\n|$)/i)?.[0] ?? '';
  for (const match of paragraph.matchAll(/`(@[^`\s]+\/[^`\s]+)`/g)) {
    result.add(match[1]!);
  }
  return result;
}

export function parseNeuronPricing(markdown: string): Map<string, TokenNeuronRates> {
  const rates = new Map<string, TokenNeuronRates>();
  for (const line of markdown.split('\n')) {
    const row = line.match(/^\|\s*(@[^|\s]+\/[^|\s]+)\s*\|[^|]*\|\s*([^|]+)\|/);
    if (!row) continue;
    const name = row[1]!;
    const raw = row[2]!.trim();
    const inputMatch = raw.match(/([\d,.]+)\s+neurons per M input tokens/i);
    const outputMatch = raw.match(/([\d,.]+)\s+neurons per M output tokens/i);
    const toPerToken = (match: RegExpMatchArray | null) => {
      if (!match) return null;
      const value = Number(match[1]!.replace(/,/g, ''));
      return Number.isFinite(value) ? value / 1_000_000 : null;
    };
    rates.set(name, {
      input: toPerToken(inputMatch),
      output: toPerToken(outputMatch),
      raw,
    });
  }
  return rates;
}

export function parseCloudflareModelsHtml(html: string, pricingMarkdown = ''): PublicCatalogModel[] {
  const pricing = parseNeuronPricing(pricingMarkdown);
  const paidRequired = parsePaidRequiredModels(pricingMarkdown);
  const models = new Map<string, PublicCatalogModel>();
  const cell = /<div\s+data-models-cell\s+([^>]+)>/g;
  let match: RegExpExecArray | null;
  while ((match = cell.exec(html)) !== null) {
    const attrs = match[1]!;
    const name = attr(attrs, 'model-id');
    const task = attr(attrs, 'model-task');
    if (!name?.startsWith('@') || !name.includes('/') || !task) continue;
    const rates = pricing.get(name);
    const capabilities = (attr(attrs, 'model-capabilities') ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    models.set(name, {
      name,
      task: normalizeCloudflareTask(task),
      author: attr(attrs, 'model-author'),
      href: attr(attrs, 'model-href'),
      capabilities,
      pricing: rates?.raw ?? attr(attrs, 'model-pricing'),
      neuronsInput: rates?.input ?? null,
      neuronsOutput: rates?.output ?? null,
      paidRequired: paidRequired.has(name) ? true : paidRequired.size > 0 && pricing.has(name) ? false : null,
    });
  }
  return [...models.values()];
}

export async function fetchCloudflarePublicCatalog(
  fetchImpl: typeof fetch = fetch,
): Promise<PublicCatalogModel[]> {
  const [modelsResponse, pricingResponse] = await Promise.all([
    fetchImpl(CLOUDFLARE_MODELS_URL, { headers: { Accept: 'text/html' } }),
    fetchImpl(CLOUDFLARE_PRICING_URL, { headers: { Accept: 'text/markdown' } }),
  ]);
  if (!modelsResponse.ok) throw new Error(`Cloudflare public model catalog failed: ${modelsResponse.status}`);
  const html = await modelsResponse.text();
  const pricingMarkdown = pricingResponse.ok ? await pricingResponse.text() : '';
  const models = parseCloudflareModelsHtml(html, pricingMarkdown);
  if (models.length === 0) throw new Error('Cloudflare public model catalog returned no models');
  return models;
}
