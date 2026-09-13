import {
  compileModelRequest,
  createModelRequest,
  parseModelResponse,
  parseModelStreamEvent,
  type CompiledModelRequest,
  type ModelCompilationOptions,
  type ModelProfile,
  type ModelProvider,
  type ModelProviderSession,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamEvent,
  type ModelTransportOptions
} from '@agent-core/model';
import { requestWindowForModel } from '../orchestration/model-request.js';
import { ModelStreamInterruptedError } from '../orchestration/model-stream.js';

export interface InferenceInvocation {
  readonly transport?: ModelTransportOptions;
  readonly request: ModelRequest;
  readonly compiled?: CompiledModelRequest;
  readonly profile: ModelProfile;
  readonly session: ModelProviderSession;
  readonly turnIndex: number;
  readonly onStreamEvent?: (
    event: Exclude<ModelStreamEvent, { readonly type: 'done' }>
  ) => void | Promise<void>;
}

/** The only runtime path that invokes a provider session. */
export class InferenceGateway {
  constructor(readonly provider: ModelProvider) {}

  createSession(): ModelProviderSession {
    return this.provider.createSession?.() ?? directProviderSession(this.provider);
  }

  async compile(
    request: ModelRequest,
    profile: ModelProfile,
    options?: ModelCompilationOptions
  ): Promise<CompiledModelRequest> {
    request = createModelRequest(request);
    request.signal?.throwIfAborted();
    if (profile.provider !== this.provider.id || request.model !== profile.id)
      throw new Error('Inference profile does not match its provider and model.');
    const body = { ...request };
    delete body.signal;
    const policy = {
      outputReservation: requestWindowForModel(
        profile,
        options?.outputReservation ?? request.maxOutputTokens
      ).maxOutputTokens
    };
    const compiled = this.provider.compileRequest
      ? await this.provider.compileRequest(request, policy)
      : await compileModelRequest({
          request,
          profile,
          ...policy,
          body,
          payloadPaths: request.messages.flatMap((message, messageIndex) => [
            ...(message.images?.map((_image, imageIndex) => [
              'messages',
              messageIndex,
              'images',
              imageIndex,
              'data'
            ]) ?? []),
            ...(message.parts?.flatMap((part, partIndex) =>
              part.type === 'image' ? [['messages', messageIndex, 'parts', partIndex, 'image', 'data']] : []
            ) ?? [])
          ]),
          endpoint: profile.capabilities.protocol?.endpoint ?? this.provider.id
        });
    if (
      compiled.provider !== profile.provider ||
      compiled.model !== profile.id ||
      compiled.capabilityRevision !== (profile.capabilities.protocol?.revision ?? 'conservative-v1')
    )
      throw new Error('Compiled input changed the admitted model or capability revision.');
    return compiled;
  }

  async invoke(
    input: InferenceInvocation & { readonly compiled: CompiledModelRequest }
  ): Promise<ModelResponse> {
    const compiled = input.compiled;
    input.request.signal?.throwIfAborted();
    const compiledStream = input.session.streamCompiled?.bind(input.session);
    const logicalStream = input.session.stream?.bind(input.session);
    const stream = compiledStream
      ? () => compiledStream(compiled, input.transport)
      : logicalStream
        ? () => logicalStream(compiled.logicalRequest)
        : undefined;
    if (!input.profile.capabilities.streaming || !stream) {
      return parseModelResponse(
        await (input.session.completeCompiled
          ? input.session.completeCompiled(compiled, input.transport)
          : input.session.complete(compiled.logicalRequest))
      );
    }

    let response: ModelResponse | undefined;
    let content = '';
    let reasoningSummary = '';
    let reasoning = '';
    let terminalEvents = 0;
    try {
      for await (const rawEvent of stream()) {
        const event = parseModelStreamEvent(rawEvent);
        if (terminalEvents > 0)
          throw new Error('Provider stream emitted an event after its terminal event.');
        if (event.type === 'done') {
          terminalEvents += 1;
          response = event.response;
          continue;
        }
        if (event.type === 'content') content = event.accumulated;
        if (event.type === 'reasoning') {
          if (event.channel === 'summary') reasoningSummary = event.accumulatedReasoning;
          else reasoning = event.accumulatedReasoning;
        }
        await input.onStreamEvent?.(event);
      }
    } catch (cause) {
      throw interrupted(
        input.turnIndex,
        cause,
        content,
        reasoningSummary,
        reasoning,
        response !== undefined
      );
    }
    if (!response) {
      throw interrupted(
        input.turnIndex,
        new Error('Model stream ended without a final response.'),
        content,
        reasoningSummary,
        reasoning,
        false
      );
    }
    return Object.freeze({
      ...response,
      ...(response.content.length === 0 && content.length > 0 ? { content } : {}),
      ...(!response.reasoning && reasoning.length > 0 ? { reasoning } : {}),
      ...(!response.reasoningSummary && reasoningSummary.length > 0 ? { reasoningSummary } : {})
    });
  }
}

function directProviderSession(provider: ModelProvider): ModelProviderSession {
  const stream = provider.stream?.bind(provider);
  return Object.freeze({
    complete: (request: ModelRequest) => provider.complete(request),
    ...(stream ? { stream: (request: ModelRequest) => stream(request) } : {}),
    ...(provider.completeCompiled ? { completeCompiled: provider.completeCompiled.bind(provider) } : {}),
    ...(provider.streamCompiled ? { streamCompiled: provider.streamCompiled.bind(provider) } : {})
  });
}

function interrupted(
  turnIndex: number,
  cause: unknown,
  content: string,
  reasoningSummary: string,
  reasoning: string,
  finalResponseReceived: boolean
): ModelStreamInterruptedError {
  return new ModelStreamInterruptedError({
    turnIndex,
    cause,
    content,
    finalResponseReceived,
    ...(reasoning.length > 0 ? { reasoning } : {}),
    ...(reasoningSummary.length > 0 ? { reasoningSummary } : {})
  });
}
