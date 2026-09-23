import { indexLines, positionOffset, boundedDiffSummary } from '../tools/edit-text/text.js';
import { viewImageTool } from '../tools/view-image/definition.js';
import { searchTextTool } from '../tools/search-text/definition.js';
import { findFilesTool } from '../tools/find-files/definition.js';
import { listDirectoryTool } from '../tools/list-directory/definition.js';
import { operationAccesses } from '../tools/apply-patch/effects.js';
import { createHash } from 'node:crypto';
import type { ArtifactRepository } from '@agent-core/persistence';
import {
  defineTool,
  isRiskAllowed,
  isWorkspaceFiles,
  requireToolService,
  ToolInputError,
  type CommandExecution,
  type CompiledToolDefinition,
  type WorkspaceFileMutation,
  type WorkspaceFiles
} from '@agent-core/tools';
import { APPLY_PATCH_LARK_GRAMMAR } from '../tools/apply-patch/grammar.js';
import { APPLY_PATCH_PROMPT_GUIDE } from '../tools/apply-patch/prompt-guide.js';
import { PatchApplyError, applyPatchUpdate } from '../tools/apply-patch/apply-diff.js';
import { PatchParseError, parseApplyPatch } from '../tools/apply-patch/patch-parser.js';
import {
  applyPatchInputSchema,
  applyPatchOutputSchema,
  type ApplyPatchFileOutput,
  type PatchMatchMode
} from '../tools/apply-patch/schema.js';
import {
  DEFAULT_LOCAL_TOOL_CONFIGURATION,
  requireLocalToolConfiguration,
  type LocalToolConfiguration
} from './configuration.js';
import { createExecCommandTool } from '../tools/exec-command/definition.js';
import {
  editTextInputSchema,
  editTextOutputSchema,
  type EditTextFileOutput
} from '../tools/edit-text/schema.js';
import { fileScope } from './resources.js';
import { readArtifactTool } from '../tools/read-artifact/definition.js';
import {
  readFilesInputSchema,
  readFilesOutputSchema,
  type ReadFileResult,
  type ReadFileFailure
} from '../tools/read-files/schema.js';
import { stopProcessTool } from '../tools/stop-process/definition.js';
import { writeStdinTool } from '../tools/write-stdin/definition.js';
import {
  buildReadFilesContent,
  buildEditTextContent,
  buildApplyPatchContent
} from './model-content.js';

const textDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const textEncoder = new TextEncoder();

export interface WorkspaceToolHost {
  readonly tools: readonly CompiledToolDefinition[];
  readonly services: Readonly<Record<string, unknown>>;
}

/** Compose tools over one workspace and its native transaction authority. */
export function createWorkspaceToolHost(options: {
  readonly files: WorkspaceFiles;
  readonly artifacts: ArtifactRepository;
  readonly commandExecution?: CommandExecution;
  readonly enabledTools: readonly string[];
  readonly configuration?: LocalToolConfiguration;
}): WorkspaceToolHost {
  const configuration = options.configuration ?? DEFAULT_LOCAL_TOOL_CONFIGURATION;
  const services = Object.freeze({
    workspaceFiles: options.files,
    artifactRepository: options.artifacts,
    localToolConfiguration: configuration,
    ...(options.commandExecution ? { commandExecution: options.commandExecution } : {})
  });
  const all = Object.freeze([
    listDirectoryTool,
    findFilesTool,
    readFilesTool,
    searchTextTool,
    editTextTool,
    applyPatchTool,
    ...(options.commandExecution
      ? [
          createExecCommandTool({
            ptySupported: options.commandExecution.descriptor.supportsPty,
            environmentLifetimeSupported:
              options.commandExecution.descriptor.capabilities.includes('environment-lifetime')
          })
        ]
      : []),
    writeStdinTool,
    stopProcessTool,
    viewImageTool,
    readArtifactTool
  ]);
  const known = new Set(all.map((tool) => tool.name));
  const unknown = options.enabledTools.filter((name) => !known.has(name));
  if (unknown.length > 0) throw new Error(`Unknown workspace tools: ${unknown.join(', ')}.`);
  const tools = Object.freeze(all.filter((tool) => options.enabledTools.includes(tool.name)));
  return Object.freeze({
    tools,
    services
  });
}

