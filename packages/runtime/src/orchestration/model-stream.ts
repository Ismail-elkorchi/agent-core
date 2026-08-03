export interface ModelStreamInterruptedInput {
  turnIndex: number;
  cause: unknown;
  content: string;
  reasoningSummary?: string;
  finalResponseReceived: boolean;
}

export class ModelStreamInterruptedError extends Error {
  readonly turnIndex: number;
  override readonly cause: unknown;
  readonly content: string;
  readonly reasoningSummary: string | undefined;
  readonly finalResponseReceived: boolean;

  constructor(input: ModelStreamInterruptedInput) {
    super(errorMessage(input.cause));
    this.name = 'ModelStreamInterruptedError';
    this.turnIndex = input.turnIndex;
    this.cause = input.cause;
    this.content = input.content;
    this.reasoningSummary = input.reasoningSummary;
    this.finalResponseReceived = input.finalResponseReceived;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
