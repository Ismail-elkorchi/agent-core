import path from 'node:path';
import { LocalArtifactRepository, JsonlEventRepository } from '@agent-core/persistence/node';
import { AgentRunCoordinator, AgentRuntime, AgentSession, agentEventCodec } from '@agent-core/runtime';
import { JsonlSessionRepository } from '@agent-core/runtime/node';

const [root, sessionId, boundary] = process.argv.slice(2);
if (!root || !sessionId || !['before-claim', 'after-claim', 'after-accept'].includes(boundary))
  throw new Error('Expected storage root, session identity, and admission crash boundary.');
const binding = { schemaId: 'test.session-ownership', schemaVersion: 1, subject: {} };
class CrashSessionRepository extends JsonlSessionRepository {
  async transitionSubmission(descriptor, submissionId, outcome) {
    if (outcome.state === 'claimed' && boundary === 'before-claim') process.exit(70);
    await super.transitionSubmission(descriptor, submissionId, outcome);
    if (outcome.state === 'claimed' && boundary === 'after-claim') process.exit(71);
  }
}
class CrashEventRepository extends JsonlEventRepository {
  async appendConditional(runId, event, options) {
    const result = await super.appendConditional(runId, event, options);
    if (boundary === 'after-accept' && options.idempotencyKey === `${runId}:run:accepted`)
      process.exit(72);
    return result;
  }
}
const repository = new CrashSessionRepository({ rootDir: path.join(root, 'sessions') });
const descriptor = await repository.open(sessionId, binding);
const events = new CrashEventRepository({ rootDir: path.join(root, 'events'), codec: agentEventCodec });
const artifacts = new LocalArtifactRepository({ rootDir: path.join(root, 'artifacts') });
const runs = new AgentRunCoordinator(events, artifacts);
const provider = {
  id: 'fixture', implementationId: 'session-ownership.fixture@1',
  describe() { throw new Error('Crash must precede provider work'); },
  describeModel() { throw new Error('Crash must precede provider work'); },
  complete() { throw new Error('Crash must precede provider work'); }
};
const session = new AgentSession({ descriptor, expectedBinding: binding, repository, runs,
  configuration: { provider: 'fixture', model: 'fixture' }, scheduling: 'manual',
  createRuntime: () => new AgentRuntime({ provider, model: 'fixture', maxOutputTokens: 64,
    toolBoundary: { authorizationPolicyId: 'test', executionTargetId: 'test' },
    repositories: { events, artifacts, session: { repository, descriptor } } }) });
await session.restore();
const started = await session.startNextSubmission();
await started.completion;
throw new Error('The requested admission crash boundary was not reached.');
