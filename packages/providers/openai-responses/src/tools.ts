import { ModelProviderError, type ModelTool } from '@agent-core/model';

/** Preserve the application's schema; Responses otherwise normalizes optional fields to required. */
export function responsesTool(tool: ModelTool): Record<string, unknown> {
  const scheduling = {
    ...(tool.async === undefined ? {} : { async: tool.async }),
    ...(tool.deferLoading === undefined ? {} : { defer_loading: tool.deferLoading }),
    ...(tool.allowedCallers === undefined ? {} : { allowed_callers: tool.allowedCallers }),
    ...(tool.outputSchema === undefined ? {} : { output_schema: tool.outputSchema })
  };
  if (tool.type === 'custom') {
    if (tool.outputSchema !== undefined) throw new ModelProviderError({ provider: 'openai', code: 'invalid_request',
      message: 'Responses custom tools do not support output_schema; use a function tool for a declared result schema.' });
    return {
      type: 'custom',
      ...scheduling,
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      format: tool.format
    };
  }
  return {
    type: 'function',
    ...scheduling,
    name: tool.function.name,
    strict: false,
    ...(tool.function.description ? { description: tool.function.description } : {}),
    ...(tool.function.parameters ? { parameters: tool.function.parameters } : {})
  };
}
