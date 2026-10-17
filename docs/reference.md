# Claude2GrokBot technical reference

Setup and usage are in the [README](../README.en.md) and the Claude skill ([skills/claude2grokbot/SKILL.md](../skills/claude2grokbot/SKILL.md)),
which is the canonical setup procedure. This page covers the interfaces.

## MCP tools

| Tool | Purpose |
|---|---|
| `submit_task` | Queue a task and wake the executor. Returns a `task_id` at once |
| `wait_for_result` | Wait up to 55 s (default 40) for the task to finish; returns the result, or the status if still running |
| `get_result` | Result text, attachment list and inline images (up to 5) |
| `get_attachment` | One attachment: image, text (paged with `offset`) or a 24 h download link |
| `get_status` / `list_tasks` | Task state |
| `cancel_task` | Cancel; a working executor is told to stop at its next heartbeat or result |
| `list_executors` / `wake_executor` | Wake status per executor; send a wake request now |

Endpoint: `<RELAY_URL>/mcp` (Streamable HTTP, JSON responses). Auth: OAuth 2.1 (claude.ai; PKCE, dynamic client
registration, client ID metadata documents; the consent page asks for `OWNER_PASSWORD`) or `Authorization: Bearer
<MCP_TOKENS>` (Claude Code). `MCP_READONLY_TOKENS` see only the read tools.

## Executor HTTP API

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /executor/claim` `{"executor"?}` | `Bearer EXECUTOR_KEY` | 200 with task + one-time `result_token`, or 204 |
| `POST /executor/heartbeat` `{task_id, result_token, note?}` | result token | extend lease (also resumes a `blocked` task); 409 if canceled |
| `POST /executor/result` `{task_id, result_token, status, result?, error?, note?, external_actions?}` | result token | `status` = `completed` \| `failed` \| `blocked` |
| `POST /executor/attachment` raw file body; headers `X-Task-Id`, `X-Result-Token`, `X-Filename`, `Content-Type` | result token | upload a file or screenshot (≤ 20 MB, ≤ 100 per task) before the final result |
| `GET /executor/ping` | `Bearer EXECUTOR_KEY` | connectivity check |
| `GET /files/<id>?exp=&sig=` | signed link (24 h) | download an attachment; only PNG/JPEG/GIF/WebP are shown inline |
| `GET /kit/install.sh`, `/kit/relay.py`, `/kit/SKILL.md?lang=en\|zh-CN` | none (no secrets) | executor kit matching this deployment |

Executor client ([relay.py](../executor-kit/relay.py), Python stdlib; or [relay.sh](../executor-kit/relay.sh), curl + jq):

```bash
curl -fsSL <RELAY_URL>/kit/install.sh | RELAY_EXECUTOR_KEY=<key> SKILL_LANG=en bash   # install or update
relay.py next                      # claim and print the next task (exit 3 = none)
relay.py heartbeat "50% done"      # keep the lease on long tasks
relay.py block "waiting for user"  # pause up to 24 h for a human
relay.py attach shot.png data.csv  # upload screenshots or files before done
relay.py done completed out.md     # upload the result (or: done failed out.md "reason")
```

Other executors: [adapters.md](adapters.md) (HMAC-signed webhooks, poll-only).

## Task lifecycle

```
submit ─▶ submitted ─(wake ok)─────▶ dispatched ─(claim)─▶ working ─▶ completed | failed
   │          ▲  └── wake rejected: retry 1m/5m/15m/1h ──────┘          │  ├─ blocked ─▶ input-required (executor waits for its user)
   │          └──────────── lease expired: requeue (max_attempts) ◀────┘  └─ cancel ─▶ canceled
```

Details: [architecture.md](architecture.md).

## Configuration

Secrets (`npx wrangler secret put NAME --name <worker>`; `scripts/setup.sh` sets them): `MCP_TOKENS`,
`MCP_READONLY_TOKENS`, `EXECUTOR_KEY`, `OWNER_PASSWORD`, `WAKE_URL`, `WAKE_SECRET`, `NOTIFY_URL`, `NOTIFY_TOKEN`,
`EXECUTORS_JSON`. See [.env.example](../.env.example).

Vars (`wrangler.jsonc`): `DEFAULT_EXECUTOR`, `WAKE_AUTH`, `LEASE_SECONDS`, `WAKE_MAX_ATTEMPTS`, `REWAKE_AFTER_SECONDS`,
`WAKE_COALESCE_SECONDS`, `ACCESS_TOKEN_TTL_SECONDS`, `RETENTION_DAYS`, `PUBLIC_URL`.

`/healthz` reports configuration warnings (e.g. a token shorter than 32 characters is ignored).

## Security summary

- Three separate credentials: Claude → service (OAuth or `MCP_TOKENS`), service → executor (wake secret),
  executor → service (`EXECUTOR_KEY` to claim, then a one-time per-task `result_token`).
- Nothing secret in the repo; tokens are stored only as SHA-256 hashes; no third-party passwords are stored.
- No task review: tasks go to the executor exactly as written.
- Executor output is returned inside `<executor_output untrusted="true">` so Claude treats it as data.

Full threat model: [security.md](security.md).

## Development

```bash
npm install
bun test           # end-to-end tests with an in-memory Workers shim; also runs relay.py, relay.sh and the kit installer
npm run typecheck
```

Pushing a `v*` tag runs CI, which builds `claude2grokbot-skill.zip` and attaches it to the release that `install.sh` downloads.
