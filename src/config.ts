import type { TaskHub } from "./hub";
import { splitList } from "./util";

/**
 * Worker bindings. Plain-text settings live in `vars` (wrangler.jsonc);
 * everything marked SECRET must be set with `wrangler secret put` and never committed.
 */
export interface Env {
  HUB: DurableObjectNamespace<TaskHub>;

  // ---- vars (non-secret) ----
  DEFAULT_EXECUTOR?: string; // name of the default executor, e.g. "default"
  WAKE_AUTH?: string; // "bearer" (Grok Bot) | "hmac" | "none"
  LEASE_SECONDS?: string; // how long an executor owns a claimed task (default 1800)
  WAKE_MAX_ATTEMPTS?: string; // wake requests per task before giving up (default 4)
  REWAKE_AFTER_SECONDS?: string; // re-send if a task was not claimed after this long (default 900)
  WAKE_COALESCE_SECONDS?: string; // don't send another wake request within this window if the last one is unanswered (default 60)
  ACCESS_TOKEN_TTL_SECONDS?: string; // OAuth access token lifetime (default 3600)
  RETENTION_DAYS?: string; // finished tasks are purged after this many days (default 30)
  PUBLIC_URL?: string; // optional: force the public origin, e.g. https://relay.example.com

  // ---- SECRETS ----
  MCP_TOKENS?: string; // static bearer tokens for MCP clients (comma separated, >= 32 chars each)
  MCP_READONLY_TOKENS?: string; // optional read-only tokens (get_status/get_result/list only)
  EXECUTOR_KEY?: string; // key executors use to claim tasks (>= 32 chars)
  OWNER_PASSWORD?: string; // enables the OAuth consent page (>= 12 chars)
  WAKE_URL?: string; // executor wake webhook URL (e.g. Grok Bot routine webhook). "none" = poll only
  WAKE_SECRET?: string; // wake webhook credential (Grok Bot: the routine "key")
  NOTIFY_URL?: string; // optional ntfy-compatible URL for alert pushes
  NOTIFY_TOKEN?: string; // optional bearer token for NOTIFY_URL
  EXECUTORS_JSON?: string; // optional, advanced: extra executors (see docs/adapters.md)
}

export type WakeAuth = "bearer" | "hmac" | "none";

export interface ExecutorConfig {
  name: string;
  wake: { type: "webhook"; url: string; auth: WakeAuth; secret?: string } | { type: "none" };
  /** Optional key that may only claim this executor's tasks. */
  executorKey?: string;
}

export interface Config {
  defaultExecutor: string;
  executors: Record<string, ExecutorConfig>;
  leaseMs: number;
  blockedTtlMs: number;
  wakeMaxAttempts: number;
  rewakeAfterMs: number;
  wakeCoalesceMs: number;
  accessTokenTtlS: number;
  refreshTokenTtlMs: number;
  retentionMs: number;
  mcpTokens: string[];
  mcpReadonlyTokens: string[];
  executorKey: string | null;
  ownerPassword: string | null;
  warnings: string[];
}

export const MIN_TOKEN_LEN = 32;
export const MIN_PASSWORD_LEN = 12;

