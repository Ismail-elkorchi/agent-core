import { ModelProviderError } from '@agent-core/model';
import {
  decodeHttpFailure,
  readBoundedResponseText,
  retryAfterDeadline,
  waitForResponseOrStatus
} from '@agent-core/provider-openai-responses';

export async function requestOllama(
  fetch: typeof globalThis.fetch,
  url: string,
  body?: object,
  signal?: AbortSignal
): Promise<Response> {
  signal?.throwIfAborted();
  const response = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal === undefined ? {} : { signal })
  });
  if (response.ok) return response;
  const retryNotBefore = retryAfterDeadline(response.headers.get('retry-after'));
  const { text, truncated } = await readBoundedResponseText(response);
  const failure = decodeHttpFailure(response.status, text);
  throw new ModelProviderError({
    provider: 'ollama',
    ...failure,
    message: `Ollama HTTP ${String(response.status)}: ${failure.message}`,
    ...(retryNotBefore === undefined ? {} : { retryNotBefore }),
    diagnostic: {
      transport: 'http',
      causeSummary: { status: response.status, ...(truncated ? { bodyTruncated: true } : {}) }
    }
  });
}

/** Each wire record is bounded independently; total generated output is governed by inference. */
export async function* readOllamaStream(
  response: Response,
  signal?: AbortSignal
): AsyncIterable<unknown> {
  if (!response.body) throw malformed('Ollama response has no body.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const maximum = 4 * 1024 * 1024;
  let buffer = '';
  let bytes = 0;
  let finished = false;
  const append = (chunk: Uint8Array) => {
    bytes += chunk.byteLength;
    if (bytes > maximum)
      throw malformed(`Ollama response frame exceeded ${String(maximum)} bytes.`);
    try {
      buffer += decoder.decode(chunk, { stream: true });
    } catch {
      throw malformed('Ollama response contains invalid UTF-8.');
    }
  };
  const finishLine = (): unknown => {
    try {
      buffer += decoder.decode();
    } catch {
      throw malformed('Ollama response contains incomplete UTF-8.');
    }
    const line = buffer;
    buffer = '';
    bytes = 0;
    if (line.trim().length === 0) return undefined;
    try {
      return JSON.parse(line) as unknown;
    } catch {
      // JSON parser errors can contain response content. Do not send it to logs or diagnostics.
      throw malformed('Ollama response contains invalid JSON.');
    }
  };
  try {
    for (;;) {
      signal?.throwIfAborted();
      const result = await waitForResponseOrStatus(reader.read(), undefined, signal);
      if (result.type !== 'response') continue;
      if (result.response.done) {
        finished = true;
        break;
      }
      const chunk = result.response.value;
      let start = 0;
      for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
        append(chunk.subarray(start, end));
        const value = finishLine();
        if (value !== undefined) yield value;
        signal?.throwIfAborted();
        start = end + 1;
      }
      append(chunk.subarray(start));
    }
    const value = finishLine();
    if (value !== undefined) yield value;
  } finally {
    if (!finished) {
      try {
        await reader.cancel('Ollama response consumption ended.');
      } catch {
        /* Preserve the original transport outcome. */
      }
    }
    reader.releaseLock();
  }
}

function malformed(message: string): ModelProviderError {
  return new ModelProviderError({ provider: 'ollama', code: 'malformed_response', message });
}
