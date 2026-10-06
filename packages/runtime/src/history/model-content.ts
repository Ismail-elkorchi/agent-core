import { parseJsonObject, type JsonObject, type JsonValue } from '@agent-core/json';

export function historyItemContent(value: JsonValue | undefined) {
  const { text, ...source } = parseJsonObject(value);
  return [
    { type: 'text' as const, text: JSON.stringify(source) },
    { type: 'text' as const, text: typeof text === 'string' ? text : JSON.stringify(text) }
  ];
}

/** The reader budgets exactly this presentation, including coverage and its cursor. */
export function historySearchContent(result: JsonObject) {
  const { coverage, scanned, scannedBytes, unread, cursor, items } = result;
  return [
    {
      type: 'text' as const,
      text: JSON.stringify({ coverage, scanned, scannedBytes, unread, cursor })
    },
    ...(Array.isArray(items) && items.length
      ? items.flatMap(historyItemContent)
      : [
          {
            type: 'text' as const,
            text:
              coverage === 'partial'
                ? 'No match in the scanned portion. Coverage is partial; inspect unread sources or continue with the cursor.'
                : 'No matching history.'
          }
        ])
  ];
}
