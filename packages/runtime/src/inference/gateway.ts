import {
  parseModelResponse,
  parseModelStreamEvent,
  type ModelProfile,
  type ModelProvider,
  type ModelProviderSession,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamEvent,
  SimpleTokenEstimator,
  type TokenEstimator
} from '@agent-core/model';
import { ModelStreamInterruptedError } from '../orchestration/model-stream.js';
import { assertModelRequestFitsProfile } from './request-fit.js';

export interface InferenceInvocation {
  readonly request: ModelRequest;
  readonly profile: ModelProfile;
  readonly session: ModelProviderSession;
  readonly turnIndex: number;
  readonly onStreamEvent?: (event: Exclude<ModelStreamEvent, { readonly type: 'done' }>) => void | Promise<void>;
}

/** The only runtime path that invokes a provider session. */
export class InferenceGateway {
  constructor(readonly provider: ModelProvider, private readonly estimator: TokenEstimator = new SimpleTokenEstimator()) {}

  createSession(): ModelProviderSession {
    return this.provider.createSession?.() ?? directProviderSession(this.provider);
  }

  async invoke(input: InferenceInvocation): Promise<ModelResponse> {
    assertModelRequestFitsProfile(input.request, input.profile, this.estimator);
    if (!input.profile.capabilities.streaming || !input.session.stream) {
      return parseModelResponse(await input.session.complete(input.request));
    }

    let response: ModelResponse | undefined;
    let content = '';
    let reasoningSummary = '';
    let terminalEvents = 0;
    try {
      for await (const rawEvent of input.session.stream(input.request)) {
        const event = parseModelStreamEvent(rawEvent);
        if (terminalEvents > 0) throw new Error('Provider stream emitted an event after its terminal event.');
        if (event.type === 'done') {
          terminalEvents += 1;
          response = event.response;
          continue;
        }
        if (event.type === 'content') content = event.accumulated;
        if (event.type === 'reasoning' && event.channel === 'summary') reasoningSummary = event.accumulatedReasoning;
        await input.onStreamEvent?.(event);
      }
    } catch (cause) {
      throw interrupted(input.turnIndex, cause, content, reasoningSummary, response !== undefined);
    }
    if (!response) {
      throw interrupted(input.turnIndex, new Error('Model stream ended without a final response.'), content, reasoningSummary, false);
    }
    return Object.freeze({
      ...response,
      ...(response.content.length === 0 && content.length > 0 ? { content } : {}),
      ...(!response.reasoningSummary && reasoningSummary.length > 0 ? { reasoningSummary } : {})
    });
  }
}

function directProviderSession(provider: ModelProvider): ModelProviderSession {
  const stream = provider.stream?.bind(provider);
  return Object.freeze({
    complete: (request: ModelRequest) => provider.complete(request),
    ...(stream ? { stream: (request: ModelRequest) => stream(request) } : {})
  });
}

function interrupted(turnIndex: number, cause: unknown, content: string, reasoningSummary: string, finalResponseReceived: boolean): ModelStreamInterruptedError {
  return new ModelStreamInterruptedError({
    turnIndex,
    cause,
    content,
    finalResponseReceived,
    ...(reasoningSummary.length > 0 ? { reasoningSummary } : {})
  });
}
