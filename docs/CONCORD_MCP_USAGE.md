# Concord MCP + OpenCode Integration

## Purpose in this repository

Concord provides shared, durable work-state for coding agents working in the
same repository. Instead of relying on chat history, agents register presence,
claim a task and its expected files, publish progress, exchange messages, and
record completion evidence in one local workspace.

In this repo Concord is used to:

- prevent two agents from editing the same files at the same time;
- make ownership and scope explicit before an edit starts;
- preserve decisions, assumptions, risks, and verification evidence;
- support review-ready handoffs between sessions.

State is stored locally under `.concord/` and is intentionally gitignored.
The MCP surface is five workflow tools: `start_work`, `inspect_work`,
`update_work`, `transfer_work`, and `finish_work`.

## Windows setup that works here

The working setup uses a portable Node 22 runtime rather than the system Node.

| Component | Value |
| --- | --- |
| Runtime | Portable Node 22 LTS (`v22.23.4`) under `%LOCALAPPDATA%\ConcordAI\node22` |
| Concord CLI / MCP | `@concord-ai/concord-mcp` `0.19.0` under `%LOCALAPPDATA%\ConcordAI\concord` |
| Launchers | `concord.cmd` and `concord-mcp.cmd` in `%LOCALAPPDATA%\ConcordAI` |
| Workspace state | `.concord/concord.db` plus generated review artifacts |
| Verification | The `concord.cmd` launcher reports `0.19.0` |

### Why Node 25 failed

The machine default was Node `v25.2.1`. Concord depends on the native
`better-sqlite3` addon (`13.0.3` in this install). That dependency ships
prebuilt native bindings for supported Node ABIs, and the Node 25 runtime did
not have a compatible binding. Installing Concord under Node 25 therefore
failed while `node-gyp` tried to rebuild `better-sqlite3`, so the CLI and MCP
server could not be installed with that runtime.

Using the portable Node 22 LTS runtime resolves the ABI mismatch and lets the
native SQLite binding load. The `concord.cmd` and `concord-mcp.cmd` launchers
pin that runtime explicitly, so the working setup does not depend on whichever
`node` happens to be first on `PATH`.

The local `opencode.json` is machine-specific and gitignored. It points at the
portable runtime and installed Concord MCP bundle by absolute path. Do not copy
that file to another machine; use the portable example below instead.

## Portable OpenCode MCP configuration

