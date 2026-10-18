import {
  isJSONRPCNotification, isJSONRPCRequest, isJSONRPCResponse,
  type Transport, type JSONRPCMessage, type TransportSendOptions, type MessageExtraInfo
} from '@modelcontextprotocol/client';
import { parseJsonValue } from '@agent-core/json';
import { jsonLimits, type McpLimits } from './limits.js';

/** Bounds parsed host transport messages; host transports must also bound raw framing. */
export class BoundedMcpTransport implements Transport {
  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
  onmessage?: ((message: JSONRPCMessage, extra?: MessageExtraInfo) => void) | undefined;
  private notifications = 0;
  private closed = false;
  constructor(private readonly inner: Transport, private readonly limits: McpLimits) {}
  get hasPerRequestStream(): boolean { return this.inner.hasPerRequestStream === true; }
  setProtocolVersion(version: string): void { this.inner.setProtocolVersion?.(version); }
  setSupportedProtocolVersions(versions: string[]): void { this.inner.setSupportedProtocolVersions?.(versions); }
  async start(): Promise<void> {
    this.inner.onclose = () => { this.closed = true; this.onclose?.(); };
    this.inner.onerror = () => { this.fail('MCP transport failed.'); };
    this.inner.onmessage = (message, extra) => {
      if (this.closed) return;
      let captured: JSONRPCMessage;
      try {
        captured = captureMessage(message, this.limits);
        if ('method' in captured && ++this.notifications > this.limits.maxNotifications) throw new Error('notification limit');
      } catch { this.fail('MCP message or notification limit exceeded.'); return; }
      this.onmessage?.(captured, extra);
    };
    await this.inner.start();
  }
  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    if (this.closed) throw new Error('MCP transport is closed.');
    const captured = captureMessage(message, this.limits);
    await this.inner.send(captured, options);
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.inner.close();
    this.onclose?.();
  }
  private fail(message: string): void {
    this.onerror?.(new Error(message));
    void this.close().catch(() => undefined);
  }
}

function captureMessage(message: JSONRPCMessage, limits: McpLimits): JSONRPCMessage {
  const captured = parseJsonValue(message, jsonLimits(limits.maxMessageBytes));
  if (isJSONRPCRequest(captured) || isJSONRPCNotification(captured) || isJSONRPCResponse(captured)) return captured;
  throw new Error('Invalid MCP JSON-RPC message.');
}
