import * as z from 'zod';
import type { WebSearchAdapter, WebSearchRequest, WebTransport } from './contracts.js';
import { WebRequestError } from './contracts.js';
import { validateWebResponse } from './capture.js';

const responseSchema = z.object({
  query: z.object({ more_results_available: z.boolean().optional() }),
  web: z.object({ results: z.array(z.object({ title: z.string().max(10_000), url: z.string().max(4096), description: z.string().max(20_000).optional() })).max(100) }).optional()
});
/** Brave GET web-search adapter. The API key remains in this closure and is never part of a tool input. */
export function createBraveSearchAdapter(options: { readonly apiKey: string; readonly transport: WebTransport }): WebSearchAdapter {
  if (!options.apiKey.trim() || /[\r\n\0]/u.test(options.apiKey) || options.apiKey.length > 4096) throw new TypeError('A valid Brave Search API key is required.');
  const apiKey = options.apiKey;
  const transport = options.transport;
  return Object.freeze({ id: 'brave.web-search.v1', origin: 'https://api.search.brave.com', transportId: transport.id, async search(input: WebSearchRequest) {
    if (!input.query.trim() || input.query.length > 600 || input.query.trim().split(/\s+/u).length > 75 || input.page < 0 || input.page > 9 || input.count < 1 || input.count > 20)
      throw new WebRequestError('invalid_response', 'Search parameters exceed the Brave API bounds.');
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', input.query);
    url.searchParams.set('count', String(input.count));
    url.searchParams.set('offset', String(input.page));
    const response = validateWebResponse(await transport.get({ url: url.href, limits: input.limits, signal: input.signal,
      headers: { accept: 'application/json', 'x-subscription-token': apiKey } }), input.limits);
    if (response.status !== 200) throw new WebRequestError('http_error', `Brave Search returned HTTP ${String(response.status)}; no page results were read.`, response.status);
    let decoded: z.infer<typeof responseSchema>;
    try { decoded = responseSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.body))); }
    catch { throw new WebRequestError('invalid_response', 'Brave Search returned an invalid response.'); }
    const results = (decoded.web?.results ?? []).slice(0, input.count).flatMap(hit => {
      // Search may return non-HTTPS links. Keep them as discovered references; retrieval has its own stricter policy.
      let target: URL;
      try { target = new URL(hit.url); } catch { return []; }
      if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) return [];
      return [{ title: scalarSlice(hit.title, 1000), url: target.href, snippet: scalarSlice(hit.description ?? '', 4000) }];
    });
    return Object.freeze({ results: Object.freeze(results), moreResults: decoded.query.more_results_available === true });
  } });
}
function scalarSlice(value: string, maximum: number): string {
  const limit = Math.min(value.length, maximum);
  return value.slice(0, limit > 0 && /[\uD800-\uDBFF]/u.test(value.charAt(limit - 1)) ? limit - 1 : limit);
}
