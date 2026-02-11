/**
 * Risk analyzer — assigns risk levels to agent actions.
 *
 * Rules-based + pattern matching. Designed to be fast (runs on every event).
 */

import type { ToolEvent, RiskAssessment, RiskLevel } from "../types.js";

// Tools that can modify external state
const DESTRUCTIVE_TOOLS = new Set(["exec", "write", "edit", "message", "delete"]);

// Tools that access external services
const EXTERNAL_TOOLS = new Set(["web_fetch", "web_search", "browser", "message", "email"]);

// Tools that are read-only and local
const SAFE_TOOLS = new Set(["read", "memory_search", "memory_get", "session_status"]);

// Patterns that suggest PII in text
const PII_PATTERNS: Array<{ pattern: RegExp; type: string }> = [
  { pattern: /\b\d{3}[-.]?\d{2}[-.]?\d{4}\b/, type: "ssn" },
  { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/, type: "email" },
  { pattern: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/, type: "credit_card" },
  { pattern: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/, type: "phone" },
  { pattern: /\bpassword\s*[:=]\s*\S+/i, type: "password" },
  { pattern: /\b(?:api[_-]?key|secret|token)\s*[:=]\s*\S+/i, type: "api_key" },
];

// Dangerous exec patterns
const DANGEROUS_EXEC_PATTERNS = [
  /\brm\s+-rf?\b/,
  /\bsudo\b/,
  /\bcurl\b.*\|\s*(?:bash|sh)\b/,
  /\bchmod\s+777\b/,
  /\bdd\s+if=/,
  /\b:(){.*};:/,  // fork bomb
  /\bmkfs\b/,
  /\b>\s*\/dev\/sd[a-z]/,
];

export class RiskAnalyzer {
  assess(event: ToolEvent): RiskAssessment {
    const reasons: string[] = [];
    let level: RiskLevel = "none";
    let piiDetected = false;
    const piiTypes: string[] = [];
    let dataExfiltration = false;
    let destructive = false;
    let reversible = true;

    const toolName = event.toolName ?? "";
    const paramsStr = JSON.stringify(event.params ?? {});
    const resultStr = JSON.stringify(event.result ?? "");
    const fullText = paramsStr + " " + resultStr;

    // Check tool category
    if (SAFE_TOOLS.has(toolName)) {
      level = "none";
      reasons.push("Read-only local tool");
      return { eventId: event.id, level, reasons, piiDetected, piiTypes, dataExfiltration, destructive, reversible };
    }

    if (DESTRUCTIVE_TOOLS.has(toolName)) {
      level = this.elevate(level, "medium");
      destructive = true;
      reasons.push(`Potentially destructive tool: ${toolName}`);
    }

    if (EXTERNAL_TOOLS.has(toolName)) {
      level = this.elevate(level, "low");
      dataExfiltration = true;
      reasons.push(`External access: ${toolName}`);
    }

    // Check exec commands specifically
    if (toolName === "exec" && event.params) {
      const cmd = String((event.params as any).command ?? "");
      for (const pattern of DANGEROUS_EXEC_PATTERNS) {
        if (pattern.test(cmd)) {
          level = this.elevate(level, "high");
          destructive = true;
          reversible = false;
          reasons.push(`Dangerous command pattern: ${pattern.source}`);
        }
      }
    }

    // Check for PII
    for (const { pattern, type } of PII_PATTERNS) {
      if (pattern.test(fullText)) {
        piiDetected = true;
        piiTypes.push(type);
        level = this.elevate(level, "high");
        reasons.push(`PII detected: ${type}`);
      }
    }

    // Check for message sending (external communication)
    if (toolName === "message" && event.params) {
      const action = (event.params as any).action;
      if (action === "send") {
        level = this.elevate(level, "medium");
        reasons.push("Sending external message");
      }
    }

    // Check for file writes to sensitive paths
    if (toolName === "write" && event.params) {
      const path = String((event.params as any).path ?? (event.params as any).file_path ?? "");
      if (path.includes(".env") || path.includes("ssh") || path.includes("credentials")) {
        level = this.elevate(level, "critical");
        reasons.push(`Writing to sensitive path: ${path}`);
      }
    }

    // Default to low if we have no specific concerns
    if (level === "none" && !SAFE_TOOLS.has(toolName)) {
      level = "low";
      reasons.push("Standard tool usage");
    }

    return {
      eventId: event.id,
      level,
      reasons,
      piiDetected,
      piiTypes: piiTypes.length > 0 ? piiTypes : undefined,
      dataExfiltration,
      destructive,
      reversible,
    };
  }

  private elevate(current: RiskLevel, proposed: RiskLevel): RiskLevel {
    const order: RiskLevel[] = ["none", "low", "medium", "high", "critical"];
    return order.indexOf(proposed) > order.indexOf(current) ? proposed : current;
  }
}
