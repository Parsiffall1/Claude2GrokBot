# Architecture

## Components

| File | Role |
|---|---|
| `src/index.ts` | Router: `/mcp`, `/executor/*`, `/files/*`, `/kit/*`, OAuth routes, `/healthz`; cron handler |
| `src/mcp.ts` | Stateless MCP server (Streamable HTTP, JSON responses). `initialize`, `ping`, `tools/list`, `tools/call` |
| `src/hub.ts` | `TaskHub` Durable Object (SQLite): tasks, events, executor state, OAuth state, timers |
| `src/oauth.ts` | OAuth 2.1 authorization server for one owner (PKCE S256, DCR, CIMD, rotating refresh tokens) |
| `src/executor-api.ts` | claim / heartbeat / result / attachment / ping for executors |
| `src/files.ts` | Signed download links for attachments |
| `src/kit.ts` | Serves the executor kit (installer, relay.py, Grok Bot skill) bundled at deploy time |
| `src/adapters/` | Wake adapters. `webhook.ts` (bearer / hmac / none); poll-only built in |
| `src/notify.ts` | Optional ntfy-compatible push |

Everything lives in **one** Durable Object instance (`idFromName("hub")`). A Durable Object handles one event at a
time, so each block of SQL without an `await` in between is atomic. That is what makes claims exclusive and
idempotency keys safe. One object comfortably handles a personal or small-team workload; shard by executor if you
outgrow it.

## Data model

`tasks`

| Column | Meaning |
|---|---|
| `id` | `t_<time36>_<80 random bits>` |
| `idempotency_key` | unique; a repeated submit returns the original task |
| `executor` | executor name |
| `title`, `instructions`, `context` | the task (only ever sent to an executor that claims with its key) |
| `waiting_on` | `executor_user` while `state = input-required` |
| `state` | see below |
| `priority`, `attempts`, `max_attempts` | claim order and retry budget |
| `wake_attempts`, `next_wake_at`, `last_wake_at`, `last_wake_status` | wake bookkeeping |
| `lease_expires_at`, `result_token_hash` | the current claim (token stored as SHA-256) |
| `result`, `error`, `note`, `external_actions` | executor output (result ≤ 256 KB) |
| `created_at`, `updated_at`, `deadline_at`, `completed_at` | ms timestamps |

`attachments` + `attachment_chunks`: files the executor uploads, stored in 1 MB chunks (a Durable Object SQLite row is
capped at 2 MB); purged with their task.

Also: `task_events` (audit trail of transitions), `executors` (last wake / claim), `oauth_clients`, `oauth_codes`,
`oauth_tokens` (hashes only), `auth_failures`, `meta`.

## States

State names follow the A2A protocol's task states so a future A2A bridge can map them 1:1.

| State | Meaning | Leaves by |
|---|---|---|
| `submitted` | queued; wake request not accepted yet | wake request accepted → `dispatched`; claim → `working` |
| `dispatched` | wake request accepted (or outcome unknown) | claim → `working`; re-send after `REWAKE_AFTER_SECONDS` |
| `working` | claimed; lease running | result → `completed`/`failed`; `blocked` → `input-required`; lease expiry → `submitted` or `failed` |
| `input-required` | the executor waits for its user (e.g. a login) | executor heartbeat → `working`; executor result → done; 24 h → `failed` |
| `completed`, `failed`, `canceled` | terminal | purged after `RETENTION_DAYS` |

## Wake request semantics

- Outcome `accepted` (2xx) or `unknown` (timeout): task → `dispatched`, re-send later only if still unclaimed.
- Outcome `rejected` (non-2xx, network error, misconfiguration): stay `submitted`, retry after 1 min, 5 min, 15 min,
  1 h, up to `WAKE_MAX_ATTEMPTS`. Then the owner is notified and the task waits for a poll or `wake_executor`.
- **Coalescing:** if a wake request was sent less than `WAKE_COALESCE_SECONDS` ago and has not claimed since, a new task
  does not send another; the executor drains the queue in one run.
- Duplicate wake requests are harmless: a second run finds nothing to claim (HTTP 204) and stops.

## Timers

After every change the hub sets its Durable Object alarm to the earliest of: next re-send, lease expiry, deadline.
The alarm runs `tick()`. A cron trigger (every 30 min) also runs `tick()` as a safety net.

## Why not …

- **MCP Tasks** (`tasks/get` etc.): experimental and changing between spec versions; plain tools work in every client today.
- **SSE / sessions:** the server never needs to push to Claude, so a stateless JSON-only Streamable HTTP server is simpler and cheaper.
- **Putting the task in the webhook body:** it would land in third-party logs and make duplicate rings dangerous.
