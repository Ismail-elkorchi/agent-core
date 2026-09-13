import {
  appendMeasuredItems,
  createMeasuredCollection,
  measuredAnchorAt,
  measuredCollectionItemById,
  removeMeasuredItems,
  replaceMeasuredItem,
  type MeasuredCollection
} from '@ismail-elkorchi/terminal-ui/collection';
import { MarkdownDocument } from './markdown.js';

/** Derived presentation belongs to one terminal session and survives unrelated state updates. */
export class RetainedListPresentation<Entry extends { readonly id: string }> {
  private readonly documents = new Map<string, MarkdownDocument>();
  private collection = createMeasuredCollection<Entry>([]);
  private entries: readonly Entry[] = [];
  private expanded: readonly string[] = [];
  private measurementKey = '';

  anchor(offsetRow: number) {
    return measuredAnchorAt(this.collection, { offsetRow });
  }

  adjacentMessage(
    offsetRow: number | 'end' | import('@ismail-elkorchi/terminal-ui/collection').MeasuredWindowAnchor,
    direction: 'previous' | 'next'
  ) {
    const anchor =
      typeof offsetRow === 'object'
        ? offsetRow
        : this.anchor(offsetRow === 'end' ? Math.max(0, this.collection.totalRows - 1) : offsetRow);
    if (anchor === undefined) return undefined;
    const index = this.entries.findIndex((entry) => entry.id === anchor.itemId);
    const destination =
      direction === 'previous' && anchor.rowWithinItem > 0
        ? index
        : index + (direction === 'previous' ? -1 : 1);
    const entry = this.entries[destination];
    return entry === undefined ? undefined : { itemId: entry.id, rowWithinItem: 0, viewportRow: 0 };
  }

  markdown(id: string, source: string): MarkdownDocument {
    let document = this.documents.get(id);
    if (document === undefined) {
      document = new MarkdownDocument(source);
      this.documents.set(id, document);
    } else document.replace(source);
    return document;
  }

  measure(
    entries: readonly Entry[],
    expanded: readonly string[],
    key: string,
    rows: (entry: Entry) => number
  ): MeasuredCollection<Entry> {
    if (entries === this.entries && expanded === this.expanded && key === this.measurementKey)
      return this.collection;
    const retained = new Set(entries.map((entry) => entry.id));
    for (const id of this.documents.keys()) if (!retained.has(id)) this.documents.delete(id);
    const previous = this.collection;
    const next = entries.map((entry) => {
      const cached = measuredCollectionItemById(previous, entry.id);
      return cached?.value === entry &&
        key === this.measurementKey &&
        expanded.includes(entry.id) === this.expanded.includes(entry.id)
        ? cached
        : { id: entry.id, value: entry, rows: rows(entry) };
    });
    const existingOrder = this.entries.filter((entry) => retained.has(entry.id)).map((entry) => entry.id);
    const nextExistingOrder = entries
      .filter((entry) => measuredCollectionItemById(previous, entry.id) !== undefined)
      .map((entry) => entry.id);
    const appendedOnly = next
      .slice(0, nextExistingOrder.length)
      .every((item) => measuredCollectionItemById(previous, item.id) !== undefined);
    if (
      key !== this.measurementKey ||
      !appendedOnly ||
      existingOrder.some((id, index) => id !== nextExistingOrder[index])
    ) {
      this.collection = createMeasuredCollection(next);
    } else {
      this.collection = removeMeasuredItems(
        this.collection,
        this.entries.filter((entry) => !retained.has(entry.id)).map((entry) => entry.id)
      );
      for (const item of next) {
        const old = measuredCollectionItemById(previous, item.id);
        if (old !== undefined && old !== item) this.collection = replaceMeasuredItem(this.collection, item);
      }
      this.collection = appendMeasuredItems(
        this.collection,
        next.filter((item) => measuredCollectionItemById(previous, item.id) === undefined)
      );
    }
    this.entries = entries;
    this.expanded = expanded;
    this.measurementKey = key;
    return this.collection;
  }
}
