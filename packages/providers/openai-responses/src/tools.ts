import type { ModelTool } from '@agent-core/model';

/** Preserve the application's schema; Responses otherwise normalizes optional fields to required. */
export function responsesTool(tool: ModelTool): Record<string, unknown> {
  const scheduling = tool.async === undefined ? {} : { async: tool.async };
  if (tool.type === 'custom') {
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