const readFilesTool = defineTool({
  name: 'read_files',
  implementationId: 'agent-core.workspace-read-files@1',
  description: 'Read line ranges from workspace text files with complete-file hashes.',
  schema: readFilesInputSchema,
  outputSchema: readFilesOutputSchema,
  buildModelContent: buildReadFilesContent,
  requirements: { services: ['workspaceFiles', 'localToolConfiguration'] },
  effectEnvelope: { accesses: [{ mode: 'read', scope: 'files' }], lockScopes: [] },
  canonicalizeInput(input, context) {
    const authority = files(context);
    return {
      ...input,
      files: input.files.map((item) => ({ ...item, path: authority.normalize(item.path) }))
    };
  },
  deriveEffects(input) {
    return {
      accesses: input.files.map((item) => ({ mode: 'read' as const, scope: fileScope(item.path) })),
      lockScopes: [],
      recovery: { kind: 'unknown' as const }
    };
  },
  async invoke(input, context) {
    const authority = files(context);
    const limits = configuration(context).readFiles;
    if (input.files.length > limits.maxFiles)
      throw new ToolInputError(`read_files accepts at most ${String(limits.maxFiles)} files.`);
    const successful: ReadFileResult[] = [];
    const failures: ReadFileFailure[] = [];
    let returnedBytes = 0;
    for (const request of input.files) {
      try {
        const loaded = await authority.readFile(request.path, {
          maximumBytes: limits.maxBytesPerFile
        });
        const content = decodeText(loaded.bytes);
        const lines = content.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
        if (request.startLine > Math.max(1, lines.length)) throw new Error('start_after_eof');
        const maximumLines = Math.min(
          request.lineCount ?? limits.maxLinesPerFile,
          limits.maxLinesPerFile
        );
        const selected = lines.slice(request.startLine - 1, request.startLine - 1 + maximumLines);
        const selectedText = selected.join('');
        const rangeBytes = textEncoder.encode(selectedText);
        if (returnedBytes + rangeBytes.byteLength > limits.maxTotalBytes)
          throw new Error('batch_byte_limit');
        returnedBytes += rangeBytes.byteLength;
        const eof = request.startLine - 1 + selected.length >= lines.length;
        successful.push({
          path: request.path,
          startLine: request.startLine,
          lineCount: selected.length,
          content: selectedText,
          bytes: rangeBytes.byteLength,
          fileBytes: loaded.bytes.byteLength,
          eof,
          truncated: !eof,
          ...(!eof ? { nextStartLine: request.startLine + selected.length } : {}),
          rangeSha256: sha256(rangeBytes),
          fullFileSha256: loaded.revision.digest,
          newlineConvention: newlineConvention(content),
          utf8Validation: 'valid'
        });
      } catch (error) {
        const reason =
          error instanceof Error && error.message === 'start_after_eof'
            ? 'start_after_eof'
            : error instanceof TypeError
              ? 'invalid_utf8'
              : error instanceof Error && error.message === 'batch_byte_limit'
                ? 'batch_byte_limit'
                : 'unreadable';
        failures.push({ path: request.path, reason, message: message(error) });
      }
    }
    const output = {
      files: successful,
      failures,
      coverage:
        failures.length === 0 && successful.every((file) => !file.truncated)
          ? ('complete' as const)
          : ('partial' as const),
      requestedFiles: input.files.length,
      returnedFiles: successful.length,
      failedFiles: failures.length,
      returnedBytes
    };
    return result(`Read ${String(successful.length)} files.`, 'files', output.coverage, output);
  }
});

