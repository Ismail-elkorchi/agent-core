import {
  accountModelRequest,
  CompleteRequestEstimator,
  type ModelInputItem,
  type ModelProfile,
  type RequestEstimator
} from '@agent-core/model';
import { ModelWindow, type ModelWindowReduction } from './model-window.js';
import {
  createPromptMaterial,
  deliverPromptContext,
  type PromptContextDelivery,
  type PromptContextItem,
  type PromptContextItemInput,
  type PromptInstructionBlock,
  type PromptMaterial,
  type PromptToolSummary
} from './prompt-material.js';

export type {
  PromptOutputContract as OutputContract,
  PromptInstructionBlock as PromptInstruction,
  PromptMaterial,
  PromptToolSummary as PromptToolSpec
} from './prompt-material.js';

export interface ModelRequestAssemblyInput {
  readonly window: ModelWindow;
  readonly task: string;
  readonly instructions: readonly PromptInstructionBlock[];
  readonly contextItems?: readonly PromptContextItemInput[];
  readonly tools: readonly PromptToolSummary[];
  readonly modelProfile: ModelProfile;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface ModelRequestAssemblyEstimate {
  readonly modelWindowTokens: number;
  readonly contextTokens: number;
}

export interface ModelRequestAssembly {
  readonly material: PromptMaterial;
  readonly messages: readonly ModelInputItem[];
  readonly historyMessages: readonly ModelInputItem[];
  readonly context: PromptContextDelivery;
  readonly reductions: readonly ModelWindowReduction[];
  readonly estimate: ModelRequestAssemblyEstimate;
}

export interface CompiledPromptMaterial {
  readonly materialId: string;
  readonly instructionMessages: readonly ModelInputItem[];
  readonly taskMessage: ModelInputItem;
  readonly stateMessage?: ModelInputItem;
  readonly messages: readonly ModelInputItem[];
}

export class ModelRequestAssembler {
  constructor(private readonly estimator: RequestEstimator = new CompleteRequestEstimator()) {}

  assemble(input: ModelRequestAssemblyInput): ModelRequestAssembly {
    const history = input.window.messagesFor(input.modelProfile);
    const prior = input.window.priorMessagesFor(input.modelProfile);
    const context = deliverPromptContext(input.contextItems ?? [], this.estimator);
    const material = createPromptMaterial({
      task: input.task,
      instructions: input.instructions,
      context: context.items,
      tools: input.tools,
      ...(input.metadata ? { metadata: input.metadata } : {})
    });
    const compiled = compilePromptMaterial(material);
    const messages = Object.freeze([
      ...compiled.instructionMessages.filter((item) => item.role !== 'user'),
      ...prior.messages,
      compiled.taskMessage,
      ...compiled.instructionMessages.filter((item) => item.role === 'user'),
      ...history.messages,
      ...(compiled.stateMessage ? [compiled.stateMessage] : [])
    ]);
    return Object.freeze({
      material,
      messages,
      historyMessages: history.messages,
      context,
      reductions: input.window.consumeReductions(),
      estimate: Object.freeze({
        modelWindowTokens: accountModelRequest(
          { model: input.modelProfile.id, messages },
          input.modelProfile,
          { estimator: this.estimator }
        ).estimatedInputTokens,
        contextTokens: context.totalTokens
      })
    });
  }
}

/** Frame application material without changing its declared instruction authority. */
export function compilePromptMaterial(material: PromptMaterial): CompiledPromptMaterial {
  const instructionMessages: ModelInputItem[] = material.instructions.map((instruction) =>
    Object.freeze({
      role: instruction.role,
      content: instruction.content
    })
  );
  if (material.outputContract)
    instructionMessages.push(
      Object.freeze({
        role: 'developer',
        content: material.outputContract.description
      })
    );
  // Tool schemas and descriptions are carried once by the advertised catalog.
  const guides = material.tools.flatMap((tool) => (tool.promptGuide ? [tool.promptGuide] : []));
  if (guides.length > 0)
    instructionMessages.push(Object.freeze({ role: 'developer', content: guides.join('\n\n') }));
  const taskMessage: ModelInputItem = Object.freeze({
    role: 'user',
    content: material.task
  });
  const stateText = renderContext(material.context);
  const stateMessage: ModelInputItem | undefined = stateText
    ? Object.freeze({ role: 'user', content: stateText })
    : undefined;
  return Object.freeze({
    materialId: material.id,
    instructionMessages: Object.freeze(instructionMessages),
    taskMessage,
    ...(stateMessage ? { stateMessage } : {}),
    messages: Object.freeze([...instructionMessages, taskMessage, ...(stateMessage ? [stateMessage] : [])])
  });
}

function renderContext(items: readonly PromptContextItem[]): string {
  if (items.length === 0) {
    return '';
  }
  const rendered = items.map((item) => {
    const range = item.range
      ? ` range="${item.range.kind}:${item.range.start !== undefined ? String(item.range.start) : ''}-${item.range.end !== undefined ? String(item.range.end) : ''}"`
      : '';
    const integrity = item.integrity ? ` integrity="${item.integrity}"` : '';
    return [
      `<context id="${escapeAttr(item.id)}" source="${escapeAttr(item.sourceUri)}" sourceKind="${item.sourceKind}" representation="${item.representation}" media="${escapeAttr(item.mediaType)}"${integrity} purpose="${escapeAttr(item.purpose)}"${range}>`,
      `<title>${escapeText(item.title)}</title>`,
      '<data>',
      escapeText(item.content),
      '</data>',
      '</context>'
    ].join('\n');
  });
  return `Context bundle:\n${rendered.join('\n\n')}`;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
