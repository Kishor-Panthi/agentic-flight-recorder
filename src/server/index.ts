/**
 * HTTP API + WebSocket server for the dashboard.
 *
 * REST API for querying sessions/events/analytics.
 * WebSocket for real-time event streaming to the dashboard.
 */

import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "http";
import { FlightRecorder } from "../core/recorder.js";

export interface ServerOptions {
  port?: number;
  host?: string;
  recorder: FlightRecorder;
}

export function createAFRServer(opts: ServerOptions) {
  const { recorder, port = 4242, host = "127.0.0.1" } = opts;

  const app = express();
  app.use(express.json());

  // CORS for local dashboard dev
  app.use((_, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Content-Type");
    next();
  });

  // ─── REST API ──────────────────────────────────────────

  // Health check
  app.get("/api/health", (_, res) => {
    res.json({ status: "ok", version: "0.1.0" });
  });

  // List sessions
  app.get("/api/sessions", (req, res) => {
    const sessions = recorder.getSessions({
      agentId: req.query.agentId as string,
      status: req.query.status as string,
      limit: Number(req.query.limit) || 50,
      offset: Number(req.query.offset) || 0,
    });
    res.json({ sessions });
  });

  // Get single session
  app.get("/api/sessions/:id", (req, res) => {
    const session = recorder.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    res.json({ session });
  });

  // Get session events (for replay)
  app.get("/api/sessions/:id/events", (req, res) => {
    const events = recorder.getSessionEvents(req.params.id, {
      type: req.query.type as string,
      limit: Number(req.query.limit) || 1000,
    });
    res.json({ events });
  });

  // Get session analytics
  app.get("/api/sessions/:id/analytics", (req, res) => {
    const analytics = recorder.getSessionAnalytics(req.params.id);
    if (!analytics) return res.status(404).json({ error: "Session not found" });
    res.json({ analytics });
  });

  // Get session anomalies
  app.get("/api/sessions/:id/anomalies", (req, res) => {
    const anomalies = recorder.getSessionAnomalies(req.params.id);
    res.json({ anomalies });
  });

  // Get recent events across all sessions
  app.get("/api/events/recent", (req, res) => {
    const events = recorder.getRecentEvents({
      agentId: req.query.agentId as string,
      limit: Number(req.query.limit) || 100,
      since: req.query.since as string,
    });
    res.json({ events });
  });

  // Ingest endpoint (for external adapters to POST events)
  app.post("/api/ingest", (req, res) => {
    try {
      const { event, session } = req.body;

      if (session?.action === "start") {
        const id = recorder.startSession({
          agentId: session.agentId,
          initiator: session.initiator,
          channel: session.channel,
          startedAt: session.startedAt ?? new Date().toISOString(),
          status: "active",
        });
        return res.json({ sessionId: id });
      }

      if (session?.action === "end") {
        recorder.endSession(session.sessionId, session.status);
        return res.json({ ok: true });
      }

      if (event) {
        recorder.record({
          ...event,
          timestamp: event.timestamp ?? new Date().toISOString(),
        });
        return res.json({ ok: true });
      }

      res.status(400).json({ error: "Must provide event or session" });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── WebSocket (Real-time) ─────────────────────────────

  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });

  const subscribers = new Set<WebSocket>();

  wss.on("connection", (ws) => {
    subscribers.add(ws);
    ws.on("close", () => subscribers.delete(ws));
  });

  // Broadcast events to all connected dashboard clients
  const broadcast = (type: string, data: unknown) => {
    const msg = JSON.stringify({ type, data, timestamp: new Date().toISOString() });
    for (const ws of subscribers) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }
  };

  recorder.on("event", (data) => broadcast("event", data));
  recorder.on("anomaly", (data) => broadcast("anomaly", data));
  recorder.on("session:start", (data) => broadcast("session:start", data));
  recorder.on("session:end", (data) => broadcast("session:end", data));

  // ─── Start ─────────────────────────────────────────────

  return {
    app,
    server,
    start: () => {
      return new Promise<void>((resolve) => {
        server.listen(port, host, () => {
          console.log(`🛩️  AFR server running at http://${host}:${port}`);
          console.log(`📡 WebSocket at ws://${host}:${port}/ws`);
          console.log(`📊 Dashboard at http://${host}:${port}`);
          resolve();
        });
      });
    },
    stop: () => {
      return new Promise<void>((resolve) => {
        for (const ws of subscribers) ws.close();
        server.close(() => resolve());
      });
    },
  };
}
