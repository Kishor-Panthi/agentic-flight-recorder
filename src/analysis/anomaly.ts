/**
 * Anomaly detector — finds unusual agent behavior patterns.
 *
 * Starts simple (rules-based), designed to evolve into ML-based over time.
 */

import { nanoid } from "nanoid";
import type { AFREvent, Anomaly, AnomalyType } from "../types.js";
import type { EventStore } from "../store/database.js";

interface AnomalyRule {
  type: AnomalyType;
  check(event: AFREvent, store: EventStore): Anomaly | null;
}

export class AnomalyDetector {
  private rules: AnomalyRule[];

  constructor() {
    this.rules = [
      new ToolBurstRule(),
      new ErrorLoopRule(),
      new OffHoursRule(),
      new CostSpikeRule(),
    ];
  }

  check(event: AFREvent, store: EventStore): Anomaly[] {
    const anomalies: Anomaly[] = [];
    for (const rule of this.rules) {
      const anomaly = rule.check(event, store);
      if (anomaly) anomalies.push(anomaly);
    }
    return anomalies;
  }
}

/**
 * Detects rapid bursts of tool calls (>10 in 30 seconds).
 */
class ToolBurstRule implements AnomalyRule {
  type: AnomalyType = "tool_burst";

  check(event: AFREvent, store: EventStore): Anomaly | null {
    if (event.type !== "tool.start") return null;

    const thirtySecsAgo = new Date(Date.now() - 30_000).toISOString();
    const recentEvents = store.getRecentEvents({
      agentId: event.agentId,
      since: thirtySecsAgo,
      limit: 20,
    });

    const toolCalls = recentEvents.filter((e) => e.type === "tool.start");

    if (toolCalls.length >= 10) {
      return {
        id: nanoid(16),
        sessionId: event.sessionId,
        eventId: event.id,
        type: this.type,
        severity: "warning",
        description: `Tool burst detected: ${toolCalls.length} tool calls in 30 seconds`,
        detectedAt: new Date().toISOString(),
        notified: false,
      };
    }

    return null;
  }
}

/**
 * Detects repeated errors (same error 3+ times in a session).
 */
class ErrorLoopRule implements AnomalyRule {
  type: AnomalyType = "error_loop";

  check(event: AFREvent, store: EventStore): Anomaly | null {
    if (event.type !== "error") return null;

    const sessionEvents = store.getSessionEvents(event.sessionId, { type: "error", limit: 10 });
    const errorMessages = sessionEvents.map((e) => (e as any).error ?? "");
    const currentError = (event as any).error ?? "";

    const sameErrors = errorMessages.filter((msg) => msg === currentError);

    if (sameErrors.length >= 3) {
      return {
        id: nanoid(16),
        sessionId: event.sessionId,
        eventId: event.id,
        type: this.type,
        severity: "alert",
        description: `Error loop detected: "${currentError.slice(0, 100)}" repeated ${sameErrors.length} times`,
        detectedAt: new Date().toISOString(),
        notified: false,
      };
    }

    return null;
  }
}

/**
 * Detects activity during off-hours (11pm - 6am local time).
 */
class OffHoursRule implements AnomalyRule {
  type: AnomalyType = "off_hours";

  check(event: AFREvent): Anomaly | null {
    if (event.type !== "session.start") return null;

    const hour = new Date(event.timestamp).getHours();
    if (hour >= 23 || hour < 6) {
      return {
        id: nanoid(16),
        sessionId: event.sessionId,
        eventId: event.id,
        type: this.type,
        severity: "info",
        description: `Agent session started during off-hours (${hour}:00)`,
        detectedAt: new Date().toISOString(),
        notified: false,
      };
    }

    return null;
  }
}

/**
 * Detects sessions that are accumulating unusually high costs.
 */
class CostSpikeRule implements AnomalyRule {
  type: AnomalyType = "cost_spike";

  check(event: AFREvent, store: EventStore): Anomaly | null {
    if (event.type !== "tool.end") return null;

    const cost = (event as any).costUsd ?? 0;
    if (cost > 1.0) {
      return {
        id: nanoid(16),
        sessionId: event.sessionId,
        eventId: event.id,
        type: this.type,
        severity: "warning",
        description: `High-cost tool call: $${cost.toFixed(2)} for ${(event as any).toolName}`,
        detectedAt: new Date().toISOString(),
        notified: false,
      };
    }

    return null;
  }
}
