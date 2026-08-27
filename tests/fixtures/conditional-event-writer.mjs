import { JsonlEventRepository, typedEventCodec } from '@agent-core/evidence/node';

const [rootDir, runId, key, expectedJson] = process.argv.slice(2);
const repository = new JsonlEventRepository({ rootDir, codec: typedEventCodec, lockTimeoutMs: 5_000, staleLockMs: 10 });
const result = await repository.appendConditional(runId, { type: 'writer', key }, {
  idempotencyKey: key,
  expectedTail: JSON.parse(expectedJson),
  driverGeneration: 1
});
process.stdout.write(`${JSON.stringify(result)}\n`);
