/** Rebuildable, bounded trigram index. Source identity is the key; absence always falls back to a source scan. */
export class LiteralHistoryIndex {
  private readonly texts = new Map<string, string>();
  private readonly grams = new Map<string, Set<string>>();
  private bytes = 0;
  private postings = 0;
  constructor(
    private readonly limits = {
      maxBytes: 4 * 1024 * 1024,
      maxSources: 4096,
      maxTerms: 65536,
      maxPostings: 131072
    }
  ) {}

  add(key: string, text: string): boolean {
    if (this.texts.has(key)) return true;
    const bytes = Buffer.byteLength(text);
    if (this.bytes + bytes > this.limits.maxBytes || this.texts.size >= this.limits.maxSources) return false;
    const terms = new Set<string>();
    for (let index = 0; index < text.length - 2; index++) {
      terms.add(text.slice(index, index + 3));
      if (terms.size > this.limits.maxTerms) return false;
    }
    if (this.postings + terms.size > this.limits.maxPostings) return false;
    let additions = 0;
    for (const term of terms) if (!this.grams.has(term)) additions++;
    if (this.grams.size + additions > this.limits.maxTerms) return false;
    this.texts.set(key, text);
    this.bytes += bytes;
    this.postings += terms.size;
    for (const term of terms) {
      const sources = this.grams.get(term) ?? new Set<string>();
      sources.add(key);
      this.grams.set(term, sources);
    }
    return true;
  }

  text(key: string): string | undefined {
    return this.texts.get(key);
  }

  matches(key: string, query: string): boolean | undefined {
    const text = this.texts.get(key);
    if (text === undefined) return undefined;
    for (let index = 0; index < query.length - 2; index++) {
      if (!this.grams.get(query.slice(index, index + 3))?.has(key)) return false;
    }
    return text.includes(query);
  }

  clear(): void {
    this.texts.clear();
    this.grams.clear();
    this.bytes = 0;
    this.postings = 0;
  }
  inspect(): Readonly<{ sources: number; bytes: number; terms: number }> {
    return Object.freeze({ sources: this.texts.size, bytes: this.bytes, terms: this.grams.size });
  }
}
