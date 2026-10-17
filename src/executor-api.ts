/**
 * Endpoints the executor calls with plain HTTPS (curl is enough; no daemon, no inbound port).
 *   POST /executor/claim      Authorization: Bearer <EXECUTOR_KEY>   body {"executor": "default"}  -> 200 task | 204 none
 *   POST /executor/heartbeat  body {"task_id","result_token","note"?}                             -> extends the lease
 *   POST /executor/result     body {"task_id","result_token","status","result"?,"error"?,"note"?,"external_actions"?}
 *   POST /executor/attachment raw file body; headers X-Task-Id, X-Result-Token, X-Filename (URL-encoded), Content-Type
 *   GET  /executor/ping       Authorization: Bearer <EXECUTOR_KEY>                                 -> connectivity check
 */
import { hubStub, loadConfig, type Env } from "./config";
import { MAX_ATTACHMENT_BYTES } from "./hub";
import { bearer, HttpError, json, readBody, safeEqual } from "./util";

const MAX_RESULT_BYTES = 256 * 1024;

/** Returns the executors this key may act for. */
async function executorScope(req: Request, env: Env): Promise<{ any: boolean; names: string[] } | null> {
  const cfg = loadConfig(env);
  const key = bearer(req);
  if (!key) return null;
  if (cfg.executorKey && (await safeEqual(key, cfg.executorKey))) return { any: true, names: [] };
  const names: string[] = [];
  for (const e of Object.values(cfg.executors)) if (e.executorKey && (await safeEqual(key, e.executorKey))) names.push(e.name);
  return names.length ? { any: false, names } : null;
}

async function parse(req: Request, max = 16 * 1024): Promise<Record<string, unknown>> {
  const text = await readBody(req, max);
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text);
    if (v && typeof v === "object" && !Array.isArray(v)) return v;
  } catch {
    /* fallthrough */
  }
  throw new HttpError(400, "bad_json", "Body must be a JSON object");
}

export async function handleExecutor(req: Request, env: Env, origin: string): Promise<Response> {
  const path = new URL(req.url).pathname;
  const cfg = loadConfig(env);
  const hub = hubStub(env);

  try {
    if (path === "/executor/claim" || path === "/executor/ping") {
      const scope = await executorScope(req, env);
      if (!scope) return json({ error: "unauthorized", message: "Missing or wrong executor key" }, 401);
      const body = req.method === "POST" ? await parse(req) : {};
      const requested = typeof body.executor === "string" && body.executor ? body.executor : scope.any ? cfg.defaultExecutor : scope.names[0];
      if (!cfg.executors[requested]) return json({ error: "unknown_executor", message: `Unknown executor "${requested}"` }, 400);
      if (!scope.any && !scope.names.includes(requested)) return json({ error: "forbidden", message: "This key cannot act for that executor" }, 403);

      if (path === "/executor/ping") return json({ ok: true, executor: requested, server_time: new Date().toISOString() });
      if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
      const claimed = await hub.claim(requested, origin);
      if (!claimed) return new Response(null, { status: 204 });
      return json(claimed);
    }

    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

    if (path === "/executor/attachment") {
      const taskId = req.headers.get("x-task-id") ?? "";
      const token = req.headers.get("x-result-token") ?? "";
      let name = req.headers.get("x-filename") ?? "file";
      try {
        name = decodeURIComponent(name);
      } catch {
        /* keep as sent */
      }
      name = name.replace(/[\\/\u0000-\u001f]/g, "_").trim() || "file";
      const type = (req.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim().toLowerCase() || "application/octet-stream";
      if (Number(req.headers.get("content-length") ?? 0) > MAX_ATTACHMENT_BYTES) return json({ error: "too_large", message: `file is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB` }, 413);
      const data = await req.arrayBuffer();
      const res = await hub.addAttachment(taskId, token, name, type, data);
      if (!res.ok) return json({ error: res.error, state: res.state }, res.status);
      return json(res.attachment);
    }

    if (path === "/executor/heartbeat") {
      const b = await parse(req);
      const res = await hub.heartbeat(String(b.task_id ?? ""), String(b.result_token ?? ""), typeof b.note === "string" ? b.note : undefined);
      return res.ok ? json(res) : json({ error: res.error, state: res.state }, res.status);
    }

    if (path === "/executor/result") {
      const b = await parse(req, MAX_RESULT_BYTES + 32 * 1024);
      const status = String(b.status ?? "completed");
      if (!["completed", "failed", "blocked"].includes(status)) return json({ error: "bad_status", message: "status must be completed, failed or blocked" }, 400);
      const asText = (v: unknown) => (v == null ? undefined : typeof v === "string" ? v : JSON.stringify(v, null, 2));
      const result = asText(b.result);
      if (result && new TextEncoder().encode(result).length > MAX_RESULT_BYTES)
        return json({ error: "payload_too_large", message: `result exceeds ${MAX_RESULT_BYTES} bytes; summarize or link to a file` }, 413);
      const res = await hub.submitResult({
        task_id: String(b.task_id ?? ""),
        result_token: String(b.result_token ?? ""),
        status: status as "completed" | "failed" | "blocked",
        result,
        error: asText(b.error),
        note: asText(b.note),
        external_actions: b.external_actions,
      });
      return res.ok ? json({ ...res, next: "Claim again until the server answers 204 (no more tasks)." }) : json({ error: res.error, state: res.state }, res.status);
    }

    return json({ error: "not_found" }, 404);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.code, message: e.message }, e.status);
    throw e;
  }
}
