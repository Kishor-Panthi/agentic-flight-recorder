#!/usr/bin/env node
/**
 * AFR CLI — command-line interface for Agentic Flight Recorder.
 *
 * Commands:
 *   afr start          Start the AFR server + OpenClaw adapter
 *   afr sessions       List recorded sessions
 *   afr replay <id>    Replay a session's events
 *   afr analytics <id> Show session analytics
 *   afr tail           Live tail of events
 *   afr status         Show server status
 */

import { Command } from "commander";
import chalk from "chalk";
import { FlightRecorder } from "../core/recorder.js";
import { createAFRServer } from "../server/index.js";
import { OpenClawAdapter } from "../adapters/openclaw.js";

const program = new Command();

program
  .name("afr")
  .description("🛩️  Agentic Flight Recorder — See what your AI agents are doing")
  .version("0.1.0");

// ─── start ───────────────────────────────────────────────

program
  .command("start")
  .description("Start the AFR server and begin recording")
  .option("-p, --port <port>", "Server port", "4242")
  .option("--db <path>", "Database path")
  .option("--log <path>", "OpenClaw log path to watch")
  .option("--no-openclaw", "Don't start OpenClaw adapter")
  .action(async (opts) => {
    console.log(chalk.cyan("🛩️  Agentic Flight Recorder v0.1.0"));
    console.log();

    const recorder = new FlightRecorder({ dbPath: opts.db });
    const server = createAFRServer({ recorder, port: Number(opts.port) });

    // Start OpenClaw adapter by default
    if (opts.openclaw !== false) {
      const adapter = new OpenClawAdapter(opts.log);
      await adapter.start(recorder);
    }

    // Log events in real-time
    recorder.on("event", ({ event, risk, anomalies }) => {
      const time = new Date(event.timestamp).toLocaleTimeString();
      const riskColor = risk
        ? { none: "green", low: "green", medium: "yellow", high: "red", critical: "bgRed" }[risk.level]
        : "green";

      if (event.type === "tool.start") {
        const e = event as any;
        console.log(
          `${chalk.gray(time)} ${chalk.cyan("🔧")} ${chalk.bold(e.toolName)} ${chalk.gray(`[${e.toolCallId?.slice(0, 8)}]`)} ${(chalk as any)[riskColor]?.(`●`) ?? "●"}`
        );
      } else if (event.type === "tool.end") {
        const e = event as any;
        const duration = e.durationMs ? `${e.durationMs}ms` : "";
        const cost = e.costUsd ? `$${e.costUsd.toFixed(4)}` : "";
        console.log(
          `${chalk.gray(time)} ${e.success !== false ? chalk.green("✓") : chalk.red("✗")} ${e.toolName} ${chalk.gray(duration)} ${chalk.yellow(cost)}`
        );
      } else if (event.type === "error") {
        console.log(
          `${chalk.gray(time)} ${chalk.red("❌")} ${(event as any).error?.slice(0, 100)}`
        );
      } else if (event.type === "session.start" || event.type.startsWith("thinking")) {
        // Handled by session logging
      }

      // Log anomalies
      for (const a of anomalies ?? []) {
        const icon = { info: "ℹ️", warning: "⚠️", alert: "🚨", critical: "🔴" }[a.severity];
        console.log(`${chalk.gray(time)} ${icon} ${chalk.bold(a.type)}: ${a.description}`);
      }
    });

    recorder.on("session:start", (session: any) => {
      console.log(
        `\n${chalk.cyan("━".repeat(60))}\n${chalk.bold("📍 New session:")} ${session.id} (${session.agentId})\n${chalk.cyan("━".repeat(60))}`
      );
    });

    recorder.on("session:end", ({ sessionId, status }: any) => {
      const icon = status === "completed" ? "✅" : "❌";
      console.log(`\n${icon} Session ${sessionId} ended: ${status}\n`);
    });

    await server.start();
    console.log();
    console.log(chalk.green("Recording... Press Ctrl+C to stop."));
  });

// ─── sessions ────────────────────────────────────────────

program
  .command("sessions")
  .description("List recorded sessions")
  .option("-a, --agent <id>", "Filter by agent ID")
  .option("-n, --limit <n>", "Max sessions to show", "20")
  .action((opts) => {
    const recorder = new FlightRecorder();
    const sessions = recorder.getSessions({
      agentId: opts.agent,
      limit: Number(opts.limit),
    });

    if (sessions.length === 0) {
      console.log(chalk.yellow("No sessions found."));
      return;
    }

    console.log(chalk.bold(`\n📋 Sessions (${sessions.length}):\n`));

    for (const s of sessions) {
      const risk = {
        none: chalk.green("●"),
        low: chalk.green("●"),
        medium: chalk.yellow("●"),
        high: chalk.red("●"),
        critical: chalk.bgRed("●"),
      }[s.maxRiskLevel];

      const cost = s.totalCostUsd ? `$${s.totalCostUsd.toFixed(2)}` : "$0.00";
      const time = new Date(s.startedAt).toLocaleString();

      console.log(
        `  ${risk} ${chalk.bold(s.id.slice(0, 12))} ${chalk.gray(s.agentId)} ${chalk.gray(time)} ${chalk.yellow(cost)} ${chalk.gray(`${s.totalToolCalls} calls`)} ${s.status === "active" ? chalk.green("ACTIVE") : ""}`
      );
    }

    recorder.close();
  });

