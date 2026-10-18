/** Fit a complete JSON envelope without skipping items or returning a non-progressing page. */
export function fitBoundedJsonPage<T, P>(
  items: readonly T[],
  present: (items: readonly T[]) => P,
  maxBytes: number,
  oversized: (requiredBytes: number) => never
): P {
  const minimum = items.length ? 1 : 0;
  for (let count = items.length; count >= minimum; count--) {
    const result = present(items.slice(0, count));
    const requiredBytes = Buffer.byteLength(JSON.stringify(result));
    if (requiredBytes <= maxBytes) return result;
    if (count === minimum) return oversized(requiredBytes);
  }
  throw new Error('Unreachable bounded JSON page fit.');
}
