import type { Element } from '@ismail-elkorchi/terminal-ui/components';
import type { MeasuredViewportLayout } from '@ismail-elkorchi/terminal-ui/layout';
import type { MeasuredViewportAnchor } from '@ismail-elkorchi/terminal-ui/interaction';
import {
  createMeasuredCollection,
  measuredAnchorAt
} from '@ismail-elkorchi/terminal-ui/collection';
import { adjacentItemId } from '@ismail-elkorchi/terminal-ui/interaction';
import { MarkdownDocument } from './markdown.js';

interface RetainedElement<Entry, Message> {
  readonly entry: Entry;
  readonly expanded: boolean;
  readonly key: string;
  readonly element: Element<Message>;
}

/** Retained presentation and the latest renderer-derived navigation geometry. */
export class RetainedListPresentation<Entry extends { readonly id: string }, Message> {
  private readonly documents = new Map<string, MarkdownDocument>();
  private elements = new Map<string, RetainedElement<Entry, Message>>();
  private entries: readonly Entry[] = [];
  private measured = createMeasuredCollection<undefined>([]);
  private currentLayout: MeasuredViewportLayout = {
    entries: [],
    geometry: { contentRows: 0, contentColumns: 0, viewportRows: 0, viewportColumns: 0 },
    scroll: { offsetRow: 0, offsetColumn: 0, followTail: true }
  };

  get layout(): MeasuredViewportLayout {
    return this.currentLayout;
  }

  set layout(layout: MeasuredViewportLayout) {
    this.currentLayout = layout;
    this.measured = createMeasuredCollection(
      layout.entries
        .filter((entry) => entry.rows > 0)
        .map((entry) => ({ id: entry.id, value: undefined, rows: entry.rows }))
    );
  }

  anchor(offsetRow: number) {
    return measuredAnchorAt(this.measured, { offsetRow });
  }

  adjacentMessage(
    offsetRow: number | 'end' | MeasuredViewportAnchor,
    direction: 'previous' | 'next'
  ) {
    const anchor =
      typeof offsetRow === 'object'
        ? offsetRow
        : this.anchor(
            offsetRow === 'end' ? Math.max(0, this.layout.geometry.contentRows - 1) : offsetRow
          );
    if (anchor === undefined) return undefined;
    if (direction === 'previous' && anchor.rowWithinItem > 0)
      return { itemId: anchor.itemId, rowWithinItem: 0, viewportRow: 0 };
    const id = adjacentItemId(
      this.entries.map((entry) => entry.id),
      anchor.itemId,
      direction === 'previous' ? -1 : 1
    );
    // Reaching an edge asks the application to load another history page.
    return id === undefined || id === anchor.itemId
      ? undefined
      : { itemId: id, rowWithinItem: 0, viewportRow: 0 };
  }

  markdown(id: string, source: string): MarkdownDocument {
    let document = this.documents.get(id);
    if (document === undefined) {
      document = new MarkdownDocument(source);
      this.documents.set(id, document);
    } else document.replace(source);
    return document;
  }

  render(
    entries: readonly Entry[],
    expanded: readonly string[],
    key: string,
    render: (entry: Entry) => Element<Message>
  ): readonly Element<Message>[] {
    const retained = new Map<string, RetainedElement<Entry, Message>>();
    const result = entries.map((entry) => {
      const cached = this.elements.get(entry.id);
      const isExpanded = expanded.includes(entry.id);
      const item =
        cached?.entry === entry && cached.expanded === isExpanded && cached.key === key
          ? cached
          : { entry, expanded: isExpanded, key, element: render(entry) };
      retained.set(entry.id, item);
      return item.element;
    });
    for (const id of this.documents.keys()) if (!retained.has(id)) this.documents.delete(id);
    this.elements = retained;
    this.entries = entries;
    return result;
  }
}
