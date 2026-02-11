/**
 * Generic HTTP adapter — any agent framework can POST events to AFR.
 *
 * This is the universal integration method. Agents send events via HTTP:
 *
 *   POST http://localhost:4242/api/ingest
 *   {
 *     "event": {
 *       "sessionId": "...",
 *       "agentId": "my-agent",
 *       "type": "tool.start",
 *       "toolName": "search",
 *       "toolCallId": "abc123",
 *       "params": { "query": "weather" }
 *     }
 *   }
 *
 * No adapter code needed — just HTTP POST from any language.
 * The /api/ingest endpoint on the server handles this natively.
 *
 * This file provides a lightweight client SDK for Node.js agents.
 */

export interface AFRClientOptions {
  /** AFR server URL (default: http://127.0.0.1:4242) */
  serverUrl?: string;
  /** Agent identifier */
  agentId: string;
  /** Agent framework name */
  framework?: string;
}

export class AFRClient {
  private serverUrl: string;
  private agentId: string;
  private framework: string;
  private currentSessionId: string | null = null;

  constructor(opts: AFRClientOptions) {
    this.serverUrl = opts.serverUrl ?? "http://127.0.0.1:4242";
    this.agentId = opts.agentId;
    this.framework = opts.framework ?? "generic";
  }

  async startSession(opts?: { initiator?: string; channel?: string }): Promise<string> {
    const res = await fetch(`${this.serverUrl}/api/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session: {
          action: "start",
          agentId: this.agentId,
          initiator: opts?.initiator,
          channel: opts?.channel,
        },
      }),
    });
    const data = await res.json() as any;
    this.currentSessionId = data.sessionId;
    return data.sessionId;
  }

  async endSession(status: "completed" | "errored" = "completed"): Promise<void> {
    if (!this.currentSessionId) return;
    await fetch(`${this.serverUrl}/api/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session: {
          action: "end",
          sessionId: this.currentSessionId,
          status,
        },
      }),
    });
    this.currentSessionId = null;
  }

  async recordToolStart(toolName: string, toolCallId: string, params?: Record<string, unknown>): Promise<void> {
    await this.recordEvent({
      type: "tool.start",
      toolName,
      toolCallId,
      params,
    });
  }

  async recordToolEnd(
    toolName: string,
    toolCallId: string,
    opts?: { result?: unknown; success?: boolean; error?: string; costUsd?: number; durationMs?: number }
  ): Promise<void> {
    await this.recordEvent({
      type: "tool.end",
      toolName,
      toolCallId,
      ...opts,
    });
  }

  async recordThinking(reasoning: string): Promise<void> {
    await this.recordEvent({
      type: "thinking.start",
      reasoning,
    });
  }

  async recordMessage(role: "user" | "assistant", content: string): Promise<void> {
    await this.recordEvent({
      type: role === "user" ? "message.user" : "message.assistant",
      content,
    });
  }

  private async recordEvent(event: Record<string, unknown>): Promise<void> {
    if (!this.currentSessionId) return;
    await fetch(`${this.serverUrl}/api/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: {
          ...event,
          sessionId: this.currentSessionId,
          agentId: this.agentId,
        },
      }),
    });
  }
}
