import { parseJsonValue } from '@agent-core/json';
import { hashJson } from '@agent-core/persistence';
import { defineTool, textEditSchema, type CompiledToolDefinition } from '@agent-core/tools';
import * as z from 'zod';
import { invocationIdentity, scopePath } from '../history/tool-support.js';
import { WORKING_STATE_GUIDANCE } from '../session/working-state.js';
import type { ContextService } from './service.js';

export function createWorkingStateTool(context: ContextService): CompiledToolDefinition {
  const schema = z.strictObject({ edits: z.array(textEditSchema).min(1) });
  const observe = async (input: Parameters<ContextService['updateWorkingState']>[0]) => {
    const output = await context.updateWorkingState(input);
    return {
      kind: 'result' as const,
      execution: { state: 'settled' as const },
      summary: `Working-state update: ${output.status}.`,
      output: parseJsonValue(output),
      scope: {
        resources: [scopePath('working_state', input.sessionId, input.branchId)],
        coverage: 'complete' as const
      }
    };
  };
  return defineTool({
    name: 'update_working_state',
    implementationId: 'agent-core.update-working-state.v1',
    description: `${WORKING_STATE_GUIDANCE} Edit the current text using exact, nonoverlapping ranges in the state presented to this inference. All ranges address that original text; creation inserts at 1:1 in empty text. A whole-text replacement is allowed. Session, branch, expected revision and attribution are supplied by the runtime. Conflicts do not merge interpretations; retrieve the indicated original when the returned current state is incomplete.`,
    schema,
    outputSchema: z.json(),
    effectEnvelope: {
      accesses: [{ mode: 'write', scope: 'working_state' }],
      lockScopes: ['working_state']
    },
    async canonicalizeInput(input, planning) {
      if (!planning.invocation)
        throw new Error('Working-state update has no runtime invocation identity.');
      const origin = await context.workingStateOrigin(planning.invocation);
      const id = `working-state-${hashJson({ invocation: invocationIdentity(planning), edits: input.edits })}`;
      return { ...input, ...origin, id };
    },
    deriveEffects(input) {
      const scope = scopePath('working_state', input.sessionId, input.branchId);
      return {
        accesses: [{ mode: 'write', scope }],
        lockScopes: [scope],
        recovery: {
          kind: 'buffered_mutation',
          transactionId: input.id,
          reconcilerId: 'agent-core.working-state.v1',
          authority: scope
        }
      };
    },
    invoke: observe,
    async recover(input) {
      // Publication is conditional and idempotent in the session journal, so reconciliation
      // can safely finish a missing append or recover its already-committed receipt.
      return { status: 'settled', observation: await observe(input) };
    }
  });
}
