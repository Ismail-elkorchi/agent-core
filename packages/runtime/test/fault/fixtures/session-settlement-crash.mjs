import path from 'node:path';
import { hashJson, JsonlEventRepository } from '@agent-core/evidence/node';
import { AgentOperationCoordinator, AgentSession, agentEventCodec } from '@agent-core/runtime';
import { JsonlSessionRepository } from '@agent-core/runtime/node';

const binding = Object.freeze({ schemaId: 'agent-core.tests/session-settlement', schemaVersion: 1, subject: Object.freeze({ fixture: 'fault-session' }) });

class CrashOnCompletionRepository {
  constructor(repository, crashTiming) {
    this.repository = repository;
    this.crashTiming = crashTiming;
  }
  create(input) { return this.repository.create(input); }
  open(id, expectedBinding) { return this.repository.open(id, expectedBinding); }
  list() { return this.repository.list(); }
  loadReplayState(id, leaf) { return this.repository.loadReplayState(id, leaf); }
  appendInput(id, input) { return this.repository.appendInput(id, input); }
  appendSteering(id, input) { return this.repository.appendSteering(id, input); }
  appendAssistant(id, input) { return this.repository.appendAssistant(id, input); }
  appendToolCall(id, input) { return this.repository.appendToolCall(id, input); }
  appendObservation(id, input) { return this.repository.appendObservation(id, input); }
  appendModelSettings(id, input) { return this.repository.appendModelSettings(id, input); }
  appendCompaction(id, input) { return this.repository.appendCompaction(id, input); }
  projectFinal(id, input) { return this.repository.projectFinal(id, input); }
  listBranchPoints(id) { return this.repository.listBranchPoints(id); }
  branchFrom(id, entryId, label) { return this.repository.branchFrom(id, entryId, label); }
  readConversation(id, leaf) { return this.repository.readConversation(id, leaf); }
  enqueueSubmission(id, input) { return this.repository.enqueueSubmission(id, input); }
  async transitionSubmission(id, submissionId, transition) {
    if (transition.state === 'completed' && this.crashTiming === 'before') process.exit(64);
    const result = await this.repository.transitionSubmission(id, submissionId, transition);
    if (transition.state === 'completed' && this.crashTiming === 'after') process.exit(65);
    return result;
  }
  loadPendingSubmissions(id) { return this.repository.loadPendingSubmissions(id); }
}

const [root, timing] = process.argv.slice(2);
if (root === undefined || (timing !== 'before' && timing !== 'after')) throw new Error('A root and settlement timing are required.');

const storedSessions = new JsonlSessionRepository({ rootDir: path.join(root, 'sessions') });
const descriptor = await storedSessions.create({ id: 'fault-session', provider: 'fixture', model: 'fixture', binding });
const repository = new CrashOnCompletionRepository(storedSessions, timing);
const events = new JsonlEventRepository({ rootDir: path.join(root, 'events'), codec: agentEventCodec });
const operations = new AgentOperationCoordinator(events);
const session = new AgentSession({
  descriptor,
  expectedBinding: binding,
  repository,
  operations,
  configuration: { provider: 'fixture', model: 'fixture' },
  createRuntime() {
    return {
      run(input) {
        return control(input.runId, (async () => {
          await operations.accept(acceptance(input.runId));
          return { state: 'ended', terminal: { runId: input.runId }, deliveryDiagnostics: [] };
        })());
      }
    };
  }
});

const submission = await session.submit({ task: 'settle this submission once' });
if (submission.kind !== 'started') throw new Error(`Expected a started submission, received ${submission.kind}.`);
await submission.completion;
throw new Error('The crash fixture did not stop at session settlement.');

function acceptance(runId) {
  return {
    runId,
    finalizationId: `${runId}:final`,
    input: { task: 'settle this submission once', instructions: [], contextItems: [] },
    configuration: {
      providerId: 'fixture', providerImplementationId: 'agent-core.tests.session-settlement-provider@1', model: 'fixture',
      runtimeImplementationId: 'agent-core.tests.session-settlement-runtime@1', toolImplementationIds: [], checks: [],
      disposition: { implementationId: 'agent-core.disposition.accept-v1', policyIdentity: { strategy: 'accept' }, policyHash: hashJson({ strategy: 'accept' }) },
      policyHash: hashJson({ allowedRisks: ['read'] })
    }
  };
}

function control(runId, result) {
  return { runId, result, injectSteering() { throw new Error('unused'); }, abort() {} };
}
