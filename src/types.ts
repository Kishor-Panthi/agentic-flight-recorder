/**
 * Core types for Agentic Flight Recorder
 *
 * Three-layer model:
 *   1. WHAT happened (events)
 *   2. WHY it happened (reasoning)
 *   3. SO WHAT (risk, cost, anomalies)
 */

// ─── Identifiers ───────────────────────────────────────────

export interface AgentIdentity {
  /** Unique agent ID (e.g., "jarvis-core", "my-langchain-agent") */
  agentId: string;
  /** Agent framework: openclaw | langchain | crewai | custom-gpt | claude-code | generic */
  framework: string;
  /** Model being used (e.g., "claude-sonnet-4-5") */
  model?: string;
  /** Additional metadata */
  meta?: Record<string, unknown>;
}

// ─── Sessions ──────────────────────────────────────────────

export interface Session {
  id: string;
  agentId: string;
  /** Who initiated this session (user ID, channel, etc.) */
  initiator?: string;
  /** Where the session is running (discord, terminal, api, etc.) */
  channel?: string;
  startedAt: string; // ISO 8601
  endedAt?: string;
  status: "active" | "completed" | "errored" | "timeout";
  /** Total estimated cost in USD */
  totalCostUsd?: number;
  /** Total tool calls in this session */
  totalToolCalls: number;
  /** Highest risk level seen in this session */
  maxRiskLevel: RiskLevel;
  meta?: Record<string, unknown>;
}

// ─── Events (Layer 1: WHAT happened) ───────────────────────

export type EventType =
  | "session.start"
  | "session.end"
  | "thinking.start"
  | "thinking.end"
  | "tool.start"
  | "tool.end"
  | "message.user"
  | "message.assistant"
  | "error"
  | "custom";

export interface BaseEvent {
  id: string;
  sessionId: string;
  agentId: string;
  type: EventType;
  timestamp: string; // ISO 8601
  /** Duration in ms (for paired events like tool.start/tool.end) */
  durationMs?: number;
}

export interface ThinkingEvent extends BaseEvent {
  type: "thinking.start" | "thinking.end";
  /** The agent's reasoning text */
  reasoning?: string;
  /** Token count for the thinking block */
  thinkingTokens?: number;
}

export interface ToolEvent extends BaseEvent {
  type: "tool.start" | "tool.end";
  /** Tool name (exec, web_fetch, read, message, etc.) */
  toolName: string;
  /** Unique ID for this tool call (to pair start/end) */
  toolCallId: string;
  /** Parameters passed to the tool */
  params?: Record<string, unknown>;
  /** Result returned by the tool */
  result?: unknown;
  /** Was the tool call successful? */
  success?: boolean;
  /** Error message if failed */
  error?: string;
  /** Estimated cost of this specific tool call in USD */
  costUsd?: number;
  /** Token usage for this call */
  tokens?: { input?: number; output?: number };
}

export interface MessageEvent extends BaseEvent {
  type: "message.user" | "message.assistant";
  content: string;
  /** Token count */
  tokens?: number;
}

export interface ErrorEvent extends BaseEvent {
  type: "error";
  error: string;
  stack?: string;
  recoverable: boolean;
}

export type AFREvent = ThinkingEvent | ToolEvent | MessageEvent | ErrorEvent | BaseEvent;

// ─── Risk Assessment (Layer 3: SO WHAT) ────────────────────

export type RiskLevel = "none" | "low" | "medium" | "high" | "critical";

export interface RiskAssessment {
  eventId: string;
  level: RiskLevel;
  /** Why this risk level was assigned */
  reasons: string[];
  /** Was PII detected in the data flow? */
  piiDetected: boolean;
  /** Types of PII found */
  piiTypes?: string[];
  /** Did data leave the local machine? */
  dataExfiltration: boolean;
  /** Is this action destructive (delete, overwrite, etc.)? */
  destructive: boolean;
  /** Is this action reversible? */
  reversible: boolean;
}

// ─── Anomalies ─────────────────────────────────────────────

export interface Anomaly {
  id: string;
  sessionId: string;
  eventId?: string;
  type: AnomalyType;
  severity: "info" | "warning" | "alert" | "critical";
  description: string;
  detectedAt: string;
  /** Has the user been notified? */
  notified: boolean;
}

export type AnomalyType =
  | "cost_spike"        // Cost significantly higher than baseline
  | "tool_burst"        // Unusual number of tool calls in short window
  | "new_tool"          // Agent used a tool it's never used before
  | "data_volume"       // Unusually large data access
  | "off_hours"         // Activity outside normal hours
  | "error_loop"        // Same error repeated multiple times
  | "pii_exposure"      // PII detected in tool parameters/results
  | "external_access"   // Unexpected external network access
  | "permission_escalation"; // Agent attempting elevated actions

// ─── Alert Configuration ───────────────────────────────────

export interface AlertConfig {
  enabled: boolean;
  channels: AlertChannel[];
  /** Minimum severity to trigger alerts */
  minSeverity: "info" | "warning" | "alert" | "critical";
  /** Quiet hours (no alerts unless critical) */
  quietHours?: { start: string; end: string; timezone: string };
}

export interface AlertChannel {
  type: "discord" | "slack" | "webhook" | "email" | "console";
  config: Record<string, string>;
}

// ─── Analytics ─────────────────────────────────────────────

export interface SessionAnalytics {
  sessionId: string;
  totalEvents: number;
  totalToolCalls: number;
  toolBreakdown: Record<string, number>; // toolName -> count
  totalCostUsd: number;
  costBreakdown: Record<string, number>; // toolName -> cost
  durationMs: number;
  riskSummary: Record<RiskLevel, number>; // level -> count
  anomalyCount: number;
  tokensUsed: { input: number; output: number; thinking: number };
}

export interface AgentAnalytics {
  agentId: string;
  period: { from: string; to: string };
  totalSessions: number;
  totalCostUsd: number;
  avgSessionCostUsd: number;
  avgSessionDurationMs: number;
  topTools: Array<{ tool: string; count: number; avgCost: number }>;
  anomalyRate: number; // anomalies per session
  riskTrend: Array<{ date: string; avgRisk: number }>;
}

// ─── Plugin Interface ──────────────────────────────────────

/**
 * Adapter interface for different agent frameworks.
 * Implement this to capture events from any agent system.
 */
export interface AgentAdapter {
  /** Unique name for this adapter */
  name: string;
  /** Which framework this adapter supports */
  framework: string;
  /** Initialize the adapter and start capturing */
  start(recorder: EventRecorder): Promise<void>;
  /** Stop capturing */
  stop(): Promise<void>;
}

/**
 * Interface that adapters use to send events to the recorder.
 */
export interface EventRecorder {
  record(event: Omit<AFREvent, "id">): void;
  startSession(session: Omit<Session, "id" | "totalToolCalls" | "maxRiskLevel">): string;
  endSession(sessionId: string, status?: Session["status"]): void;
}
