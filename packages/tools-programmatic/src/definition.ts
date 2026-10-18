import * as z from 'zod';
import type { ProgramExecutionHost } from '@agent-core/runtime';
import { defineTool, requireToolService, ToolInputError } from '@agent-core/tools';
import { parseProgramLimits, type ProgramLimits } from './limits.js';

export interface ProgrammaticToolOptions {
  readonly name?: string;
  readonly limits?: Partial<ProgramLimits>;
}

/** Register with the runtime's programRunner using the same exact tool name. */
export function createProgrammaticTool(options: ProgrammaticToolOptions = {}) {
  const name = options.name ?? 'run_program';
  const limits = parseProgramLimits(options.limits ?? {});
  return defineTool({
    name,
    implementationId: 'agent-core.programmatic.v1',
    description:
      'Run an isolated JavaScript async function body. Use await call(name, input) to invoke tools from the tools manifest. Each call returns a durable host receipt. Return a JSON value. No filesystem, network, environment, modules, timers, or credentials are available.',
    invocationModes: ['direct'],
    schema: z.strictObject({ source: z.string().min(1).max(limits.sourceBytes) }),
    outputSchema: z.json(),
    textInput: {
      format: { type: 'text' },
      description: 'A JavaScript async function body using call(name, input) and tools.',
      decode: (source) => ({ source })
    },
    requirements: { services: ['programExecution'] },
    isAvailable: () => true,
    effectEnvelope: { accesses: [], lockScopes: [] },
    canonicalizeInput(input) {
      if (new TextEncoder().encode(input.source).byteLength > limits.sourceBytes)
        throw new ToolInputError('Program source exceeds its UTF-8 byte limit.');
      return input;
    },
    deriveEffects: () => ({ accesses: [], lockScopes: [], recovery: { kind: 'unknown' } }),
    async invoke(input, context) {
      const host = requireToolService<ProgramExecutionHost>(
        context,
        'programExecution',
        isProgramExecutionHost,
        'runtime-owned program execution host'
      );
      return host.execute(input, context);
    }
  });
}

function isProgramExecutionHost(value: unknown): value is ProgramExecutionHost {
  return typeof value === 'object' && value !== null &&
    'execute' in value && typeof value.execute === 'function';
}
