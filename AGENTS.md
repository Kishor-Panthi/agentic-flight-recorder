# AGENTS.md — Agentic Flight Recorder (AFR)

## What Is This?

A universal observability and audit system for AI agents. Think "black box flight recorder" — every tool call, reasoning step, cost, and risk is captured, analyzed, and replayable. Works with OpenClaw out of the box, any HTTP-capable agent via the generic adapter, and with planned support for LangChain/CrewAI.

**Author:** Kishor Panthi | **Repo:** `Kishor-Panthi/agentic-flight-recorder` | **License:** MIT

---

## Codebase Map

```
src/
├── index.ts              # Public API — exports everything a consumer needs
├── types.ts              # Core type system — the data model (single source of truth)
├── core/
│   └── recorder.ts       # FlightRecorder — the event pipeline hub
├── store/
│   └── database.ts       # EventStore — SQLite persistence (better-sqlite3, WAL mode)
├── analysis/
│   ├── risk.ts           # RiskAnalyzer — rules-based risk scoring per event
│   └── anomaly.ts        # AnomalyDetector — pattern-based anomaly rules
├── server/
│   └── index.ts          # Express + WebSocket HTTP API server
├── adapters/
│   ├── openclaw.ts       # OpenClawAdapter — log file watcher for OpenClaw
│   └── generic-http.ts   # AFRClient — Node.js SDK for any agent framework
└── cli/
    └── index.ts          # CLI — Commander-based: start, sessions, replay, analytics
```

### Entry Points (tsup builds these)

| Entry | File | Purpose |
|-------|------|---------|
| `index` | `src/index.ts` | Library exports |
| `cli/index` | `src/cli/index.ts` | `afr` CLI binary |
| `server/index` | `src/server/index.ts` | Server module (re-exported from index.ts) |

---

## Core Data Model (`src/types.ts`)

Three layers of observability:

### Layer 1: WHAT happened (Events)
```
BaseEvent → ThinkingEvent | ToolEvent | MessageEvent | ErrorEvent
```

- **`Session`**: Tracks agent sessions — status, cost, risk, tool call count, initiator, channel
- **`ToolEvent`**: tool.start / tool.end with toolName, params, result, cost, duration, tokens
- **`ThinkingEvent`**: Agent reasoning text and thinking token count
- **`MessageEvent`**: User/assistant message content
- **`ErrorEvent`**: Error tracking with recoverability flag

### Layer 2: WHY it happened
Captured via thinking events — the agent's reasoning chain at decision time.

### Layer 3: SO WHAT (Risk + Anomalies)
- **`RiskAssessment`**: Per-event risk score (none → critical), PII flags, data exfiltration, destructiveness
- **`Anomaly`**: Cross-event pattern detection — bursts, error loops, off-hours, cost spikes

### Pluggable Architecture
- **`AgentAdapter`** interface for adding new agent frameworks
- **`EventRecorder`** interface for the core pipeline
- Plug in adapters by implementing `AgentAdapter` and calling `recorder.record()`

---

## Key Modules

### 1. FlightRecorder (`src/core/recorder.ts`) — The Hub

Constructor takes `RecorderOptions` (dbPath, realtime). Extends EventEmitter.

**Flow per event:**
1. Generate nanoid → store in SQLite
2. Update session stats (tool call count, max risk level)
3. Run through `RiskAnalyzer.assess()` → store risk assessment
4. Run through `AnomalyDetector.check()` → store & emit any anomalies
5. Emit `"event"` for real-time subscribers

**Key methods:** `startSession`, `endSession`, `record`, getters (sessions, events, analytics, anomalies)

### 2. EventStore (`src/store/database.ts`) — SQLite Persistence

- Auto-creates `~/.afr/flight-recorder.db`
- WAL mode + foreign keys enabled
- 4 tables: `sessions`, `events` (JSON blob), `risk_assessments`, `anomalies`
- 8 indexes for common query patterns
- `insertOrReplace` on risk assessments (one per event)
- Event data column stores type-specific fields as JSON (tool name, params, cost, etc.)

### 3. RiskAnalyzer (`src/analysis/risk.ts`) — Rules-Based

Runs on every tool.start and tool.end. Checks:

| Pattern | What It Detects | Risk Level |
|---------|----------------|------------|
| Safe tools (read, memory_search, etc.) | Read-only local | none |
| Destructive tools (exec, write, edit) | State mutation | medium |
| External access (web_fetch, message) | Data leaving machine | low |
| Dangerous exec patterns | rm -rf, sudo, fork bombs, etc. | high |
| PII patterns | SSN, email, credit card, phone, API keys | high |
| Sensitive file writes | .env, ssh, credentials paths | critical |

**`Elevate` function**: Only upgrades risk level, never downgrades. This ensures the worst risk wins.

### 4. AnomalyDetector (`src/analysis/anomaly.ts`) — Pattern Rules

Currently 4 rules, designed to evolve to ML:

| Rule | Trigger | Severity |
|------|---------|----------|
| `ToolBurstRule` | 10+ tool.start in 30s | warning |
| `ErrorLoopRule` | Same error 3+ times in session | alert |
| `OffHoursRule` | Session starts 23:00–06:00 | info |
| `CostSpikeRule` | Single tool call > $1.00 | warning |