const editTextTool = defineTool({
  name: 'edit_text',
  implementationId: 'agent-core.workspace-edit-text@1',
  description: 'Atomically replace exact Unicode-scalar ranges in workspace UTF-8 files.',
  schema: editTextInputSchema,
  outputSchema: editTextOutputSchema,
  buildModelContent: buildEditTextContent,
  requirements: { services: ['workspaceFiles', 'localToolConfiguration'] },
  effectEnvelope: {
    accesses: [
      { mode: 'read', scope: 'files' },
      { mode: 'write', scope: 'files' }
    ],
    lockScopes: ['files']
  },
  canonicalizeInput(input, context) {
    const authority = files(context);
    return {
      ...input,
      dryRun: input.dryRun || context.policy.dryRunWrites === true,
      files: input.files.map((item) => ({ ...item, path: authority.normalize(item.path) }))
    };
  },
  deriveEffects(input) {
    return {
      accesses: input.files.flatMap((item) => [
        { mode: 'read' as const, scope: fileScope(item.path) },
        ...(input.dryRun ? [] : [{ mode: 'write' as const, scope: fileScope(item.path) }])
      ]),
      lockScopes: input.dryRun ? [] : ['files'],
      recovery: { kind: 'unknown' as const }
    };
  },
  isAvailable: (policy) => isRiskAllowed(policy, 'read') || isRiskAllowed(policy, 'write'),
  async invoke(input, context) {
    const authority = files(context);
    const mutations: WorkspaceFileMutation[] = [];
    const outputs: EditTextFileOutput[] = [];
    const limits = configuration(context).editText;
    if (input.files.length > limits.maxFiles) throw new ToolInputError('Edit file limit exceeded.');
    uniquePaths(input.files.map((file) => file.path));
    const replacementBytes = input.files.reduce(
      (sum, file) =>
        sum +
        file.edits.reduce((bytes, edit) => bytes + Buffer.byteLength(edit.replacementText), 0),
      0
    );
    if (replacementBytes > limits.maxTotalReplacementBytes)
      throw new ToolInputError('Replacement byte limit exceeded.');
    for (const request of input.files) {
      if (request.edits.length > limits.maxEditsPerFile)
        throw new ToolInputError('Edit count limit exceeded.');
      const mode = await fileMode(authority, request.path);
      const loaded = await authority.readFile(request.path, {
        maximumBytes: configuration(context).editText.maxFileBytes
      });
      if (loaded.revision.digest !== request.expectedSha256)
        throw new ToolInputError(`File digest changed: ${request.path}`);
      const old = decodeText(loaded.bytes);
      const lines = indexLines(old);
      const edits = request.edits
        .map((edit) => ({
          edit,
          start: positionOffset(old, lines, edit.range.start.line, edit.range.start.column),
          end: positionOffset(old, lines, edit.range.end.line, edit.range.end.column)
        }))
        .sort((left, right) => right.start - left.start);
      let next = old;
      let previousStart = Number.POSITIVE_INFINITY;
      for (const planned of edits) {
        if (
          planned.end > previousStart ||
          planned.start === previousStart ||
          planned.end < planned.start ||
          next.slice(planned.start, planned.end) !== planned.edit.expectedText
        )
          throw new ToolInputError(`Edit precondition failed: ${request.path}`);
        next = `${next.slice(0, planned.start)}${planned.edit.replacementText}${next.slice(planned.end)}`;
        previousStart = planned.start;
      }
      const nextBytes = textEncoder.encode(next);
      const changed = next !== old;
      if (nextBytes.length > limits.maxNewBytesPerFile)
        throw new ToolInputError('Edited file exceeds its byte limit.');
      if (changed && !input.dryRun)
        mutations.push({
          kind: 'write',
          path: request.path,
          bytes: nextBytes,
          mode,
          expected: { kind: 'matches', ...loaded.revision }
        });
      outputs.push({
        path: request.path,
        oldSha256: loaded.revision.digest,
        newSha256: sha256(nextBytes),
        oldBytes: loaded.bytes.byteLength,
        newBytes: nextBytes.byteLength,
        changed,
        finalState: input.dryRun || !changed ? 'unchanged' : 'changed',
        newlineConvention: newlineConvention(old),
        changedRanges: request.edits.map((edit) => ({
          range: edit.range,
          expectedTextSha256: sha256(textEncoder.encode(edit.expectedText)),
          replacementTextSha256: sha256(textEncoder.encode(edit.replacementText)),
          expectedScalars: unicodeScalarCount(edit.expectedText),
          replacementScalars: unicodeScalarCount(edit.replacementText)
        }))
      });
    }
    if (mutations.length > 0) await authority.transaction(mutations);
    const changed = outputs.filter((item) => item.changed).map((item) => item.path);
    const output = {
      applicationStatus: input.dryRun
        ? ('dry_run' as const)
        : changed.length === 0
          ? ('no_change' as const)
          : ('applied' as const),
      ...(input.dryRun || changed.length === 0 ? {} : { transactionOutcome: 'committed' as const }),
      rootState: 'known' as const,
      dryRun: input.dryRun,
      files: outputs,
      changedPaths: input.dryRun ? [] : changed,
      wouldChangePaths: changed,
      potentiallyAffectedPaths: changed,
      diffSummary: {
        ...boundedDiffSummary(changed, limits.maxDiffSummaryBytes),
        totalChangedRanges: input.files.reduce((sum, item) => sum + item.edits.length, 0)
      }
    };
    return result(
      `${input.dryRun ? 'Planned' : 'Applied'} ${String(changed.length)} file edits.`,
      'files',
      'complete',
      output
    );
  }
});