`opencode.example.json` is the portable template. It uses `npx` and reads the
agent identity from the environment:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "lsp": true,
  "formatter": true,
  "mcp": {
    "concord": {
      "type": "local",
      "command": ["npx", "-y", "@concord-ai/concord-mcp@latest"],
      "enabled": true,
      "cwd": ".",
      "environment": {
        "CONCORD_AGENT_KIND": "opencode",
        "CONCORD_AGENT_ID": "{env:CONCORD_AGENT_ID}",
        "CONCORD_TELEMETRY_DISABLED": "1"
      }
    }
  }
}
```

Ensure `npx` runs under Node `>=22.12` (Node 22 LTS is recommended). Node 25
does not have a compatible prebuilt `better-sqlite3` binding in this setup.

Set a distinct identity per OpenCode session before starting it, for example:

```powershell
$env:CONCORD_AGENT_ID = "opencode:session-a"
opencode
```

Use a different value such as `opencode:session-b` for the second session.
Start OpenCode from the repository root so Concord resolves the same
`.concord/` workspace. Pin `@concord-ai/concord-mcp@0.19.0` instead of
`@latest` if reproducible installs are required.

## Two OpenCode sessions

Both sessions connect to the same workspace and see the same tasks, agents,
and messages.

1. **Claim scope before editing.** Session A calls `start_work` with a stable
   task id, title, agent kind, and expected files. Session B calls
   `inspect_work` to see active tasks and overlaps, then calls `start_work` for
   a different task or file scope.
2. **Inspect before acting.** `inspect_work` reads the workspace, one task,
   one agent, or one message thread. Use it to check `expected_version`,
   ownership, and existing evidence.
3. **Record durable context.** `update_work` records progress, assumptions,
   decisions, questions, blockers, and findings. It can also send a `prompt`
   or `reply` to another promptable agent, subject to the OpenCode limitation
   below.
4. **Move ownership deliberately.** `transfer_work` supports `assign`,
   `accept`, `decline`, `release`, `reassign`, `offer`, and `reopen`. Supply
   the `expected_version` last read so stale changes are rejected.
5. **Finish with evidence.** Before ending work, call `finish_work` once with
   the outcome (`handoff`, `review_ready`, `complete`, or `closed`), changed
   files, test or verification commands, decisions, assumptions, risks, and
   provenance. Use `review_ready` when another agent or human should review.

Keep claims small. Resolve any overlap reported by `start_work` before editing.

## OpenCode limitation

Concord `0.19.0` has no native OpenCode adapter. `concord adapters status`
reports adapters for harnesses such as Claude Code, Codex, Cursor, Gemini,
Grok, Goose, Antigravity, Copilot CLI, and Devin, but not OpenCode. As a
result, OpenCode does not get native lifecycle hooks, idle wake-up, or
automatic live message injection.

The MCP workflow tools still work normally. Live peer messaging is the part
that needs the CLI inbox:

```powershell
concord inbox register --agent "opencode:session-a" --provider opencode
concord inbox drain --agent "opencode:session-a" --provider opencode
```

`inbox register` advertises the session as able to receive messages.
`inbox drain` prints and acknowledges every waiting message. Run these with
the same agent id used in `CONCORD_AGENT_ID`. Without this step, messages may
be stored in the workspace but will not be delivered to the OpenCode session
as live input. `update_work` prompt/reply remains useful for durable threads,
but it is not a substitute for an adapter.

## Sanitized evidence from this session

The following is a sanitized record of this documentation task. It contains no
credentials, environment contents, account data, or absolute user paths.

```text
Task: TASK-CONCORD-MCP-DOCS
Title: Document Concord MCP + OpenCode integration
Agent: opencode:concord-a
Kind: opencode

start_work:
  status: active
  version: 1
  overlaps: 0
  expected_files: docs/CONCORD_MCP_USAGE.md
  modules: docs
  domains: developer-tooling, agent-coordination

finish_work:
  outcome: review_ready
  expected_version: 1
  what_changed: Added docs/CONCORD_MCP_USAGE.md describing the purpose of
    Concord MCP in this repo, the portable Node 22 / Concord 0.19.0 setup,
    the Node 25 better-sqlite3 failure, portable OpenCode configuration,
    the two-session workflow, the missing OpenCode adapter, and inbox
    register/drain usage.
  changed_files:
    - docs/CONCORD_MCP_USAGE.md
  tests_run:
    - documentation-only; verified the file exists and the example config
      matches opencode.example.json
  decisions:
    - Use environment placeholders instead of machine-specific paths.
    - Document Node 22 as the supported runtime for this install.
    - Describe inbox register/drain as the OpenCode live-message workaround.
  assumptions:
    - Concord 0.19.0 remains the installed CLI/MCP version.
    - OpenCode sessions use distinct CONCORD_AGENT_ID values.
  known_risks:
    - The native adapter situation may change in a later Concord release.
    - The portable npx example depends on network access to the npm registry.
  guardrails_checked:
    - No secrets, .env contents, account data, or absolute user paths added.
    - README.md and other project files left unchanged.
```

## Repository hygiene verification

Before committing, the staged file set was checked for secrets and generated
artifacts:

- `git check-ignore` confirmed `backend/.env`, `.data/`, `.freebuff/`,
  `ai-engine/venv*/`, model/dataset directories, `.concord/`, and the local
  `opencode.json` are excluded.
- Compiled launcher binaries (`*.exe`) are excluded; the launcher source remains
  in the repository.
- Real-looking test account identifiers in the paper-wallet tests were replaced
  with clearly fake values, and the diagnostic script now requires credentials
  from `DIAG_EMAIL` / `DIAG_PASSWORD`.
- `npx vitest run src/test/goalCurrency.test.ts
  src/test/paperWalletFollow.test.ts` passed 4 tests.
- Both OpenCode JSON files parse successfully.
