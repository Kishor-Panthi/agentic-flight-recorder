/**
 * Agentic Flight Recorder — Universal observability for AI agents.
 *
 * @example
 * ```ts
 * import { FlightRecorder, createAFRServer, OpenClawAdapter, AFRClient } from "agentic-flight-recorder";
 *
 * // Option 1: Full server with OpenClaw adapter
 * const recorder = new FlightRecorder();
 * const server = createAFRServer({ recorder });
 * const adapter = new OpenClawAdapter();
 * await adapter.start(recorder);
 * await server.start();
 *
 * // Option 2: Client SDK for any agent
 * const client = new AFRClient({ agentId: "my-agent" });
 * await client.startSession();
 * await client.recordToolStart("search", "call-1", { query: "test" });
 * await client.recordToolEnd("search", "call-1", { success: true });
 * await client.endSession();
 * ```
 */

export { FlightRecorder } from "./core/recorder.js";
export type { RecorderOptions } from "./core/recorder.js";

export { createAFRServer } from "./server/index.js";
export type { ServerOptions } from "./server/index.js";

export { EventStore } from "./store/database.js";

export { RiskAnalyzer } from "./analysis/risk.js";
export { AnomalyDetector } from "./analysis/anomaly.js";

export { OpenClawAdapter } from "./adapters/openclaw.js";
export { AFRClient } from "./adapters/generic-http.js";
export type { AFRClientOptions } from "./adapters/generic-http.js";

export type {
  AFREvent,
  AgentAdapter,
  AgentAnalytics,
  AgentIdentity,
  AlertChannel,
  AlertConfig,
  Anomaly,
  AnomalyType,
  BaseEvent,
  ErrorEvent,
  EventRecorder,
  EventType,
  MessageEvent,
  RiskAssessment,
  RiskLevel,
  Session,
  SessionAnalytics,
  ThinkingEvent,
  ToolEvent,
} from "./types.js";
