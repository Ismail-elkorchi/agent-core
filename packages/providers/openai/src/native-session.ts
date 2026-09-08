import { isDeepStrictEqual } from 'node:util';
import { NativeResponsesConnection, type OpenAIResponsesWebSocketFactory } from './native-connection.js';
export {
  defaultOpenAIResponsesWebSocketFactory,
  type OpenAIResponsesWebSocket,
  type OpenAIResponsesWebSocketFactory
} from './native-connection.js';
import { nativeFailure as failure, aggregateResponses } from './native-output.js';
import { parseJsonObject, type JsonObject } from '@agent-core/json';
import {
  ModelProviderError,
  assertRequestAccountingFits,
  modelInputIdentity,
  modelOutputToInput,
  modelTransportSignal,
  parseModelRequest,
  parseModelInputItem,
  parseModelNativeToolCallIdentity,
  type CompiledModelRequest,
  type ModelInputItem,
  type ModelProviderSession,
  type ModelRequest,
  type ModelResponse,
  type ModelSteeringDelivery,
  type ModelSteeringSubmission,
  type ModelStreamEvent,
  type ModelToolCall,
  type ModelTransportOptions,
  type ModelNativeDelivery,
  type ModelToolResultSubmission,
  type ModelToolResultDelivery,
  type ModelNativeContinuation,
  type ModelNativeResponseBoundary,
  type ModelNativeToolCallIdentity,
  type ModelNativeDispatch
} from '@agent-core/model';
import {
  decodeResponsesPayload,
  responsesInput,
  responsesOutput
} from '@agent-core/provider-openai-responses';

