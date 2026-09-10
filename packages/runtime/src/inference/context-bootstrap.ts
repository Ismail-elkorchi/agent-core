import {
  assertRequestAccountingFits,
  modelInputIdentity,
  type ModelProfile,
  type ModelProvider
} from '@agent-core/model';
import type { CompiledToolDefinition } from '@agent-core/tools';
import type { ContextBootstrapPolicy } from '../context/service.js';
import { sourceRef } from '../history/reader.js';
import { requestWindowForModel, supportsParameter, toolsForModel } from '../orchestration/model-request.js';
import { replaySourceEntries, selectedHistoryEntries } from '../orchestration/session-replay.js';
import { encodeContextTransformReference } from './context-transform.js';
import { InferenceGateway } from './gateway.js';
import { ModelRequestAssembler } from './model-request-assembler.js';
import { ModelWindow } from './model-window.js';
import type { PromptContextItemInput, PromptInstructionBlock } from './prompt-material.js';
import type { InferenceService } from './service.js';

export interface RuntimeContextBootstrapOptions {
  readonly nativeTransform?: {
    readonly inference: InferenceService;
    readonly ownerId: () => string | Promise<string>;
  };
  readonly provider: ModelProvider;
  readonly model: string;
  readonly tools: () => readonly CompiledToolDefinition[] | Promise<readonly CompiledToolDefinition[]>;
  readonly instructions?: readonly PromptInstructionBlock[];
  readonly contextItems?: () =>
    | readonly PromptContextItemInput[]
    | Promise<readonly PromptContextItemInput[]>;
  readonly maxOutputTokens?: number;
  readonly task?: () => string | Promise<string>;
  /** The active runtime supplies pending calls; idle controls normally have none. */
  readonly pendingCallIds?: () => readonly string[];
}

/** Uses runtime assembly and provider compilation at the same boundary as normal inference. */
export function createRuntimeContextBootstrapValidator(
  options: RuntimeContextBootstrapOptions
): NonNullable<ContextBootstrapPolicy['validate']> {
  const gateway = new InferenceGateway(options.provider);
  return async ({ view, selection, notes, signal }) => {
    signal?.throwIfAborted();
    if ((options.pendingCallIds?.().length ?? 0) > 0)
      throw new Error(
        'context_admission_failed: synchronous provider calls still require their exact results.'
      );
    const profile: ModelProfile = await options.provider.describeModel(options.model);
    const window = new ModelWindow();
    const proposed = {
      windowId: 'bootstrap',
      parentWindowId: view.contextWindow?.windowId ?? null,
      historyPosition: view.cut,
      selection,
      reason: 'bootstrap validation',
      createdAt: new Date().toISOString()
    };
    const selected = selectedHistoryEntries({
      ...view,
      contextWindow: proposed
    });
    const calls = selected.filter((entry) => entry.type === 'tool_call');
    const results = selected.filter((entry) => entry.type === 'observation');
    if (
      calls.some(
        (call) =>
          !results.some(
            (result) =>
              result.runId === call.runId &&
              result.toolBatchId === call.toolBatchId &&
              result.callIndex === call.callIndex
          )
      ) ||
      results.some(
        (result) =>
          result.callId &&
          !calls.some((call) => call.runId === result.runId && call.callId === result.callId)
      )
    ) {
      throw new Error(
        'context_admission_failed: selected tool protocol contains an unmatched call or result.'
      );
    }
    let providerState: ReturnType<typeof encodeContextTransformReference> | undefined;
    if (selection.strategy === 'provider') {
      if (!options.nativeTransform)
        throw new Error(
          'context_admission_failed: native transformation requires governed inference and an owning budget identity.'
        );
      // Open obligations and the active run stay in their original protocol form.
      const finalized = new Set(view.runFinalizations.map((run) => run.runId));
      const represented = selected.filter((entry) => 'runId' in entry && finalized.has(entry.runId));
      if (represented.length === 0)
        throw new Error(
          'context_admission_failed: no completed source window is available for native transformation.'
        );
      const transformWindow = new ModelWindow();
      replaySourceEntries(transformWindow, view.cut.sessionId, represented, selection.representations);
      transformWindow.invalidateProviderState({
        provider: options.provider.id,
        model: options.model,
        ...(profile.capabilities.protocol ? { protocol: profile.capabilities.protocol } : {})
      });
      const sources = represented.map((entry) => sourceRef(view.cut.sessionId, entry));
      const invocationId = `context-transform-${(await modelInputIdentity({ sessionId: view.cut.sessionId, branchId: view.cut.branchId, sources, model: options.model })).slice(7)}`;
      const transformed = await options.nativeTransform.inference.transformContext({
        ownerId: await options.nativeTransform.ownerId(),
        invocationId,
        purpose: 'context_transformation',
        transformId: invocationId,
        request: {
          model: options.model,
          messages: transformWindow.priorMessagesFor(profile).messages,
          maxOutputTokens: requestWindowForModel(profile, options.maxOutputTokens).maxOutputTokens
        },
        profile,
        ...(signal ? { signal } : {})
      });
      for (const [index, item] of transformed.result.input.entries())
        window.recordSourceItem(`${invocationId}:${String(index)}`, item);
      const representedIds = new Set(sources.map((source) => source.entryId));
      replaySourceEntries(
        window,
        view.cut.sessionId,
        selected.filter((entry) => !representedIds.has(sourceRef(view.cut.sessionId, entry).entryId)),
        selection.representations
      );
      providerState = encodeContextTransformReference({
        format: 'agent-core.context-transform/1',
        ownerId: transformed.ownerId,
        invocationId,
        transformId: transformed.result.transformId,
        artifact: transformed.artifact,
        sources
      });
    } else replaySourceEntries(window, view.cut.sessionId, selected, selection.representations);
    window.invalidateProviderState({
      provider: options.provider.id,
      model: options.model,
      ...(profile.capabilities.protocol ? { protocol: profile.capabilities.protocol } : {})
    });
    const context: PromptContextItemInput[] = [...((await options.contextItems?.()) ?? [])];
    for (const note of notes) {
      if (note.status !== 'available' || note.truncated)
        throw new Error('context_admission_failed: selected note is unavailable or incomplete.');
      context.push({
        sourceUri: `note://${note.revision.scope.sessionId}/${note.revision.noteId}/${note.revision.revisionId}`,
        sourceKind: 'generated',
        representation: 'full',
        mediaType: note.revision.mediaType,
        title: note.revision.title,
        content: note.text,
        purpose: 'selected model note'
      });
    }
    const tools = await options.tools();
    const limits = requestWindowForModel(profile, options.maxOutputTokens);
    const assembled = new ModelRequestAssembler().assemble({
      window,
      task: (await options.task?.()) ?? '',
      instructions: options.instructions ?? [],
      contextItems: context,
      tools: [],
      modelProfile: profile
    });
    const compiled = await gateway.compile(
      {
        model: options.model,
        messages: assembled.messages,
        tools: toolsForModel([...tools], profile),
        ...(supportsParameter(profile, 'maxOutputTokens')
          ? { maxOutputTokens: limits.maxOutputTokens }
          : {}),
        ...(signal ? { signal } : {})
      },
      profile,
      { outputReservation: limits.maxOutputTokens }
    );
    assertRequestAccountingFits(compiled.accounting);
    return providerState ? { providerState } : undefined;
  };
}