**To add a new rule**: implement `AnomalyRule` (type + check method) and add to the `rules` array in the constructor.

### 5. HTTP Server (`src/server/index.ts`) — Express + WebSocket

- **REST API**: `/api/health`, `/api/sessions`, `/api/sessions/:id`, `/api/sessions/:id/events`, `/api/sessions/:id/analytics`, `/api/sessions/:id/anomalies`, `/api/events/recent`, `POST /api/ingest`
- **WebSocket**: `/ws` — broadcasts events, anomalies, session start/end in real-time
- **CORS**: Wide open (`*`) for local dashboard dev
- **Ingest endpoint**: Accepts session actions (start/end) and raw events from external agents

### 6. OpenClawAdapter (`src/adapters/openclaw.ts`) — Log Watcher

- Watches `/tmp/openclaw/openclaw-YYYY-MM-DD.log` (configurable via constructor)
- Parses embedded log entries: `embedded run prompt start`, `embedded run tool start`, `embedded run tool end`
- Maps OpenClaw `runId` → AFR `sessionId` internally
- Tracks tool start times for duration calculation
- Passes errors through to event stream

**Important**: This adapter is tuned to OpenClaw's specific log format. If OpenClaw changes its log format, this adapter needs updating.

### 7. AFRClient (`src/adapters/generic-http.ts`) — Universal SDK

- Thin wrapper around `POST /api/ingest`
- Manages session lifecycle (start → record events → end)
- Methods: `startSession`, `endSession`, `recordToolStart`, `recordToolEnd`, `recordThinking`, `recordMessage`
- Server URL defaults to `http://127.0.0.1:4242`

---

## CLI Usage

```
afr start                  # Start server + recording (auto-detect OpenClaw)
afr sessions               # List recorded sessions
afr replay <sessionId>     # Replay session step-by-step
afr analytics <sessionId>  # Detailed analytics per session
```

CLI output uses chalk for coloring. Session replay has configurable speed (`--speed 2x`).

---

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/sessions` | List sessions (filter: agentId, status, limit, offset) |
| GET | `/api/sessions/:id` | Single session detail |
| GET | `/api/sessions/:id/events` | Session events for replay |
| GET | `/api/sessions/:id/analytics` | Session analytics |
| GET | `/api/sessions/:id/anomalies` | Session anomalies |
| GET | `/api/events/recent` | Recent events across all sessions |
| POST | `/api/ingest` | Ingest events (universal) |
| WS | `/ws` | Real-time event stream |

---

## Design Decisions & Tradeoffs

### Current Architecture
- **Local-first, no cloud**: SQLite keeps everything on the user's machine. Privacy-first.
- **Event-driven**: Node.js EventEmitter pattern — cheap, simple, no queue infrastructure needed yet.
- **Rules-based analysis**: Fast (microseconds per event), deterministic, no model dependency. Good enough for v0.1.
- **Log file watcher for OpenClaw**: fs.watchFile with 500ms polling. Simple but not real-time. A WebSocket connection would be faster but requires OpenClaw gateway to expose events.

### Known Gaps
- **No dashboard UI yet**: Server + API exist. Dashboard is planned (React).
- **CLI replay is basic**: Line-by-line log output. No terminal UI.
- **One adapter pattern**: Only OpenClaw adapter implemented. LangChain, CrewAI, Claude Code are planned.
- **No auth/security**: Server binds to 127.0.0.1 only. Meant for local use. Cloud version would need auth.
- **No alert delivery**: Anomalies are detected and stored but not delivered anywhere (Discord, Slack, etc.). AlertConfig type exists but not wired.
- **Risk summary not fully wired**: The riskSummary in SessionAnalytics always returns zeros — the actual risk level aggregation per session type isn't implemented yet.

---

## Roadmap (From README)

1. Web dashboard (React)
2. LangChain adapter
3. CrewAI adapter
4. ML-based anomaly detection
5. Cloud version for teams
6. Compliance report export (SOC2, HIPAA)
7. Agent-to-agent monitoring

---

## First Tasks for Next Session

**High priority:**
1. **Wire risk aggregation into analytics** — `riskSummary` in `getSessionAnalytics()` returns zeros. Needs to query `risk_assessments` table per session and count levels.
2. **Add alert delivery** — implement an alert notifier that sends anomaly alerts to Discord/Slack/webhook. The `AlertConfig` and `AlertChannel` types are defined but unused.
3. **Build the React dashboard** — HTML shell exists (`dashboard/`) but no React app. Use the existing API + WebSocket endpoints.

**Medium priority:**
4. **Add session filtering by date range** — API only supports agentId + status currently.
5. **CLI improvements** — add JSON output flag (`--json`) for pipeable output.

**Nice to have:**
6. Integrate actual token/cost tracking from OpenClaw events (currently tool events don't carry token counts from the log parser).

---

## Build & Test

```bash
npm run build          # tsup — builds dist/
npm run dev            # tsup --watch
npm test               # vitest (no tests written yet)
npm run lint           # eslint src/
npm run dev:dashboard  # React dashboard dev server
```

**Important**: Build output goes to `dist/`. The CLI binary is at `dist/cli/index.js` (shebang handled by tsup banner).
