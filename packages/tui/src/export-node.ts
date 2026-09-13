import type { SessionBranchPage } from '@agent-core/runtime';
import { randomUUID } from 'node:crypto';
import { mkdir, open, rm } from 'node:fs/promises';
import path from 'node:path';
import { projectSessionEntry } from './conversation.js';

/** Export the explicitly selected, authorized pages. Provider-private state is never projected. */
export async function exportConversation(
  directory: string,
  pages: readonly SessionBranchPage[],
  signal: AbortSignal
): Promise<string> {
  signal.throwIfAborted();
  if (pages.length === 0) throw new Error('Load recorded history before exporting.');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `conversation-${randomUUID()}.jsonl`);
  const handle = await open(file, 'wx', 0o600);
  let completed = false;
  try {
    await handle.writeFile(
      JSON.stringify({
        format: 'agent-core.conversation',
        coverage: 'selected-pages',
        boundaries: pages.map((page) => page.boundary),
        entries: pages.map((page) => page.entries.map((entry) => entry.id)),
        oversizedEntries: pages.flatMap((page) =>
          page.oversizedEntry === undefined ? [] : [{ boundary: page.boundary, ...page.oversizedEntry }]
        )
      }) + '\n'
    );
    const seen = new Set<string>();
    for (const page of pages)
      for (const entry of page.entries) {
        signal.throwIfAborted();
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        for (const projected of projectSessionEntry(entry)) {
          await handle.writeFile(
            JSON.stringify({
              source: { sessionId: page.boundary.sessionId, entryId: entry.id, timestamp: entry.timestamp },
              ...projected
            }) + '\n'
          );
        }
      }
    await handle.sync();
    completed = true;
    return file;
  } finally {
    await handle.close();
    if (!completed) await rm(file);
  }
}
