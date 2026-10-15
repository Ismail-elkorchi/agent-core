import { compileModelRequest } from '@agent-core/model';

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
      contextReset: 'fresh_request',
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
  lastTask;
  taskCalls = new Set();
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
  async complete(request) {
    this.calls.push(request);
    if (request.messages.some(item => item.role === 'user' && item.content.includes('Prepare a fresh context for the same ongoing work'))) {
      const task = request.messages.findLast(item => item.role === 'user');
      const recovery = JSON.parse(task.content);
      const retain = (recovery.inventory.items ?? [])
        .filter(item => item.type === 'input' && /^(Background detail|Correction:|Explicit task replacement:)/u.test(item.description))
        .map(item => item.source);
      return {
        provider: this.id, model: request.model, content: '', terminationReason: 'tool_calls',
        toolCalls: [{ id: `recovery-${this.calls.length}`, type: 'function', name: 'context_transition',
          input: { kind: 'json', value: { reason: 'Release unrelated sources to admit the original task; preserve user requirements.', retain } } }]
      };
    }
    const texts = requestTexts(request);
    const taskIndex = request.messages.findLastIndex(
      (item) => item.role === 'user' && !item.content.startsWith('Context bundle:')
    );
    const lastUser = request.messages[taskIndex]?.content ?? '';
    if (this.lastTask !== lastUser) { this.lastTask = lastUser; this.taskCalls.clear(); }
    const current = request.messages.slice(taskIndex + 1);
    const used = new Set([...this.taskCalls, ...current.flatMap(item => (item.toolCalls ?? []).map(call => call.name))]);
    const available = name => request.tools?.some(tool => tool.type === 'function' && tool.function.name === name);
    let content = 'ACK';
    let toolCalls;
    const call = (name, value) => [{
      id: `${name}-${String(this.calls.length).padStart(4, '0')}`,
      type: 'function', name, input: { kind: 'json', value }
    }];
    if (lastUser.includes('LOOKUP:') && !used.has('background_lookup')) {
      toolCalls = call('background_lookup', {});
      content = '';
    } else if (lastUser.includes('REPORT:') && available('context_inspect') && !used.has('context_inspect')) {
      toolCalls = call('context_inspect', {});
      content = '';
    } else if (lastUser.includes('REPORT:') && available('context_transition') && !used.has('context_transition')) {
      const inspection = current.findLast(item => item.role === 'tool' && item.toolName === 'context_inspect');
      let selected = [];
      try { selected = inspection ? JSON.parse(inspection.content).selection?.items ?? [] : []; } catch {
        return { provider: this.id, model: request.model, content: 'Context inspection unavailable.', terminationReason: 'stop' };
      }
      const retain = selected.filter(item => item.type === 'input' && /^(Background detail|Correction:|Explicit task replacement:)/u.test(item.description)).map(item => item.source);
      toolCalls = call('context_transition', {
        reason: 'Before answering, release unrelated material while preserving authoritative requirements through scoped retrieval.',
        retain
      });
      content = '';
    } else if (
      lastUser.includes('REPORT:') && !used.has('history_search') &&
      !request.messages.some(item => item.role === 'protocol') && available('history_search')
    ) {
      toolCalls = call('history_search', {
        query: 'STATE[', filter: { role: 'user' }, limit: 50, maxBytes: 32000, maxScanned: 1000
      });
      content = '';
    } else if (lastUser.includes('REPORT:')) {
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
      content = JSON.stringify(state);
    }
    for (const tool of toolCalls ?? []) this.taskCalls.add(tool.name);
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
  // This fixture is a plumbing oracle: only user records and scoped
  // history search results are authoritative inputs. It does not measure injection resistance.
  const historyCalls = new Set(request.messages.flatMap(item =>
    (item.toolCalls ?? []).filter(call => call.name === 'history_search').map(call => call.id)));
  return request.messages.flatMap(item =>
    item.role === 'user' || (item.role === 'tool' && historyCalls.has(item.toolCallId))
        ? strings(item.content) : []);
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
