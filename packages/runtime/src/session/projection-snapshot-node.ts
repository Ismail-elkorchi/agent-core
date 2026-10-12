import * as z from 'zod';
import type { HistoryLedgerHead } from '../history/contracts.js';
import {
  branchNavigation,
  branchSourceMetadata,
  type BranchEntryPosition,
  type BranchPageSource
} from './branch-page.js';
import type { SessionSourceMetadata, SessionSourceSnapshot } from './contracts.js';
import { SessionIndexNodeError } from './projection-tree-node.js';

export interface SessionIndexState {
  readonly branchId: string;
  readonly contextId: string | null;
  readonly lookupRoot: string | null;
  readonly inheritedHeadsRoot: string | null;
  readonly activeRunsRoot: string | null;
  readonly finalizedRunsRoot: string | null;
  readonly unconfirmedRunsRoot: string | null;
  readonly confirmedRunsRoot: string | null;
}

interface ProjectionSnapshotTree {
  get(root: string | null, key: string): Promise<unknown>;
  entries(root: string | null): AsyncIterable<readonly [string, unknown]>;
}

const id = z.string().min(1);
const rootHash = z.string().regex(/^[a-f0-9]{64}$/u).nullable();
const stateSchema = z.strictObject({
  branchId: id,
  contextId: id.nullable(),
  lookupRoot: rootHash,
  inheritedHeadsRoot: rootHash,
  activeRunsRoot: rootHash,
  finalizedRunsRoot: rootHash,
  unconfirmedRunsRoot: rootHash,
  confirmedRunsRoot: rootHash
}).readonly();
const pointerSchema = z.strictObject({ entryId: id }).readonly();
const countSchema = z.strictObject({ count: z.number().int().nonnegative() }).readonly();
const activeRunSchema = z.strictObject({ entriesRoot: rootHash }).readonly();
const activeEntrySchema = pointerSchema.unwrap().extend({ depth: z.number().int().nonnegative() }).readonly();
const finalizationSchema = z.strictObject({ runId: id, throughEntryId: id, finalizationId: id }).readonly();
const unconfirmedSchema = z.strictObject({ runId: id, finalized: z.boolean() }).readonly();
const headSchema = z.strictObject({
  runId: id,
  sequence: z.number().int().min(-1),
  hash: z.string().regex(/^[a-f0-9]{64}$/u).optional()
}).readonly();

function invalid(detail: string): never {
  throw new SessionIndexNodeError(`Invalid session snapshot projection: ${detail}`);
}

