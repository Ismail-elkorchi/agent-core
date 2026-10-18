import { createInterface } from 'node:readline';
const input = createInterface({ input: process.stdin });
for await (const line of input) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  let result;
  if (request.method === 'server/discover') result = {
    supportedVersions: ['2026-07-28'], capabilities: { tools: {} }
  };
  else if (request.method === 'tools/list') result = {
    ttlMs: 0, cacheScope: 'private', tools: [{ name: 'echo', description: 'Echo a value',
      inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } }]
  };
  else if (request.method === 'tools/call') result = {
    content: [], structuredContent: { value: request.params.arguments.value,
      explicit: process.env.MCP_FIXTURE_ENV, ambientHome: process.env.HOME ?? '' }
  };
  else result = { content: [], isError: true };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { resultType: 'complete', ...result } }) + '\n');
}
