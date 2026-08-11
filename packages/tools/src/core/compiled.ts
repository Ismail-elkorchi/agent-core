import type { ToolDefinition } from './definition.js';

declare const compiledTool: unique symbol;
export type CompiledToolDefinition<TDecodedInput = unknown, TCanonicalInput = TDecodedInput, TOutput = unknown> =
  ToolDefinition<TDecodedInput, TCanonicalInput, TOutput> & { readonly [compiledTool]: true };

const compiledTools = new WeakSet();

export function markCompiledTool<T extends ToolDefinition>(tool: T): T & CompiledToolDefinition {
  compiledTools.add(tool);
  return tool as T & CompiledToolDefinition;
}

export function isCompiledTool(tool: unknown): tool is CompiledToolDefinition { return typeof tool === 'object' && tool !== null && compiledTools.has(tool); }
