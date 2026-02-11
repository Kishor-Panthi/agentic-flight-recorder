/**
 * SQLite-based event store.
 * Local-first, zero config, portable.
 */

import Database from "better-sqlite3";
import { join } from "path";
import { homedir } from "os";
import { mkdirSync } from "fs";
import type {
  AFREvent,
  Session,
  RiskAssessment,
  Anomaly,
  SessionAnalytics,
  RiskLevel,
} from "../types.js";

const DEFAULT_DB_DIR = join(homedir(), ".afr");
const DEFAULT_DB_PATH = join(DEFAULT_DB_DIR, "flight-recorder.db");

export class EventStore {
  private db: Database.Database;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    mkdirSync(join(dbPath, ".."), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        initiator TEXT,
        channel TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        total_cost_usd REAL DEFAULT 0,
        total_tool_calls INTEGER DEFAULT 0,
        max_risk_level TEXT DEFAULT 'none',
        meta TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        duration_ms INTEGER,
        data TEXT NOT NULL, -- JSON blob with type-specific fields
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );

      CREATE TABLE IF NOT EXISTS risk_assessments (
        event_id TEXT PRIMARY KEY,
        level TEXT NOT NULL,
        reasons TEXT NOT NULL, -- JSON array
        pii_detected INTEGER DEFAULT 0,
        pii_types TEXT, -- JSON array
        data_exfiltration INTEGER DEFAULT 0,
        destructive INTEGER DEFAULT 0,
        reversible INTEGER DEFAULT 1,
        FOREIGN KEY (event_id) REFERENCES events(id)
      );

      CREATE TABLE IF NOT EXISTS anomalies (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        event_id TEXT,
        type TEXT NOT NULL,
        severity TEXT NOT NULL,
        description TEXT NOT NULL,
        detected_at TEXT NOT NULL,
        notified INTEGER DEFAULT 0,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );

      -- Indexes for common queries
      CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
      CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
      CREATE INDEX IF NOT EXISTS idx_events_agent ON events(agent_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
      CREATE INDEX IF NOT EXISTS idx_anomalies_session ON anomalies(session_id);
      CREATE INDEX IF NOT EXISTS idx_anomalies_severity ON anomalies(severity);
    `);
  }

  // ─── Sessions ──────────────────────────────────────────

  insertSession(session: Session): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, agent_id, initiator, channel, started_at, status, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        session.id,
        session.agentId,
        session.initiator ?? null,
        session.channel ?? null,
        session.startedAt,
        session.status,
        session.meta ? JSON.stringify(session.meta) : null
      );
  }

  updateSession(
    id: string,
    updates: Partial<Pick<Session, "endedAt" | "status" | "totalCostUsd" | "totalToolCalls" | "maxRiskLevel">>
  ): void {
    const sets: string[] = [];
    const values: unknown[] = [];

    if (updates.endedAt !== undefined) { sets.push("ended_at = ?"); values.push(updates.endedAt); }
    if (updates.status !== undefined) { sets.push("status = ?"); values.push(updates.status); }
    if (updates.totalCostUsd !== undefined) { sets.push("total_cost_usd = ?"); values.push(updates.totalCostUsd); }
    if (updates.totalToolCalls !== undefined) { sets.push("total_tool_calls = ?"); values.push(updates.totalToolCalls); }
    if (updates.maxRiskLevel !== undefined) { sets.push("max_risk_level = ?"); values.push(updates.maxRiskLevel); }

    if (sets.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  }

  getSession(id: string): Session | undefined {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as any;
    return row ? this.rowToSession(row) : undefined;
  }

  listSessions(opts?: {
    agentId?: string;
    status?: string;
    limit?: number;
    offset?: number;
  }): Session[] {
    const where: string[] = [];
    const params: unknown[] = [];

    if (opts?.agentId) { where.push("agent_id = ?"); params.push(opts.agentId); }
    if (opts?.status) { where.push("status = ?"); params.push(opts.status); }

    const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const limit = opts?.limit ?? 50;
    const offset = opts?.offset ?? 0;

    const rows = this.db
      .prepare(`SELECT * FROM sessions ${whereClause} ORDER BY started_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as any[];

    return rows.map(this.rowToSession);
  }

  // ─── Events ────────────────────────────────────────────

