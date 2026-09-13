/** Preserve causal diagnostics without serializing arbitrary error properties. */
export function describeError(error: unknown): string {
  const seen = new Set<Error>();
  function describe(value: unknown): string {
    if (!(value instanceof Error)) return String(value);
    if (seen.has(value)) return '[repeated error]';
    seen.add(value);
    const aggregateCauses: readonly unknown[] = value instanceof AggregateError ? value.errors : [];
    const causes = [...aggregateCauses];
    if (value.cause !== undefined && !causes.includes(value.cause)) causes.push(value.cause);
    return [value.message, ...causes.map((cause) => `Caused by: ${describe(cause)}`)].join('\n');
  }
  return describe(error);
}
