/**
 * OpenClaw adapter — captures events from OpenClaw's log stream.
 *
 * Two modes:
 *   1. Log file watcher (reads /tmp/openclaw/openclaw-YYYY-MM-DD.log)
 *   2. WebSocket listener (connects to OpenClaw gateway for real-time events)
 *
 * This is the first adapter. The pattern is reusable for LangChain, CrewAI, etc.
 */

import { readFileSync, watchFile, unwatchFile, statSync } from "fs";
import { nanoid } from "nanoid";
import type { AgentAdapter, EventRecorder, ToolEvent } from "../types.js";

interface OpenClawLogEntry {
  type: "log" | "meta" | "notice";
  time?: string;
  level?: string;
  subsystem?: string;
  message?: string;
  raw?: string;
}

export class OpenClawAdapter implements AgentAdapter {
  name = "openclaw";
  framework = "openclaw";

  private recorder: EventRecorder | null = null;
  private logPath: string;
  private lastSize = 0;
  private sessionMap: Map<string, string> = new Map(); // runId -> sessionId
  private toolStartTimes: Map<string, number> = new Map(); // toolCallId -> startTime

  constructor(logPath?: string) {
    const today = new Date().toISOString().split("T")[0];
    this.logPath = logPath ?? `/tmp/openclaw/openclaw-${today}.log`;
  }

  async start(recorder: EventRecorder): Promise<void> {
    this.recorder = recorder;

    // Read existing content
    try {
      const stat = statSync(this.logPath);
      this.lastSize = stat.size;
    } catch {
      // File doesn't exist yet, that's fine
    }

    // Watch for changes
    watchFile(this.logPath, { interval: 500 }, () => {
      this.readNewLines();
    });

    console.log(`🔌 OpenClaw adapter watching: ${this.logPath}`);
  }

  async stop(): Promise<void> {
    unwatchFile(this.logPath);
  }

  private readNewLines(): void {
    try {
      const stat = statSync(this.logPath);
      if (stat.size <= this.lastSize) return;

      const fd = readFileSync(this.logPath, "utf-8");
      const newContent = fd.slice(this.lastSize);
      this.lastSize = stat.size;

      const lines = newContent.split("\n").filter(Boolean);
      for (const line of lines) {
        this.processLine(line);
      }
    } catch {
      // File may be rotating, ignore
    }
  }

  private processLine(line: string): void {
    if (!this.recorder) return;

    let entry: OpenClawLogEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      return; // Not JSON, skip
    }

    if (entry.type !== "log" || !entry.message) return;

    const msg = entry.message;
    const time = entry.time ?? new Date().toISOString();

    // Parse embedded run events
    const runStartMatch = msg.match(/embedded run prompt start: runId=(\S+) sessionId=(\S+)/);
    if (runStartMatch) {
      const [, runId, openclawSessionId] = runStartMatch;
      const sessionId = this.recorder.startSession({
        agentId: this.extractAgentId(msg),
        initiator: openclawSessionId,
        channel: "openclaw",
        startedAt: time,
        status: "active",
        meta: { openclawRunId: runId, openclawSessionId },
      });
      this.sessionMap.set(runId, sessionId);
      return;
    }

    // Tool start
    const toolStartMatch = msg.match(/embedded run tool start: runId=(\S+) tool=(\S+) toolCallId=(\S+)/);
    if (toolStartMatch) {
      const [, runId, toolName, toolCallId] = toolStartMatch;
      const sessionId = this.sessionMap.get(runId);
      if (!sessionId) return;

      this.toolStartTimes.set(toolCallId, Date.now());

      const event: Omit<ToolEvent, "id"> = {
        sessionId,
        agentId: this.extractAgentId(msg),
        type: "tool.start",
        timestamp: time,
        toolName,
        toolCallId,
      };
      this.recorder.record(event);
      return;
    }

    // Tool end
    const toolEndMatch = msg.match(/embedded run tool end: runId=(\S+) tool=(\S+) toolCallId=(\S+)/);
    if (toolEndMatch) {
      const [, runId, toolName, toolCallId] = toolEndMatch;
      const sessionId = this.sessionMap.get(runId);
      if (!sessionId) return;

      const startTime = this.toolStartTimes.get(toolCallId);
      const durationMs = startTime ? Date.now() - startTime : undefined;
      this.toolStartTimes.delete(toolCallId);

      const event: Omit<ToolEvent, "id"> = {
        sessionId,
        agentId: this.extractAgentId(msg),
        type: "tool.end",
        timestamp: time,
        toolName,
        toolCallId,
        durationMs,
        success: true,
      };
      this.recorder.record(event);
      return;
    }

    // Errors
    if (entry.level === "error" || entry.level === "ERROR") {
      // Try to find the associated session
      const runIdMatch = msg.match(/runId=(\S+)/);
      const sessionId = runIdMatch ? this.sessionMap.get(runIdMatch[1]) : undefined;

      if (sessionId) {
        this.recorder.record({
          sessionId,
          agentId: this.extractAgentId(msg),
          type: "error",
          timestamp: time,
          error: msg,
          recoverable: true,
        } as any);
      }
    }
  }

  private extractAgentId(msg: string): string {
    // Try to extract from subsystem
    const match = msg.match(/agent[:/](\S+)/);
    return match ? match[1] : "openclaw-agent";
  }
}
