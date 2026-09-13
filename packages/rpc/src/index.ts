import * as z from 'zod';

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message);
    this.name = 'RpcError';
  }
}
export interface RpcMethod<Schema extends z.ZodType = z.ZodType> {
  readonly params: Schema;
  invoke(params: unknown): Promise<unknown>;
}
export function rpcMethod<Schema extends z.ZodType, Result>(
  params: Schema,
  handler: (params: z.output<Schema>) => Result | Promise<Result>
): RpcMethod<Schema> {
  return {
    params,
    async invoke(raw) {
      let decoded: z.output<Schema>;
      try {
        decoded = await params.parseAsync(raw ?? {});
      } catch (error) {
        throw new RpcError(-32602, error instanceof Error ? error.message : 'Invalid parameters.');
      }
      return handler(decoded);
    }
  };
}
export type RpcParameters<Method extends RpcMethod> = z.input<Method['params']>;

export * from './note-parameters.js';
export * from './session-methods.js';
export * from './session-parameters.js';

export { inputRpcMethods, type InputRpcOperations } from './input-methods.js';

export { recoveryRpcMethods, type RecoveryRpcOperations } from './recovery-methods.js';