function num(v: string | undefined, d: number, min: number, max: number): number {
  const n = Number(v);
  if (!v || !Number.isFinite(n)) return d;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function validWakeUrl(u: string): boolean {
  try {
    const url = new URL(u);
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

function wakeFrom(name: string, url: string | undefined, auth: string | undefined, secret: string | undefined, warnings: string[]): ExecutorConfig["wake"] {
  if (!url || url === "none") return { type: "none" };
  if (!validWakeUrl(url)) {
    warnings.push(`executor "${name}": wake URL must be https (or http://localhost for dev); falling back to poll-only`);
    return { type: "none" };
  }
  const a = (auth || "bearer").toLowerCase() as WakeAuth;
  if (!["bearer", "hmac", "none"].includes(a)) {
    warnings.push(`executor "${name}": unknown wake auth "${auth}", using bearer`);
  }
  const wakeAuth: WakeAuth = ["bearer", "hmac", "none"].includes(a) ? a : "bearer";
  if (wakeAuth !== "none" && !secret) warnings.push(`executor "${name}": wake auth is ${wakeAuth} but no secret is set`);
  return { type: "webhook", url, auth: wakeAuth, secret };
}

export function loadConfig(env: Env): Config {
  const warnings: string[] = [];
  const strong = (list: string[], label: string) =>
    list.filter((t) => {
      if (t.length >= MIN_TOKEN_LEN) return true;
      warnings.push(`${label}: ignoring a token shorter than ${MIN_TOKEN_LEN} characters`);
      return false;
    });

  const defaultExecutor = (env.DEFAULT_EXECUTOR || "default").trim();
  const executors: Record<string, ExecutorConfig> = {
    [defaultExecutor]: { name: defaultExecutor, wake: wakeFrom(defaultExecutor, env.WAKE_URL, env.WAKE_AUTH, env.WAKE_SECRET, warnings) },
  };

  if (env.EXECUTORS_JSON) {
    try {
      const extra = JSON.parse(env.EXECUTORS_JSON) as Record<string, { wake_url?: string; wake_auth?: string; wake_secret?: string; executor_key?: string }>;
      for (const [name, e] of Object.entries(extra)) {
        if (!/^[a-z0-9][a-z0-9._:-]{0,63}$/i.test(name)) {
          warnings.push(`EXECUTORS_JSON: invalid executor name "${name}"`);
          continue;
        }
        let key = e.executor_key;
        if (key && key.length < MIN_TOKEN_LEN) {
          warnings.push(`executor "${name}": executor_key too short, ignored`);
          key = undefined;
        }
        executors[name] = { name, wake: wakeFrom(name, e.wake_url, e.wake_auth, e.wake_secret, warnings), executorKey: key };
      }
    } catch {
      warnings.push("EXECUTORS_JSON is not valid JSON; ignored");
    }
  }

  let executorKey = env.EXECUTOR_KEY || null;
  if (executorKey && executorKey.length < MIN_TOKEN_LEN) {
    warnings.push(`EXECUTOR_KEY shorter than ${MIN_TOKEN_LEN} characters; executor endpoints disabled`);
    executorKey = null;
  }
  let ownerPassword = env.OWNER_PASSWORD || null;
  if (ownerPassword && ownerPassword.length < MIN_PASSWORD_LEN) {
    warnings.push(`OWNER_PASSWORD shorter than ${MIN_PASSWORD_LEN} characters; OAuth disabled`);
    ownerPassword = null;
  }

  return {
    defaultExecutor,
    executors,
    leaseMs: num(env.LEASE_SECONDS, 1800, 60, 86400) * 1000,
    blockedTtlMs: 24 * 3600 * 1000,
    wakeMaxAttempts: num(env.WAKE_MAX_ATTEMPTS, 4, 1, 20),
    rewakeAfterMs: num(env.REWAKE_AFTER_SECONDS, 900, 60, 86400) * 1000,
    wakeCoalesceMs: num(env.WAKE_COALESCE_SECONDS, 60, 0, 3600) * 1000,
    accessTokenTtlS: num(env.ACCESS_TOKEN_TTL_SECONDS, 3600, 300, 86400),
    refreshTokenTtlMs: 30 * 86400 * 1000,
    retentionMs: num(env.RETENTION_DAYS, 30, 1, 365) * 86400 * 1000,
    mcpTokens: strong(splitList(env.MCP_TOKENS), "MCP_TOKENS"),
    mcpReadonlyTokens: strong(splitList(env.MCP_READONLY_TOKENS), "MCP_READONLY_TOKENS"),
    executorKey,
    ownerPassword,
    warnings,
  };
}

export function hubStub(env: Env): DurableObjectStub<TaskHub> {
  return env.HUB.get(env.HUB.idFromName("hub"));
}
