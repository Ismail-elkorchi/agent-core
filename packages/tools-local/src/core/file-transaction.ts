import { isWorkspaceFiles, throwIfAborted, type WorkspaceFileMutation } from '@agent-core/tools';
import * as z from 'zod';
import type { FileReadIdentity } from './file-read.js';
import type { FileAuthority } from './rooted-files.js';
import type {
  TextPatchJournalAuthority,
  TextTransactionOptions,
  TextTransactionResult
} from './text-write.js';

export type FileTransactionResult = TextTransactionResult | { readonly outcome: 'committed' };

const diagnosticSchema = z.strictObject({
  action: z.string(), path: z.string(), message: z.string(), code: z.string().optional()
});
const recoverySchema = z.strictObject({
  status: z.enum(['succeeded', 'failed', 'uncertain']),
  diagnostics: z.array(diagnosticSchema), strandedPaths: z.array(z.string())
});
export const fileTransactionResultSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('committed'), cleanup: recoverySchema.optional() }),
  z.strictObject({ outcome: z.literal('committed_with_residue'), cleanup: recoverySchema }),
  z.strictObject({ outcome: z.literal('rolled_back'), failure: diagnosticSchema, rollback: recoverySchema }),
  z.strictObject({ outcome: z.literal('rollback_failed'), failure: diagnosticSchema, rollback: recoverySchema })
]);

export interface FileRevision {
  readonly identity: FileReadIdentity;
  readonly sha256: string;
  readonly bytes: number;
}

export interface FileWritePlan {
  readonly path: string;
  readonly content: string;
  readonly mode?: number;
  readonly expected: FileRevision | 'absent';
}

export interface FileRemovePlan {
  readonly path: string;
  readonly expected: FileRevision;
}

export interface FileTransactionPlan {
  readonly writes: readonly FileWritePlan[];
  readonly removes: readonly FileRemovePlan[];
  readonly parentDirsToCreate?: readonly string[];
}

/** Translate one validated text plan into the selected authority's native transaction. */
export async function commitFileTransaction(
  root: FileAuthority,
  plan: FileTransactionPlan,
  options: TextTransactionOptions,
  journal?: TextPatchJournalAuthority
): Promise<FileTransactionResult> {
  throwIfAborted(options.signal);
  if (!isWorkspaceFiles(root)) {
    if (!journal) throw new Error('A local file transaction requires its patch journal.');
    return journal.commit({
      writes: plan.writes.map(({ expected, ...write }) => expected === 'absent'
        ? { ...write, overwrite: false, expectedAbsent: true }
        : { ...write, overwrite: true, ...localPrecondition(expected) }),
      removes: plan.removes.map(({ path, expected }) => ({ path, ...localPrecondition(expected) })),
      ...(plan.parentDirsToCreate ? { parentDirsToCreate: plan.parentDirsToCreate } : {})
    }, options);
  }
  const mutations: WorkspaceFileMutation[] = [
    ...plan.writes.map((write): WorkspaceFileMutation => ({
      kind: 'write',
      path: write.path,
      bytes: Buffer.from(write.content, 'utf8'),
      mode: write.mode ?? 0o644,
      expected: write.expected === 'absent'
        ? { kind: 'absent' }
        : workspacePrecondition(write.expected)
    })),
    ...plan.removes.map((remove): WorkspaceFileMutation => ({
      kind: 'remove', path: remove.path, expected: workspacePrecondition(remove.expected)
    }))
  ];
  await root.transaction(mutations);
  return { outcome: 'committed' };
}

function localPrecondition(revision: FileRevision) {
  if (revision.identity.kind !== 'rooted') throw new Error('File revision belongs to a different authority.');
  return { expectedCurrentSha256: revision.sha256, expectedCurrentIdentity: revision.identity.value };
}

function workspacePrecondition(revision: FileRevision) {
  if (revision.identity.kind !== 'workspace') throw new Error('File revision belongs to a different authority.');
  return { kind: 'matches' as const, size: revision.bytes, digest: revision.sha256 };
}
