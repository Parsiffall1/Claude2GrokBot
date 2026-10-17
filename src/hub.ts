import { DurableObject } from "cloudflare:workers";
import { createAdapter, type WakeOutcome } from "./adapters";
import { loadConfig, type Config, type Env } from "./config";
import { notify } from "./notify";
import { equalHashes, iso, sha256HexBytes, newTaskId, now, randomToken, sha256Hex } from "./util";

/**
 * TaskHub: a single SQLite-backed Durable Object that owns all state.
 * Durable Objects process one event at a time, so every "read then write" block below that
 * contains no `await` is atomic. Claims and result submissions rely on that.
 */

export type TaskState =
  | "submitted" // queued, wake request not accepted yet
  | "dispatched" // wake request accepted, waiting for the executor to claim
  | "working" // claimed, executor holds a lease
  | "input-required" // the executor is waiting for its user (e.g. a login only they can do)
  | "completed"
  | "failed"
  | "canceled";

const TERMINAL: TaskState[] = ["completed", "failed", "canceled"];
const WAKE_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

interface TaskRow {
  id: string;
  idempotency_key: string | null;
  executor: string;
  title: string;
  instructions: string;
  context: string | null;
  waiting_on: string | null;
  state: TaskState;
  priority: number;
  attempts: number;
  max_attempts: number;
  wake_attempts: number;
  next_wake_at: number | null;
  last_wake_at: number | null;
  last_wake_status: string | null;
  lease_expires_at: number | null;
  result_token_hash: string | null;
  result: string | null;
  error: string | null;
  external_actions: string | null;
  note: string | null;
  source: string | null;
  notified_stuck: number;
  created_at: number;
  updated_at: number;
  deadline_at: number | null;
  completed_at: number | null;
}

interface ExecutorRow {
  name: string;
  last_wake_at: number | null;
  last_wake_status: string | null;
  last_wake_detail: string | null;
  last_claim_at: number | null;
}

export interface SubmitInput {
  title: string;
  instructions: string;
  context?: string;
  executor?: string;
  idempotency_key?: string;
  deadline_minutes?: number;
  priority?: number;
  max_attempts?: number;
  source?: string;
}

export interface TaskView {
  task_id: string;
  title: string;
  executor: string;
  state: TaskState;
  waiting_on: string | null;
  attempts: number;
  max_attempts: number;
  wake: { attempts: number; last_status: string | null; last_at: string | null };
  lease_expires_at: string | null;
  has_result: boolean;
  error: string | null;
  note: string | null;
  created_at: string | null;
  updated_at: string | null;
  deadline_at: string | null;
  completed_at: string | null;
  next_step: string;
}

