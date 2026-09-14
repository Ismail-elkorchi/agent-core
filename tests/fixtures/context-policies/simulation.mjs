import { compileModelRequest, createProviderContextState } from '@agent-core/model';

export const simulationProfile = Object.freeze({
  id: 'deterministic-memory-parser-v1',
  provider: 'simulation',
  capabilities: {
    streaming: false,
    toolCalling: true,
    supportedToolInputs: [{ kind: 'json' }],
    jsonMode: true,
    jsonSchema: true,
    logprobs: false,
    temperature: false,
    topP: false,
    protocol: {
      version: 1,
      revision: 'simulation/2',
      endpoint: 'simulation://local',
      roles: ['system', 'developer', 'user', 'assistant'],
      inputKinds: ['text', 'tool_call', 'tool_result', 'protocol'],
      outputKinds: ['text', 'tool_call', 'protocol'],
      state: 'exact',
      continuation: 'replay',
      asyncTools: false,
      steering: 'next_request',
      contextTransforms: ['simulation.compact'],
      toolChoice: ['auto'],
      counting: 'estimate'
    }
  },
  modalities: { input: ['text'], output: ['text'] },
  limits: { contextTokens: 128_000, outputTokens: 4096 },
  supportedParameters: ['maxOutputTokens', 'responseFormat', 'tools'],
  metadata: { measurement: 'deterministic-simulation' }
});

/** A deliberately simple parser, never an empirical stand-in for a language model. */
export class MemorySimulationProvider {
  id = 'simulation';
  implementationId = 'context-policies.simulation@1';
  calls = [];
  transforms = [];
  admittedTransforms = new WeakSet();
  describe() {
    return {
      id: this.id,
      displayName: 'Deterministic simulation',
      defaultModel: simulationProfile.id
    };
  }
  async describeModel() {
    return simulationProfile;
  }
  async compileRequest(request) {
    const { signal: _signal, ...body } = request;
    return compileModelRequest({
      request,
      profile: await this.describeModel(request.model),
      body,
      endpoint: 'simulation://local'
    });
  }
  async completeCompiled(compiled) {
    return this.complete(compiled.logicalRequest);
  }
  async compileContextTransform({ request }) {
    const compiled = await compileModelRequest({
      request,
      profile: await this.describeModel(request.model),
      body: { model: request.model, input: request.messages },
      endpoint: 'simulation://local'
    });
    this.admittedTransforms.add(compiled);
    return compiled;
  }
  async transformContextCompiled(transformId, compiled) {
    if (!this.admittedTransforms.has(compiled))
      throw new Error('Transform was not admitted by the fixture.');
    compiled.logicalRequest.signal?.throwIfAborted();
    this.transforms.push({ transformId, compiled });
    const facts = requestTexts(compiled.logicalRequest).flatMap((text) =>
      [...text.matchAll(/STATE\[\d+\]\s*\{[^\n]*?\}/gu)].map((match) => match[0])
    );
    const memory = [...new Set(facts)].join('\n');
    const state = await createProviderContextState({
      protocolRevision: 'simulation/2',
      provider: this.id,
      endpoint: 'simulation://local',
      request: compiled.logicalRequest,
      requestId: transformId,
      kind: 'simulation.compaction',
      data: { memory },
      requiresExactPrefix: false,
      tokenEstimate: Math.ceil(memory.length / 4)
    });
    return { transformId, state, input: [{ role: 'protocol', content: '', state }] };
  }
  async complete(request) {
    this.calls.push(request);
    const texts = requestTexts(request);
    const taskIndex = request.messages.findLastIndex(
      (item) => item.role === 'user' && !item.content.startsWith('Context bundle:')
    );
    const lastUser = request.messages[taskIndex]?.content ?? '';
    const hasToolResult = request.messages
      .slice(taskIndex + 1)
      .some((item) => item.role === 'tool');
    let content = 'ACK';
    let toolCalls;
    if (
      lastUser.includes('REPORT:') &&
      !hasToolResult &&
      !request.messages.some((item) => item.role === 'protocol') &&
      request.tools?.some(
        (tool) => tool.type === 'function' && tool.function.name === 'history_search'
      )
    ) {
      toolCalls = [
        {
          id: `search-${String(this.calls.length).padStart(4, '0')}`,
          type: 'function',
          name: 'history_search',
          input: {
            kind: 'json',
            value: {
              query: 'STATE[',
              filter: { role: 'user' },
              limit: 50,
              maxBytes: 32000,
              maxScanned: 1000
            }
          }
        }
      ];
      content = '';
    } else if (lastUser.includes('REPORT:') || lastUser.includes('WRITE_SESSION_NOTE:')) {
      const facts = texts
        .flatMap((value) => [...value.matchAll(/STATE\[(\d+)\]\s*(\{[^\n]*?\})/gu)])
        .sort((a, b) => Number(a[1]) - Number(b[1]));
      const state = {};
      for (const match of facts) {
        try {
          Object.assign(state, JSON.parse(match[2]));
        } catch {
          /* Bounded excerpts can end mid-record. */
        }
      }
      content = lastUser.includes('WRITE_SESSION_NOTE:')
        ? `Derived memory; consult original history for authority.\nSTATE[${facts.at(-1)?.[1] ?? '000'}] ${JSON.stringify(state)}`
        : JSON.stringify(state);
    }
    return {
      provider: this.id,
      model: request.model,
      content,
      ...(toolCalls ? { toolCalls } : {}),
      terminationReason: toolCalls ? 'tool_calls' : 'stop'
      // Deliberately omit usage: Core records estimates and the report labels them.
    };
  }
}

function requestTexts(request) {
  return request.messages.flatMap((item) =>
    item.role === 'protocol' ? strings(item.state.data.memory) : strings(item.content)
  );
}

function strings(text) {
  if (typeof text !== 'string') return [];
  try {
    const jsonStart = text.indexOf('\n[');
    const value = JSON.parse(jsonStart >= 0 ? text.slice(jsonStart + 1) : text.split('\n\n', 1)[0]);
    const visit = (item) =>
      typeof item === 'string'
        ? [item]
        : item && typeof item === 'object'
          ? Object.values(item).flatMap(visit)
          : [];
    return [text, ...visit(value)];
  } catch {
    return [text];
  }
}
