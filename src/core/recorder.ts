/**
 * Core event recorder — the heart of AFR.
 *
 * Receives events from adapters, runs them through the analysis pipeline,
 * stores them, and emits to real-time subscribers (dashboard, alerts).
 */

import { nanoid } from "nanoid";
import { EventEmitter } from "events";
import { EventStore } from "../store/database.js";
import { RiskAnalyzer } from "../analysis/risk.js";
import { AnomalyDetector } from "../analysis/anomaly.js";
import type {
  AFREvent,
  Session,
  EventRecorder,
  RiskAssessment,
  Anomaly,
  RiskLevel,
} from "../types.js";

export interface RecorderOptions {
  dbPath?: string;
  /** Enable real-time WebSocket broadcasting */
  realtime?: boolean;
}

export class FlightRecorder extends EventEmitter implements EventRecorder {
  private store: EventStore;
  private riskAnalyzer: RiskAnalyzer;
  private anomalyDetector: AnomalyDetector;
  private activeSessions: Map<string, { toolCalls: number; maxRisk: RiskLevel }> = new Map();

  constructor(opts?: RecorderOptions) {
    super();
    this.store = new EventStore(opts?.dbPath);
    this.riskAnalyzer = new RiskAnalyzer();
    this.anomalyDetector = new AnomalyDetector();
  }

  // ─── EventRecorder Interface ───────────────────────────

  startSession(
    session: Omit<Session, "id" | "totalToolCalls" | "maxRiskLevel">
  ): string {
    const id = nanoid(16);
    const fullSession: Session = {
      ...session,
      id,
      totalToolCalls: 0,
      maxRiskLevel: "none",
    };
    this.store.insertSession(fullSession);
    this.activeSessions.set(id, { toolCalls: 0, maxRisk: "none" });
    this.emit("session:start", fullSession);
    return id;
  }

  endSession(sessionId: string, status: Session["status"] = "completed"): void {
    const state = this.activeSessions.get(sessionId);
    this.store.updateSession(sessionId, {
      endedAt: new Date().toISOString(),
      status,
      totalToolCalls: state?.toolCalls ?? 0,
      maxRiskLevel: state?.maxRisk ?? "none",
    });
    this.activeSessions.delete(sessionId);
    this.emit("session:end", { sessionId, status });
  }

  record(event: Omit<AFREvent, "id">): void {
    const id = nanoid(16);
    const fullEvent = { ...event, id } as AFREvent;

    // Store the event
    this.store.insertEvent(fullEvent);

    // Track session stats
    if (event.type === "tool.end") {
      const state = this.activeSessions.get(event.sessionId);
      if (state) {
        state.toolCalls++;
      }
    }

    // Run risk analysis on tool events
    let risk: RiskAssessment | undefined;
    if (event.type === "tool.start" || event.type === "tool.end") {
      risk = this.riskAnalyzer.assess(fullEvent as any);
      this.store.insertRiskAssessment(risk);

      // Update max risk for session
      const state = this.activeSessions.get(event.sessionId);
      if (state && this.riskIsHigher(risk.level, state.maxRisk)) {
        state.maxRisk = risk.level;
      }
    }

    // Check for anomalies
    const anomalies = this.anomalyDetector.check(fullEvent, this.store);
    for (const anomaly of anomalies) {
      this.store.insertAnomaly(anomaly);
      this.emit("anomaly", anomaly);
    }

    // Emit for real-time subscribers
    this.emit("event", { event: fullEvent, risk, anomalies });
  }

  // ─── Query Interface ───────────────────────────────────

  getSessions(opts?: Parameters<EventStore["listSessions"]>[0]) {
    return this.store.listSessions(opts);
  }

  getSession(id: string) {
    return this.store.getSession(id);
  }

  getSessionEvents(sessionId: string, opts?: { type?: string; limit?: number }) {
    return this.store.getSessionEvents(sessionId, opts);
  }

  getSessionAnalytics(sessionId: string) {
    return this.store.getSessionAnalytics(sessionId);
  }

  getRecentEvents(opts?: { agentId?: string; limit?: number; since?: string }) {
    return this.store.getRecentEvents(opts);
  }

  getSessionAnomalies(sessionId: string) {
    return this.store.getSessionAnomalies(sessionId);
  }

  // ─── Helpers ───────────────────────────────────────────

  private riskIsHigher(a: RiskLevel, b: RiskLevel): boolean {
    const order: RiskLevel[] = ["none", "low", "medium", "high", "critical"];
    return order.indexOf(a) > order.indexOf(b);
  }

  close(): void {
    this.store.close();
  }
}
