import {
  ModelProviderError,
  parseModelResponse,
  parseModelUsage,
  type ModelResponse,
  type ModelUsage
} from '@agent-core/model';

export function nativeFailure(
  code: ConstructorParameters<typeof ModelProviderError>[0]['code'],
  message: string
): ModelProviderError {
  return new ModelProviderError({ provider: 'openai', code, message });
}
function addUsage(responses: readonly ModelResponse[]): ModelUsage | undefined {
  if (responses.some((item) => !item.usage)) return undefined;
  const sum: Record<string, number> = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  for (const response of responses)
    for (const [key, value] of Object.entries(response.usage ?? {}))
      if (typeof value === 'number') sum[key] = (sum[key] ?? 0) + value;
  return parseModelUsage(sum);
}

export function aggregateResponses(responses: readonly ModelResponse[]): ModelResponse {
  const response = responses.at(-1);
  if (!response) throw nativeFailure('malformed_response', 'Missing native response settlement.');
  const usage = addUsage(responses);
  return parseModelResponse({
    ...response,
    content: responses.map((item) => item.content).join(''),
    output: responses.flatMap((item) => item.output ?? []),
    toolCalls: responses.flatMap((item) => item.toolCalls ?? []),
    ...(usage ? { usage } : {}),
    transport: {
      provider: 'openai',
      strategy: 'websocket_native',
      ...(response.requestId ? { responseId: response.requestId } : {})
    }
  });
}
