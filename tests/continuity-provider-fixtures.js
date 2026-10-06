import { conservativeProtocolCapabilities } from '@agent-core/model';
import { ClaudeProvider } from '@agent-core/provider-claude';
import { OllamaProvider } from '@agent-core/provider-ollama';
import { OpenAIProvider } from '@agent-core/provider-openai';
import { OpenAICodexProvider } from '@agent-core/provider-openai-codex';
import { OpenRouterProvider } from '@agent-core/provider-openrouter';

export const providerIds = ['openai', 'openai-codex', 'openrouter', 'ollama', 'claude'];
export const model = 'fixture/continuity';
export const continuation = 'Inspection completed; the observed failure is in validation. Keep user constraints. Next: repair validation, then run the checks.';
export const thinking = { type: 'thinking', thinking: 'Private protocol reasoning.', signature: 'original-signature+/=' };

/** Real adapter compilers and decoders, with deterministic local transports. */
export function continuityProvider(id, { contextTokens = 128_000, respond = () => 'Recorded answer.', bodies = [], opaqueReasoning = false, countTokens = true, firstTool } = {}) {
  const definition = {
    displayName: 'Continuity fixture',
    capabilities: {
      streaming: false, toolCalling: true, supportedToolInputs: [{ kind: 'json' }],
      jsonMode: id !== 'claude', jsonSchema: id !== 'claude', logprobs: false,
      temperature: id !== 'openai-codex', topP: id !== 'openai-codex',
      ...(id === 'claude' ? {
        protocol: conservativeProtocolCapabilities('https://api.anthropic.com/v1/messages', {
          revision: 'claude-messages-2026-09-07-v1', roles: ['system', 'user', 'assistant'],
          inputKinds: ['text', 'tool_call', 'tool_result', 'protocol'],
          outputKinds: ['text', 'tool_call', 'protocol'], state: 'exact',
          counting: countTokens ? 'provider' : 'estimate'
        })
      } : {}),
      ...(id === 'openai-codex' ? { reasoning: { strategies: ['effort'], efforts: ['low', 'high'], canDisable: false, separateOutput: true } } : {})
    },
    modalities: { input: ['text'], output: ['text'] },
    limits: { contextTokens, outputTokens: 4096 },
    supportedParameters: ['tools', ...(id === 'openai-codex' ? ['reasoning'] : ['temperature', 'topP', 'maxOutputTokens']), ...(id === 'claude' ? [] : ['responseFormat'])]
  };
  const modelProfiles = { [model]: definition };
  const reply = (body) => {
    bodies.push(body);
    return respond(body);
  };
  if (id === 'openai' || id === 'openai-codex') {
    const fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      const text = reply(body);
      const response = {
        id: `resp-${bodies.length}`, model, status: 'completed',
        output: [
          ...(opaqueReasoning ? [{ type: 'reasoning', id: 'reasoning-1', encrypted_content: 'original-opaque+/=', summary: [] }] : []),
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }
        ],
        usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 }
      };
      return body.stream ? sse([
        { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
        { type: 'response.output_text.delta', delta: text },
        { type: 'response.completed', response }
      ]) : Response.json(response);
    };
    return id === 'openai' ? new OpenAIProvider({ apiKey: 'test', modelProfiles, fetch })
      : new OpenAICodexProvider({
        modelProfiles, fetch, transport: 'http_sse',
        auth: {
          describe: () => ({ type: 'bearer', label: 'test' }),
          getBearerToken: async () => ({ token: `header.${Buffer.from(JSON.stringify({
            'https://api.openai.com/auth': { chatgpt_account_id: 'account' }
          })).toString('base64url')}.signature` }),
          async invalidate() {}
        }
      });
  }
  if (id === 'openrouter') return new OpenRouterProvider({ apiKey: 'test', fetch: async (_url, init) => {
    if (!init?.body) return Response.json({ data: [{
      id: model, context_length: contextTokens,
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      top_provider: { context_length: contextTokens, max_completion_tokens: 4096 },
      supported_parameters: ['tools', 'max_tokens', 'temperature', 'top_p', 'response_format']
    }] });
    const body = JSON.parse(init.body);
    const text = reply(body);
    const reasoning = opaqueReasoning ? { reasoning_details: [{ type: 'reasoning.encrypted', data: 'original-opaque+/=', id: 'reasoning-1', index: 0 }] } : {};
    const response = {
      id: `gen-${bodies.length}`, model,
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text, ...reasoning } }],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 }
    };
    return body.stream ? sse([
      { id: response.id, model, choices: [{ finish_reason: null, delta: { content: text, ...reasoning } }] },
      { id: response.id, model, choices: [{ finish_reason: 'stop', delta: {} }], usage: response.usage }
    ]) : Response.json(response);
  } });
  if (id === 'ollama') return new OllamaProvider({ modelProfiles, clientFactory: () => ({
    async chat(body) {
      const content = reply(body);
      return (async function* () {
        yield { model, message: { role: 'assistant', content, thinking: 'Original thinking.' },
          done: true, done_reason: 'stop', prompt_eval_count: 20, eval_count: 10 };
      })();
    },
    abort() {}
  }) });
  if (id === 'claude') return new ClaudeProvider({ apiKey: 'test', modelProfiles, countTokens, fetch: async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).endsWith('/count_tokens'))
      return Response.json({ input_tokens: Math.ceil(JSON.stringify(body).length / 3) });
    const tool = firstTool && bodies.length === 0 ? [{ type: 'tool_use', id: 'inspection-call', name: firstTool, input: {} }] : [];
    return Response.json({
      id: `msg-${bodies.length}`, type: 'message', role: 'assistant', model, stop_reason: tool.length ? 'tool_use' : 'end_turn',
      content: [thinking, { type: 'text', text: reply(body) }, ...tool], usage: { input_tokens: 20, output_tokens: 10 }
    });
  } });
  throw new Error(`Unknown fixture provider: ${id}`);
}

function sse(chunks) {
  return new Response([...chunks.map(chunk => `data: ${JSON.stringify(chunk)}`), 'data: [DONE]'].join('\n\n'), {
    headers: { 'content-type': 'text/event-stream' }
  });
}
