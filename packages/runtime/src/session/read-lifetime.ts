/** Owns admitted session reads, including any derived-index publication they perform. */
export class SessionReadLifetime {
  private readonly pending = new Set<Promise<unknown>>();
  private closing: Promise<void> | undefined;

  read<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) throw new Error('Session reads are closed.');
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason: unknown) => void;
    const pending = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
    this.pending.add(pending);
    try { resolve(operation()); } catch (error) { reject(error); }
    void pending.then(
      () => this.pending.delete(pending),
      () => this.pending.delete(pending)
    );
    return pending;
  }

  close(): Promise<void> {
    this.closing ??= Promise.allSettled(this.pending).then(() => undefined);
    return this.closing;
  }
}
