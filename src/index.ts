/**
 * Claude2GrokBot — let Claude (via MCP) wake an executor agent that is not running,
 * hand it tasks, and collect the results. Cloudflare Worker + one SQLite Durable Object.
 */
import { hubStub, loadConfig, type Env } from "./config";
import { handleExecutor } from "./executor-api";
import { handleFile } from "./files";
import { handleKit } from "./kit";
import { handleMcp, type McpAuth } from "./mcp";
import { handleOAuth, protectedResourceMetadataUrl, verifyOAuthAccess } from "./oauth";
import { page } from "./pages";
import { bearer, CORS_HEADERS, escapeHtml, json, safeEqual, VERSION } from "./util";

export { TaskHub } from "./hub";

function publicOrigin(env: Env, url: URL): string {
  return (env.PUBLIC_URL || url.origin).replace(/\/+$/, "");
}

function withCors(res: Response): Response {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(CORS_HEADERS)) r.headers.set(k, v);
  return r;
}

async function authenticateMcp(req: Request, env: Env, origin: string): Promise<McpAuth | Response> {
  const cfg = loadConfig(env);
  const token = bearer(req);
  if (token) {
    for (const t of cfg.mcpTokens) if (await safeEqual(token, t)) return { scope: "full", subject: "static-token" };
    for (const t of cfg.mcpReadonlyTokens) if (await safeEqual(token, t)) return { scope: "read", subject: "static-readonly-token" };
    if (cfg.ownerPassword) {
      const o = await verifyOAuthAccess(env, token);
      if (o) return o;
    }
  }
  const challenge = cfg.ownerPassword
    ? `Bearer resource_metadata="${protectedResourceMetadataUrl(origin)}", scope="tasks"${token ? `, error="invalid_token"` : ""}`
    : `Bearer realm="claude2grokbot"${token ? `, error="invalid_token"` : ""}`;
  return json({ error: token ? "invalid_token" : "unauthorized", message: "Provide a valid bearer token or sign in with OAuth." }, 401, { "WWW-Authenticate": challenge });
}

function homePage(env: Env, origin: string): Response {
  const cfg = loadConfig(env);
  return page(
    "Claude2GrokBot",
    `<div class="card"><h1>Claude2GrokBot is running</h1>
     <p>An MCP task relay that lets Claude wake an executor agent and collect results.</p>
     <dl><dt>MCP endpoint</dt><dd><code>${escapeHtml(origin)}/mcp</code></dd>
     <dt>OAuth</dt><dd>${cfg.ownerPassword ? "enabled" : "disabled (set OWNER_PASSWORD)"}</dd>
     <dt>Static tokens</dt><dd>${cfg.mcpTokens.length} configured</dd>
     <dt>Executors</dt><dd>${Object.values(cfg.executors).map((e) => escapeHtml(`${e.name} (${e.wake.type === "webhook" ? "webhook" : "poll-only"})`)).join(", ")}</dd></dl>
     ${cfg.warnings.length ? `<p class="err">Configuration warnings:</p><pre>${escapeHtml(cfg.warnings.join("\n"))}</pre>` : ""}
     <p class="muted">Health check: <code>/healthz</code></p></div>`,
  );
}

export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const origin = publicOrigin(env, url);
    const path = url.pathname;
    try {
      if (path === "/mcp" || path === "/mcp/") {
        if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
        const auth = await authenticateMcp(req, env, origin);
        if (auth instanceof Response) return withCors(auth);
        return withCors(await handleMcp(req, env, auth, origin));
      }
      if (path.startsWith("/executor/")) return await handleExecutor(req, env, origin);
      if (path.startsWith("/files/")) return await handleFile(req, env);
      if (path.startsWith("/kit/")) return handleKit(req, origin);

      const oauth = await handleOAuth(req, env, origin);
      if (oauth) return oauth;

      if (path === "/healthz") {
        const cfg = loadConfig(env);
        return json({
          ok: true,
          version: VERSION,
          oauth: !!cfg.ownerPassword,
          static_tokens: cfg.mcpTokens.length,
          executor_key: !!cfg.executorKey,
          executors: Object.values(cfg.executors).map((e) => ({ name: e.name, wake: e.wake.type })),
          warnings: cfg.warnings,
        });
      }
      if (path === "/" && req.method === "GET") return homePage(env, origin);
      return json({ error: "not_found" }, 404);
    } catch (e) {
      console.error("unhandled", e);
      return json({ error: "internal_error" }, 500);
    }
  },

  /** Cron fallback (wrangler.jsonc "triggers"): runs housekeeping even if an alarm was missed. */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(hubStub(env).tick().then(() => undefined));
  },
} satisfies ExportedHandler<Env>;
