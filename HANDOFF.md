# HANDOFF.md

> **Collaboration Protocol**
>
> This file is the canonical collaboration state for this repository. Every
> human, AI model, subprocess, or other participant must read it before
> starting work.
>
> - Repository evidence takes precedence over assumptions, chat history, and
>   summaries. Mark every material claim as **Confirmed**, **Inferred**, or
>   **Unknown**. Record verification only when it was actually performed.
> - Append only evidence and activity records authored by you. Never silently
>   rewrite or delete another participant's findings. Another participant's
>   entry may be edited only to correct an objectively wrong reference, and
>   the correction must be noted in your own activity entry.
> - Preserve prior evidence, authorship, decisions, and rejected approaches.
>   Record disagreements as new attributed evidence instead of overwriting
>   history.
> - Shared `Current State` may be updated only when repository evidence changes
>   the accepted snapshot. Preserve the displaced state and reasoning in
>   `Recent Activity` or `Archived Summary`.
> - Issue owners may update their issue's status and resolution. Other
>   participants must append attributed evidence or a proposed resolution;
>   they must not erase the owner's record.
> - `Current State` describes what is accepted now. `Recent Activity` explains
>   how the repository reached that state. The former must be understandable
>   without reading the latter.
> - Keep exactly one bounded, immediately actionable item in `Next Action`.
>   Before finishing, replace it only when completed or made obsolete by
>   evidence.
> - Protocol changes require a recorded proposal containing the motivation,
>   compatibility with existing history, and migration impact. The proposal
>   must be tracked as an Active Issue and must not be adopted without explicit
>   approval.
> - Leave the document understandable to a completely new participant who has
>   no access to previous conversations.

## Current State

### Authoritative snapshot

| Confidence | Accepted project state | Repository evidence |
| --- | --- | --- |
| **Confirmed** | The package is `agent-meetings` version 2.0.0, implemented in TypeScript as an ESM Node.js project. | `package.json`; baseline commit `1a37c85` on `main` before this protocol was initialized. |
| **Confirmed** | The project provides the `am`/`agent-meetings` CLI, a long-lived HTTP/WebSocket server, a browser Web console, and meeting modes for debate, discussion, and collaboration. | `package.json`, `src/cli/`, `src/server/`, `src/meeting/`, `public/index.html`. |
| **Confirmed** | Agent implementations cover direct LLM APIs, Playwright browser sessions, local subprocess CLIs, and external protocol agents. | `src/llm/`, `src/agent/browser/`, `src/agent/subprocess/`, `src/agent/protocol/`. |
| **Confirmed** | Meeting state is persisted as JSON under the configured data directory and supports checkpoint/resume behavior. | `src/persistence/json-store.ts`, `src/cli/commands/resume.ts`. |
| **Confirmed** | A Windows 10/11 x64 portable archive build exists with bundled Node.js 22.22.0 and Playwright Chromium; GitHub Actions builds and smoke-tests it on `windows-latest`. | `packaging/windows/`, `.github/workflows/windows-portable.yml`, commits `835791f` and `1a37c85`. |
| **Confirmed** | A multi-architecture Docker image workflow publishes from pushes to `main`. | `Dockerfile`, `.github/workflows/docker-publish.yml`. |
| **Confirmed** | The TypeScript build completed successfully on 2026-07-28 in the local macOS workspace. | `npm run build` exited 0. |
| **Confirmed** | All current automated tests completed successfully on 2026-07-28: 5 test files and 25 tests passed. | `npm test` / `vitest run` exited 0. |
| **Confirmed** | The configured lint command is not currently runnable in this workspace because the `eslint` executable is not installed. | `npm run lint` exited 127 with `eslint: command not found`; see `AM-DX-001`. |
| **Unknown** | The current Windows portable archive and Docker image were not rebuilt or exercised during this protocol-initialization task. | No Windows or Docker runtime verification was performed on 2026-07-28. |

### Present constraints and unfinished work

| Confidence | Constraint or unfinished state | Evidence |
| --- | --- | --- |
| **Confirmed** | User-facing behavior has unresolved correctness and onboarding problems; the canonical list is in `Active Issues`. | Issues `AM-UX-001` through `AM-UX-009` and `AM-QA-001`. |
| **Confirmed** | This protocol initialization does not change application behavior or resolve existing UX issues. | Activity `ACT-20260728-01`. |
| **Confirmed** | No previous tracked `HANDOFF.md` or `BOOTSTRAP.md` existed to migrate. | `git ls-files` and `git log --all -- HANDOFF.md BOOTSTRAP.md` returned no prior entries before this change. |

## Active Issues

Status values are `Open`, `In Progress`, `Blocked`, `Resolved`, or `Archived`.
Evidence additions must include their author and date. All issues below are
currently unassigned.

