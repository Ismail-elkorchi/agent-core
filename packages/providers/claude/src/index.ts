import type { BearerTokenProvider } from '@agent-core/auth';
import { parseJsonObject, type JsonObject } from '@agent-core/json';
import {
  ModelContractError,
  ModelProviderError,
  assertModelRequestSupported,
  assertProviderContextCompatible,
  compileModelRequest,
  conservativeProtocolCapabilities,
  createProviderContextState,
  modelOutputToInput,
  modelTransportSignal,
  parseModelProfile,
  parseModelRequest,
  parseModelResponse,
  requiredProtocolRevision,
  type CompiledModelRequest,
  type ModelContentPart,
  type ModelInputItem,
  type ModelOutputItem,
  type ModelProfile,
  type ModelProvider,
  type ModelProviderSession,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamEvent,
  type ModelToolCall,
  type ModelTransportOptions,
  type ModelUsage
} from '@agent-core/model';
import {
  readBoundedJsonResponse,
  readBoundedResponseText,
  readJsonSseEvents
} from '@agent-core/provider-openai-responses';

export type ClaudeModelProfileDefinition = Omit<ModelProfile, 'id' | 'provider'>;
export interface ClaudeProviderOptions {
  readonly apiKey?: string;
  readonly auth?: BearerTokenProvider;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly fetch?: typeof fetch;
  readonly modelProfiles?: Readonly<Record<string, ClaudeModelProfileDefinition>>;
  readonly defaultOutputTokens?: number;
  readonly countTokens?: boolean;
  readonly maxConcurrentCounts?: number;
}
/** Native Messages; no developer-role promotion or OpenAI-compatible thinking reconstruction. */
export class ClaudeProvider implements ModelProvider {
  readonly id = 'claude';
  readonly implementationId = 'agent-core.provider.claude-messages@1';
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly compiledRequests = new WeakMap<ModelRequest, CompiledModelRequest>();
  private counting = 0;
  constructor(private readonly options: ClaudeProviderOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'https://api.anthropic.com/v1').replace(/\/+$/u, '');
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    if (
      options.defaultOutputTokens !== undefined &&
      (!Number.isSafeInteger(options.defaultOutputTokens) || options.defaultOutputTokens < 1)
    )
      throw new RangeError('defaultOutputTokens must be positive.');
    if (
      options.maxConcurrentCounts !== undefined &&
      (!Number.isSafeInteger(options.maxConcurrentCounts) || options.maxConcurrentCounts < 1)
    )
      throw new RangeError('maxConcurrentCounts must be positive.');
  }
  describe() {
    return {
      id: this.id,
      displayName: 'Claude Messages',
      defaultModel: this.options.model ?? 'claude-sonnet-4-6'
    };
  }
  describeModel(model: string): Promise<ModelProfile> {
    const definition = this.options.modelProfiles?.[model];
    if (!definition && model !== 'claude-sonnet-4-6')
      return Promise.reject(
        this.error(
          'model_unavailable',
          `No verified Claude profile for ${model}; supply an exact model profile.`
        )
      );
    const protocol = conservativeProtocolCapabilities(`${this.baseUrl}/messages`, {
      reasoningAccounting: 'included_output',
      revision: 'claude-messages-2026-09-07-v1',
      roles: ['system', 'user', 'assistant'],
      inputKinds: ['text', 'image', 'document', 'tool_call', 'tool_result', 'protocol'],
      outputKinds: ['text', 'tool_call', 'protocol', 'refusal'],
      state: 'exact',
      counting: this.options.countTokens ? 'provider' : 'estimate'
    });
    return Promise.resolve(
      parseModelProfile({
        id: model,
        provider: this.id,
        capabilities: {
          streaming: true,
          toolCalling: true,
          supportedToolInputs: [{ kind: 'json' }],
          jsonMode: false,
          jsonSchema: false,
          logprobs: false,
          temperature: true,
          topP: true,
          reasoning: { strategies: ['budget'], canDisable: true, separateOutput: true },
          protocol
        },
        modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
        limits: {},
        supportedParameters: ['tools', 'temperature', 'topP', 'maxOutputTokens', 'reasoning'],
        ...definition,
        ...(definition
          ? {
              capabilities: {
                ...definition.capabilities,
                protocol: definition.capabilities.protocol ?? protocol
              }
            }
          : {})
      })
    );
  }
  async compileRequest(request: ModelRequest): Promise<CompiledModelRequest> {
    try {
      request = parseModelRequest(request);
      request.signal?.throwIfAborted();
      const cached = this.compiledRequests.get(request);
      if (cached) return cached;
      const profile = await this.describeModel(request.model);
      assertModelRequestSupported(profile, request);
      for (const [index, item] of request.messages.entries())
        if (item.role === 'protocol')
          await assertProviderContextCompatible(
            item.state,
            request,
            `${this.baseUrl}/messages`,
            request.messages.slice(0, index),
            this.id,
            requiredProtocolRevision(await this.describeModel(request.model))
          );
      const body = claudeRequest(request, this.options.defaultOutputTokens ?? 4096);
      const tokens = this.options.countTokens ? await this.countInput(body, request.signal) : undefined;
      const compiled = await compileModelRequest({
        request,
        profile,
        body,
        payloadPaths: claudePayloadPaths(body),
        endpoint: `${this.baseUrl}/messages`,
        outputReservation: Number(body.max_tokens),
        ...(tokens === undefined ? {} : { providerInputTokens: tokens })
      });
      this.compiledRequests.set(compiled.logicalRequest, compiled);
      return compiled;
    } catch (error) {
      throw this.normalize(error, request.signal);
    }
  }
  createSession(): ModelProviderSession {
    return {
      complete: (request) => this.complete(request),
      stream: (request) => this.stream(request),
      completeCompiled: (request, options) => this.completeCompiled(request, options),
      streamCompiled: (request, options) => this.streamCompiled(request, options)
    };
  }
  async complete(request: ModelRequest): Promise<ModelResponse> {
    return this.completeCompiled(await this.compileRequest(request));
  }
  async completeCompiled(
    compiled: CompiledModelRequest,
    options?: ModelTransportOptions
  ): Promise<ModelResponse> {
    this.assertCompiled(compiled);
    const signal = modelTransportSignal(compiled.logicalRequest, options);
    try {
      const response = await this.post('/messages', { ...compiled.body, stream: false }, signal);
      return await this.decodeResponse(compiled.logicalRequest, await readBoundedJsonResponse(response));
    } catch (error) {
      throw this.normalize(error, signal);
    }
  }
  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    yield* this.streamCompiled(await this.compileRequest(request));
  }
  async *streamCompiled(
    compiled: CompiledModelRequest,
    options?: ModelTransportOptions
  ): AsyncIterable<ModelStreamEvent> {
    this.assertCompiled(compiled);
    const request = compiled.logicalRequest;
    const signal = modelTransportSignal(request, options);
    try {
      const response = await this.post('/messages', { ...compiled.body, stream: true }, signal);
      if (!response.body) throw this.error('malformed_response', 'Claude stream has no body.');
      let message: JsonObject | undefined;
      const blocks = new Map<number, Record<string, unknown>>();
      const inputs = new Map<number, string>();
      const stopped = new Set<number>();
      let content = '';
      let summary = '';
      let ended = false;
      for await (const event of readJsonSseEvents(response.body, {
        ...(signal ? { signal: signal } : {}),
        statusIntervalMs: 15_000,
        idleTimeoutMs: 120_000,
        decodeData: parseJsonObject,
        createMalformedError: (message) => this.error('malformed_response', message)
      })) {
        signal?.throwIfAborted();
        if (event.type === 'status') {
          yield { type: 'status', message: 'Waiting for Claude stream data.' };
          continue;
        }
        if (event.type !== 'data' || event.data === '[DONE]') continue;
        const part = event.data;
        if (part.type === 'ping') continue;
        if (part.type === 'error')
          throw this.error('provider_unavailable', 'Claude stream returned an error.');
        if (part.type === 'message_start') {
          if (message) throw this.error('malformed_response', 'Duplicate Claude message_start.');
          message = parseJsonObject(part.message);
          continue;
        }
        if (!message)
          throw this.error('malformed_response', 'Claude stream item arrived before message_start.');
        if (part.type === 'content_block_start') {
          const index = blockIndex(part.index);
          if (blocks.has(index)) throw this.error('malformed_response', 'Duplicate content block.');
          blocks.set(index, { ...parseJsonObject(part.content_block) });
          continue;
        }
        if (part.type === 'content_block_delta') {
          const index = blockIndex(part.index);
          const block = blocks.get(index);
          if (!block || stopped.has(index))
            throw this.error('malformed_response', 'Delta has no active content block.');
          const delta = parseJsonObject(part.delta);
          if (delta.type === 'text_delta' && block.type === 'text' && typeof delta.text === 'string') {
            block.text = `${typeof block.text === 'string' ? block.text : ''}${delta.text}`;
            content += delta.text;
            if (delta.text) yield { type: 'content', content: delta.text, accumulated: content };
          } else if (
            delta.type === 'thinking_delta' &&
            block.type === 'thinking' &&
            typeof delta.thinking === 'string'
          ) {
            block.thinking = `${typeof block.thinking === 'string' ? block.thinking : ''}${delta.thinking}`;
            summary += delta.thinking;
            if (delta.thinking)
              yield {
                type: 'reasoning',
                reasoning: delta.thinking,
                accumulatedReasoning: summary,
                channel: 'summary'
              };
          } else if (
            delta.type === 'signature_delta' &&
            block.type === 'thinking' &&
            typeof delta.signature === 'string'
          )
            block.signature = `${typeof block.signature === 'string' ? block.signature : ''}${delta.signature}`;
          else if (
            delta.type === 'input_json_delta' &&
            block.type === 'tool_use' &&
            typeof delta.partial_json === 'string'
          )
            inputs.set(index, `${inputs.get(index) ?? ''}${delta.partial_json}`);
          else throw this.error('malformed_response', 'Unknown or incompatible Claude content delta.');
          continue;
        }
        if (part.type === 'content_block_stop') {
          const index = blockIndex(part.index);
          const block = blocks.get(index);
          if (!block || stopped.has(index))
            throw this.error('malformed_response', 'Invalid content_block_stop.');
          const input = inputs.get(index);
          if (input !== undefined) block.input = parseJsonObject(JSON.parse(input) as unknown);
          stopped.add(index);
          if (block.type === 'tool_use') yield { type: 'tool_call', toolCall: claudeToolCall(block) };
          continue;
        }
        if (part.type === 'message_delta') {
          message = parseJsonObject({
            ...message,
            ...parseJsonObject(part.delta),
            ...(part.usage
              ? { usage: { ...parseJsonObject(message.usage), ...parseJsonObject(part.usage) } }
              : {})
          });
          continue;
        }
        if (part.type === 'message_stop') {
          if (blocks.size !== stopped.size)
            throw this.error('malformed_response', 'Claude stopped with unfinished content blocks.');
          ended = true;
          break;
        }
        throw this.error(
          'malformed_response',
          `Unknown required Claude stream event: ${typeof part.type === 'string' ? part.type : 'invalid'}.`
        );
      }
      if (!ended || !message)
        throw this.error('malformed_response', 'Claude stream disconnected before message_stop.');
      const ordered = Array.from(blocks.entries()).sort(([a], [b]) => a - b);
      if (ordered.some(([index], position) => index !== position))
        throw this.error('malformed_response', 'Claude content block sequence has gaps.');
      yield {
        type: 'done',
        response: await this.decodeResponse(request, {
          ...message,
          content: ordered.map(([, block]) => block)
        })
      };
    } catch (error) {
      throw this.normalize(error, signal);
    }
  }
  private async decodeResponse(request: ModelRequest, value: unknown): Promise<ModelResponse> {
    const payload = parseJsonObject(value);
    if (
      payload.type !== 'message' ||
      typeof payload.id !== 'string' ||
      typeof payload.model !== 'string' ||
      !Array.isArray(payload.content) ||
      typeof payload.stop_reason !== 'string'
    )
      throw this.error('malformed_response', 'Claude returned a malformed or nonterminal message.');
    const output: ModelOutputItem[] = [];
    const calls: ModelToolCall[] = [];
    let content = '';
    let reasoningSummary = '';
    for (const raw of payload.content) {
      const block = parseJsonObject(raw);
      if (block.type === 'text' && typeof block.text === 'string') {
        content += block.text;
        output.push({ type: 'text', text: block.text });
      } else if (block.type === 'tool_use') {
        const toolCall = claudeToolCall(block);
        calls.push(toolCall);
        output.push({ type: 'tool_call', toolCall });
      } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
        if (
          block.type === 'thinking' &&
          (typeof block.thinking !== 'string' || typeof block.signature !== 'string' || !block.signature)
        )
          throw this.error('malformed_response', 'Claude thinking block lacks its original signature.');
        if (block.type === 'redacted_thinking' && (typeof block.data !== 'string' || !block.data))
          throw this.error('malformed_response', 'Claude redacted thinking lacks data.');
        if (typeof block.thinking === 'string') reasoningSummary += block.thinking;
        output.push({
          type: 'protocol',
          state: await createProviderContextState({
            protocolRevision: requiredProtocolRevision(await this.describeModel(request.model)),
            provider: this.id,
            endpoint: `${this.baseUrl}/messages`,
            request: { ...request, messages: [...request.messages, ...modelOutputToInput(output)] },
            requestId: payload.id,
            kind: 'claude.thinking',
            data: { block }
          })
        });
      } else
        throw this.error(
          'malformed_response',
          `Unsupported required Claude content block: ${typeof block.type === 'string' ? block.type : 'invalid'}.`
        );
    }
    const termination =
      payload.stop_reason === 'tool_use'
        ? 'tool_calls'
        : payload.stop_reason === 'max_tokens'
          ? 'output_limit'
          : payload.stop_reason === 'refusal'
            ? 'content_filter'
            : ['end_turn', 'stop_sequence'].includes(payload.stop_reason)
              ? 'stop'
              : 'unknown';
    return parseModelResponse({
      provider: this.id,
      model: payload.model,
      requestId: payload.id,
      content,
      output,
      terminationReason: termination,
      providerTerminationReason: payload.stop_reason,
      ...(calls.length ? { toolCalls: calls } : {}),
      ...(reasoningSummary ? { reasoningSummary } : {}),
      usage: claudeUsage(payload.usage)
    });
  }
  private async countInput(
    body: Record<string, unknown>,
    signal: AbortSignal | undefined
  ): Promise<number> {
    if (this.counting >= (this.options.maxConcurrentCounts ?? 2))
      throw this.error('rate_limited', 'Claude token-count concurrency limit reached.');
    this.counting++;
    try {
      const countBody = { ...body };
      delete countBody.max_tokens;
      delete countBody.temperature;
      delete countBody.top_p;
      const response = await this.post('/messages/count_tokens', countBody, signal);
      const result = parseJsonObject(await readBoundedJsonResponse(response));
      if (
        typeof result.input_tokens !== 'number' ||
        !Number.isSafeInteger(result.input_tokens) ||
        result.input_tokens < 0
      )
        throw this.error('malformed_response', 'Invalid Claude token count.');
      return result.input_tokens;
    } finally {
      this.counting--;
    }
  }
  private async post(
    path: string,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined
  ): Promise<Response> {
    signal?.throwIfAborted();
    const key = this.options.auth
      ? (await this.options.auth.getBearerToken(signal)).token
      : this.options.apiKey;
    if (!key) throw this.error('invalid_request', 'Claude requires explicit API credentials.');
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {})
    });
    if (!response.ok) {
      await readBoundedResponseText(response);
      throw this.error(
        response.status === 429
          ? 'rate_limited'
          : response.status >= 500
            ? 'provider_unavailable'
            : 'invalid_request',
        `Claude HTTP ${String(response.status)}.`
      );
    }
    return response;
  }
  private assertCompiled(compiled: CompiledModelRequest): void {
    if (this.compiledRequests.get(compiled.logicalRequest) !== compiled)
      throw this.error('invalid_request', 'Unrecognized Claude compiled request.');
  }
  private error(
    code: ConstructorParameters<typeof ModelProviderError>[0]['code'],
    message: string
  ): ModelProviderError {
    return new ModelProviderError({ provider: this.id, code, message });
  }
  private normalize(error: unknown, signal?: AbortSignal): ModelProviderError {
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError'))
      return this.error('aborted', 'Claude request aborted.');
    if (error instanceof ModelProviderError) return error;
    return this.error(
      error instanceof ModelContractError ? 'invalid_request' : 'malformed_response',
      error instanceof Error ? error.message : 'Claude request failed.'
    );
  }
}
function claudeRequest(request: ModelRequest, defaultOutput: number): Record<string, unknown> {
  const system: unknown[] = [];
  const messages: { role: 'user' | 'assistant'; content: unknown[] }[] = [];
  const append = (role: 'user' | 'assistant', content: unknown[]) => {
    const previous = messages.at(-1);
    if (previous?.role === role) previous.content.push(...content);
    else messages.push({ role, content });
  };
  for (const item of request.messages) {
    if (item.role === 'developer' || item.role === 'control')
      throw new ModelProviderError({
        provider: 'claude',
        code: 'invalid_request',
        message: `Claude cannot preserve the ${item.role} authority channel.`
      });
    if (item.role === 'protocol') {
      if (item.state.kind !== 'claude.thinking')
        throw new ModelProviderError({
          provider: 'claude',
          code: 'invalid_request',
          message: 'Unsupported Claude protocol state.'
        });
      append('assistant', [parseJsonObject(item.state.data.block)]);
      continue;
    }
    const content = claudeContent(item);
    if (item.role === 'system') {
      if (messages.length)
        throw new ModelProviderError({
          provider: 'claude',
          code: 'invalid_request',
          message:
            'Claude system instructions must precede conversation; moving later instructions would change causality.'
        });
      system.push(...content);
    } else if (item.role === 'tool') {
      if (!item.toolCallId || item.toolCallType !== 'function')
        throw new ModelProviderError({
          provider: 'claude',
          code: 'invalid_request',
          message: 'Claude tool results require an original function call ID.'
        });
      append('user', [{ type: 'tool_result', tool_use_id: item.toolCallId, content }]);
    } else {
      if (item.role === 'assistant')
        for (const call of item.toolCalls ?? []) {
          if (!call.id || call.type !== 'function')
            throw new ModelProviderError({
              provider: 'claude',
              code: 'invalid_request',
              message: 'Claude requires an identified JSON tool call.'
            });
          content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input.value });
        }
      append(item.role, content);
    }
  }
  const body: Record<string, unknown> = {
    model: request.model,
    max_tokens: request.maxOutputTokens ?? defaultOutput,
    messages,
    ...(system.length ? { system } : {})
  };
  if (request.tools?.length)
    body.tools = request.tools.map((tool) => {
      if (tool.type !== 'function' || tool.async)
        throw new ModelProviderError({
          provider: 'claude',
          code: 'invalid_request',
          message: 'Claude reference adapter requires synchronous JSON tools.'
        });
      return {
        name: tool.function.name,
        ...(tool.function.description ? { description: tool.function.description } : {}),
        input_schema: tool.function.parameters ?? { type: 'object', properties: {} }
      };
    });
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.topP !== undefined) body.top_p = request.topP;
  if (request.reasoning?.strategy === 'disabled') body.thinking = { type: 'disabled' };
  else if (request.reasoning) {
    if (
      request.reasoning.strategy !== 'budget' ||
      request.reasoning.maxTokens < 1024 ||
      request.reasoning.maxTokens >= Number(body.max_tokens) ||
      request.temperature !== undefined ||
      request.topP !== undefined
    )
      throw new ModelProviderError({
        provider: 'claude',
        code: 'invalid_request',
        message: 'Claude manual thinking needs a budget >= 1024 below max output and no sampling controls.'
      });
    body.thinking = { type: 'enabled', budget_tokens: request.reasoning.maxTokens };
  }
  return body;
}
function claudeContent(item: ModelInputItem): unknown[] {
  return [
    ...(item.content ? [{ type: 'text', text: item.content }] : []),
    ...(item.images ?? []).map((image) => claudePart({ type: 'image', image })),
    ...(item.parts ?? []).map(claudePart)
  ];
}
function claudePart(part: ModelContentPart): unknown {
  if (part.type === 'text') return { type: 'text', text: part.text };
  if (part.type === 'image')
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: part.image.mediaType,
        data:
          part.image.type === 'base64' ? part.image.data : Buffer.from(part.image.data).toString('base64')
      }
    };
  if (part.type === 'document' && part.source.type !== 'file')
    return {
      type: 'document',
      source:
        part.source.type === 'url'
          ? { type: 'url', url: part.source.value }
          : { type: 'base64', media_type: part.mediaType, data: part.source.value }
    };
  throw new ModelProviderError({
    provider: 'claude',
    code: 'invalid_request',
    message: `Unsupported Claude media: ${part.type}.`
  });
}
function claudeToolCall(block: Readonly<Record<string, unknown>>): ModelToolCall {
  if (typeof block.id !== 'string' || !block.id || typeof block.name !== 'string' || !block.name)
    throw new Error('Claude tool_use is missing its identity.');
  return {
    type: 'function',
    id: block.id,
    name: block.name,
    input: { kind: 'json', value: parseJsonObject(block.input) }
  };
}
function claudeUsage(value: unknown): ModelUsage {
  const usage = parseJsonObject(value);
  for (const key of [
    'input_tokens',
    'output_tokens',
    'cache_read_input_tokens',
    'cache_creation_input_tokens'
  ])
    if (
      (key === 'input_tokens' || key === 'output_tokens' || usage[key] !== undefined) &&
      (typeof usage[key] !== 'number' || !Number.isSafeInteger(usage[key]) || usage[key] < 0)
    )
      throw new Error('Malformed Claude usage.');
  const read = Number(usage.cache_read_input_tokens ?? 0);
  const write = Number(usage.cache_creation_input_tokens ?? 0);
  const input = Number(usage.input_tokens) + read + write;
  const output = Number(usage.output_tokens);
  return {
    promptTokens: input,
    completionTokens: output,
    totalTokens: input + output,
    ...(read ? { cacheReadTokens: read } : {}),
    ...(write ? { cacheWriteTokens: write } : {})
  };
}
function blockIndex(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('Invalid Claude block index.');
  return value;
}

function claudePayloadPaths(body: Record<string, unknown>): readonly (readonly (string | number)[])[] {
  const paths: (string | number)[][] = [];
  if (!Array.isArray(body.messages)) return paths;
  const visit = (value: unknown, path: (string | number)[]): void => {
    if (!Array.isArray(value)) return;
    for (const [index, raw] of (value as unknown[]).entries()) {
      const block = parseJsonObject(raw);
      if (block.type === 'thinking' || block.type === 'redacted_thinking') paths.push([...path, index]);
      else if (block.type === 'image' || block.type === 'document') paths.push([...path, index, 'source']);
      else if (block.type === 'tool_result') visit(block.content, [...path, index, 'content']);
    }
  };
  for (const [index, raw] of (body.messages as unknown[]).entries())
    visit(parseJsonObject(raw).content, ['messages', index, 'content']);
  return paths;
}
