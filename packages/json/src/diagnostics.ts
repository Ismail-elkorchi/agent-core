export interface DiagnosticLimits {
  readonly maxBytes: number;
  readonly maxEntries: number;
  readonly maxDepth: number;
}

export interface DiagnosticText {
  readonly text: string;
  readonly bytes: number;
  readonly truncated: boolean;
}

/** A bounded description of arbitrary values, for display only. Never JSON or an identity input. */
export function renderDiagnostic(input: unknown, requested: Partial<DiagnosticLimits> = {}): DiagnosticText {
  const limits = { maxBytes: 32_768, maxEntries: 100, maxDepth: 8, ...requested };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new TypeError(`Diagnostic limit ${name} must be a positive safe integer.`);
  }
  const encoder = new TextEncoder();
  const parts: string[] = [];
  const ancestors = new WeakSet();
  let bytes = 0;
  let entries = 0;
  let truncated = false;
  function write(text: string): void {
    // Limit inspection and allocation before encoding even a single enormous string.
    const remaining = limits.maxBytes - bytes;
    const buffer = new Uint8Array(Math.min(remaining, text.length * 3));
    const result = encoder.encodeInto(text, buffer);
    parts.push(text.slice(0, result.read));
    bytes += result.written;
    if (result.read < text.length) truncated = true;
  }
  function isTruncated(): boolean {
    return truncated;
  }
  function visit(value: unknown, depth: number): void {
    if (isTruncated()) return;
    if (value === null) {
      write('null');
      return;
    }
    switch (typeof value) {
      case 'string':
        write('"');
        write(value);
        write('"');
        return;
      case 'boolean':
      case 'number':
        write(String(value));
        return;
      case 'undefined':
        write('[undefined]');
        return;
      case 'bigint':
        write('[bigint]');
        return;
      case 'function':
        write('[function]');
        return;
      case 'symbol':
        write('[symbol]');
        return;
    }
    if (depth >= limits.maxDepth) {
      write('[depth limit]');
      truncated = true;
      return;
    }
    if (ancestors.has(value)) {
      write('[circular]');
      return;
    }
    ancestors.add(value);
    try {
      const array = Array.isArray(value);
      const prototype: unknown = Object.getPrototypeOf(value);
      if (!array && prototype !== Object.prototype && prototype !== null && !(value instanceof Error)) {
        write('[object]');
        return;
      }
      write(array ? '[' : '{');
      // Reflection necessarily asks the object for its own keys. The shared entry budget
      // bounds property reads and recursion across the whole value, including Error causes.
      let first = true;
      for (const key of Reflect.ownKeys(value)) {
        if (array && key === 'length') continue;
        if (isTruncated()) break;
        if (entries >= limits.maxEntries) {
          write('[entry limit]');
          truncated = true;
          break;
        }
        entries += 1;
        if (!first) write(', ');
        first = false;
        if (!array) {
          write(typeof key === 'string' ? key : '[symbol key]');
          write(': ');
        }
        if (isTruncated()) break;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor && 'value' in descriptor) visit(descriptor.value, depth + 1);
        else write('[accessor]');
      }
      if (!truncated) write(array ? ']' : '}');
    } catch {
      write('[inspection failed]');
    } finally {
      ancestors.delete(value);
    }
  }
  visit(input, 0);
  return Object.freeze({ text: parts.join(''), bytes, truncated });
}