| ID | Status | Severity | Owner | Evidence and confidence | Current resolution state |
| --- | --- | --- | --- | --- | --- |
| `AM-UX-001` | Open | P0 | Unassigned | **Confirmed** — `serve` declares `--port`, `--data-dir`, `--no-mcp`, `--mcp-stdio`, and `--ws-token`, but its action passes only the config path to `createServer` (`src/cli/commands/serve.ts`). Reviewed by Codex on 2026-07-14. | No fix exists. CLI options can be accepted without changing server behavior. |
| `AM-UX-002` | Open | P0 | Unassigned | **Confirmed** — the Web console uses the same global `meetingId` for the active meeting and a viewed historical meeting; `viewPastMeeting` overwrites it (`public/index.html`). Reviewed by Codex on 2026-07-14. | No fix exists. Active and viewed meeting identity must be separated. |
| `AM-UX-003` | Open | P0 | Unassigned | **Confirmed** — Commander defaults in `run` override meeting configuration, and `resume --build-rounds` defaults to 3 even when the user did not request an override (`src/cli/commands/run.ts`, `src/cli/commands/resume.ts`). Reviewed by Codex on 2026-07-14. | No fix exists. A single documented precedence chain is required. |
| `AM-UX-004` | Open | P0 | Unassigned | **Confirmed** — registry health checks are stored, but `/agents` does not expose readiness and `getOnline()` returns every configured agent (`src/server/agent-registry.ts`, `src/server/http-routes.ts`). Reviewed by Codex on 2026-07-14. | No fix exists. The UI cannot distinguish ready, login-required, missing-command, missing-key, and offline agents. |
| `AM-UX-005` | Open | P1 | Unassigned | **Confirmed** — the Web console has duplicate create-folder listeners, fragile history error rendering, optimistic stop messaging after failed requests, and inconsistent form enable/disable behavior (`public/index.html`). Reviewed by Codex on 2026-07-14. | No unified UI state model or regression coverage exists. |
| `AM-UX-006` | Open | P1 | Unassigned | **Confirmed** — preset selection infers agent type from the first visual `.tag`, which may contain `vision` rather than the agent type (`public/index.html`). Reviewed by Codex on 2026-07-14. | No fix exists. Selection should use explicit structured agent metadata. |
| `AM-UX-007` | Open | P1 | Unassigned | **Confirmed** — README onboarding, product naming, default agent claims, source/portable commands, placeholder API keys, and destructive setup behavior are inconsistent (`README.md`, `.env.example`, `src/cli/commands/setup.ts`). Reviewed by Codex on 2026-07-14. | No consolidated first-run flow exists. Changes require coordinated documentation, configuration, and setup UX work. |
| `AM-UX-008` | Open | P1 | Unassigned | **Confirmed** — PDF/DOCX uploads are converted to Base64 in the browser and inserted into the visible context field without size, progress, error, or removal controls (`public/index.html`). Reviewed by Codex on 2026-07-14. | No attachment model or upload endpoint exists. |
| `AM-UX-009` | Open | P2 | Unassigned | **Confirmed** — mode-specific rounds, timeout, worktree, and working-directory controls are all shown in the primary form, and changing mode does not hide irrelevant settings (`public/index.html`). Reviewed by Codex on 2026-07-14. | No basic/advanced disclosure model exists. |
| `AM-QA-001` | Open | P2 | Unassigned | **Confirmed** — the repository has five Vitest suites for backend/configuration behavior but no automated Web console end-to-end tests (`tests/`). Reviewed by Codex on 2026-07-28. | No browser UX regression suite exists. |
| `AM-DX-001` | Open | P1 | Unassigned | **Confirmed** — `package.json` defines `npm run lint`, but no local `eslint` executable is available and the command exits 127. Verified by Codex on 2026-07-28. | Lint dependencies/configuration must be restored or the script must be replaced with the intended supported check. |

## Next Action

**`AM-UX-001` — Make every declared `serve` option effective.** Wire explicit
CLI values into server startup so they override configuration without replacing
unspecified configuration values; implement `--no-mcp` and `--mcp-stdio`
behavior or remove unsupported options; validate invalid values with actionable
errors; and add regression tests proving each retained flag changes the
effective server configuration.

## Recent Activity

### `ACT-20260728-01` — Initialize the repository collaboration protocol

- **Role:** Codex, protocol bootstrap participant.
- **Task:** Create the canonical collaboration handoff required by
  `BOOTSTRAP.md`, expose it from README, and preserve the current repository
  evidence.
- **Context inspected:** `BOOTSTRAP.md`, `README.md`, `package.json`,
  `.gitignore`, Git history and status, GitHub Actions workflows, source/test
  inventory, and the UX review findings recorded in the current collaboration.
- **Actions performed:** Designed the protocol and evidence schema; created
  `HANDOFF.md`; added the README protocol pointer; added the supplied
  `BOOTSTRAP.md` to version control; excluded unrelated untracked artifacts.
- **Files modified:** `HANDOFF.md`, `README.md`; `BOOTSTRAP.md` added as the
  protocol source.
- **Findings:** No prior HANDOFF history exists. Ten unresolved UX/QA findings
  were preserved as stable issues, and the failed lint invocation created
  `AM-DX-001`.
- **Verification performed:** `npm run build` exited 0; `npm test` exited 0
  with 5 files and 25 tests passing; `npm run lint` exited 127 because `eslint`
  was not found. No Windows or Docker runtime test was performed.
- **Issues created or updated:** Created `AM-UX-001` through `AM-UX-009`,
  `AM-QA-001`, and `AM-DX-001`.
- **Remaining uncertainty:** The current Windows portable and Docker artifacts
  retain repository evidence but were not independently exercised in this
  activity.
- **Recommended next action:** Use the single canonical `Next Action` above;
  no additional action is proposed.

## Archived Summary

No activity has been archived yet.

### Archival policy

- Keep the newest ten `Recent Activity` entries in full, newest first.
- When archiving older entries, group them by an explicit date range and list
  every original activity ID and author.
- Preserve architectural decisions, unresolved issue IDs, rejected approaches,
  major reasoning, verification evidence, and uncertainty. Never archive away
  evidence still needed by an Active Issue.
- Archival is compression, not deletion: if details cannot be preserved without
  changing their meaning, leave the original entry in `Recent Activity`.
- Record each archival operation as a new participant-owned activity entry.