const applyPatchTool = defineTool({
  name: 'apply_patch',
  implementationId: 'agent-core.workspace-apply-patch@1',
  description: 'Apply one Codex-style patch atomically through the filesystem service.',
  promptGuide: APPLY_PATCH_PROMPT_GUIDE,
  schema: applyPatchInputSchema,
  outputSchema: applyPatchOutputSchema,
  buildModelContent: buildApplyPatchContent,
  textInput: {
    description: 'Pass the patch document directly.',
    promptGuide: APPLY_PATCH_PROMPT_GUIDE,
    format: { type: 'grammar' as const, syntax: 'lark', definition: APPLY_PATCH_LARK_GRAMMAR },
    decode: (text: string) => ({ patch: text })
  },
  requirements: { services: ['workspaceFiles', 'localToolConfiguration'] },
  effectEnvelope: {
    accesses: [
      { mode: 'read', scope: 'files' },
      { mode: 'write', scope: 'files' },
      { mode: 'delete', scope: 'files' }
    ],
    lockScopes: ['files']
  },
  canonicalizeInput(input, context) {
    const limits = configuration(context).applyPatch;
    const tree = parseApplyPatch(input.patch, { maxPatchBytes: limits.maxPatchBytes });
    if (tree.operations.length > limits.maxOperations)
      throw new ToolInputError('Patch operation limit exceeded.');
    const authority = files(context);
    for (const operation of tree.operations) {
      operation.path = authority.normalize(operation.path);
      if (operation.kind === 'update' && operation.moveTo)
        operation.moveTo = authority.normalize(operation.moveTo);
    }
    return { ...input, dryRun: input.dryRun || context.policy.dryRunWrites === true, tree };
  },
  snapshotInput(input) {
    return {
      patch: input.patch,
      dryRun: input.dryRun,
      ...(input.expectedOldSha256 ? { expectedOldSha256: input.expectedOldSha256 } : {})
    };
  },
  deriveEffects(input) {
    return {
      accesses: input.tree.operations.flatMap((operation) =>
        operationAccesses(operation, input.dryRun)
      ),
      lockScopes: input.dryRun ? [] : ['files'],
      recovery: { kind: 'unknown' as const }
    };
  },
  isAvailable: (policy) => isRiskAllowed(policy, 'read') || isRiskAllowed(policy, 'write'),
  async invoke(input, context) {
    const authority = files(context);
    const mutations: WorkspaceFileMutation[] = [];
    const outputs: ApplyPatchFileOutput[] = [];
    const affected = new Set<string>();
    const limits = configuration(context).applyPatch;
    uniquePaths(
      input.tree.operations.flatMap((operation) =>
        operation.kind === 'update' && operation.moveTo
          ? [operation.path, operation.moveTo]
          : [operation.path]
      )
    );
    for (const pathname of Object.keys(input.expectedOldSha256 ?? {})) {
      if (
        authority.normalize(pathname) !== pathname ||
        !input.tree.operations.some(
          (operation) => operation.path === pathname && operation.kind !== 'add'
        )
      )
        throw new ToolInputError(`Invalid patch precondition path: ${pathname}`);
    }
    try {
      for (const operation of input.tree.operations) {
        const expectedDigest = input.expectedOldSha256?.[operation.path];
        if (operation.kind === 'add') {
          const bytes = textEncoder.encode(operation.content);
          if (bytes.length > limits.maxNewBytesPerFile)
            throw new ToolInputError('Added file exceeds its byte limit.');
          mutations.push({
            kind: 'write',
            path: operation.path,
            bytes,
            mode: 0o644,
            expected: { kind: 'absent' }
          });
          affected.add(operation.path);
          outputs.push(
            patchFile(
              operation.path,
              'add',
              undefined,
              undefined,
              bytes,
              operation.additions,
              0,
              0,
              true,
              []
            )
          );
          continue;
        }
        const mode = await fileMode(authority, operation.path);
        const loaded = await authority.readFile(operation.path, {
          maximumBytes: configuration(context).applyPatch.maxFileBytes
        });
        if (expectedDigest && loaded.revision.digest !== expectedDigest)
          throw new ToolInputError(`Patch digest changed: ${operation.path}`);
        if (operation.kind === 'delete') {
          mutations.push({
            kind: 'remove',
            path: operation.path,
            expected: { kind: 'matches', ...loaded.revision }
          });
          affected.add(operation.path);
          outputs.push(
            patchFile(
              operation.path,
              'delete',
              undefined,
              loaded.bytes,
              undefined,
              0,
              0,
              0,
              true,
              []
            )
          );
          continue;
        }
        const applied = applyPatchUpdate(decodeText(loaded.bytes), operation);
        const bytes = textEncoder.encode(applied.content);
        const destination = operation.moveTo ?? operation.path;
        if (bytes.length > limits.maxNewBytesPerFile)
          throw new ToolInputError('Patched file exceeds its byte limit.');
        if (!applied.changed && !operation.moveTo) {
          outputs.push(
            patchFile(
              operation.path,
              'update',
              undefined,
              loaded.bytes,
              bytes,
              applied.additions,
              applied.deletions,
              applied.hunkCount,
              false,
              applied.matchModes
            )
          );
          continue;
        }
        mutations.push({
          kind: 'write',
          path: destination,
          bytes,
          mode,
          expected: operation.moveTo ? { kind: 'absent' } : { kind: 'matches', ...loaded.revision }
        });
        if (operation.moveTo)
          mutations.push({
            kind: 'remove',
            path: operation.path,
            expected: { kind: 'matches', ...loaded.revision }
          });
        affected.add(operation.path);
        affected.add(destination);
        outputs.push(
          patchFile(
            operation.path,
            operation.moveTo ? 'move' : 'update',
            operation.moveTo,
            loaded.bytes,
            bytes,
            applied.additions,
            applied.deletions,
            applied.hunkCount,
            applied.changed || Boolean(operation.moveTo),
            applied.matchModes
          )
        );
      }
    } catch (error) {
      if (error instanceof PatchApplyError || error instanceof PatchParseError)
        throw new ToolInputError(error.message);
      throw error;
    }
    if (input.dryRun) {
      for (const mutation of mutations) {
        if (
          mutation.expected.kind === 'absent' &&
          (await authority.stat(mutation.path)).kind !== 'absent'
        )
          throw new ToolInputError(`Patch destination already exists: ${mutation.path}`);
      }
    } else if (mutations.length > 0) await authority.transaction(mutations);
    if (input.dryRun) for (const output of outputs) output.finalState = 'unchanged';
    const changed = [...affected];
    const created = outputs.filter((item) => item.operation === 'add').map((item) => item.path);
    const deleted = outputs.filter((item) => item.operation === 'delete').map((item) => item.path);
    const moved = outputs.flatMap((item) =>
      item.operation === 'move' && item.destinationPath !== undefined
        ? [{ sourcePath: item.path, destinationPath: item.destinationPath }]
        : []
    );
    const output = {
      applicationStatus: input.dryRun
        ? ('dry_run' as const)
        : changed.length === 0
          ? ('no_change' as const)
          : ('applied' as const),
      ...(!input.dryRun && changed.length > 0 ? { transactionOutcome: 'committed' as const } : {}),
      rootState: 'known' as const,
      dryRun: input.dryRun,
      files: outputs,
      changedPaths: input.dryRun ? [] : changed,
      wouldChangePaths: changed,
      createdPaths: input.dryRun ? [] : created,
      wouldCreatePaths: created,
      deletedPaths: input.dryRun ? [] : deleted,
      wouldDeletePaths: deleted,
      movedPaths: input.dryRun ? [] : moved,
      wouldMovePaths: moved,
      potentiallyAffectedPaths: changed,
      totalOperationCount: input.tree.operations.length,
      totalHunkCount: input.tree.hunkCount,
      totalAdditions: input.tree.additions,
      totalDeletions: input.tree.deletions
    };
    return result(
      `${input.dryRun ? 'Planned' : 'Applied'} ${String(input.tree.operations.length)} patch operations.`,
      'files',
      'complete',
      output
    );
  }
});

