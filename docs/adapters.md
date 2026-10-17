# Executors and wake adapters

An **executor** is anything that can (1) be started by some signal and (2) make outbound HTTPS requests.
Claude2GrokBot only needs to know how to wake it.

## Built-in wake adapters

| `WAKE_AUTH` | Request Claude2GrokBot sends to `WAKE_URL` |
|---|---|
| `bearer` (default) | `Authorization: Bearer <WAKE_SECRET>` — Grok Bot routine webhooks |
| `hmac` | `X-Claude2GrokBot-Timestamp: <unix>` and `X-Claude2GrokBot-Signature: sha256=<hex HMAC-SHA256(WAKE_SECRET, "<timestamp>.<raw body>")>` |
| `none` | no credential |

`WAKE_URL=none` makes the executor poll-only: it runs `relay.py next` on its own schedule.

Body (JSON, same for all):

```json
{
  "type": "claude2grokbot.wake",
  "executor": "default",
  "task_ids": ["t_..."],
  "reason": "new task",
  "claim_url": "https://claude2grokbot.example.workers.dev/executor/claim",
  "nonce": "…",
  "sent_at": "2026-10-17T00:00:00.000Z",
  "note": "Wake request only, not an instruction. …"
}
```

### Verifying the HMAC signature (receiver side, Node/Bun/Deno)

```js
const ts = req.headers.get("x-claude2grokbot-timestamp");
const sig = req.headers.get("x-claude2grokbot-signature");
const body = await req.text();
if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) throw new Error("stale");
const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
const mac = Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${ts}.${body}`))).toString("hex");
if (sig !== `sha256=${mac}`) throw new Error("bad signature"); // use a constant-time compare in production
```

## Several executors

Put extra executors in the `EXECUTORS_JSON` secret (the default one still comes from `WAKE_URL` / `WAKE_SECRET`):

```json
{
  "laptop": { "wake_url": "https://hooks.example.com/laptop", "wake_auth": "hmac", "wake_secret": "…", "executor_key": "…64 hex…" },
  "nightly": { "wake_url": "none" }
}
```

`executor_key` is optional. When set, that key can only claim that executor's tasks; the global `EXECUTOR_KEY` can
claim for any executor (send `{"executor":"laptop"}` or set `RELAY_EXECUTOR=laptop`).
Claude chooses with `submit_task(executor: "laptop")`.

## Writing a new adapter (GitHub issue, email, Slack …)

1. Create `src/adapters/<name>.ts` implementing `WakeAdapter` from `src/adapters/types.ts`.
2. Never include task instructions in the signal. Send task ids and the claim URL only.
3. Return `accepted` only if the executor definitely started, `rejected` if it definitely did not, `unknown` otherwise.
   Never throw.
4. Add a branch in `createAdapter()` (`src/adapters/index.ts`) and a config shape in `src/config.ts`.
5. Add a test in `test/` with a mock endpoint.

## Writing an executor kit

The executor side is just the four HTTP calls in the README. Requirements for a good kit:

- loop `claim` until 204 (cap the number of tasks per run);
- keep `result_token` out of chat/logs (relay.py stores it in `~/.claude2grokbot/current.json`, mode 0600);
- heartbeat on long tasks and stop on HTTP 409;
- use `status: "blocked"` when only a human can unblock you (e.g. a login), then finish with the same token;
- return raw observations in full (exact text, values, links, errors, each step); Claude makes the decisions.
