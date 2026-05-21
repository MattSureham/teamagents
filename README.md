# Agent Meetings

A framework for running structured technical meetings and debates between AI agents and LLMs.

## How it works

Agent Meetings runs a **long-lived server** that agents register with. When you schedule a meeting, the server picks up the topic and the participants, then runs a structured debate through a fixed sequence of phases. Each phase has a specific purpose and turn-taking rule. The output is a full transcript plus a structured summary.

### Architecture

```
┌──────────────────────────────────┐
│         CLI (client)             │   Talks to the server over HTTP
│  schedule, list, view, config    │   to schedule meetings, list agents, etc.
└──────────────┬───────────────────┘
               │ HTTP (localhost:4200)
┌──────────────┴───────────────────┐
│         Server                   │
│                                  │
│  HTTP routes   WebSocket (/ws)   │   REST API for management
│     │              │             │   WebSocket for protocol agents
│  ┌──┴──────────────┴──┐         │
│  │   AgentRegistry    │         │   Holds all IAgent instances
│  │  ┌──────────────┐  │         │   Boots subprocess + LLM agents from config
│  │  │  IAgent      │  │         │   Accepts protocol agents over WS
│  │  │  IAgent      │  │         │
│  │  │  IAgent ...   │  │         │
│  │  └──────────────┘  │         │
│  └────────┬───────────┘         │
│           │                      │
│  ┌────────┴───────────┐         │
│  │  MeetingEngine     │         │   State machine: phases + turn management
│  │  ┌──────────────┐  │         │   Prompts each agent in sequence
│  │  │  TurnManager │  │         │   Collects transcript, produces summary
│  │  └──────────────┘  │         │
│  └────────┬───────────┘         │
│           │                      │
│  ┌────────┴───────────┐         │
│  │  JsonFileStore      │         │   Persists meetings to data/meetings/<id>.json
│  └────────────────────┘         │
└──────────────────────────────────┘
               ▲
               │ WebSocket (ws://localhost:4200/ws)
┌──────────────┴───────────────────┐
│   External Protocol Agent         │
│   Any process in any language     │
└──────────────────────────────────┘
```

### How agents work

Every participant — CLI tool, LLM API, or remote process — implements the same `IAgent` interface:

```
respond(meetingPrompt) → AgentResponse   // called each turn
health() → AgentHealth                   // status check
shutdown() → void                        // cleanup
```

The server doesn't care how an agent produces its response. It just calls `respond()` on each agent in turn and records what comes back.

#### Browser agents (free chat UIs — no API key needed)

Browser agents use Playwright to control real web chat interfaces. No API key, no billing — you open the free tier of any chat site, log in once in the browser window that pops up, and the session persists. The framework types your prompt, waits for the response, and extracts the text.

```
Turn start
  → Navigate to chat site (e.g., chatgpt.com)
  → Click input box, type the meeting prompt
  → Press Enter
  → Wait for stop button to appear (generation started)
  → Wait for stop button to disappear (generation done)
  → Extract the assistant's response text
  → Return it to the meeting
Turn end
```

**First run**: a Chromium window opens. Log into your accounts (ChatGPT, Claude, Gemini, DeepSeek). The login session is saved in `~/.agent-meetings/browser/<agent-id>/` so you only need to do this once. Subsequent runs reuse the session.

**Sites supported out of the box**: `chatgpt`, `claude`, `gemini`, `deepseek`.

Add a browser agent to your config:

```yaml
agents:
  - id: chatgpt
    name: "ChatGPT"
    type: browser
    capabilities: [general, creative, brainstorming]
    site: chatgpt
    timeoutMs: 120000
```

Run a meeting with free agents only — zero API cost:

```bash
agent-meetings run -t "Design a REST API for a todo app" -a chatgpt,claude-web,gemini-web
```

#### Subprocess agents (CLI tools)

For tools like `claude` or `openclaw`, the server spawns a **new child process per turn**. The full meeting context (topic, background, transcript so far, and the current prompt) is formatted as text. The CLI is invoked with that text as an argument. The server reads stdout and treats it as the agent's response.

```
Turn start
  → Build prompt text from meeting state
  → Spawn: claude -p "{prompt text}" --output-format text
  → Wait for stdout (up to timeoutMs)
  → Record response in transcript
Turn end
```