/** Captured roots provide point lookups without loading the preceding branch metadata. */
export async function createProjectionSnapshot(
  source: BranchPageSource,
  sourceRevision: number,
  leafId: string | null,
  state: SessionIndexState | undefined,
  tree: ProjectionSnapshotTree
): Promise<SessionSourceSnapshot> {
  const checked = async <T>(operation: () => Promise<T>): Promise<T> => {await source.validate(); return operation();};
  await source.validate();
  z.number().int().nonnegative().parse(sourceRevision);
  const captured = state === undefined ? undefined : stateSchema.parse({
    branchId: state.branchId,
    contextId: state.contextId,
    lookupRoot: state.lookupRoot,
    inheritedHeadsRoot: state.inheritedHeadsRoot,
    activeRunsRoot: state.activeRunsRoot,
    finalizedRunsRoot: state.finalizedRunsRoot,
    unconfirmedRunsRoot: state.unconfirmedRunsRoot,
    confirmedRunsRoot: state.confirmedRunsRoot
  });
  const leaf = leafId === null ? undefined : await source.readPosition(leafId);
  if (leafId !== null && (!leaf || !captured)) invalid('selected leaf or branch state is missing.');
  if (leafId === null && captured !== undefined) invalid('empty branch has nonempty branch state.');
  const boundary = Object.freeze({ sessionId: source.sessionId, leafId, leafHash: leaf?.hash ?? null });
  const navigation = await branchNavigation(source, boundary);

  const selectedPosition = async (entryId: string): Promise<BranchEntryPosition | undefined> => {
    const value = await source.readPosition(entryId);
    if (value === undefined) return undefined;
    return (await navigation.at(value.depth))?.metadata.entryId === entryId ? value : undefined;
  };
  const byId = async (entryId: string): Promise<SessionSourceMetadata | undefined> => {
    const value = await selectedPosition(entryId);
    return value === undefined ? undefined : branchSourceMetadata(entryId, value);
  };
  const pointedPosition = async (key: string) => {
    const value = await tree.get(captured?.lookupRoot ?? null, key);
    if (value === undefined) return undefined;
    const { entryId } = pointerSchema.parse(value);
    const position = await selectedPosition(entryId);
    if (position === undefined) invalid(`lookup ${key} is outside its branch.`);
    return { entryId, position };
  };
  const pointedMetadata = async (key: string, matches: (metadata: SessionSourceMetadata) => boolean) => {
    const value = await pointedPosition(key);
    if (value === undefined) return undefined;
    const metadata = branchSourceMetadata(value.entryId, value.position);
    if (!matches(metadata)) invalid(`lookup ${key} has a different identity.`);
    return metadata;
  };
  const runPosition = async (runId: string, input: boolean): Promise<number | undefined> => {
    const value = await pointedPosition(`${input ? 'input' : 'run'}:${runId}`);
    if (value === undefined) return undefined;
    if (value.position.runId !== runId || (input && value.position.type !== 'input'))
      invalid(`run lookup ${runId} has a different identity.`);
    return value.position.depth;
  };
  const isFinalized = async (runId: string): Promise<boolean> => {
    const value = await tree.get(captured?.finalizedRunsRoot ?? null, runId);
    if (value === undefined) return false;
    const record = finalizationSchema.parse(value);
    if (record.runId !== runId) invalid('finalization run identity changed.');
    return await selectedPosition(record.throughEntryId) !== undefined;
  };
  const readHeads = async (): Promise<ReadonlyMap<string, HistoryLedgerHead>> => {
    const heads = new Map<string, HistoryLedgerHead>();
    for await (const [key, value] of tree.entries(captured?.inheritedHeadsRoot ?? null)) {
      const head = headSchema.parse(value);
      if (head.runId !== key || heads.has(key)) invalid('inherited run head identity changed.');
      heads.set(key, head);
    }
    return heads;
  };
  const readLatestContext = async (): Promise<SessionSourceMetadata | undefined> => {
    if (!captured?.contextId) return undefined;
    const metadata = await byId(captured.contextId);
    if (metadata?.type !== 'context_transition') invalid('latest context is missing or has a different type.');
    return metadata;
  };
  let inheritedHeads: Promise<ReadonlyMap<string, HistoryLedgerHead>> | undefined;
  let latestContext: Promise<SessionSourceMetadata | undefined> | undefined;

  const snapshot: SessionSourceSnapshot = {
    boundary,
    sourceRevision,
    branchId: captured?.branchId ?? source.sessionId,
    entries: Object.freeze({
      length: navigation.length,
      at: (index: number) => checked(async () => {
        if (!Number.isSafeInteger(index)) return undefined;
        const value = await navigation.at(index < 0 ? navigation.length + index : index);
        return value === undefined ? undefined : branchSourceMetadata(value.metadata.entryId, value.metadata);
      }),
      async *[Symbol.asyncIterator]() {
        for (let depth = 0; depth < navigation.length; depth++) {
          const value = await checked(() => navigation.at(depth));
          if (value === undefined) invalid('branch entry is missing.');
          yield branchSourceMetadata(value.metadata.entryId, value.metadata);
        }
      }
    }),
    index: Object.freeze({
      async *exchange(exchangeId: string) {
        await source.validate();
        const value = await tree.get(captured?.lookupRoot ?? null, `exchange-count:${exchangeId}`);
        if (value === undefined) return;
        const { count } = countSchema.parse(value);
        for (let index = 0; index < count; index++) {
          await source.validate();
          const metadata = await pointedMetadata(`exchange-entry:${exchangeId}:${String(index)}`,
            entry => entry.context.exchangeId === exchangeId);
          if (metadata === undefined) invalid('exchange member is missing.');
          yield metadata;
        }
      },
      byId: Object.freeze({ get: (entryId: string) => checked(() => byId(entryId)), has: (entryId: string) => checked(async () => await selectedPosition(entryId) !== undefined) }),
      bySource: Object.freeze({ get: (key: string) => checked(() => pointedMetadata(`source:${key}`,
        entry => (entry.source ? `event:${entry.source.eventId}` : entry.entryId) === key)) }),
      byIdentity: Object.freeze({ get: (identity: string) => checked(() => pointedMetadata(`identity:${identity}`, entry => entry.identity === identity)) }),
      runs: Object.freeze({
        has: (runId: string) => checked(async () => await runPosition(runId, false) !== undefined),
        lastPosition: (runId: string) => checked(() => runPosition(runId, false))
      }),
      positions: Object.freeze({ get: (entryId: string) => checked(async () => (await selectedPosition(entryId))?.depth) }),
      inputs: Object.freeze({ get: (runId: string) => checked(() => runPosition(runId, true)) })
    }),
    get inheritedHeads() { return inheritedHeads ??= checked(readHeads); },
    finalizedRuns: Object.freeze({ has: (runId: string) => checked(() => isFinalized(runId)) }),
    get latestContext() { return latestContext ??= checked(readLatestContext); },
    async confirmedHead(runId: string) {
      await source.validate();
      const value = await tree.get(captured?.confirmedRunsRoot ?? null, runId);
      if (value === undefined) return undefined;
      const head = headSchema.parse(value);
      if (head.runId !== runId) invalid('confirmed run head identity changed.');
      return await isFinalized(runId) ? head : undefined;
    },
    async *unconfirmedRuns() {
      await source.validate();
      for await (const [key, value] of tree.entries(captured?.unconfirmedRunsRoot ?? null)) {
        await source.validate();
        const run = unconfirmedSchema.parse(value);
        if (run.runId !== key) invalid('unconfirmed run identity changed.');
        if (await runPosition(run.runId, false) === undefined) invalid('unconfirmed run is outside its branch.');
        yield run;
      }
    },
    async *activeInputs() {
      await source.validate();
      const entries: { readonly runId: string; readonly entryId: string; readonly depth: number }[] = [];
      const seen = new Set<string>();
      for await (const [runId, value] of tree.entries(captured?.activeRunsRoot ?? null)) {
        id.parse(runId);
        const run = activeRunSchema.parse(value);
        if (await isFinalized(runId)) continue;
        for await (const [, item] of tree.entries(run.entriesRoot)) {
          const entry = activeEntrySchema.parse(item);
          if (seen.has(entry.entryId)) invalid('active input occurs more than once.');
          seen.add(entry.entryId);
          entries.push({ runId, ...entry });
        }
      }
      entries.sort((left, right) => left.depth - right.depth);
      for (const entry of entries) {
        await source.validate();
        const value = await selectedPosition(entry.entryId);
        if (value?.depth !== entry.depth || value.runId !== entry.runId ||
            (value.type !== 'input' && value.type !== 'steering'))
          invalid('active input identity or branch position changed.');
        yield branchSourceMetadata(entry.entryId, value);
      }
    }
  };
  return Object.freeze(snapshot);
}
