# Security model and threat analysis

## Credentials

| Link | Credential | Stored where | Notes |
|---|---|---|---|
| Claude → Claude2GrokBot | OAuth access token (1 h) + rotating refresh token (30 d), **or** static `MCP_TOKENS` | client side; server keeps SHA-256 hashes / Worker secret | `MCP_READONLY_TOKENS` can only read |
| Owner → Claude2GrokBot | `OWNER_PASSWORD` | Worker secret | needed for OAuth consent; lock after 10 failures per IP or 100 overall in 15 min |
| Claude2GrokBot → executor | wake secret (`WAKE_SECRET`) | Worker secret | Grok Bot: bearer key; others: HMAC |
| executor → Claude2GrokBot (claim) | `EXECUTOR_KEY` | executor env / `~/.config/claude2grokbot/executor.env` (0600) | only reaches `/executor/*` |
| executor → Claude2GrokBot (result) | per-task `result_token` (256-bit, one claim) | `~/.claude2grokbot/current.json` (0600) | hash stored; invalid after the result or requeue |

Nothing secret lives in the repository, `wrangler.jsonc`, task payloads or logs. Tokens shorter than 32 characters
are ignored and reported by `/healthz`.

## No task review

The server does not inspect, classify or hold back tasks: every task is stored and handed to the executor exactly as
written. Deciding what to do is Claude's job (and the user's, through Claude); the executor only executes and reports
back.

## Threats and mitigations

| Threat | Mitigation |
|---|---|
| **Prompt injection into the executor** (web page / email says "send money") | Wake requests carry no instructions; tasks come only from an authenticated claim; executor skill treats any other text as data |
| **Prompt injection into Claude** via results | Results are wrapped in `<executor_output untrusted="true">`; closing tags in the output are neutralised; the tool reply tells Claude not to follow instructions in it |
| **Unattended Claude runs** (routines/scheduled tasks call connectors without asking) | Give them a `MCP_READONLY_TOKENS` token if they should only read |
| **Uploaded file runs as a page on this origin** (HTML/SVG attachment) | Downloads need a signed, 24 h link; only PNG/JPEG/GIF/WebP are served inline, everything else as `application/octet-stream` with `Content-Disposition: attachment`, `nosniff` and a sandboxing CSP |
| **Leaked wake key** | Attacker can only trigger empty runs (cost, not data). Rotate: delete and re-add the Grok Bot webhook trigger, update `WAKE_SECRET` |
| **Leaked EXECUTOR_KEY** | Attacker could claim tasks (read instructions). Rotate the secret and the executor config; review `task_events` |
| **Leaked MCP token** | Remove it from `MCP_TOKENS` (comma list allows overlap during rotation) |
| **Stolen OAuth tokens** | Short access tokens (1 h); refresh tokens rotate on use, and replaying a used refresh token revokes the whole grant. Changing `OWNER_PASSWORD` stops new sign-ins; existing refresh tokens stay valid until they expire (30 d). A one-click "revoke all" admin action is on the roadmap (`TaskHub.revokeAllOAuth()` already exists) |
| **Duplicate execution** | Idempotency keys, atomic claims, leases, one-time result tokens |
| **Password brute force** | Atomic check in the Durable Object; 10 failures per IP / 100 overall per 15 minutes; use a long passphrase |
| **Open client registration abuse** | Registration grants nothing without the owner password; at 500 clients the oldest token-less one is evicted; unused registrations are purged after a day |
| **Clickjacking of the consent page** | `X-Frame-Options: DENY`, `frame-ancestors 'none'` |
| **Notification leaks** | Notifications contain counts and executor names only; use a long random ntfy topic or self-host |

## Known limits

- No task review on the server: anyone holding a full MCP token or OAuth grant can have the executor do anything it can do.
  Keep tokens private. MCP clients may show their own per-tool permission prompts; that is a client setting.
- Single owner. Team setups share one password; use per-person OAuth only through your own identity provider fork.
- No rate limiting on MCP calls beyond Cloudflare's platform limits.

## Reporting vulnerabilities

Please open a private security advisory on GitHub rather than a public issue.