This per-turn spawning means the agent is stateless between turns — each invocation gets the full transcript as context. It works with any CLI tool that accepts a prompt argument. Timeout is configurable (default 60s); if the subprocess doesn't finish in time, the turn is recorded as a timeout and the meeting moves on.

To add a new CLI agent, add an entry to your config:

```yaml
agents:
  - id: my-tool
    name: "My Tool"
    type: subprocess
    tool: generic
    capabilities: [coding]
    command: my-tool
    args: ["--prompt", "{prompt}"]    # {prompt} is replaced with the full context
    timeoutMs: 120000
```

#### LLM agents (API-based)

For raw LLM APIs (Anthropic, OpenAI, Gemini, Ollama), the server calls the API directly using Node's built-in `fetch`. The meeting context is converted to chat messages (system prompt + conversation history + current turn prompt) and sent to the model.

```
Turn start
  → Build system prompt ("You are Alice, participating in a debate about X...")
  → Convert transcript to user/assistant messages
  → Add current turn prompt
  → POST to API endpoint
  → Return response content
Turn end
```

The system prompt includes the agent's name, capabilities, meeting topic, current phase, and phase-specific instructions (e.g., "State your position clearly" during POSITION, "Respond to others' points" during REBUTTAL).

To add an LLM agent:

```yaml
agents:
  - id: claude-sonnet
    name: "Claude Sonnet"
    type: llm
    capabilities: [analysis, reasoning]
    provider: anthropic
    model: claude-sonnet-4-20250514
    apiKey: "${ANTHROPIC_API_KEY}"     # reads from ANTHROPIC_API_KEY env var
```

Supported providers:

| Provider | Adapter | Endpoint | Auth |
|----------|---------|----------|------|
| `anthropic` | AnthropicAdapter | `api.anthropic.com` | `ANTHROPIC_API_KEY` env or `apiKey` |
| `openai` | OpenAIAdapter | `api.openai.com` | `OPENAI_API_KEY` env or `apiKey` |
| `gemini` | GeminiAdapter | Google AI | `GEMINI_API_KEY` env or `apiKey` |
| `deepseek` | DeepSeekAdapter | `api.deepseek.com` | `DEEPSEEK_API_KEY` env or `apiKey` |
| `minimax` | MinimaxAdapter | `api.minimax.chat` | `MINIMAX_API_KEY` env or `apiKey` |
| `qwen` | QwenAdapter | `dashscope-intl.aliyuncs.com` | `QWEN_API_KEY` env or `apiKey` |
| `kimi` | KimiAdapter | `api.moonshot.ai` | `MOONSHOT_API_KEY` env or `apiKey` |
| `kimi-code` | KimiCodeAdapter | `api.kimi.com/coding/v1` | `KIMI_API_KEY` env or `apiKey` |
| `ollama` | OllamaAdapter | `http://127.0.0.1:11434` | none |
| `openai-compat` | OpenAICompatAdapter | custom `endpoint` | optional `apiKey` |

`openai-compat` covers any local OpenAI-compatible server — vLLM, LM Studio, llama.cpp, text-generation-webui, and more. Set `endpoint` to your server's base URL (e.g., `http://127.0.0.1:8000/v1`).

#### Protocol agents (WebSocket)

For external processes that you want to keep running long-term, they connect to the server over WebSocket at `/ws` and implement a simple JSON protocol:

```
Agent connects to ws://localhost:4200/ws
  → Agent sends: {"type": "register", "id": "...", "name": "...", "capabilities": [...]}
  → Server sends: {"type": "registered", "id": "..."}
  → (periodic) Agent sends: {"type": "heartbeat"}
  → (periodic) Server sends: {"type": "heartbeat_ack"}

When a meeting turn arrives for this agent:
  → Server sends: {"type": "meeting_prompt", "requestId": "...", "meetingId": "...", ...}
  → Agent sends: {"type": "meeting_response", "requestId": "...", "content": "..."}

When another agent speaks:
  → Server broadcasts: {"type": "meeting_update", "meetingId": "...", "message": {...}}
```