export interface NativeResponsesHost {
  compileRequest(request: ModelRequest): Promise<CompiledModelRequest>;
  compileNativeFrame(
    request: ModelRequest,
    body: JsonObject,
    retainedBody: JsonObject,
    retainedInputTokenReservation: number
  ): Promise<CompiledModelRequest>;
  assertCompiled(compiled: CompiledModelRequest): void;
  decodeNativeResponse(request: ModelRequest, payload: unknown): Promise<ModelResponse>;
  nativeHeaders(signal?: AbortSignal): Promise<Readonly<Record<string, string>>>;
  nativeSupported(model: string): Promise<boolean>;
  endpoint(): string;
}
interface Submission {
  readonly kind: ModelNativeDispatch['kind'];
  readonly identity: string;
  readonly input: readonly ModelInputItem[];
  readonly sourceCalls: readonly ModelNativeToolCallIdentity[];
  delivery: ModelNativeDelivery & {
    readonly providerEventId?: string;
    readonly requiredToolCallIds?: readonly string[];
  };
  stage: 'admitting' | 'sent' | 'settled';
  compiled?: CompiledModelRequest;
  pending?: boolean;
  admissionFinished?: Promise<void>;
  finishAdmission?: () => void;
}
interface PendingTool {
  readonly call: ModelToolCall;
  readonly source: ModelNativeToolCallIdentity;
  deliveryId?: string;
}
interface ActiveResponse {
  readonly boundary: ModelNativeResponseBoundary;
  readonly body: JsonObject;
  terminal: boolean;
}
export class NativeResponsesSession implements ModelProviderSession {
  private readonly connection: NativeResponsesConnection;
  private readonly submissions = new Map<string, Submission>();
  private readonly deliveryEvents: ModelStreamEvent[] = [];
  private readonly seenCalls = new Map<string, PendingTool>();
  private failure: Error | undefined;
  private active: ActiveResponse | undefined;
  private logical: ModelRequest | undefined;
  private options: ModelTransportOptions | undefined;
  private signal: AbortSignal | undefined;
  private busy = false;
  private admitting = false;
  private readonly pendingTools = new Map<string, PendingTool>();
  constructor(
    private readonly host: NativeResponsesHost,
    factory: OpenAIResponsesWebSocketFactory,
    idleTimeoutMs: number
  ) {
    this.connection = new NativeResponsesConnection(host, factory, idleTimeoutMs, (error) => {
      this.disconnect(error);
    });
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    return this.completeCompiled(await this.host.compileRequest(request));
  }
  async completeCompiled(
    compiled: CompiledModelRequest,
    options?: ModelTransportOptions
  ): Promise<ModelResponse> {
    for await (const event of this.streamCompiled(compiled, options))
      if (event.type === 'done') return event.response;
    throw failure('malformed_response', 'Native Responses ended without settlement.');
  }
  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    yield* this.streamCompiled(await this.host.compileRequest(request));
  }
  async steer(input: ModelSteeringSubmission): Promise<ModelSteeringDelivery> {
    return this.submit('steering', input, []);
  }
  async deliverToolResults(input: ModelToolResultSubmission): Promise<ModelToolResultDelivery> {
    const sourceCalls = Object.freeze(input.sourceCalls.map(parseModelNativeToolCallIdentity));
    const delivery = await this.submit('tool_results', { ...input, input: input.results }, sourceCalls);
    return Object.freeze({ ...delivery, sourceCalls });
  }
  async continueNative(input: ModelNativeContinuation): Promise<ModelNativeDelivery> {
    return this.submit('continuation', input, []);
  }
  steeringStatus(deliveryId: string): Promise<ModelSteeringDelivery> {
    return Promise.resolve(this.entry(deliveryId, 'steering').delivery);
  }
  toolResultStatus(deliveryId: string): Promise<ModelToolResultDelivery> {
    const entry = this.entry(deliveryId, 'tool_results');
    return Promise.resolve(Object.freeze({ ...entry.delivery, sourceCalls: entry.sourceCalls }));
  }
  nativeDeliveryStatus(deliveryId: string): Promise<ModelNativeDelivery> {
    return Promise.resolve(this.entry(deliveryId, 'continuation').delivery);
  }
  private entry(id: string, kind: Submission['kind']): Submission {
    const entry = this.submissions.get(id);
    if (entry?.stage === 'admitting')
      throw failure('invalid_request', 'Native admission is still in progress.');
    if (entry?.kind !== kind) throw failure('invalid_request', 'Unknown native delivery.');
    return entry;
  }
  private async submit(
    kind: Submission['kind'],
    input: ModelNativeContinuation,
    sourceCalls: readonly ModelNativeToolCallIdentity[]
  ): Promise<ModelNativeDelivery> {
    if (!input.deliveryId || !input.responseId)
      throw failure('invalid_request', 'Exact delivery and response IDs required.');
    const model = this.logical?.model ?? 'unknown';
    const messages = Object.freeze(input.input.map(parseModelInputItem));
    const catalog =
      input.tools === undefined
        ? undefined
        : parseModelRequest({
            model,
            messages: this.logical?.messages ?? messages,
            tools: input.tools
          }).tools;
    const owned = { messages, ...(catalog === undefined ? {} : { tools: catalog }) };
    const identity = await modelInputIdentity({
      kind,
      responseId: input.responseId,
      input: owned.messages,
      sourceCalls,
      ...(owned.tools === undefined ? {} : { tools: owned.tools })
    });
    const prior = this.submissions.get(input.deliveryId);
    if (prior) {
      if (prior.identity !== identity)
        throw failure('invalid_request', 'Native delivery ID reused for changed input.');
      await prior.admissionFinished;
      return prior.delivery;
    }
    input.signal?.throwIfAborted();
    this.signal?.throwIfAborted();
    const active = this.active;
    if (
      !this.busy ||
      !active ||
      !this.logical ||
      !this.connection.available ||
      this.failure ||
      active.boundary.responseId !== input.responseId
    )
      throw failure(
        'invalid_request',
        'Native delivery requires the exact current response on its original connection.'
      );
    if (!this.options?.native)
      throw failure('invalid_request', 'Native continuation requires host admission before transmission.');
    if (this.admitting) throw failure('invalid_request', 'A native admission is already in progress.');
    if (this.submissions.size >= 4096)
      throw failure('invalid_request', 'Native delivery retention limit reached.');
    if (kind === 'steering') {
      if (!owned.messages.length || owned.messages.some((item) => item.role !== 'user'))
        throw failure('invalid_request', 'Native steering accepts only user contributions.');
      if (this.pendingDeliveries().length)
        throw failure(
          'invalid_request',
          'Await the current native continuation before another steering submission.'
        );
    } else {
      if (!active.terminal)
        throw failure(
          'invalid_request',
          'Explicit native continuation requires a completed response boundary.'
        );
      if (this.pendingDeliveries().some((entry) => entry.kind !== 'steering'))
        throw failure('invalid_request', 'A native successor has already been submitted.');
      if (kind === 'tool_results') this.validateResults(owned.messages, sourceCalls);
      else if (owned.messages.some((item) => item.role !== 'user' && item.role !== 'control'))
        throw failure('invalid_request', 'Independent continuation accepts user and configuration inputs.');
      const delivered = new Set(sourceCalls.map((call) => call.toolCallId));
      for (const [id, tool] of this.pendingTools) {
        if (!tool.call.async && !tool.deliveryId && !delivered.has(id))
          throw failure(
            'invalid_request',
            'Synchronous tool dependencies require all original results before continuation.'
          );
      }
    }
    this.admitting = true;
    const entry: Submission = {
      kind,
      identity,
      input: owned.messages,
      sourceCalls,
      stage: 'admitting',
      delivery: Object.freeze({
        deliveryId: input.deliveryId,
        responseId: input.responseId,
        inputIdentity: identity,
        status: 'failed',
        detail: 'Not transmitted.'
      })
    };
    entry.admissionFinished = new Promise<void>((resolve) => {
      entry.finishAdmission = resolve;
    });
    this.submissions.set(input.deliveryId, entry);
    try {
      if (!(await this.host.nativeSupported(model)))
        throw failure('invalid_request', 'Native continuation is unsupported by this model/endpoint.');
      const steering = this.pendingDeliveries().filter((item) => item !== entry && item.kind === 'steering');
      const retainedRequest = parseModelRequest({
        ...this.logical,
        messages: [...this.logical.messages, ...steering.flatMap((item) => item.input)]
      });
      const admissionSignal = modelTransportSignal(
        { ...retainedRequest, ...(this.signal ? { signal: this.signal } : {}) },
        input.signal ? { signal: input.signal } : undefined
      );
      const logical = parseModelRequest({
        ...retainedRequest,
        ...(admissionSignal ? { signal: admissionSignal } : {}),
        messages: [...retainedRequest.messages, ...owned.messages],
        ...(owned.tools === undefined ? {} : { tools: owned.tools })
      });
      const effective = await this.host.compileRequest(logical);
      const appended = responsesInput({ ...logical, messages: owned.messages }, 'openai').input;
      const retained = responsesInput(retainedRequest, 'openai').input;
      const body = parseJsonObject(
        kind === 'steering'
          ? { type: 'response.steer', previous_response_id: input.responseId, input: appended }
          : {
              ...effective.body,
              type: 'response.create',
              previous_response_id: input.responseId,
              input: appended
            }
      );
      const retainedBody = parseJsonObject(
        kind === 'steering' ? { ...active.body, input: retained } : { input: retained }
      );
      const pendingOutputTokens =
        kind === 'steering' && !active.terminal ? effective.accounting.outputReservation : 0;
      const compiled = await this.host.compileNativeFrame(logical, body, retainedBody, pendingOutputTokens);
      entry.compiled = compiled;
      entry.delivery = Object.freeze({ ...entry.delivery, inputIdentity: compiled.inputIdentity });
      assertRequestAccountingFits(compiled.accounting);
      const dispatch: ModelNativeDispatch = Object.freeze({
        kind,
        deliveryId: input.deliveryId,
        responseId: input.responseId,
        compiled,
        sourceCalls,
        generationDeliveryId: steering[0]?.delivery.deliveryId ?? input.deliveryId
      });
      await this.options.native.admit(dispatch);
      input.signal?.throwIfAborted();
      this.signal?.throwIfAborted();
      if (!this.canTransmit(active))
        throw failure(
          'invalid_request',
          'Native response changed during host admission; nothing transmitted.'
        );
      entry.stage = 'sent';
      for (const source of sourceCalls) {
        const tool = this.pendingTools.get(source.toolCallId);
        if (tool) tool.deliveryId = input.deliveryId;
      }
      this.update(entry, { ...entry.delivery, status: 'submitted' });
      try {
        this.connection.send(compiled.body);
      } catch {
        this.disconnect(failure('provider_unavailable', 'Connection failed during native transmission.'));
      }
      return entry.delivery;
    } catch (error) {
      entry.stage = 'settled';
      this.update(entry, {
        ...entry.delivery,
        status: 'failed',
        detail: 'Host admission or cancellation prevented transmission.'
      });
      throw error;
    } finally {
      this.admitting = false;
      entry.finishAdmission?.();
    }
  }
  private canTransmit(active: ActiveResponse): boolean {
    return !this.failure && this.connection.available && this.active === active && this.busy;
  }
  private validateResults(
    input: readonly ModelInputItem[],
    sources: readonly ModelNativeToolCallIdentity[]
  ): void {
    if (!input.length) throw failure('invalid_request', 'Native tool result delivery cannot be empty.');
    if (sources.length !== input.length)
      throw failure('invalid_request', 'Each result requires its original source call binding.');
    const ids = new Set<string>();
    for (const [index, item] of input.entries()) {
      const source = sources[index];
      const tool =
        item.role === 'tool' && item.toolCallId ? this.pendingTools.get(item.toolCallId) : undefined;
      if (
        item.role !== 'tool' ||
        !item.toolCallId ||
        !tool ||
        source?.toolCallId !== item.toolCallId ||
        source.responseId !== tool.source.responseId ||
        source.catalogIdentity !== tool.source.catalogIdentity ||
        item.toolName !== tool.call.name ||
        item.toolCallType !== tool.call.type
      )
        throw failure('invalid_request', 'Missing or unmatched original native tool result identity.');
      if (tool.deliveryId || ids.has(item.toolCallId))
        throw failure('invalid_request', 'Native tool result already delivered or reserved.');
      ids.add(item.toolCallId);
    }
  }
  private pendingDeliveries(): Submission[] {
    return Array.from(this.submissions.values()).filter((entry) => entry.stage !== 'settled');
  }
  private deliveryEvent(entry: Submission): ModelStreamEvent {
    if (entry.kind === 'steering') return { type: 'steering', delivery: entry.delivery };
    if (entry.kind === 'tool_results')
      return {
        type: 'tool_result_delivery',
        delivery: { ...entry.delivery, sourceCalls: entry.sourceCalls }
      };
    return { type: 'native_delivery', delivery: entry.delivery };
  }
  private update(entry: Submission, delivery: Submission['delivery']): void {
    const { detail, ...withoutDetail } = delivery;
    void detail;
    entry.delivery = Object.freeze(
      delivery.status === 'submitted' ||
        delivery.status === 'applied' ||
        (delivery.status === 'acknowledged' && !entry.pending)
        ? withoutDetail
        : delivery
    );
    if (delivery.status === 'applied' || delivery.status === 'failed' || delivery.status === 'uncertain')
      entry.stage = 'settled';
    this.deliveryEvents.push(this.deliveryEvent(entry));
    this.connection.notify();
  }
  async *streamCompiled(
    compiled: CompiledModelRequest,
    options?: ModelTransportOptions
  ): AsyncIterable<ModelStreamEvent> {
    this.host.assertCompiled(compiled);
    if (this.busy) throw failure('invalid_request', 'A native response is already active.');
    if (Array.from(this.submissions.values()).some((entry) => entry.delivery.status === 'uncertain'))
      throw failure(
        'invalid_request',
        'Uncertain native delivery must be reconciled before starting another stream.'
      );
    this.busy = true;
    this.options = options
      ? {
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.native ? { native: { admit: options.native.admit } } : {})
        }
      : undefined;
    this.signal = modelTransportSignal(compiled.logicalRequest, options);
    this.logical = compiled.logicalRequest;
    this.pendingTools.clear();
    let completed = false;
    const abort = () => {
      this.disconnect(failure('aborted', 'Native Responses request aborted.'));
    };
    this.signal?.addEventListener('abort', abort, { once: true });
    const responses: ModelResponse[] = [];
    const terminalIds = new Set<string>();
    let content = '';
    try {
      this.signal?.throwIfAborted();
      await this.connection.connect(this.signal);
      this.connection.send(compiled.body);
      for (;;) {
        while (this.deliveryEvents.length) {
          const deliveryEvent = this.deliveryEvents.shift();
          if (deliveryEvent) yield deliveryEvent;
        }
        if (
          !this.failure &&
          this.active?.terminal &&
          !this.pendingDeliveries().length &&
          !(this.options?.native && this.pendingTools.size)
        ) {
          completed = true;
          yield { type: 'done', response: aggregateResponses(responses) };
          return;
        }
        const event = await this.connection.next(this.signal);
        if (event.type === 'agent.native.wake') continue;
        if (event.type === 'response.created') {
          const response = parseJsonObject(event.response);
          if (typeof response.id !== 'string' || !response.id || terminalIds.has(response.id))
            throw failure('malformed_response', 'Native response omitted or reused its identity.');
          const previous = this.active;
          let request = compiled.logicalRequest;
          let body = compiled.body;
          let inputIdentity = compiled.inputIdentity;
          const deliveryIds: string[] = [];
          let generationDeliveryId: string | undefined;
          if (previous) {
            if (
              !previous.terminal ||
              (response.previous_response_id !== undefined &&
                response.previous_response_id !== previous.boundary.responseId)
            )
              throw failure('malformed_response', 'Native successor has no exact completed parent.');
            const entries = Array.from(this.submissions.values()).filter(
              (entry) =>
                entry.delivery.responseId === previous.boundary.responseId &&
                (entry.stage === 'sent' || entry.delivery.status === 'uncertain')
            );
            const explicit = entries.find((entry) => entry.kind !== 'steering');
            const steers = entries.filter(
              (entry) =>
                entry.kind === 'steering' &&
                (entry.delivery.status === 'acknowledged' ||
                  (entry.delivery.status === 'uncertain' && entry.delivery.providerEventId))
            );
            const cause = explicit ?? steers[0];
            if (entries.filter((entry) => entry.kind === 'steering').length !== steers.length)
              throw failure('malformed_response', 'Successor preceded steering acknowledgment.');
            if (!cause?.compiled)
              throw failure('malformed_response', 'Unattributed native response continuation.');
            // Steering was admitted before the parent completed. Its response input now includes the exact parent output.
            request =
              explicit?.compiled?.logicalRequest ??
              parseModelRequest({
                ...this.logical,
                messages: [...this.logical.messages, ...steers.flatMap((entry) => entry.input)]
              });
            body = explicit?.compiled?.body ?? previous.body;
            inputIdentity = cause.compiled.inputIdentity;
            generationDeliveryId = steers[0]?.delivery.deliveryId ?? cause.delivery.deliveryId;
            for (const entry of [...steers, ...(explicit ? [explicit] : [])]) {
              deliveryIds.push(entry.delivery.deliveryId);
              if (entry.kind !== 'steering') {
                this.update(entry, {
                  ...entry.delivery,
                  successorResponseId: response.id,
                  status: 'acknowledged'
                });
              }
              this.update(entry, { ...entry.delivery, successorResponseId: response.id, status: 'applied' });
              for (const source of entry.sourceCalls) this.pendingTools.delete(source.toolCallId);
            }
          }
          const { signal: omittedSignal, ...durableRequest } = request;
          void omittedSignal;
          const boundary: ModelNativeResponseBoundary = Object.freeze({
            responseId: response.id,
            ...(previous ? { previousResponseId: previous.boundary.responseId } : {}),
            deliveryIds: Object.freeze(deliveryIds),
            ...(generationDeliveryId ? { generationDeliveryId } : {}),
            ...this.obligations(),
            inputIdentity,
            catalogIdentity: await modelInputIdentity(request.tools ?? []),
            request: parseModelRequest(durableRequest)
          });
          this.active = { boundary, body, terminal: false };
          this.logical = request;
          yield { type: 'response_started', responseId: response.id, native: boundary };
          continue;
        }
        if (
          event.type === 'response.steer.accepted' ||
          event.type === 'response.steer.failed' ||
          event.type === 'response.steer.pending'
        ) {
          const steer = parseJsonObject(event.steer);
          const entry =
            Array.from(this.submissions.values()).find(
              (item) => item.kind === 'steering' && item.delivery.providerEventId === steer.id
            ) ??
            this.pendingDeliveries().find(
              (item) => item.kind === 'steering' && item.delivery.responseId === steer.previous_response_id
            );
          if (
            !entry ||
            typeof steer.id !== 'string' ||
            entry.delivery.responseId !== steer.previous_response_id ||
            entry.delivery.status === 'applied' ||
            entry.delivery.status === 'failed'
          )
            throw failure('malformed_response', 'Unmatched native steering acknowledgment.');
          entry.pending = event.type === 'response.steer.pending';
          if (entry.pending) {
            if (!Array.isArray(event.required_input))
              throw failure('malformed_response', 'Pending steering omitted required input stubs.');
            const ids = event.required_input.map((value) => {
              const stub = parseJsonObject(value);
              if (
                (stub.type !== 'function_call_output' && stub.type !== 'custom_tool_call_output') ||
                typeof stub.call_id !== 'string' ||
                !this.pendingTools.has(stub.call_id)
              )
                throw failure('malformed_response', 'Unsupported or unmatched pending steering dependency.');
              return stub.call_id;
            });
            entry.delivery = Object.freeze({ ...entry.delivery, requiredToolCallIds: Object.freeze(ids) });
          }
          this.update(entry, {
            ...entry.delivery,
            providerEventId: steer.id,
            status: event.type === 'response.steer.failed' ? 'failed' : 'acknowledged',
            ...(entry.pending ? { detail: 'Awaiting original tool results or approvals.' } : {})
          });
          continue;
        }
        if (!this.active) throw failure('malformed_response', 'Native output preceded response.created.');
        if (event.response_id !== undefined && event.response_id !== this.active.boundary.responseId)
          throw failure('malformed_response', 'Native event belongs to a different response.');
        if (event.type === 'response.output_text.delta' && typeof event.delta === 'string' && event.delta) {
          content += event.delta;
          yield { type: 'content', content: event.delta, accumulated: content };
          continue;
        }
        if (event.type === 'response.output_item.done') {
          const payload = decodeResponsesPayload({ output: [event.item] });
          for (const item of await responsesOutput({
            request: this.active.boundary.request,
            provider: 'openai',
            endpoint: this.host.endpoint(),
            requestId: this.active.boundary.responseId,
            items: payload.output ?? []
          })) {
            if (item.type === 'tool_call' && this.rememberCall(item.toolCall))
              yield {
                type: 'tool_call',
                toolCall: item.toolCall,
                source: {
                  responseId: this.active.boundary.responseId,
                  catalogIdentity: this.active.boundary.catalogIdentity,
                  toolCallId: item.toolCall.id ?? ''
                }
              };
          }
          continue;
        }
        if (event.type === 'response.completed' || event.type === 'response.incomplete') {
          const response = await this.host.decodeNativeResponse(this.active.boundary.request, event.response);
          if (
            !response.requestId ||
            response.requestId !== this.active.boundary.responseId ||
            terminalIds.has(response.requestId)
          )
            throw failure(
              'malformed_response',
              'Native terminal response identity is invalid or duplicated.'
            );
          terminalIds.add(response.requestId);
          responses.push(response);
          for (const call of response.toolCalls ?? []) this.rememberCall(call);
          this.active.terminal = true;
          this.logical = parseModelRequest({
            ...this.active.boundary.request,
            messages: [...this.active.boundary.request.messages, ...modelOutputToInput(response.output ?? [])]
          });
          yield {
            type: 'response_boundary',
            response,
            native: Object.freeze({ ...this.active.boundary, ...this.obligations() })
          };
        } else if (event.type === 'error' || event.type === 'response.failed') {
          throw failure(
            'provider_unavailable',
            'Native Responses failed; delivery status must be reconciled before replay.'
          );
        }
      }
    } catch (error) {
      this.disconnect(
        this.signal?.aborted
          ? failure('aborted', 'Native Responses request aborted.')
          : error instanceof Error
            ? error
            : failure('unknown', 'Native transport failed.')
      );
      while (this.deliveryEvents.length) {
        const deliveryEvent = this.deliveryEvents.shift();
        if (deliveryEvent) yield deliveryEvent;
      }
      throw this.failure ?? error;
    } finally {
      this.signal?.removeEventListener('abort', abort);
      this.busy = false;
      this.active = undefined;
      if (!completed)
        this.disconnect(failure('aborted', 'Native response consumer stopped before settlement.'));
    }
  }
  private obligations(): Pick<
    ModelNativeResponseBoundary,
    'requiredToolCallIds' | 'pendingToolCalls' | 'continuation'
  > {
    return {
      requiredToolCallIds: Object.freeze(
        Array.from(this.pendingTools.values())
          .filter((tool) => !tool.call.async)
          .map((tool) => tool.source.toolCallId)
      ),
      pendingToolCalls: Object.freeze(Array.from(this.pendingTools.values()).map((tool) => tool.source)),
      continuation: this.pendingDeliveries().some((entry) => entry.kind === 'steering')
        ? 'automatic'
        : 'client'
    };
  }
  private rememberCall(call: ModelToolCall): boolean {
    if (!call.id || !this.active)
      throw failure('malformed_response', 'Native tool call omitted its response/call identity.');
    const prior = this.seenCalls.get(call.id);
    if (prior) {
      if (prior.source.responseId !== this.active.boundary.responseId || !isDeepStrictEqual(prior.call, call))
        throw failure('malformed_response', 'Native call ID was reused for different output.');
      return false;
    }
    if (this.seenCalls.size >= 4096)
      throw failure('malformed_response', 'Native call retention limit reached.');
    this.pendingTools.set(call.id, {
      call,
      source: Object.freeze({
        responseId: this.active.boundary.responseId,
        catalogIdentity: this.active.boundary.catalogIdentity,
        toolCallId: call.id
      })
    });
    const stored = this.pendingTools.get(call.id);
    if (stored) this.seenCalls.set(call.id, stored);
    return true;
  }
  close(): Promise<void> {
    this.disconnect(failure('aborted', 'Native session closed.'));
    return Promise.resolve();
  }
  resetContinuation(reason: string): void {
    this.disconnect(failure('invalid_request', `Native continuation explicitly reset: ${reason}`));
  }
  private disconnect(error: Error): void {
    this.failure =
      error instanceof ModelProviderError
        ? error
        : failure('provider_unavailable', 'Native transport disconnected with uncertain delivery.');
    this.connection.close(this.failure);
    for (const entry of this.submissions.values()) {
      if (entry.stage === 'sent')
        this.update(entry, {
          ...entry.delivery,
          status: 'uncertain',
          detail: 'Connection closed before application was confirmed; do not replay automatically.'
        });
    }
    this.connection.notify();
  }
}