function result<T>(summary: string, scope: string, coverage: 'complete' | 'partial', output: T) {
  return { kind: 'result' as const, summary, scope: { resources: [scope], coverage }, output };
}
function files(context: import('@agent-core/tools').ToolExecutionContext): WorkspaceFiles {
  return requireToolService(context, 'workspaceFiles', isWorkspaceFiles, 'WorkspaceFiles');
}
const configuration = requireLocalToolConfiguration;
function decodeText(bytes: Uint8Array): string {
  if (bytes.includes(0)) throw new TypeError('Binary file');
  return textDecoder.decode(bytes);
}
function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function newlineConvention(value: string): 'lf' | 'crlf' | 'mixed' | 'none' {
  const crlf = (value.match(/\r\n/gu) ?? []).length;
  const lf = (value.match(/(?<!\r)\n/gu) ?? []).length;
  return crlf > 0 && lf > 0 ? 'mixed' : crlf > 0 ? 'crlf' : lf > 0 ? 'lf' : 'none';
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function unicodeScalarCount(value: string): number {
  return Array.from(value).length;
}
function patchFile(
  filePath: string,
  operation: 'add' | 'update' | 'delete' | 'move',
  destinationPath: string | undefined,
  oldBytes: Uint8Array | undefined,
  newBytes: Uint8Array | undefined,
  additions: number,
  deletions: number,
  hunkCount: number,
  changed: boolean,
  matchModes: readonly PatchMatchMode[]
): ApplyPatchFileOutput {
  return {
    path: filePath,
    operation,
    ...(destinationPath ? { destinationPath } : {}),
    hunkCount,
    additions,
    deletions,
    ...(oldBytes ? { oldSha256: sha256(oldBytes) } : {}),
    ...(newBytes ? { newSha256: sha256(newBytes) } : {}),
    oldBytes: oldBytes?.byteLength ?? 0,
    newBytes: newBytes?.byteLength ?? 0,
    plannedChange: changed,
    finalState: changed ? ('changed' as const) : ('unchanged' as const),
    ...(matchModes.length > 0
      ? { matchModes: [...matchModes], exact: matchModes.every((mode) => mode === 'exact') }
      : {})
  };
}

function uniquePaths(paths: readonly string[]): void {
  if (new Set(paths).size !== paths.length)
    throw new ToolInputError('A file may occur only once in a transaction.');
}
async function fileMode(authority: WorkspaceFiles, pathname: string): Promise<number> {
  const stat = await authority.stat(pathname);
  if (stat.kind !== 'file') throw new ToolInputError(`Not a regular file: ${pathname}`);
  return stat.mode;
}