This means you can write an agent in any language. It just needs to open a WebSocket, register, and respond to prompts. See the [WebSocket Protocol](#websocket-protocol-for-external-agents) section for the full message spec.

---

### How a meeting works (debate phases)

When a meeting starts, it moves through a fixed sequence of phases. Each phase has a goal and a turn-taking rule.

```
schedule → PENDING → start → OPENING → POSITION → REBUTTAL ─┬→ DELIBERATION ─┬→ VOTING → SUMMARY → CONCLUDED
                   cancel                                      └──────────────────────────┘
```

#### Phase details

**OPENING** — The moderator introduces the topic, lists the participants with their capabilities, and explains the ground rules. Only the moderator speaks.

**POSITION** — Round-robin. Each agent states their position on the topic. One round. Prompt: *"What is your position on [topic]? State your reasoning clearly."*

**REBUTTAL** — Round-robin. Each agent responds to the positions already stated, pointing out weaknesses and defending their own view. Configurable number of rounds (`maxRebuttalRounds`, default 1). Prompt: *"You have heard the positions stated so far. Please offer your rebuttal..."*

**DELIBERATION** — Free-form discussion. Each agent gets one initial turn to raise points. After that, agents that indicated they want to speak more get additional turns from a FIFO queue. Capped at `maxDeliberationRounds` (default 3). Prompt: *"The floor is open for deliberation..."*

**VOTING** — Each agent is asked a structured yes/no question about the emerging consensus. Responses are parsed for "VOTE: YES" / "VOTE: NO" to produce a tally.

**SUMMARY** — The moderator (or a configured LLM) reads the full transcript and produces a structured summary:
- **Consensus** — what was agreed upon
- **Key points** — main arguments and findings
- **Dissenting views** — minority opinions
- **Action items** — concrete follow-up tasks
- **Vote tally** — YES/NO/ABSTAIN counts

**CONCLUDED** — Meeting closed, transcript and summary persisted to disk.

#### Moderator

By default, the system itself acts as moderator (using the configured `defaultModerator` LLM for summaries). You can also designate a specific agent as moderator in the meeting config. If no LLM is available for the moderator, summary output is a simple template with the full transcript appended.

#### Timeouts and failures

Each turn has a configurable timeout (`turnTimeoutMs`, default 60,000ms). If an agent doesn't respond in time, its turn is recorded as `[Agent X did not respond within the time limit]` and the meeting proceeds to the next speaker. If an agent throws an error, it's recorded as `[Agent X encountered an error]`. The meeting never stalls on a single broken agent.

---

## Deployment Guide

This guide covers setting up Agent Meetings from scratch on macOS and Windows — cloning the repo, installing dependencies, configuring agents, and running your first meeting.

### Prerequisites

| Requirement | macOS | Windows |
|-------------|-------|---------|
| **Node.js 18+** | `brew install node` or [nodejs.org](https://nodejs.org) | [nodejs.org](https://nodejs.org) (LTS, check "Add to PATH") |
| **Git** | `brew install git` or `xcode-select --install` | [git-scm.com](https://git-scm.com) |
| **Python 3.11+** (optional) | `brew install python@3.11` | [python.org](https://python.org) or `winget install Python.Python.3.11` |
| **Playwright Chromium** (optional) | `npx playwright install chromium` | `npx playwright install chromium` |

**Python** is only needed if you plan to use the Hermes builder agent. If you're only using CLI tools (Claude Code, OpenClaw) and LLM APIs, Node.js alone is sufficient.

**Playwright Chromium** is only needed for browser agents (ChatGPT Web, Claude Web, Gemini Web, DeepSeek Web). If you're not using browser agents, skip that step.

Verify your installs:

**macOS / Linux:**
```bash
node --version   # must be >= 18
git --version
python3 --version  # optional, >= 3.11 for Hermes
```

**Windows (Command Prompt or PowerShell):**
```cmd
node --version
git --version
python --version
```

### Step 1 — Clone and install

**macOS / Linux:**
```bash
git clone https://github.com/MattSureham/teamagents.git
cd teamagents
npm install
```

**Windows (Command Prompt):**
```cmd
git clone https://github.com/MattSureham/teamagents.git
cd teamagents
npm install
```

**Windows (PowerShell):**
```powershell
git clone https://github.com/MattSureham/teamagents.git
cd teamagents
npm install
```

### Step 2 — Set up API keys (.env)

Create a `.env` file from the template:

**macOS / Linux:**
```bash
cp .env.example .env
```

**Windows (Command Prompt):**
```cmd
copy .env.example .env
```

**Windows (PowerShell):**
```powershell
Copy-Item .env.example .env
```

Edit `.env` and add your API keys:

```ini
# Required if using DeepSeek models (moderator, summarizer)
DEEPSEEK_API_KEY=sk-...

# Optional — add keys for the providers you use
MINIMAX_API_KEY=
QWEN_API_KEY=
MOONSHOT_API_KEY=
KIMI_API_KEY=
```

The framework reads `.env` automatically on every run — no need to `export` keys in each terminal session. All keys are optional; only add the ones for providers you actually use.

**Environment variable fallback:** If a key isn't in `.env`, the framework checks the shell environment (`export` or `$env:`). `.env` takes priority for keys it defines.

### Step 3 — Configure agents

Edit `meetings.config.yml`. The framework ships with a fully annotated example at [meetings.config.example.yml](meetings.config.example.yml). You can start from that:

**macOS / Linux:**
```bash
cp meetings.config.example.yml meetings.config.yml
```

**Windows (Command Prompt):**
```cmd
copy meetings.config.example.yml meetings.config.yml
```

**Windows (PowerShell):**
```powershell
Copy-Item meetings.config.example.yml meetings.config.yml
```

Or build your own. Here's a minimal config with common agents:

```yaml
server:
  port: 4200
  host: "0.0.0.0"
  dataDir: "./data"

agents:
  # ── Thinkers (LLM API) ──
  - id: deepseek
    name: "DeepSeek"
    type: llm
    provider: deepseek
    model: deepseek-chat
    apiKey: "${DEEPSEEK_API_KEY}"
    capabilities: [architecture, planning, coding, reasoning]

  - id: minimax
    name: "MiniMax"
    type: llm
    provider: minimax
    model: abab6.5s-chat
    apiKey: "${MINIMAX_API_KEY}"
    capabilities: [brainstorming, creative, design]

  # ── Builders (subprocess — can write code, run commands) ──
  - id: claude-code
    name: "Claude Code"
    type: subprocess
    tool: claude-code
    command: claude
    args: ["-p", "{prompt}", "--output-format", "text", "--permission-mode", "bypassPermissions", "--bare"]
    timeoutMs: 1800000
    capabilities: [coding, building, debugging, testing]

meetings:
  mode: debate
  defaultModerator: deepseek
```

Config fields are documented in the [Configuration Reference](#configuration-reference) below.

### Step 4 — Install browser engines (optional)

Only needed if you plan to use browser agents (ChatGPT Web, Claude Web, Gemini Web, DeepSeek Web):

```bash
npx playwright install chromium
```

This downloads a Chromium binary (~150 MB) to Playwright's cache. Browser agent sessions are saved in `~/.agent-meetings/browser/<agent-id>/` so you only log in once.

Skip this step if you're only using LLM and subprocess agents.

### Step 5 — Verify

Run a quick test meeting to confirm everything works:

```bash
npx tsx src/cli/index.ts run \
  -t "Say hello and introduce yourself in one sentence" \
  -a deepseek,minimax \
  -m deepseek
```

If you see the opening, a DeepSeek response, and a summary, you're ready. Full usage: `npx tsx src/cli/index.ts run --help`.

### Running on another machine

To set up the framework on a second machine:

1. **Clone the repo** (Step 1 above)
2. **Copy your `.env` file** from your primary machine — it contains your API keys. Or create a new one from `.env.example` and re-enter your keys.
3. **Copy your `meetings.config.yml`** — or recreate it. Note that file paths in `command` and `cwd` fields may differ between machines (e.g., Hermes path `/Users/xxx/hermes-agent` vs `C:\Users\xxx\hermes-agent`).
4. **Install provider-specific CLI tools** if you use builder agents:
   - **Claude Code**: `npm install -g @anthropic-ai/claude-code` then `claude` in PATH
   - **OpenClaw**: `npm install -g openclaw` then `openclaw` in PATH
   - **Hermes**: clone `https://github.com/NousResearch/Hermes-Agent.git`, set up venv, install dependencies
5. **Run Step 5** to verify.

**Pro tip:** Keep your config and `.env` in a private git repo or a password manager. The config file references API keys via `${VAR}` syntax so the `.env` stays separate — never commit `.env` to git.

### Updating

```bash
git pull
npm install        # in case dependencies changed
```

### Run a meeting (one command)

The `run` command does everything in one shot — loads your config, runs the debate, streams the transcript live to your terminal, and prints the summary at the end. No server to start, no second terminal.

**LLM-only meeting** (thinkers talk through a plan):
```bash
agent-meetings run \
  -t "Plan and spec a new URL shortener SaaS — architecture, stack, and launch strategy" \
  -a deepseek,minimax
```

**Builder meeting** (agents that can actually write code and create files):
```bash
agent-meetings run \
  -t "Build a URL shortener in Next.js with Redis — create the full project" \
  -a claude-code,openclaw \
  -m deepseek
```

In a builder meeting, the subprocess agents (`claude-code`, `openclaw`) are invoked with the full meeting context. They can read the transcript, reason about what was planned, and **produce actual output** — writing files, running commands, scaffolding projects. The LLM agent (`deepseek`) acts as moderator: it reviews the output, spots gaps, and directs next steps.

**Mixed meeting** (thinker plans, builders implement):
```bash
agent-meetings run \
  -t "Design and build a REST API for a todo app — DeepSeek architects, Claude Code and OpenClaw implement" \
  -a deepseek,claude-code,openclaw \
  -m deepseek
```

**Free meeting** (no API keys at all — uses free chat UIs):
```bash
agent-meetings run \
  -t "Plan our team's Q3 roadmap" \
  -a chatgpt,claude-web,gemini-web
```

**Collaboration mode** (agents plan, build, and review together — more than just talking):

```bash
agent-meetings run \
  -t "Build a REST API for a todo app with Express and TypeScript" \
  -a claude-code,openclaw,deepseek-v4-pro \
  -m deepseek-v4-pro \
  --mode collaboration \
  --work-dir /tmp/todo-api
```

Collaboration mode uses a different phase flow designed for actual building:

```
OPENING → PLAN → BUILD → REVIEW → SUMMARY → CONCLUDED
```

- **PLAN** — each agent proposes an approach and architecture
- **BUILD** — agents take turns implementing. Each turn prompts the agent to produce concrete output (code, files, docs)
- **REVIEW** — agents review what the team built and suggest improvements
- Summary focuses on deliverables and decisions, not consensus and votes

The `--work-dir` flag gives subprocess agents a shared directory — Claude Code and OpenClaw see each other's files and can build on previous work. Default mode is `debate` (structured discussion with positions, rebuttals, and voting).

What you'll see:

```
╔══════════════════════════════════════════════╗
║         AGENT MEETINGS — Live Session        ║
╠══════════════════════════════════════════════╣
║ Topic: Plan and spec a new URL shortener ... ║
╠══════════════════════════════════════════════╣
║ Participants:                                  ║
║   • DeepSeek (llm)                             ║
║   • MiniMax (llm)                              ║
║ Moderator: DeepSeek                            ║
╚══════════════════════════════════════════════╝

── OPENING — topic introduction ─────────────────
  ◆ [16:15:32] Moderator:
    MEETING TOPIC: Plan and spec a new URL shortener...

── POSITION — agents state their views ──────────
  ◇ [16:15:45] DeepSeek:
    For the URL shortener, I recommend a serverless architecture...

  ◇ [16:15:58] MiniMax:
    I think we should consider a Rust-based backend with PostgreSQL...

── REBUTTAL — agents respond to each other ──────
  ◇ [16:16:12] DeepSeek:
    MiniMax raises a good point about Rust, but serverless gives us...

  ◇ [16:16:25] MiniMax:
    The serverless approach has cold start concerns at scale...

  ... (deliberation, voting, summary follow) ...

═══════════════════════════════════════════════
              MEETING SUMMARY
═══════════════════════════════════════════════

Consensus: Use a hybrid approach — serverless API + PostgreSQL...
Key Points:
  • Cloudflare Workers for the redirect layer
  • PostgreSQL for analytics and user management
  • Next.js for the dashboard
  ...
```

### Server mode (multi-meeting, background, WebSocket agents)

If you want a persistent server for multiple meetings or external protocol agents:

```bash
# Terminal 1 — start the server
npm start

# Terminal 2 — schedule and manage meetings
npx tsx src/cli/index.ts schedule -t "Architecture review" -a deepseek,minimax
npx tsx src/cli/index.ts list meetings
npx tsx src/cli/index.ts view <id>

# Stop the server (macOS/Linux)
npm stop

# On Windows, use Ctrl+C in the server terminal instead
```

### Web Console

Agent Meetings includes a built-in web UI at `http://127.0.0.1:4200/` — no extra setup required.

```bash
npm start
```

Then open **`http://127.0.0.1:4200/`** in a browser. The web console provides:

- **Agent selection** — click chips to pick participants (color-coded: purple=LLM, orange=browser, green=subprocess)
- **Topic & context** — type or upload a `.txt`/`.md` file
- **Mode toggle** — debate or collaboration
- **Settings** — rebuttal rounds, deliberation turns, max turns, timeout, moderator
- **Live transcript** — messages stream in real time with phase dividers and colored avatars
- **Summary** — consensus, key points, dissenting views, vote tally, deliverables on conclusion

---

## Configuration Reference

Full annotated example at [meetings.config.example.yml](meetings.config.example.yml).

### `server`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `port` | number | 4200 | HTTP + WebSocket port |
| `host` | string | "0.0.0.0" | Bind address |
| `dataDir` | string | "./data" | Where meeting files and agent state are saved |

### `agents` (array)

Common fields for all agent types:

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier (used in `--agents` flag) |
| `name` | string | Display name (appears in transcript) |
| `type` | `subprocess` \| `llm` | Agent type |
| `capabilities` | string[] | Skills/topics this agent can contribute to |

Subprocess-specific fields:

| Field | Type | Description |
|-------|------|-------------|
| `command` | string | CLI command to spawn (e.g., `claude`) |
| `args` | string[] | CLI arguments (use `{prompt}` as placeholder for meeting context) |
| `env` | object | Extra environment variables |
| `cwd` | string | Working directory |
| `timeoutMs` | number | Per-turn timeout in ms (default: 60000) |

LLM-specific fields:

| Field | Type | Description |
|-------|------|-------------|
| `provider` | `anthropic` \| `openai` \| `gemini` \| `deepseek` \| `minimax` \| `qwen` \| `kimi` \| `kimi-code` \| `ollama` \| `openai-compat` | Which API to call |
| `model` | string | Model name (e.g., `claude-sonnet-4-20250514`, `gpt-4o`) |
| `apiKey` | string | API key (use `${ENV_VAR}` for environment variable) |
| `endpoint` | string | Custom endpoint URL (only needed for Ollama, defaults to `http://127.0.0.1:11434`) |

### `meetings`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `mode` | `debate` \| `collaboration` | `debate` | Meeting mode — debate for structured discussion, collaboration for planning + building |
| `turnTimeoutMs` | number | 60000 | Max time an agent has to respond to a turn |
| `maxRebuttalRounds` | number | 1 | How many rounds of rebuttal before deliberation |
| `maxDeliberationRounds` | number | 3 | How many deliberation rounds (hand-raising for more turns) |
| `maxPlanRounds` | number | 1 | Collaboration only — plan iteration rounds |
| `maxBuildRounds` | number | 3 | Collaboration only — build iteration rounds |
| `maxReviewRounds` | number | 1 | Collaboration only — review iteration rounds |
| `defaultModerator` | string | — | Agent ID to use as moderator if none specified in the meeting |

---

## CLI Reference

```
agent-meetings run -t <topic> -a <agent-ids> [options]
  One-shot command — loads config, runs the meeting, streams transcript live.
  Saves full transcript to data/meetings/<id>.json and .log when done.
  -t, --topic <topic>          Meeting topic (required)
  -a, --agents <ids>           Comma-separated agent IDs (required)
  -m, --moderator <id>         Agent ID to act as moderator
  -x, --context <text>         Background context (text or path to a file)
  -c, --config <path>          Path to config file (default: ./meetings.config.yml)
  --mode <mode>                Meeting mode: debate (default) or collaboration
  --work-dir <path>            Shared working directory for agents to build in (collaboration mode)
  --turn-timeout <ms>          Turn timeout in ms (default: 60000)
  --rebuttal-rounds <n>        Max rebuttal rounds (default: 1)
  --deliberation-turns <n>     Max deliberation turns (default: 10)
  --max-turns <n>              Max total turns before forcing conclusion (default: 50)
  --no-stream                  Only show summary, not live transcript

agent-meetings resume <meeting-id> [options]
  Resume an interrupted meeting from where it left off. Restores full transcript,
  phase position, turn state, and working directory from the last checkpoint.
  -c, --config <path>          Path to config file (default: ./meetings.config.yml)
  -s, --server <url>           Delegate to a running server
  --no-stream                  Only show summary, not live transcript

agent-meetings serve [options]
  Start the persistent server (for multiple meetings, WS agents).
  -p, --port <port>            Port to listen on
  -c, --config <path>          Path to config file (default: ./meetings.config.yml)
  -d, --data-dir <path>        Data directory for persistence

agent-meetings schedule -t <topic> -a <agent-ids> [options]
  Schedule a meeting on a running server.
  -t, --topic <topic>          Meeting topic (required)
  -a, --agents <ids>           Comma-separated agent IDs (required)
  -m, --moderator <id>         Agent ID to act as moderator
  -x, --context <text>         Background context (literal text or path to a file)
  -s, --server <url>           Server URL (default: http://localhost:4200)
  --no-auto-start              Schedule without starting immediately

agent-meetings list <resource>
  agents                       List registered agents with capabilities
  meetings                     List all meetings (--status active|concluded|pending|cancelled)

agent-meetings view <meeting-id>
  Shows full transcript, summary, vote tally, and metadata

agent-meetings config validate
  -c, --config <path>          Validate a config file and report errors

agent-meetings config show
  -c, --config <path>          Print effective config (API keys masked)
```

---

## WebSocket Protocol (for external agents)

Connect to `ws://<host>:<port>/ws`.

### Messages from agent to server

**register** — sent once on connect (within 10 seconds, or the connection is closed):
```json
{
  "type": "register",
  "id": "my-agent",
  "name": "My Agent",
  "capabilities": ["coding", "architecture"]
}
```

**heartbeat** — sent periodically to keep the connection alive:
```json
{"type": "heartbeat"}
```

**meeting_response** — sent in response to a `meeting_prompt`:
```json
{
  "type": "meeting_response",
  "requestId": "same-as-in-the-prompt",
  "content": "My position on this topic is..."
}
```

### Messages from server to agent

**registered** — confirms registration:
```json
{"type": "registered", "id": "my-agent"}
```

**heartbeat_ack** — response to heartbeat:
```json
{"type": "heartbeat_ack"}
```

**meeting_prompt** — a turn for this agent to speak:
```json
{
  "type": "meeting_prompt",
  "requestId": "uuid",
  "meetingId": "uuid",
  "phase": "position",
  "topic": "Should we adopt microservices?",
  "background": "We are a team of 10...",
  "transcript": [
    {
      "id": "msg-uuid",
      "authorId": "other-agent",
      "authorName": "Claude Sonnet",
      "content": "I think...",
      "phase": "position",
      "timestamp": 1714000000000
    }
  ],
  "speakingOrder": ["my-agent", "other-agent"],
  "currentPrompt": "What is your position on this topic?"
}
```

**meeting_update** — broadcast when another agent speaks:
```json
{
  "type": "meeting_update",
  "meetingId": "uuid",
  "message": {
    "id": "msg-uuid",
    "authorName": "Claude Sonnet",
    "content": "I think..."
  }
}
```

**error** — sent if the server rejects a message:
```json
{"type": "error", "message": "Registration requires id and name"}
```

---

## Programmatic Use

```typescript
import {
  createServer,
  MeetingEngine,
  LLMAgent,
  AnthropicAdapter,
  SubprocessAgent,
} from 'agent-meetings';

// ── Start the full server ──────────────────────────────────
const server = await createServer('./meetings.config.yml');
await server.start();
// Server running, agents booted from config, ready for CLI and WS

// ── Or run a meeting directly (no server needed) ───────────
const alice = new LLMAgent(
  'alice',
  'Alice',
  ['architecture', 'typescript'],
  new AnthropicAdapter(process.env.ANTHROPIC_API_KEY!)
);

const bob = new LLMAgent(
  'bob',
  'Bob',
  ['python', 'data-engineering'],
  new AnthropicAdapter(process.env.ANTHROPIC_API_KEY!)
);

const meeting = new MeetingEngine({
  topic: 'Monolith vs. microservices for a 10-person team',
  context: 'We are building a SaaS product with a monolith and considering a split.',
  participants: [alice, bob],
  turnTimeoutMs: 60_000,
  maxRebuttalRounds: 1,
  maxDeliberationRounds: 3,
});

await meeting.start();

// meeting.transcript is the full Message[]
// meeting.summary has consensus, keyPoints, dissentingViews, actionItems, voteTally
// meeting.toStoredMeeting() serializes everything for persistence

console.log(meeting.summary?.consensus);
```

---

## Data Persistence

All data lives in the `dataDir` directory (default `./data`):

```
data/
├── agents.json                # Array of registered agents
└── meetings/
    ├── <uuid-1>.json          # Full meeting record (JSON — topic, transcript, summary, phase timeline, checkpoint state)
    ├── <uuid-1>.log           # Human-readable transcript log (same meeting, readable format)
    ├── <uuid-2>.json
    ├── <uuid-2>.log
    └── ...
```

Each `run` command saves two files: a `.json` record for programmatic access and a `.log` file for human reading. Both are written automatically at meeting end. The file paths are printed to the terminal.

### Checkpointing and Resume

The meeting engine writes a checkpoint to `{id}.json` after every agent turn and phase transition. If a meeting is interrupted (crash, Ctrl+C, server restart), it can be resumed from where it left off:

```bash
# Start a meeting, then Ctrl+C mid-way
agent-meetings run -t "Architecture review" -a deepseek,minimax

# Resume it — same ID, same transcript, same phase, same workDir
agent-meetings resume <meeting-id>
```

Interrupted meetings appear with status `active` on disk. On server startup, the framework detects them and logs instructions for resuming. Use `POST /meetings/:id/resume` to resume via the HTTP API.

The checkpoint preserves: full transcript, phase timeline, turn manager state (who has spoken, raised hands), rebuttal round position, config values, context images, and working directory.

---

## Troubleshooting

### Config fails to load

**Symptom:** `Failed to load config: Implicit map keys need to be followed by map values at line X`

**Fix:** A stray or invisible character is on the indicated line. Common causes:
- Curly/smart quotes (`"` vs `"`) from copy-paste — re-type quotes as straight ASCII
- Non-printing Unicode characters — delete the affected line and re-type it
- Missing space after `- ` in a list item

Run `npx tsx src/cli/index.ts config validate` to check your config.

### API key errors

**Symptom:** `DeepSeek API error 401: Authentication Fails` (or similar for other providers)

**Fix:**
1. Check your `.env` file exists and has the correct key: `cat .env`
2. Verify the key is valid on the provider's console
3. Make sure the `apiKey` field in your config references the right env var: `apiKey: "${DEEPSEEK_API_KEY}"`

### Agent not found

**Symptom:** `Agent "xxx" not found in config`

**Fix:** The agent ID in your `--agents` flag must match an `id` field in `meetings.config.yml`. Run `npx tsx src/cli/index.ts list agents` (requires server mode) or check your config directly.

### Builder agent times out

**Symptom:** `[Agent X did not respond within the time limit]`

**Fix:** Increase `timeoutMs` for that agent in your config. Builders writing code need more time than thinkers:
```yaml
- id: claude-code
  ...
  timeoutMs: 1800000   # 30 minutes
```

### Browser agent can't find Chromium

**Symptom:** `Executable doesn't exist at .../chromium/.../chrome`

**Fix:** Run `npx playwright install chromium`. This downloads the Chromium binary Playwright needs (~150 MB).

### Browser agent shows CAPTCHA or "Something went wrong"

**Symptom:** Cloudflare verification, login loops, or generic errors in browser agents

**Fix:**
1. Run `npx tsx src/cli/index.ts browser-setup` to open login windows before a meeting
2. Log in manually in each window — sessions persist in `~/.agent-meetings/browser/`
3. If the issue persists, delete the session folder (`rm -rf ~/.agent-meetings/browser/<agent-id>/`) and re-login

### "command not found" for builder agent

**Symptom:** Subprocess agent health check fails with "Command not found"

**Fix:** The `command` field in your config must be in PATH or an absolute path:
```yaml
# These work:
command: claude                  # in PATH
command: /usr/local/bin/claude   # absolute path
command: ./venv/bin/python       # relative to project root
```

For Hermes specifically, make sure the venv is set up:
```bash
cd /path/to/hermes-agent
python3 -m venv venv
./venv/bin/pip install -e .
```

### Shell quoting issues on macOS/Linux

**Symptom:** `dquote>` prompt appearing, truncated arguments, or unexpected behavior with `-x` / `--context`

**Fix:** Use straight ASCII quotes (`"` and `'`), not smart/curly quotes from word processors or chat apps. For long context text, use a file instead:
```bash
echo "your long context here..." > /tmp/context.txt
npx tsx src/cli/index.ts run -t "Topic" -x /tmp/context.txt -a ...
```

### TypeScript compile errors after pull

**Symptom:** `npx tsc --noEmit` shows errors after `git pull`

**Fix:**
```bash
npm install        # new adapters may add dependencies
npm run build      # recompile
```

## License

MIT