type Fail = { ok: false; status: number; error: string; state?: string };

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    idempotency_key TEXT UNIQUE,
    executor TEXT NOT NULL,
    title TEXT NOT NULL,
    instructions TEXT NOT NULL,
    context TEXT,
    waiting_on TEXT,
    state TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    wake_attempts INTEGER NOT NULL DEFAULT 0,
    next_wake_at INTEGER,
    last_wake_at INTEGER,
    last_wake_status TEXT,
    lease_expires_at INTEGER,
    result_token_hash TEXT,
    result TEXT,
    error TEXT,
    external_actions TEXT,
    note TEXT,
    source TEXT,
    notified_stuck INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deadline_at INTEGER,
    completed_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS tasks_queue ON tasks (executor, state, priority, created_at)`,
  `CREATE INDEX IF NOT EXISTS tasks_state ON tasks (state, updated_at)`,
  `CREATE TABLE IF NOT EXISTS task_events (
    task_id TEXT NOT NULL, ts INTEGER NOT NULL, from_state TEXT, to_state TEXT, actor TEXT, note TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS task_events_task ON task_events (task_id, ts)`,
  `CREATE TABLE IF NOT EXISTS executors (
    name TEXT PRIMARY KEY, last_wake_at INTEGER, last_wake_status TEXT, last_wake_detail TEXT, last_claim_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`,
  `CREATE TABLE IF NOT EXISTS oauth_clients (
    client_id TEXT PRIMARY KEY, secret_hash TEXT, redirect_uris TEXT NOT NULL, name TEXT, auth_method TEXT NOT NULL, created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS oauth_codes (
    code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, challenge TEXT NOT NULL,
    scope TEXT NOT NULL, resource TEXT, expires_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS oauth_tokens (
    token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, client_id TEXT NOT NULL, scope TEXT NOT NULL,
    family TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS auth_failures (ts INTEGER NOT NULL, ip TEXT)`,
  `CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, name TEXT NOT NULL, content_type TEXT NOT NULL,
    size INTEGER NOT NULL, sha256 TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS attachments_task ON attachments (task_id)`,
  `CREATE TABLE IF NOT EXISTS attachment_chunks (
    attachment_id TEXT NOT NULL, seq INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (attachment_id, seq))`,
];

/** Files and screenshots the executor returns. Stored in chunks because a SQLite row in a Durable Object is capped at 2 MB. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_TASK = 100;
const CHUNK_BYTES = 1024 * 1024;

export interface AttachmentMeta {
  id: string;
  task_id: string;
  name: string;
  content_type: string;
  size: number;
  sha256: string;
  created_at: string | null;
}

/** States in which a task needs nothing more from the executor right now, so a waiting caller should be answered. */
const SETTLED: TaskState[] = [...TERMINAL, "input-required"];

export class TaskHub extends DurableObject<Env> {
  private sql: SqlStorage;
  /** Callers blocked in waitForTask, woken by setState. In memory only: a waiting request keeps the object alive. */
  private waiters = new Map<string, Set<() => void>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    for (const stmt of SCHEMA) this.sql.exec(stmt);
  }

  // ------------------------------------------------------------------ helpers
  private rows<T>(q: string, ...b: unknown[]): T[] {
    return this.sql.exec(q, ...b).toArray() as unknown as T[];
  }
  private row<T>(q: string, ...b: unknown[]): T | null {
    return this.rows<T>(q, ...b)[0] ?? null;
  }
  private run(q: string, ...b: unknown[]): void {
    this.sql.exec(q, ...b);
  }
  private task(id: string): TaskRow | null {
    return this.row<TaskRow>(`SELECT * FROM tasks WHERE id = ?`, id);
  }
  private event(id: string, from: string | null, to: string | null, actor: string, note?: string): void {
    this.run(`INSERT INTO task_events (task_id, ts, from_state, to_state, actor, note) VALUES (?, ?, ?, ?, ?, ?)`, id, now(), from, to, actor, note ?? null);
  }
  private setState(r: TaskRow, to: TaskState, actor: string, fields: Record<string, unknown> = {}, note?: string): void {
    const sets = ["state = ?", "updated_at = ?"];
    const vals: unknown[] = [to, now()];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v ?? null);
    }
    this.run(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, ...vals, r.id);
    if (r.state !== to || note) this.event(r.id, r.state, to, actor, note);
    if (r.state !== to) for (const wake of this.waiters.get(r.id) ?? []) wake();
  }
  private getMeta(k: string): string | null {
    return this.row<{ v: string }>(`SELECT v FROM meta WHERE k = ?`, k)?.v ?? null;
  }
  private setMeta(k: string, v: string): void {
    this.run(`INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, k, v);
  }
  private rememberOrigin(origin?: string): string {
    if (origin) {
      if (this.getMeta("origin") !== origin) this.setMeta("origin", origin);
      return origin;
    }
    return this.env.PUBLIC_URL || this.getMeta("origin") || "";
  }
  private touchExecutor(name: string, fields: Partial<ExecutorRow>): void {
    this.run(`INSERT INTO executors (name) VALUES (?) ON CONFLICT(name) DO NOTHING`, name);
    const entries = Object.entries(fields);
    if (!entries.length) return;
    this.run(`UPDATE executors SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE name = ?`, ...entries.map(([, v]) => v ?? null), name);
  }

  private view(r: TaskRow): TaskView {
    const hints: Record<TaskState, string> = {
      submitted: "Queued. The executor has not accepted the wake request yet; Claude2GrokBot retries automatically.",
      dispatched: "Executor was woken and should claim the task shortly. Check again with get_status.",
      working: "The executor is working on it. Check again later with get_status.",
      "input-required": "The executor is waiting for its user to do something in the executor's own app (e.g. log in).",
      completed: "Done. Call get_result to read the output.",
      failed: "Failed. Call get_result for the error and any partial output.",
      canceled: "Canceled.",
    };
    return {
      task_id: r.id,
      title: r.title,
      executor: r.executor,
      state: r.state,
      waiting_on: r.waiting_on,
      attempts: r.attempts,
      max_attempts: r.max_attempts,
      wake: { attempts: r.wake_attempts, last_status: r.last_wake_status, last_at: iso(r.last_wake_at) },
      lease_expires_at: r.state === "working" ? iso(r.lease_expires_at) : null,
      has_result: r.result != null,
      error: r.error,
      note: r.note,
      created_at: iso(r.created_at),
      updated_at: iso(r.updated_at),
      deadline_at: iso(r.deadline_at),
      completed_at: iso(r.completed_at),
      next_step: hints[r.state],
    };
  }

  // ------------------------------------------------------------------ tasks (called by MCP tools)
  async submitTask(input: SubmitInput, origin: string): Promise<{ ok: true; task: TaskView; deduplicated: boolean; wake: WakeOutcome | null } | Fail> {
    const cfg = loadConfig(this.env);
    origin = this.rememberOrigin(origin);
    const executor = input.executor || cfg.defaultExecutor;
    if (!cfg.executors[executor]) return { ok: false, status: 400, error: `Unknown executor "${executor}". Known: ${Object.keys(cfg.executors).join(", ")}` };

    // ---- atomic section (no await) ----
    if (input.idempotency_key) {
      const existing = this.row<TaskRow>(`SELECT * FROM tasks WHERE idempotency_key = ?`, input.idempotency_key);
      if (existing) return { ok: true, task: this.view(existing), deduplicated: true, wake: null };
    }
    const t = now();
    const id = newTaskId();
    this.run(
      `INSERT INTO tasks (id, idempotency_key, executor, title, instructions, context, state, priority, max_attempts,
        next_wake_at, source, created_at, updated_at, deadline_at)
       VALUES (?, ?, ?, ?, ?, ?, 'submitted', ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.idempotency_key ?? null,
      executor,
      input.title,
      input.instructions,
      input.context ?? null,
      input.priority ?? 0,
      input.max_attempts ?? 3,
      t,
      input.source ?? null,
      t,
      t,
      input.deadline_minutes ? t + input.deadline_minutes * 60_000 : null,
    );
    this.event(id, null, "submitted", "client");
    // ---- end atomic section ----

    const wake = await this.sendWake(executor, origin, "new task");
    await this.scheduleAlarm();
    return { ok: true, task: this.view(this.task(id)!), deduplicated: false, wake };
  }

  async getTask(id: string, origin: string): Promise<TaskView | null> {
    this.rememberOrigin(origin);
    const r = this.task(id);
    return r ? this.view(r) : null;
  }

  /** Blocks until the task is settled (finished or waiting for the executor's user) or the timeout passes. */
  async waitForTask(id: string, timeoutMs: number, origin: string): Promise<TaskView | null> {
    this.rememberOrigin(origin);
    const deadline = now() + timeoutMs;
    for (;;) {
      const r = this.task(id);
      if (!r || SETTLED.includes(r.state) || now() >= deadline) return r ? this.view(r) : null;
      await new Promise<void>((resolve) => {
        const set = this.waiters.get(id) ?? new Set<() => void>();
        this.waiters.set(id, set);
        const done = () => {
          clearTimeout(timer);
          set.delete(done);
          if (!set.size) this.waiters.delete(id);
          resolve();
        };
        const timer = setTimeout(done, Math.max(0, deadline - now()));
        set.add(done);
      });
    }
  }

  async getResult(id: string, origin: string): Promise<{ task: TaskView; result: string | null; external_actions: string | null } | null> {
    this.rememberOrigin(origin);
    const r = this.task(id);
    if (!r) return null;
    return {
      task: this.view(r),
      result: r.result,
      // Raw JSON text as stored (may be truncated at 8000 chars, so not re-parsed).
      external_actions: r.external_actions,
    };
  }

  async listTasks(filter: string, limit: number, origin: string): Promise<TaskView[]> {
    this.rememberOrigin(origin);
    let rows: TaskRow[];
    if (filter === "all") rows = this.rows(`SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?`, limit);
    else if (filter === "active")
      rows = this.rows(`SELECT * FROM tasks WHERE state NOT IN ('completed','failed','canceled') ORDER BY created_at DESC LIMIT ?`, limit);
    else rows = this.rows(`SELECT * FROM tasks WHERE state = ? ORDER BY created_at DESC LIMIT ?`, filter, limit);
    return rows.map((r) => this.view(r));
  }

  async cancelTask(id: string, reason: string | undefined, actor: string, origin: string): Promise<{ ok: true; task: TaskView } | Fail> {
    this.rememberOrigin(origin);
    const r = this.task(id);
    if (!r) return { ok: false, status: 404, error: "No such task" };
    if (!TERMINAL.includes(r.state)) {
      this.setState(r, "canceled", actor, { completed_at: now(), next_wake_at: null, lease_expires_at: null, waiting_on: null }, reason ? `canceled: ${reason}` : "canceled");
    }
    return { ok: true, task: this.view(this.task(id)!) };
  }

  async listExecutors(): Promise<Array<Record<string, unknown>>> {
    const cfg = loadConfig(this.env);
    return Object.values(cfg.executors).map((e) => {
      const st = this.row<ExecutorRow>(`SELECT * FROM executors WHERE name = ?`, e.name);
      const waiting = this.row<{ n: number }>(`SELECT COUNT(*) AS n FROM tasks WHERE executor = ? AND state IN ('submitted','dispatched')`, e.name)?.n ?? 0;
      const working = this.row<{ n: number }>(`SELECT COUNT(*) AS n FROM tasks WHERE executor = ? AND state = 'working'`, e.name)?.n ?? 0;
      return {
        name: e.name,
        default: e.name === cfg.defaultExecutor,
        wake: e.wake.type === "webhook" ? `webhook (${e.wake.auth})` : "none (poll-only)",
        last_wake_at: iso(st?.last_wake_at),
        last_wake_status: st?.last_wake_status ?? null,
        last_wake_detail: st?.last_wake_detail ?? null,
        last_claim_at: iso(st?.last_claim_at),
        tasks_waiting: waiting,
        tasks_working: working,
      };
    });
  }

  /** Manual wake (MCP tool wake_executor). */
  async wakeExecutor(name: string | null, origin: string): Promise<WakeOutcome> {
    const out = await this.sendWake(name || loadConfig(this.env).defaultExecutor, this.rememberOrigin(origin), "manual wake", { force: true });
    await this.scheduleAlarm();
    return out;
  }

  // ------------------------------------------------------------------ wake requests
  private async sendWake(name: string, origin: string, reason: string, opts: { force?: boolean } = {}): Promise<WakeOutcome> {
    const cfg = loadConfig(this.env);
    const exec = cfg.executors[name];
    if (!exec) return { status: "rejected", detail: `unknown executor ${name}` };

    // ---- atomic section ----
    const t = now();
    const ids = this.rows<{ id: string }>(
      `SELECT id FROM tasks WHERE executor = ? AND state IN ('submitted','dispatched') AND wake_attempts < ?
       ORDER BY priority DESC, created_at ASC LIMIT 50`,
      name,
      cfg.wakeMaxAttempts,
    ).map((r) => r.id);
    if (!ids.length && !opts.force) return { status: "skipped", detail: "no tasks waiting" };

    if (exec.wake.type === "none") {
      for (const id of ids) this.run(`UPDATE tasks SET last_wake_status = 'poll-only', next_wake_at = NULL WHERE id = ?`, id);
      return { status: "skipped", detail: "poll-only executor: it claims tasks on its own schedule" };
    }

    const st = this.row<ExecutorRow>(`SELECT * FROM executors WHERE name = ?`, name);
    const recentUnanswered =
      (st?.last_wake_status === "accepted" || st?.last_wake_status === "pending") && st.last_wake_at != null && t >= st.last_wake_at && t - st.last_wake_at < cfg.wakeCoalesceMs && !(st.last_claim_at && st.last_claim_at > st.last_wake_at);
    if (recentUnanswered && !opts.force) {
      // The executor was just woken and hasn't claimed yet; it drains the queue, so don't spend another run.
      for (const id of ids)
        this.run(
          `UPDATE tasks SET state = 'dispatched', last_wake_status = 'coalesced', next_wake_at = ?, updated_at = ? WHERE id = ? AND state IN ('submitted','dispatched')`,
          Math.max(st!.last_wake_at! + cfg.rewakeAfterMs, t + cfg.wakeCoalesceMs),
          t,
          id,
        );
      return { status: "accepted", detail: "coalesced with a wake request sent moments ago" };
    }

    this.touchExecutor(name, { last_wake_at: t, last_wake_status: "pending", last_wake_detail: null });
    for (const id of ids)
      this.run(`UPDATE tasks SET wake_attempts = wake_attempts + 1, last_wake_at = ?, next_wake_at = ?, updated_at = ? WHERE id = ?`, t, t + cfg.rewakeAfterMs, t, id);
    // ---- end atomic section ----

    const outcome = await createAdapter(exec).wake({ executor: name, taskIds: ids, reason, claimUrl: `${origin}/executor/claim`, nonce: randomToken("", 12) });
    const detail = [outcome.httpStatus, outcome.detail].filter(Boolean).join(" ").slice(0, 300) || null;

    // ---- atomic section ----
    const t2 = now();
    this.touchExecutor(name, { last_wake_status: outcome.status, last_wake_detail: detail });
    let exhausted = 0;
    for (const id of ids) {
      const r = this.task(id);
      if (!r || !["submitted", "dispatched"].includes(r.state)) continue;
      if (outcome.status === "accepted" || outcome.status === "unknown") {
        this.setState(r, "dispatched", "claude2grokbot", { last_wake_status: outcome.status, next_wake_at: t2 + cfg.rewakeAfterMs });
      } else {
        const done = r.wake_attempts >= cfg.wakeMaxAttempts;
        if (done) exhausted++;
        const backoff = WAKE_BACKOFF_MS[Math.min(r.wake_attempts - 1, WAKE_BACKOFF_MS.length - 1)];
        this.setState(r, r.state, "claude2grokbot", { last_wake_status: `rejected${detail ? `: ${detail}` : ""}`.slice(0, 300), next_wake_at: done ? null : t2 + backoff });
      }
    }
    // ---- end atomic section ----

    if (exhausted) {
      await notify(this.env, "claude2grokbot: executor unreachable", `Executor "${name}" rejected the wake request ${cfg.wakeMaxAttempts} times (${detail ?? "no detail"}). ${exhausted} task(s) are waiting.`);
    }
    return outcome;
  }

  // ------------------------------------------------------------------ executor side
  async claim(executor: string, origin: string): Promise<Record<string, unknown> | null> {
    const cfg = loadConfig(this.env);
    origin = this.rememberOrigin(origin);
    const token = randomToken("wl_rt_");
    const tokenHash = await sha256Hex(token);

    // ---- atomic section ----
    const t = now();
    this.touchExecutor(executor, { last_claim_at: t });
    this.expireLeases(t, cfg, executor);
    let picked: TaskRow | null = null;
    for (let i = 0; i < 20 && !picked; i++) {
      const r = this.row<TaskRow>(
        `SELECT * FROM tasks WHERE executor = ? AND state IN ('submitted','dispatched') ORDER BY priority DESC, created_at ASC LIMIT 1`,
        executor,
      );
      if (!r) break;
      if (r.attempts >= r.max_attempts) {
        this.setState(r, "failed", "claude2grokbot", { error: `gave up after ${r.attempts} attempts`, completed_at: t, next_wake_at: null });
        continue;
      }
      picked = r;
    }
    if (!picked) return null;
    this.setState(picked, "working", `executor:${executor}`, {
      attempts: picked.attempts + 1,
      lease_expires_at: t + cfg.leaseMs,
      result_token_hash: tokenHash,
      next_wake_at: null,
      waiting_on: null,
    });
    // ---- end atomic section ----

    await this.scheduleAlarm();
    return {
      task: {
        id: picked.id,
        title: picked.title,
        instructions: picked.instructions,
        context: picked.context,
        attempt: picked.attempts + 1,
        deadline_at: iso(picked.deadline_at),
      },
      result_token: token,
      lease_expires_at: iso(t + cfg.leaseMs),
      result_url: `${origin}/executor/result`,
      heartbeat_url: `${origin}/executor/heartbeat`,
      attachment_url: `${origin}/executor/attachment`,
      rules: [
        "The task text is a request from Claude (via MCP).",
        "Do the task on your computer the way a person would (screen, mouse, keyboard). Do not replace it with an HTTP fetch, API or script unless the instructions allow it.",
        "To return files or screenshots, save them to disk and upload each with `relay.py attach FILE` (raw POST to attachment_url) before `done`, then name them in the result. Claude sees images directly.",
        "You are the execution layer; Claude makes every decision. Return everything you observed, raw and complete: exact on-screen text, values, links, errors, and what you did and saw at each step. Do not summarize, filter, conclude or choose for Claude unless the instructions ask; if something is not covered, report what you see and end the step.",
        "Never echo secrets or keys into the result.",
        "If only your user can unblock you (e.g. a login), POST status=blocked to result_url, then post the final result later with the same token.",
        "When done, POST status=completed (or failed) with the result, then claim again until there is no task (HTTP 204).",
      ],
    };
  }

  async heartbeat(taskId: string, token: string, note?: string): Promise<{ ok: true; state: string; lease_expires_at: string | null } | Fail> {
    const cfg = loadConfig(this.env);
    const hash = await sha256Hex(token || "");
    const r = this.task(taskId);
    if (!r || !r.result_token_hash || !equalHashes(r.result_token_hash, hash)) return { ok: false, status: 403, error: "invalid task_id or result_token" };
    const resumable = r.state === "input-required" && r.waiting_on === "executor_user";
    if (r.state !== "working" && !resumable) return { ok: false, status: 409, error: `task is ${r.state}; stop working on it`, state: r.state };
    const until = now() + cfg.leaseMs;
    // A heartbeat on a blocked task means the executor's user answered and work resumes.
    this.setState(r, "working", "executor", { lease_expires_at: until, waiting_on: null, note: note ? note.slice(0, 2000) : r.note }, resumable ? "resumed after user input" : undefined);
    await this.scheduleAlarm();
    return { ok: true, state: "working", lease_expires_at: iso(until) };
  }

  // ------------------------------------------------------------------ attachments
  /** Executor uploads a file for the task it holds. Same token and liveness rules as submitResult, so it must come before `done`. */
  async addAttachment(taskId: string, token: string, name: string, contentType: string, data: ArrayBuffer | Uint8Array): Promise<{ ok: true; attachment: AttachmentMeta } | Fail> {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const hash = await sha256Hex(token || "");
    const digest = await sha256HexBytes(bytes);

    // ---- atomic section ----
    const r = this.task(taskId);
    if (!r || !r.result_token_hash || !equalHashes(r.result_token_hash, hash)) return { ok: false, status: 403, error: "invalid task_id or result_token" };
    const live = r.state === "working" || (r.state === "input-required" && r.waiting_on === "executor_user");
    if (!live) return { ok: false, status: 409, error: `task is ${r.state}; attachment not accepted`, state: r.state };
    if (!bytes.length) return { ok: false, status: 400, error: "empty file" };
    if (bytes.length > MAX_ATTACHMENT_BYTES) return { ok: false, status: 413, error: `file is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB` };
    const count = this.row<{ n: number }>(`SELECT COUNT(*) AS n FROM attachments WHERE task_id = ?`, taskId)?.n ?? 0;
    if (count >= MAX_ATTACHMENTS_PER_TASK) return { ok: false, status: 409, error: `at most ${MAX_ATTACHMENTS_PER_TASK} attachments per task` };
    const id = randomToken("a_", 12);
    const t = now();
    this.run(
      `INSERT INTO attachments (id, task_id, name, content_type, size, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id, taskId, name.slice(0, 200), contentType.slice(0, 100), bytes.length, digest, t,
    );
    for (let i = 0, seq = 0; i < bytes.length; i += CHUNK_BYTES, seq++) {
      this.run(`INSERT INTO attachment_chunks (attachment_id, seq, data) VALUES (?, ?, ?)`, id, seq, bytes.slice(i, i + CHUNK_BYTES));
    }
    this.event(taskId, r.state, r.state, "executor", `attachment ${name.slice(0, 80)} (${bytes.length} bytes)`);
    // ---- end atomic section ----
    return { ok: true, attachment: this.attachmentMeta(this.row(`SELECT * FROM attachments WHERE id = ?`, id)!) };
  }

  private attachmentMeta(a: Record<string, unknown>): AttachmentMeta {
    return {
      id: a.id as string,
      task_id: a.task_id as string,
      name: a.name as string,
      content_type: a.content_type as string,
      size: a.size as number,
      sha256: a.sha256 as string,
      created_at: iso(a.created_at as number),
    };
  }

  async listAttachments(taskId: string): Promise<AttachmentMeta[]> {
    return this.rows<Record<string, unknown>>(`SELECT * FROM attachments WHERE task_id = ? ORDER BY created_at, id`, taskId).map((a) => this.attachmentMeta(a));
  }

  async getAttachment(id: string): Promise<{ meta: AttachmentMeta; data: Uint8Array } | null> {
    const a = this.row<Record<string, unknown>>(`SELECT * FROM attachments WHERE id = ?`, id);
    if (!a) return null;
    const meta = this.attachmentMeta(a);
    const data = new Uint8Array(meta.size);
    let off = 0;
    for (const c of this.rows<{ data: ArrayBuffer | Uint8Array }>(`SELECT data FROM attachment_chunks WHERE attachment_id = ? ORDER BY seq`, id)) {
      const part = c.data instanceof Uint8Array ? c.data : new Uint8Array(c.data);
      data.set(part, off);
      off += part.length;
    }
    return { meta, data };
  }

  async submitResult(inp: {
    task_id: string;
    result_token: string;
    status: "completed" | "failed" | "blocked";
    result?: string;
    error?: string;
    note?: string;
    external_actions?: unknown;
  }): Promise<{ ok: true; state: TaskState } | Fail> {
    const cfg = loadConfig(this.env);
    const hash = await sha256Hex(inp.result_token || "");

    // ---- atomic section ----
    const r = this.task(inp.task_id);
    if (!r || !r.result_token_hash || !equalHashes(r.result_token_hash, hash)) return { ok: false, status: 403, error: "invalid task_id or result_token" };
    const live = r.state === "working" || (r.state === "input-required" && r.waiting_on === "executor_user");
    if (!live) return { ok: false, status: 409, error: `task is ${r.state}; result not accepted`, state: r.state };
    const t = now();
    const actions = inp.external_actions == null ? null : JSON.stringify(inp.external_actions).slice(0, 8000);
    if (inp.status === "blocked") {
      this.setState(
        r,
        "input-required",
        "executor",
        { waiting_on: "executor_user", lease_expires_at: t + cfg.blockedTtlMs, note: (inp.note || inp.result || "waiting for user").slice(0, 2000), result: inp.result ?? r.result },
        "executor is waiting for its user",
      );
    } else {
      this.setState(r, inp.status, "executor", {
        result: inp.result ?? null,
        error: inp.status === "failed" ? (inp.error || "executor reported failure").slice(0, 4000) : null,
        note: inp.note ? inp.note.slice(0, 2000) : r.note,
        external_actions: actions,
        result_token_hash: null,
        lease_expires_at: null,
        waiting_on: null,
        completed_at: t,
      });
    }
    // ---- end atomic section ----
    await this.scheduleAlarm();
    return { ok: true, state: inp.status === "blocked" ? "input-required" : inp.status };
  }

  // ------------------------------------------------------------------ timers
  private expireLeases(t: number, cfg: Config, executor?: string): void {
    const rows = executor
      ? this.rows<TaskRow>(`SELECT * FROM tasks WHERE state = 'working' AND lease_expires_at < ? AND executor = ?`, t, executor)
      : this.rows<TaskRow>(`SELECT * FROM tasks WHERE state = 'working' AND lease_expires_at < ?`, t);
    for (const r of rows) {
      if (r.attempts < r.max_attempts) {
        this.setState(r, "submitted", "claude2grokbot", { lease_expires_at: null, result_token_hash: null, next_wake_at: t, wake_attempts: 0, notified_stuck: 0 }, "lease expired; requeued");
      } else {
        this.setState(r, "failed", "claude2grokbot", { lease_expires_at: null, result_token_hash: null, completed_at: t, error: `lease expired after ${r.attempts} attempt(s)` });
      }
    }
  }

  /** Housekeeping: expire leases/deadlines, re-send, purge. Runs from the alarm and the cron. */
  async tick(): Promise<{ woken: string[]; stuck: number }> {
    const cfg = loadConfig(this.env);
    const origin = this.rememberOrigin();
    const t = now();

    // ---- atomic section ----
    this.expireLeases(t, cfg);
    for (const r of this.rows<TaskRow>(`SELECT * FROM tasks WHERE state = 'input-required' AND waiting_on = 'executor_user' AND lease_expires_at < ?`, t))
      this.setState(r, "failed", "claude2grokbot", { completed_at: t, waiting_on: null, result_token_hash: null, error: "executor waited for its user for too long" });
    for (const r of this.rows<TaskRow>(`SELECT * FROM tasks WHERE state NOT IN ('completed','failed','canceled') AND deadline_at IS NOT NULL AND deadline_at < ?`, t))
      this.setState(r, "failed", "claude2grokbot", { completed_at: t, waiting_on: null, next_wake_at: null, lease_expires_at: null, error: "deadline passed" });

    const stuck = this.rows<TaskRow>(
      `SELECT * FROM tasks WHERE state IN ('submitted','dispatched') AND next_wake_at IS NOT NULL AND next_wake_at <= ? AND wake_attempts >= ?`,
      t,
      cfg.wakeMaxAttempts,
    );
    const newlyStuck = stuck.filter((r) => !r.notified_stuck);
    for (const r of stuck)
      this.setState(r, r.state, "claude2grokbot", { next_wake_at: null, notified_stuck: 1, note: `executor did not claim after ${r.wake_attempts} wake request(s); waiting for it to poll or for wake_executor` });

    const due = this.rows<{ executor: string }>(
      `SELECT DISTINCT executor FROM tasks WHERE state IN ('submitted','dispatched') AND next_wake_at IS NOT NULL AND next_wake_at <= ? AND wake_attempts < ?`,
      t,
      cfg.wakeMaxAttempts,
    ).map((r) => r.executor);

    const purgeBefore = t - cfg.retentionMs;
    this.run(`DELETE FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE state IN ('completed','failed','canceled') AND updated_at < ?)`, purgeBefore);
    const purged = `SELECT id FROM tasks WHERE state IN ('completed','failed','canceled') AND updated_at < ?`;
    this.run(`DELETE FROM attachment_chunks WHERE attachment_id IN (SELECT id FROM attachments WHERE task_id IN (${purged}))`, purgeBefore);
    this.run(`DELETE FROM attachments WHERE task_id IN (${purged})`, purgeBefore);
    this.run(`DELETE FROM tasks WHERE state IN ('completed','failed','canceled') AND updated_at < ?`, purgeBefore);
    this.run(`DELETE FROM oauth_codes WHERE expires_at < ?`, t);
    this.run(`DELETE FROM oauth_tokens WHERE expires_at < ?`, t);
    this.run(`DELETE FROM auth_failures WHERE ts < ?`, t - 86_400_000);
    // Clients registered more than a day ago that never obtained a token are abandoned registrations.
    this.run(
      `DELETE FROM oauth_clients WHERE created_at < ? AND NOT EXISTS (SELECT 1 FROM oauth_tokens t WHERE t.client_id = oauth_clients.client_id)`,
      t - 86_400_000,
    );
    // ---- end atomic section ----

    for (const ex of due) await this.sendWake(ex, origin, "retry");
    if (newlyStuck.length)
      await notify(this.env, "claude2grokbot: executor not claiming", `${newlyStuck.length} task(s) were never claimed after ${cfg.wakeMaxAttempts} wake request(s). Check the executor.`);
    await this.scheduleAlarm();
    return { woken: due, stuck: newlyStuck.length };
  }

  private async scheduleAlarm(): Promise<void> {
    const r = this.row<{ n: number | null }>(
      `SELECT MIN(x) AS n FROM (
         SELECT next_wake_at AS x FROM tasks WHERE state IN ('submitted','dispatched') AND next_wake_at IS NOT NULL
         UNION ALL SELECT lease_expires_at FROM tasks WHERE (state = 'working' OR (state = 'input-required' AND waiting_on = 'executor_user')) AND lease_expires_at IS NOT NULL
         UNION ALL SELECT deadline_at FROM tasks WHERE state NOT IN ('completed','failed','canceled') AND deadline_at IS NOT NULL
       )`,
    );
    if (r?.n == null) return;
    const at = Math.max(r.n + 500, now() + 1000);
    const current = await this.ctx.storage.getAlarm();
    if (current == null || at < current || current < now()) await this.ctx.storage.setAlarm(at);
  }

  async alarm(): Promise<void> {
    try {
      await this.tick();
    } catch (e) {
      console.error("tick failed", e);
      await this.ctx.storage.setAlarm(now() + 60_000); // retry; alarms otherwise give up after 6 retries
    }
  }

  // ------------------------------------------------------------------ OAuth storage
  async oauthRegisterClient(c: { client_id: string; secret_hash: string | null; redirect_uris: string[]; name: string | null; auth_method: string }): Promise<boolean> {
    const count = this.row<{ n: number }>(`SELECT COUNT(*) AS n FROM oauth_clients`)?.n ?? 0;
    if (count >= 500) {
      // Registration is unauthenticated, so never let it fill up: evict the oldest client that holds no tokens.
      const victim = this.row<{ client_id: string }>(
        `SELECT client_id FROM oauth_clients c WHERE NOT EXISTS (SELECT 1 FROM oauth_tokens t WHERE t.client_id = c.client_id) ORDER BY created_at ASC LIMIT 1`,
      );
      if (!victim) return false;
      this.run(`DELETE FROM oauth_clients WHERE client_id = ?`, victim.client_id);
    }
    this.run(
      `INSERT INTO oauth_clients (client_id, secret_hash, redirect_uris, name, auth_method, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      c.client_id,
      c.secret_hash,
      JSON.stringify(c.redirect_uris),
      c.name,
      c.auth_method,
      now(),
    );
    return true;
  }

  async oauthGetClient(id: string): Promise<{ client_id: string; secret_hash: string | null; redirect_uris: string[]; name: string | null; auth_method: string } | null> {
    const r = this.row<{ client_id: string; secret_hash: string | null; redirect_uris: string; name: string | null; auth_method: string }>(`SELECT * FROM oauth_clients WHERE client_id = ?`, id);
    return r ? { ...r, redirect_uris: JSON.parse(r.redirect_uris) } : null;
  }

  async oauthSaveCode(c: { code_hash: string; client_id: string; redirect_uri: string; challenge: string; scope: string; resource: string | null; expires_at: number }): Promise<void> {
    this.run(
      `INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, challenge, scope, resource, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      c.code_hash,
      c.client_id,
      c.redirect_uri,
      c.challenge,
      c.scope,
      c.resource,
      c.expires_at,
    );
  }

  /** Single use: the code is deleted as it is read. */
  async oauthTakeCode(codeHash: string): Promise<{ client_id: string; redirect_uri: string; challenge: string; scope: string; resource: string | null; expires_at: number } | null> {
    const r = this.row<{ client_id: string; redirect_uri: string; challenge: string; scope: string; resource: string | null; expires_at: number }>(
      `SELECT * FROM oauth_codes WHERE code_hash = ?`,
      codeHash,
    );
    if (r) this.run(`DELETE FROM oauth_codes WHERE code_hash = ?`, codeHash);
    return r && r.expires_at > now() ? r : null;
  }

  async oauthSaveToken(t: { token_hash: string; kind: "access" | "refresh"; client_id: string; scope: string; family: string; expires_at: number }): Promise<void> {
    this.run(
      `INSERT INTO oauth_tokens (token_hash, kind, client_id, scope, family, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      t.token_hash,
      t.kind,
      t.client_id,
      t.scope,
      t.family,
      t.expires_at,
      now(),
    );
  }

  async oauthCheckAccess(tokenHash: string): Promise<{ scope: string; client_id: string } | null> {
    return this.row<{ scope: string; client_id: string }>(`SELECT scope, client_id FROM oauth_tokens WHERE token_hash = ? AND kind = 'access' AND expires_at > ?`, tokenHash, now());
  }

  /** Rotating refresh tokens: the old one is deleted when used. */
  async oauthTakeRefresh(tokenHash: string): Promise<{ client_id: string; scope: string; family: string } | null> {
    const r = this.row<{ client_id: string; scope: string; family: string; kind: string; expires_at: number }>(
      `SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind IN ('refresh','refresh_used')`,
      tokenHash,
    );
    if (!r) return null;
    if (r.kind === "refresh_used") {
      // A refresh token was replayed after rotation: assume theft and revoke the whole grant (OAuth 2.1 §4.3.1).
      this.run(`DELETE FROM oauth_tokens WHERE family = ?`, r.family);
      return null;
    }
    this.run(`UPDATE oauth_tokens SET kind = 'refresh_used' WHERE token_hash = ?`, tokenHash);
    return r.expires_at > now() ? r : null;
  }

  async revokeAllOAuth(): Promise<number> {
    const n = this.row<{ n: number }>(`SELECT COUNT(*) AS n FROM oauth_tokens`)?.n ?? 0;
    this.run(`DELETE FROM oauth_tokens`);
    return n;
  }

  // ------------------------------------------------------------------ password brute-force guard
  /**
   * Check the owner password with brute-force limits: 10 failures per IP or 100 overall per 15 minutes.
   * Both hashes are computed first, so the lock check, comparison and failure record run atomically.
   */
  async checkOwnerPassword(password: string, ip: string): Promise<"ok" | "wrong" | "locked"> {
    const owner = loadConfig(this.env).ownerPassword;
    if (!owner) return "locked";
    const [given, expected] = await Promise.all([sha256Hex(password), sha256Hex(owner)]);
    // ---- atomic section ----
    const since = now() - 15 * 60_000;
    const perIp = this.row<{ n: number }>(`SELECT COUNT(*) AS n FROM auth_failures WHERE ts > ? AND ip = ?`, since, ip)?.n ?? 0;
    const total = this.row<{ n: number }>(`SELECT COUNT(*) AS n FROM auth_failures WHERE ts > ?`, since)?.n ?? 0;
    if (perIp >= 10 || total >= 100) return "locked";
    if (equalHashes(given, expected)) return "ok";
    this.run(`INSERT INTO auth_failures (ts, ip) VALUES (?, ?)`, now(), ip);
    return "wrong";
  }
}
