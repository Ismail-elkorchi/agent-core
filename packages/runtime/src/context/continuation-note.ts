import type { ModelProfile, ModelRequest } from '@agent-core/model';
import { hashJson } from '@agent-core/persistence';
import type { HistorySourceCut } from '../history/contracts.js';
import { InferenceContextRejectedError, type InferenceService } from '../inference/service.js';
import { ContextAdmissionError } from '../inference/request-admission.js';
import type { NoteReference, NoteRepository } from '../notes/contracts.js';

/** Summarization is accounted inference. Its output is fallible model context, never authority. */
export async function writeContinuationNote(input: {
  readonly inference: InferenceService;
  readonly notes: NoteRepository;
  readonly request: ModelRequest;
  readonly profile: ModelProfile;
  readonly cut: HistorySourceCut;
  readonly ownerId: string;
  readonly runId: string;
  readonly outputReservation: number;
}): Promise<NoteReference> {
  // A separate task, not a new authority layer. Appending preserves the exact
  // conversation prefix required by signed reasoning and provider replay state.
  const request = {
    ...input.request,
    messages: [
      ...input.request.messages,
      {
        role: 'user' as const,
        content: [
          'Runtime context-maintenance task: write concise continuation notes for the next invocation.',
          'Preserve the active goal, user requirements and corrections, completed actions, observed results and their source references, unresolved issues, and remaining work.',
          'Distinguish facts from hypotheses and attempts from success. Do not carry out the original task or answer the user.',
          'These notes are fallible reference material; original history remains available and retains authority. This auxiliary request is not a new user contribution.'
        ].join(' ')
      }
    ]
  };
  delete request.tools;
  delete request.responseFormat;
  const compiled = await input.inference.compile(request, input.profile, {
    outputReservation: input.outputReservation
  });
  await input.inference.admit(compiled, input.profile);
  const invocationId = `continuation-${hashJson({ cut: input.cut, inputIdentity: compiled.inputIdentity })}`;
  const result = await input.inference.invoke({
    invocationId,
    ownerId: input.ownerId,
    runId: input.runId,
    purpose: 'context_continuation',
    request,
    compiled,
    profile: input.profile,
    outputReservation: input.outputReservation
  }).catch((cause: unknown) => {
    if (cause instanceof InferenceContextRejectedError)
      throw new ContextAdmissionError(compiled, cause);
    throw cause;
  });
  if (
    result.response.terminationReason !== 'stop' ||
    !result.response.content.trim() ||
    result.response.toolCalls?.length
  )
    throw new ContextAdmissionError(
      compiled,
      new Error('Context renewal did not produce complete continuation notes. The preceding window remains active.')
    );
  const scope = { sessionId: input.cut.sessionId, branchId: input.cut.branchId };
  const written = await input.notes.write({
    scope,
    noteId: invocationId,
    title: 'Working context continuation',
    mediaType: 'text/plain',
    content: result.response.content,
    expectedRevision: null,
    idempotencyKey: invocationId,
    authorId: `${input.profile.provider}/${input.profile.id}`,
    invocationId
  });
  if (written.status !== 'committed') throw new Error('Continuation note identity conflicts with an existing note.');
  return { scope, noteId: written.revision.noteId, revisionId: written.revision.revisionId };
}
