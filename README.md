# 🛩️ Agentic Flight Recorder (AFR)

**Universal observability for AI agents.** See what your agents are doing, why, and at what cost.

Like a black box flight recorder, but for AI agents. Every tool call, every decision, every risk — captured, analyzed, and replayable.

## The Problem

You deploy an AI agent. It makes 20 tool calls. Did it leak sensitive data? Why did it cost $47? What did it actually do at 3am?

**Today: You have no idea.** OpenClaw logs tool start/end times. Claude Code shows thinking then forgets it. Custom GPTs are complete black boxes.

**With AFR:** Every action is recorded, risk-scored, and replayable. Get alerts when something looks wrong. Know exactly what your agents are doing.

## Quick Start

```bash
npm install agentic-flight-recorder

# Start recording (auto-detects OpenClaw)
npx afr start

# Open dashboard
open http://localhost:4242
```

## Features

### 🔍 Three-Layer Observability

| Layer | What | How |
|-------|------|-----|
| **WHAT** | Every tool call, params, results | Event capture |
| **WHY** | Agent reasoning & decisions | Thinking capture |
| **SO WHAT** | Risk scores, PII detection, cost | Real-time analysis |

### 📊 Live Dashboard
Real-time view of agent activity with risk coloring:
```
19:53:25 🧠 THINKING: "Need to search for patent info..."
19:53:32 🔧 exec → `openclaw logs --help`     🟢 $0.001
19:53:35 🔧 web_fetch → agentictrust.com       🟢 $0.002
19:53:39 🔧 exec → `head ~/.openclaw/logs/...` 🟡 $0.001
```

### 🚨 Anomaly Detection
- **Tool bursts** — 10+ calls in 30 seconds
- **Error loops** — same error 3+ times
- **Cost spikes** — unusually expensive calls
- **Off-hours activity** — agents running at 3am
- **PII exposure** — SSNs, credit cards, API keys in data

### 🔄 Session Replay
```bash
afr replay <session-id> --speed 2x
```
Watch exactly what your agent did, step by step. Like a DVR for AI.

### 💰 Cost Tracking
Per-agent, per-session, per-tool cost breakdown. Know where your money goes.

## Architecture

```
Your AI Agent (OpenClaw, LangChain, CrewAI, Custom GPTs, anything)
       │
       ▼
┌─────────────────────────────┐
│  Capture Layer              │  SDK, log watcher, or HTTP ingest
├─────────────────────────────┤
│  Analysis Engine            │  Risk scoring, PII detection, anomaly detection
├─────────────────────────────┤
│  Storage (SQLite)           │  Local-first, zero config
├─────────────────────────────┤
│  API + WebSocket Server     │  REST for queries, WS for real-time
├─────────────────────────────┤
│  Dashboard / CLI            │  Live view, replay, analytics
└─────────────────────────────┘
```

## Adapters

| Framework | Integration | Status |
|-----------|------------|--------|
| OpenClaw | Log file watcher (automatic) | ✅ Built |
| Any (HTTP) | POST to `/api/ingest` | ✅ Built |
| LangChain | Callback handler | 🔜 Planned |
| CrewAI | Observer pattern | 🔜 Planned |
| Claude Code | CLI wrapper | 🔜 Planned |

### Universal HTTP Integration

Any agent in any language can send events:

```bash
# Start a session
curl -X POST http://localhost:4242/api/ingest \
  -H "Content-Type: application/json" \
  -d '{"session": {"action": "start", "agentId": "my-agent"}}'

# Record a tool call
curl -X POST http://localhost:4242/api/ingest \
  -H "Content-Type: application/json" \
  -d '{"event": {"sessionId": "...", "type": "tool.start", "toolName": "search", "toolCallId": "abc"}}'
```

### Node.js SDK

```typescript
import { AFRClient } from "agentic-flight-recorder";

const afr = new AFRClient({ agentId: "my-agent" });
await afr.startSession();
await afr.recordToolStart("search", "call-1", { query: "test" });
await afr.recordToolEnd("search", "call-1", { success: true });
await afr.endSession();
```

## CLI

```bash
afr start                  # Start server + recording
afr sessions               # List sessions
afr replay <id>            # Replay a session
afr analytics <id>         # Session analytics
```

## API

| Endpoint | Description |
|----------|-------------|
| `GET /api/health` | Health check |
| `GET /api/sessions` | List sessions |
| `GET /api/sessions/:id` | Get session |
| `GET /api/sessions/:id/events` | Session events (for replay) |
| `GET /api/sessions/:id/analytics` | Session analytics |
| `GET /api/sessions/:id/anomalies` | Session anomalies |
| `GET /api/events/recent` | Recent events |
| `POST /api/ingest` | Ingest events (universal adapter) |
| `WS /ws` | Real-time event stream |

## Self-Hosted & Privacy-First

- **All data stays local** — SQLite database on your machine
- **No cloud required** — runs entirely on localhost
- **Open source** — MIT licensed, audit the code yourself
- **Optional cloud dashboard** — coming soon for teams

## Roadmap

- [ ] Web dashboard (React)
- [ ] LangChain adapter
- [ ] CrewAI adapter
- [ ] ML-based anomaly detection
- [ ] Cloud version for teams
- [ ] Compliance report export (SOC2, HIPAA)
- [ ] Agent-to-agent monitoring

## License

MIT