  insertEvent(event: AFREvent): void {
    const { id, sessionId, agentId, type, timestamp, durationMs, ...rest } = event;
    this.db
      .prepare(
        `INSERT INTO events (id, session_id, agent_id, type, timestamp, duration_ms, data)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, sessionId, agentId, type, timestamp, durationMs ?? null, JSON.stringify(rest));
  }

  getSessionEvents(sessionId: string, opts?: { type?: string; limit?: number }): AFREvent[] {
    const where = ["session_id = ?"];
    const params: unknown[] = [sessionId];

    if (opts?.type) { where.push("type = ?"); params.push(opts.type); }

    const limit = opts?.limit ?? 1000;
    const rows = this.db
      .prepare(`SELECT * FROM events WHERE ${where.join(" AND ")} ORDER BY timestamp ASC LIMIT ?`)
      .all(...params, limit) as any[];

    return rows.map(this.rowToEvent);
  }

  getRecentEvents(opts?: { agentId?: string; limit?: number; since?: string }): AFREvent[] {
    const where: string[] = [];
    const params: unknown[] = [];

    if (opts?.agentId) { where.push("agent_id = ?"); params.push(opts.agentId); }
    if (opts?.since) { where.push("timestamp > ?"); params.push(opts.since); }

    const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const limit = opts?.limit ?? 100;

    const rows = this.db
      .prepare(`SELECT * FROM events ${whereClause} ORDER BY timestamp DESC LIMIT ?`)
      .all(...params, limit) as any[];

    return rows.map(this.rowToEvent);
  }

  // ─── Risk Assessments ──────────────────────────────────

  insertRiskAssessment(ra: RiskAssessment): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO risk_assessments
         (event_id, level, reasons, pii_detected, pii_types, data_exfiltration, destructive, reversible)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        ra.eventId,
        ra.level,
        JSON.stringify(ra.reasons),
        ra.piiDetected ? 1 : 0,
        ra.piiTypes ? JSON.stringify(ra.piiTypes) : null,
        ra.dataExfiltration ? 1 : 0,
        ra.destructive ? 1 : 0,
        ra.reversible ? 1 : 0
      );
  }

  // ─── Anomalies ─────────────────────────────────────────

  insertAnomaly(anomaly: Anomaly): void {
    this.db
      .prepare(
        `INSERT INTO anomalies (id, session_id, event_id, type, severity, description, detected_at, notified)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        anomaly.id,
        anomaly.sessionId,
        anomaly.eventId ?? null,
        anomaly.type,
        anomaly.severity,
        anomaly.description,
        anomaly.detectedAt,
        anomaly.notified ? 1 : 0
      );
  }

  getSessionAnomalies(sessionId: string): Anomaly[] {
    const rows = this.db
      .prepare("SELECT * FROM anomalies WHERE session_id = ? ORDER BY detected_at DESC")
      .all(sessionId) as any[];

    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      eventId: r.event_id,
      type: r.type,
      severity: r.severity,
      description: r.description,
      detectedAt: r.detected_at,
      notified: !!r.notified,
    }));
  }

  // ─── Analytics ─────────────────────────────────────────

  getSessionAnalytics(sessionId: string): SessionAnalytics | undefined {
    const session = this.getSession(sessionId);
    if (!session) return undefined;

    const events = this.getSessionEvents(sessionId);
    const toolEvents = events.filter((e) => e.type === "tool.end") as any[];

    const toolBreakdown: Record<string, number> = {};
    const costBreakdown: Record<string, number> = {};
    let totalCost = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let thinkingTokens = 0;

    for (const e of toolEvents) {
      const name = e.toolName ?? "unknown";
      toolBreakdown[name] = (toolBreakdown[name] ?? 0) + 1;
      const cost = e.costUsd ?? 0;
      costBreakdown[name] = (costBreakdown[name] ?? 0) + cost;
      totalCost += cost;
      inputTokens += e.tokens?.input ?? 0;
      outputTokens += e.tokens?.output ?? 0;
    }

    for (const e of events) {
      if (e.type === "thinking.end") {
        thinkingTokens += (e as any).thinkingTokens ?? 0;
      }
    }

    const anomalies = this.getSessionAnomalies(sessionId);
    const startTime = new Date(session.startedAt).getTime();
    const endTime = session.endedAt ? new Date(session.endedAt).getTime() : Date.now();

    const riskSummary: Record<RiskLevel, number> = { none: 0, low: 0, medium: 0, high: 0, critical: 0 };

    return {
      sessionId,
      totalEvents: events.length,
      totalToolCalls: toolEvents.length,
      toolBreakdown,
      totalCostUsd: totalCost,
      costBreakdown,
      durationMs: endTime - startTime,
      riskSummary,
      anomalyCount: anomalies.length,
      tokensUsed: { input: inputTokens, output: outputTokens, thinking: thinkingTokens },
    };
  }

  // ─── Helpers ───────────────────────────────────────────

  private rowToSession(row: any): Session {
    return {
      id: row.id,
      agentId: row.agent_id,
      initiator: row.initiator,
      channel: row.channel,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      status: row.status,
      totalCostUsd: row.total_cost_usd,
      totalToolCalls: row.total_tool_calls,
      maxRiskLevel: row.max_risk_level,
      meta: row.meta ? JSON.parse(row.meta) : undefined,
    };
  }

  private rowToEvent(row: any): AFREvent {
    const data = JSON.parse(row.data);
    return {
      id: row.id,
      sessionId: row.session_id,
      agentId: row.agent_id,
      type: row.type,
      timestamp: row.timestamp,
      durationMs: row.duration_ms,
      ...data,
    };
  }

  close(): void {
    this.db.close();
  }
}
