import type { ArtifactRepository, EventEnvelope, EventRepository } from '@agent-core/persistence';
import { parseJsonValue } from '@agent-core/json';
import type { ModelOutputItem } from '@agent-core/model';
import type { AgentEvent } from '../events.js';
import type {
  SessionAssistantEntry,
  SessionBranchEntry,
  SessionRunFinalization
} from '../session/contracts.js';
import type { HistoryLedgerHead } from './contracts.js';

interface CachedRun {
  readonly sequence: number;
  readonly hash?: string;
  readonly records: readonly EventEnvelope<AgentEvent>[];
  readonly finalizationId?: string;
}
const caches = new WeakMap<EventRepository<AgentEvent>, Map<string, CachedRun>>();
interface JoinedRun {
  readonly key: string;
  readonly mirrors: readonly SessionBranchEntry[];
  readonly replacements: ReadonlyMap<string, SessionBranchEntry>;
  readonly additions: readonly SessionBranchEntry[];
  readonly head?: HistoryLedgerHead;
}
const joinedCaches = new WeakMap<EventRepository<AgentEvent>, Map<string, JoinedRun>>();

/** Read each immutable run once per head; event order, never cross-ledger timestamps, determines causal order. */
export async function joinHistoryLedgers(input: {
  readonly entries: readonly SessionBranchEntry[];
  readonly finalizations: readonly SessionRunFinalization[];
  readonly events: EventRepository<AgentEvent>;
  readonly artifacts?: ArtifactRepository;
  readonly heads?: readonly HistoryLedgerHead[];
  readonly inheritedHeads?: readonly HistoryLedgerHead[];
}): Promise<{
  readonly entries: readonly SessionBranchEntry[];
  readonly heads: readonly HistoryLedgerHead[];
}> {
  const entriesByRun = new Map<string, SessionBranchEntry[]>();
  for (const entry of input.entries) {
    if (!('runId' in entry)) continue;
    const group = entriesByRun.get(entry.runId) ?? [];
    group.push(entry);
    entriesByRun.set(entry.runId, group);
  }
  let joinCache = joinedCaches.get(input.events);
  if (!joinCache) {
    joinCache = new Map();
    joinedCaches.set(input.events, joinCache);
  }
  const runIds = [...entriesByRun.keys()];
  const finalizations = new Map(input.finalizations.map((record) => [record.runId, record]));
  const capturedHeads = new Map(input.heads?.map((head) => [head.runId, head]));
  const inheritedHeads = new Map(input.inheritedHeads?.map((head) => [head.runId, head]));
  const heads: HistoryLedgerHead[] = [];
  const additions = new Map<string, readonly SessionBranchEntry[]>();
  const replacements = new Map<string, SessionBranchEntry>();
  for (const runId of runIds) {
    const explicit = capturedHeads.get(runId);
    const inherited = inheritedHeads.get(runId);
    const limit = explicit ?? inherited;
    const finalization = finalizations.get(runId);
    let records = await readRun(input.events, runId, finalization?.finalizationId);
    const mirrors = entriesByRun.get(runId) ?? [];
    const joinKey = `${runId}:${records.at(-1)?.hash ?? ''}:${limit?.hash ?? ''}:${String(limit?.sequence)}:${finalization?.finalizationId ?? ''}`;
    const cached = joinCache.get(runId);
    if (
      cached?.key === joinKey &&
      cached.mirrors.length === mirrors.length &&
      cached.mirrors.every((entry, index) => entry === mirrors[index])
    ) {
      for (const [id, entry] of cached.replacements) replacements.set(id, entry);
      additions.set(runId, cached.additions);
      if (cached.head) heads.push(cached.head);
      continue;
    }
    const ended = finalization
      ? records.find(
          (record) =>
            record.event.type === 'run.ended' &&
            record.event.terminal.finalizationId === finalization.finalizationId
        )
      : undefined;
    const ceiling = Math.min(
      limit?.sequence ?? Number.MAX_SAFE_INTEGER,
      ended?.sequence ?? Number.MAX_SAFE_INTEGER
    );
    records = records.filter((record) => record.sequence <= ceiling);
    const last = records.at(-1);
    if (
      limit &&
      (limit.sequence === -1
        ? last !== undefined
        : last?.sequence !== limit.sequence || last.hash !== limit.hash)
    )
      throw new Error('History ledger source cut is unavailable or its identity changed.');
    // Finalized runs have an immutable run.ended boundary in the session cut. Only open tails need cursor storage.
    const head =
      !ended || limit
        ? Object.freeze({ runId, sequence: last?.sequence ?? -1, ...(last ? { hash: last.hash } : {}) })
        : undefined;
    if (head) heads.push(head);
    const runReplacements = new Map<string, SessionBranchEntry>();
    const byIdentity = new Map(
      mirrors.filter((entry) => entry.source === undefined).map((entry) => [entryIdentity(entry), entry])
    );
    const byEventId = new Map(
      mirrors.flatMap((entry) => (entry.source ? [[entry.source.eventId, entry] as const] : []))
    );
    const extra = new Map<string, SessionBranchEntry>();
    const observed = new Set<string>();
    const outputByTurn = new Map<string, readonly ModelOutputItem[]>();
    for (const record of records) {
      const event = record.event;
      if (event.type === 'provider.attempt.settled' && event.response.output)
        outputByTurn.set(`${event.turnId}:${String(event.requestAttempt)}`, event.response.output);
      const entry = publicEventEntry(record, mirrors[0]?.parentId ?? null, outputByTurn);
      if (!entry) continue;
      const identity = entryIdentity(entry);
      if (event.type === 'observation.record.created' && observed.has(identity)) continue;
      if (entry.type === 'observation') observed.add(identity);
      const recordedMirror = entry.source ? byEventId.get(entry.source.eventId) : undefined;
      if (recordedMirror?.source && recordedMirror.source.hash !== record.hash)
        throw new Error('Session mirror source hash conflicts with its authoritative ledger event.');
      const mirror = recordedMirror ?? byIdentity.get(identity);
      if (mirror) {
        if (entry.type === 'steering' && mirror.type === 'steering' && entry.content !== mirror.content)
          throw new Error('Steering delivery identity has conflicting original content.');
        const replacement = mergeMirror(entry, mirror);
        replacements.set(mirror.id, replacement);
        runReplacements.set(mirror.id, replacement);
      } else extra.set(identity, entry);
    }
    const added = Object.freeze([...extra.values()]);
    additions.set(runId, added);
    // One cache slot per run and source limit. Obsolete open heads are rebuildable.
    joinCache.set(
      runId,
      Object.freeze({
        key: joinKey,
        mirrors: Object.freeze(mirrors),
        replacements: runReplacements,
        additions: added,
        ...(head ? { head } : {})
      })
    );
  }
  const joined: SessionBranchEntry[] = [];
  const lastByRun = new Map<string, string>();
  for (const entry of input.entries) if ('runId' in entry) lastByRun.set(entry.runId, entry.id);
  const emitted = new Set<string>();
  for (const original of input.entries) {
    const entry = replacements.get(original.id) ?? original;
    if ('runId' in entry && entry.source) {
      for (const extra of additions.get(entry.runId) ?? []) {
        if (extra.source && extra.source.sequence < entry.source.sequence && !emitted.has(extra.id)) {
          joined.push(extra);
          emitted.add(extra.id);
        }
      }
    }
    joined.push(entry);
    if ('runId' in entry && lastByRun.get(entry.runId) === entry.id) {
      for (const extra of additions.get(entry.runId) ?? [])
        if (!emitted.has(extra.id)) {
          joined.push(extra);
          emitted.add(extra.id);
        }
    }
  }
  return Object.freeze({ entries: Object.freeze(joined), heads: Object.freeze(heads) });
}
async function readRun(
  events: EventRepository<AgentEvent>,
  runId: string,
  finalizationId?: string
): Promise<readonly EventEnvelope<AgentEvent>[]> {
  let cache = caches.get(events);
  if (!cache) {
    cache = new Map();
    caches.set(events, cache);
  }
  const existing = cache.get(runId);
  if (finalizationId && existing?.finalizationId === finalizationId) return existing.records;
  const tail = await events.tail(runId);
  if (existing?.sequence === tail.sequence && existing.hash === tail.hash) return existing.records;
  const records: EventEnvelope<AgentEvent>[] = [];
  for await (const record of events.read(runId)) {
    if (record.sequence > tail.sequence) break;
    records.push(record);
  }
  if (records.length !== tail.sequence + 1 || records.at(-1)?.hash !== tail.hash)
    throw new Error('History ledger is incomplete.');
  const ended = records.find((record) => record.event.type === 'run.ended')?.event;
  cache.set(
    runId,
    Object.freeze({
      ...tail,
      records: Object.freeze(records),
      ...(ended?.type === 'run.ended' ? { finalizationId: ended.terminal.finalizationId } : {})
    })
  );
  return records;
}
function publicEventEntry(
  record: EventEnvelope<AgentEvent>,
  parentId: string | null,
  outputs: ReadonlyMap<string, readonly ModelOutputItem[]>
): SessionBranchEntry | undefined {
  const event = record.event;
  const source = Object.freeze({
    runId: record.runId,
    eventId: record.eventId,
    sequence: record.sequence,
    hash: record.hash
  });
  const base = {
    id: `event:${record.eventId}`,
    parentId,
    timestamp: record.timestamp,
    source,
    runId: record.runId
  };
  if (event.type === 'input.steering.accepted')
    return Object.freeze({
      ...base,
      type: 'steering',
      deliveryId: event.deliveryId,
      content: event.content
    });
  if (event.type === 'assistant.ended' || event.type === 'assistant.interrupted') {
    const output = outputs.get(`${event.turnId}:${String(event.requestAttempt)}`);
    const entry: SessionAssistantEntry = Object.freeze({
      ...base,
      type: 'assistant',
      turnId: event.turnId,
      turnIndex: event.turnIndex,
      requestAttempt: event.requestAttempt,
      content: event.content,
      completeness: event.modelOutput.status,
      ...(output ? { output } : {})
    });
    return entry;
  }
  if (event.type === 'tool.started')
    return Object.freeze({
      ...base,
      type: 'tool_call',
      turnId: event.turnId,
      turnIndex: event.turnIndex,
      requestAttempt: event.requestAttempt,
      toolBatchId: event.toolBatchId,
      callIndex: event.callIndex,
      ...(event.callId ? { callId: event.callId } : {}),
      call: parseJsonValue(event.input)
    });
  if (event.type === 'tool.ended')
    return Object.freeze({
      ...base,
      type: 'observation',
      turnId: event.turnId,
      turnIndex: event.turnIndex,
      requestAttempt: event.requestAttempt,
      toolBatchId: event.toolBatchId,
      callIndex: event.callIndex,
      ...(event.callId ? { callId: event.callId } : {}),
      toolAttempt: event.toolAttempt,
      toolName: event.toolName,
      ok: event.observation.ok,
      summary: event.observation.summary,
      output: parseJsonValue(event.observation.output)
    });
  if (event.type === 'observation.record.created')
    return Object.freeze({
      ...base,
      type: 'observation',
      turnId: event.turnId,
      turnIndex: event.turnIndex,
      requestAttempt: event.requestAttempt,
      toolBatchId: event.toolBatchId,
      callIndex: event.callIndex,
      ...(event.callId ? { callId: event.callId } : {}),
      toolAttempt: event.toolAttempt,
      toolName: event.toolName,
      ok: event.retainedPresentation.ok,
      summary: event.retainedPresentation.summary,
      output: parseJsonValue(event.retainedPresentation)
    });
  return undefined;
}
function mergeMirror(entry: SessionBranchEntry, mirror: SessionBranchEntry): SessionBranchEntry {
  const routing = { id: mirror.id, parentId: mirror.parentId };
  switch (entry.type) {
    case 'steering':
      if (mirror.type === 'steering') return Object.freeze({ ...mirror, ...entry, ...routing });
      break;
    case 'assistant':
      if (mirror.type === 'assistant') return Object.freeze({ ...mirror, ...entry, ...routing });
      break;
    case 'tool_call':
      if (mirror.type === 'tool_call') return Object.freeze({ ...mirror, ...entry, ...routing });
      break;
    case 'observation':
      if (mirror.type === 'observation') return Object.freeze({ ...mirror, ...entry, ...routing });
      break;
  }
  throw new Error('Session mirror kind conflicts with its authoritative ledger event.');
}

function entryIdentity(entry: SessionBranchEntry): string {
  if (entry.type === 'steering' && entry.deliveryId) return `steering:${entry.runId}:${entry.deliveryId}`;
  if (entry.type === 'assistant')
    return `assistant:${entry.runId}:${entry.turnId}:${String(entry.requestAttempt)}:${entry.completeness ?? 'complete'}`;
  if (entry.type === 'tool_call')
    return `tool_call:${entry.runId}:${entry.toolBatchId}:${String(entry.callIndex)}`;
  if (entry.type === 'observation')
    return `observation:${entry.runId}:${entry.turnId}:${String(entry.requestAttempt)}:${String(entry.toolBatchId)}:${String(entry.callIndex)}:${String(entry.toolAttempt)}`;
  return `entry:${entry.id}`;
}