// ─── replay ──────────────────────────────────────────────

program
  .command("replay <sessionId>")
  .description("Replay a session's events step by step")
  .option("--speed <x>", "Playback speed multiplier", "1")
  .action(async (sessionId, opts) => {
    const recorder = new FlightRecorder();
    const session = recorder.getSession(sessionId);

    if (!session) {
      console.log(chalk.red(`Session ${sessionId} not found.`));
      recorder.close();
      return;
    }

    const events = recorder.getSessionEvents(sessionId);
    console.log(chalk.bold(`\n🔄 Replaying session ${sessionId} (${events.length} events):\n`));

    const speed = Number(opts.speed);

    for (let i = 0; i < events.length; i++) {
      const event = events[i]!;
      const time = new Date(event.timestamp).toLocaleTimeString();

      // Delay based on timestamp diff
      if (i > 0) {
        const prev = new Date(events[i - 1]!.timestamp).getTime();
        const curr = new Date(event.timestamp).getTime();
        const delay = Math.min((curr - prev) / speed, 2000); // Cap at 2s
        if (delay > 0) await sleep(delay);
      }

      if (event.type === "tool.start") {
        const e = event as any;
        console.log(`${chalk.gray(time)} ${chalk.cyan("🔧 START")} ${chalk.bold(e.toolName)}`);
        if (e.params) {
          const paramStr = JSON.stringify(e.params, null, 2).slice(0, 200);
          console.log(chalk.gray(`         ${paramStr}`));
        }
      } else if (event.type === "tool.end") {
        const e = event as any;
        const icon = e.success !== false ? chalk.green("✓ END  ") : chalk.red("✗ END  ");
        console.log(`${chalk.gray(time)} ${icon} ${e.toolName} ${chalk.gray(e.durationMs ? `(${e.durationMs}ms)` : "")}`);
      } else if (event.type === "thinking.start") {
        const e = event as any;
        console.log(`${chalk.gray(time)} ${chalk.magenta("🧠 THINKING")} ${chalk.gray(e.reasoning?.slice(0, 150) ?? "")}`);
      } else if (event.type === "error") {
        console.log(`${chalk.gray(time)} ${chalk.red("❌ ERROR")} ${(event as any).error?.slice(0, 150)}`);
      } else if (event.type === "message.user") {
        console.log(`${chalk.gray(time)} ${chalk.blue("👤 USER")} ${(event as any).content?.slice(0, 150)}`);
      } else if (event.type === "message.assistant") {
        console.log(`${chalk.gray(time)} ${chalk.green("🤖 AGENT")} ${(event as any).content?.slice(0, 150)}`);
      }
    }

    // Show analytics
    const analytics = recorder.getSessionAnalytics(sessionId);
    if (analytics) {
      console.log(`\n${chalk.bold("📊 Session Summary:")}`);
      console.log(`   Duration: ${Math.round(analytics.durationMs / 1000)}s`);
      console.log(`   Tool calls: ${analytics.totalToolCalls}`);
      console.log(`   Cost: $${analytics.totalCostUsd.toFixed(2)}`);
      console.log(`   Anomalies: ${analytics.anomalyCount}`);
      if (Object.keys(analytics.toolBreakdown).length > 0) {
        console.log(`   Tools: ${Object.entries(analytics.toolBreakdown).map(([k, v]) => `${k}(${v})`).join(", ")}`);
      }
    }

    recorder.close();
  });

// ─── analytics ───────────────────────────────────────────

program
  .command("analytics <sessionId>")
  .description("Show detailed analytics for a session")
  .action((sessionId) => {
    const recorder = new FlightRecorder();
    const analytics = recorder.getSessionAnalytics(sessionId);

    if (!analytics) {
      console.log(chalk.red(`Session ${sessionId} not found.`));
      recorder.close();
      return;
    }

    console.log(chalk.bold(`\n📊 Analytics for ${sessionId}:\n`));
    console.log(`  Events:     ${analytics.totalEvents}`);
    console.log(`  Tool calls: ${analytics.totalToolCalls}`);
    console.log(`  Duration:   ${Math.round(analytics.durationMs / 1000)}s`);
    console.log(`  Cost:       ${chalk.yellow(`$${analytics.totalCostUsd.toFixed(4)}`)}`);
    console.log(`  Anomalies:  ${analytics.anomalyCount}`);
    console.log(`  Tokens:     in=${analytics.tokensUsed.input} out=${analytics.tokensUsed.output} thinking=${analytics.tokensUsed.thinking}`);

    if (Object.keys(analytics.toolBreakdown).length > 0) {
      console.log(`\n  ${chalk.bold("Tool Usage:")}`);
      for (const [tool, count] of Object.entries(analytics.toolBreakdown).sort((a, b) => b[1] - a[1])) {
        const cost = analytics.costBreakdown[tool] ?? 0;
        const bar = "█".repeat(Math.min(count, 30));
        console.log(`    ${tool.padEnd(15)} ${chalk.cyan(bar)} ${count} ${chalk.yellow(`$${cost.toFixed(4)}`)}`);
      }
    }

    recorder.close();
  });

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

program.parse();
