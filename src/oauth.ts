/**
 * A small OAuth 2.1 authorization server for a single owner, as required by MCP clients such as claude.ai.
 *  - Authorization code + PKCE (S256 only), rotating refresh tokens
 *  - Dynamic Client Registration (RFC 7591) and Client ID Metadata Documents (https client_id URLs)
 *  - Metadata: RFC 8414 (authorization server) and RFC 9728 (protected resource)
 * The consent screen asks for OWNER_PASSWORD. No third-party login, no stored passwords.
 * If OWNER_PASSWORD is not set, OAuth is disabled and only static bearer tokens work.
 */
import { hubStub, loadConfig, type Env } from "./config";
import { page } from "./pages";
import { clientIp, CORS_HEADERS, equalHashes, escapeHtml, json, randomToken, sha256B64url, sha256Hex } from "./util";

export const SCOPES = ["tasks", "tasks:read"];
const CODE_TTL_MS = 10 * 60_000;

export function protectedResourceMetadataUrl(origin: string): string {
  return `${origin}/.well-known/oauth-protected-resource`;
}

function oauthJson(data: unknown, status = 200): Response {
  return json(data, status, { ...CORS_HEADERS, Pragma: "no-cache" });
}
function oauthError(error: string, description: string, status = 400): Response {
  return oauthJson({ error, error_description: description }, status);
}

function asMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
    scopes_supported: SCOPES,
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
}

function prMetadata(origin: string) {
  return {
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    scopes_supported: SCOPES,
    bearer_methods_supported: ["header"],
    resource_name: "Claude2GrokBot",
  };
}

/** Allowed redirect URIs: https, http on loopback (CLI clients), or private-use app schemes. */
function validRedirect(u: string): boolean {
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol) && !["javascript:", "data:", "vbscript:", "file:", "blob:", "about:"].includes(url.protocol);
}

interface ClientInfo {
  client_id: string;
  name: string | null;
  redirect_uris: string[];
  auth_method: string;
  secret_hash: string | null;
}

async function lookupClient(env: Env, clientId: string): Promise<ClientInfo | null> {
  if (!clientId) return null;
  if (clientId.startsWith("https://")) {
    // Client ID Metadata Document: the client_id is a URL serving the client's metadata.
    try {
      const res = await fetch(clientId, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(5000), redirect: "manual" });
      if (res.status !== 200) return null; // redirects are not followed for client metadata
      const text = await res.text();
      if (text.length > 65536) return null;
      const doc = JSON.parse(text) as { client_id?: string; client_name?: string; redirect_uris?: unknown };
      if (doc.client_id !== clientId || !Array.isArray(doc.redirect_uris)) return null;
      const uris = doc.redirect_uris.filter((u): u is string => typeof u === "string" && validRedirect(u));
      return { client_id: clientId, name: doc.client_name ?? new URL(clientId).hostname, redirect_uris: uris, auth_method: "none", secret_hash: null };
    } catch {
      return null;
    }
  }
  const c = await hubStub(env).oauthGetClient(clientId);
  return c ? { ...c } : null;
}

function grantedScope(requested: string | null): string {
  const asked = (requested || "").split(/\s+/).filter(Boolean);
  if (asked.length && asked.every((s) => s === "tasks:read")) return "tasks:read";
  return "tasks";
}

interface AuthzParams {
  response_type: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  state: string;
  scope: string;
  resource: string;
}

function readParams(src: URLSearchParams | FormData): AuthzParams {
  const g = (k: string) => String(src.get(k) ?? "");
  return {
    response_type: g("response_type"),
    client_id: g("client_id"),
    redirect_uri: g("redirect_uri"),
    code_challenge: g("code_challenge"),
    code_challenge_method: g("code_challenge_method"),
    state: g("state"),
    scope: g("scope"),
    resource: g("resource"),
  };
}

function redirectWith(redirectUri: string, params: Record<string, string>): Response {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
  return new Response(null, { status: 302, headers: { Location: url.toString(), "Cache-Control": "no-store" } });
}

function consentPage(p: AuthzParams, client: ClientInfo, origin: string, error?: string): Response {
  const hidden = Object.entries(p)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`)
    .join("");
  const host = (() => {
    try {
      return new URL(p.redirect_uri).host || p.redirect_uri;
    } catch {
      return p.redirect_uri;
    }
  })();
  const scope = grantedScope(p.scope);
  return page(
    "Authorize access",
    `<div class="card">
      <h1>Connect ${escapeHtml(client.name || "an app")} to Claude2GrokBot</h1>
      <p class="muted">${escapeHtml(origin)}</p>
      <dl><dt>App</dt><dd>${escapeHtml(client.name || client.client_id)}</dd>
      <dt>Returns to</dt><dd>${escapeHtml(host)}</dd>
      <dt>Access</dt><dd>${scope === "tasks" ? "Submit, read and cancel tasks; wake executors" : "Read task status and results only"}</dd></dl>
      <p>Only approve if you started this connection yourself (for example from claude.ai or Claude Code).</p>
      ${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
      <form method="post" action="/authorize">${hidden}
        <label for="pw">Owner password</label>
        <input id="pw" type="password" name="password" autocomplete="current-password" required autofocus>
        <div class="row"><button class="primary" name="decision" value="allow">Allow</button><button name="decision" value="deny" formnovalidate>Deny</button></div>
      </form></div>`,
  );
}

async function validateAuthz(env: Env, p: AuthzParams): Promise<{ client: ClientInfo } | { error: string }> {
  if (p.response_type !== "code") return { error: "Unsupported response_type (only 'code')." };
  if (!p.code_challenge || p.code_challenge_method !== "S256") return { error: "PKCE with code_challenge_method=S256 is required." };
  const client = await lookupClient(env, p.client_id);
  if (!client) return { error: "Unknown client. Re-add the connector so it can register again." };
  if (!client.redirect_uris.includes(p.redirect_uri)) return { error: "redirect_uri is not registered for this client." };
  return { client };
}

async function authorize(req: Request, env: Env, origin: string): Promise<Response> {
  if (req.method === "GET") {
    const p = readParams(new URL(req.url).searchParams);
    const v = await validateAuthz(env, p);
    if ("error" in v) return page("Authorization error", `<div class="card"><h1>Can't authorize</h1><p>${escapeHtml(v.error)}</p></div>`, 400);
    return consentPage(p, v.client, origin);
  }
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  const form = await req.formData();
  const p = readParams(form);
  const v = await validateAuthz(env, p);
  if ("error" in v) return page("Authorization error", `<div class="card"><h1>Can't authorize</h1><p>${escapeHtml(v.error)}</p></div>`, 400);
  if (form.get("decision") !== "allow") return redirectWith(p.redirect_uri, { error: "access_denied", state: p.state, iss: origin });

  const hub = hubStub(env);
  const check = await hub.checkOwnerPassword(String(form.get("password") ?? ""), clientIp(req));
  if (check === "locked") return consentPage(p, v.client, origin, "Too many wrong passwords. Wait 15 minutes and try again.");
  if (check === "wrong") return consentPage(p, v.client, origin, "Wrong password.");

  const code = randomToken("wl_ac_");
  await hub.oauthSaveCode({
    code_hash: await sha256Hex(code),
    client_id: p.client_id,
    redirect_uri: p.redirect_uri,
    challenge: p.code_challenge,
    scope: grantedScope(p.scope),
    resource: p.resource || null,
    expires_at: Date.now() + CODE_TTL_MS,
  });
  return redirectWith(p.redirect_uri, { code, state: p.state, iss: origin });
}

async function register(req: Request, env: Env): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    const text = await req.text();
    if (text.length > 16384) return oauthError("invalid_client_metadata", "Registration request too large");
    body = JSON.parse(text);
  } catch {
    return oauthError("invalid_client_metadata", "Body must be JSON");
  }
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === "string") : [];
  if (!uris.length || uris.length > 10 || !uris.every(validRedirect)) return oauthError("invalid_redirect_uri", "Provide 1-10 redirect_uris using https, http://localhost or an app scheme");
  const method = typeof body.token_endpoint_auth_method === "string" ? body.token_endpoint_auth_method : "client_secret_basic";
  if (!["none", "client_secret_basic", "client_secret_post"].includes(method)) return oauthError("invalid_client_metadata", "Unsupported token_endpoint_auth_method");
  const name = typeof body.client_name === "string" ? body.client_name.slice(0, 100) : null;

  const clientId = randomToken("wl_client_", 16);
  const secret = method === "none" ? null : randomToken("wl_cs_");
  const ok = await hubStub(env).oauthRegisterClient({ client_id: clientId, secret_hash: secret ? await sha256Hex(secret) : null, redirect_uris: uris, name, auth_method: method });
  if (!ok) return oauthError("invalid_client_metadata", "Client registration limit reached", 400);
  return oauthJson(
    {
      client_id: clientId,
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: name,
      redirect_uris: uris,
      token_endpoint_auth_method: method,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: SCOPES.join(" "),
    },
    201,
  );
}

async function authenticateClient(req: Request, form: URLSearchParams, env: Env): Promise<ClientInfo | Response> {
  let id = form.get("client_id") || "";
  let secret = form.get("client_secret") || "";
  const basic = /^Basic\s+(.+)$/i.exec(req.headers.get("authorization") || "");
  if (basic) {
    try {
      const [u, s] = atob(basic[1]).split(":");
      id = decodeURIComponent(u);
      secret = decodeURIComponent(s ?? "");
    } catch {
      return oauthError("invalid_client", "Malformed Basic credentials", 401);
    }
  }
  const client = await lookupClient(env, id);
  if (!client) return oauthError("invalid_client", "Unknown client", 401);
  if (client.auth_method !== "none") {
    if (!secret || !client.secret_hash || !equalHashes(await sha256Hex(secret), client.secret_hash)) return oauthError("invalid_client", "Client authentication failed", 401);
  }
  return client;
}

async function issueTokens(env: Env, clientId: string, scope: string, family: string): Promise<Response> {
  const cfg = loadConfig(env);
  const hub = hubStub(env);
  const access = randomToken("wl_at_");
  const refresh = randomToken("wl_rf_");
  const t = Date.now();
  await hub.oauthSaveToken({ token_hash: await sha256Hex(access), kind: "access", client_id: clientId, scope, family, expires_at: t + cfg.accessTokenTtlS * 1000 });
  await hub.oauthSaveToken({ token_hash: await sha256Hex(refresh), kind: "refresh", client_id: clientId, scope, family, expires_at: t + cfg.refreshTokenTtlMs });
  return oauthJson({ access_token: access, token_type: "Bearer", expires_in: cfg.accessTokenTtlS, refresh_token: refresh, scope });
}

async function token(req: Request, env: Env): Promise<Response> {
  const ct = req.headers.get("content-type") || "";
  let form: URLSearchParams;
  if (ct.includes("application/json")) {
    const b = (await req.json().catch(() => ({}))) as Record<string, string>;
    form = new URLSearchParams(Object.entries(b).map(([k, v]) => [k, String(v)]));
  } else {
    form = new URLSearchParams(await req.text());
  }
  const client = await authenticateClient(req, form, env);
  if (client instanceof Response) return client;
  const hub = hubStub(env);
  const grant = form.get("grant_type");

  if (grant === "authorization_code") {
    const code = form.get("code") || "";
    const verifier = form.get("code_verifier") || "";
    const rec = await hub.oauthTakeCode(await sha256Hex(code));
    if (!rec || rec.client_id !== client.client_id) return oauthError("invalid_grant", "Invalid or expired code");
    if (rec.redirect_uri !== (form.get("redirect_uri") || "")) return oauthError("invalid_grant", "redirect_uri mismatch");
    if (!verifier || (await sha256B64url(verifier)) !== rec.challenge) return oauthError("invalid_grant", "PKCE verification failed");
    return issueTokens(env, client.client_id, rec.scope, randomToken("", 12));
  }
  if (grant === "refresh_token") {
    const rec = await hub.oauthTakeRefresh(await sha256Hex(form.get("refresh_token") || ""));
    if (!rec || rec.client_id !== client.client_id) return oauthError("invalid_grant", "Invalid or expired refresh token");
    const wanted = form.get("scope");
    const scope = wanted && grantedScope(wanted) === "tasks:read" ? "tasks:read" : rec.scope;
    return issueTokens(env, client.client_id, scope, rec.family);
  }
  return oauthError("unsupported_grant_type", "Use authorization_code or refresh_token");
}

/** Returns a Response for OAuth routes, or null if the path is not an OAuth route. */
export async function handleOAuth(req: Request, env: Env, origin: string): Promise<Response | null> {
  const path = new URL(req.url).pathname;
  const isOAuthPath =
    path.startsWith("/.well-known/oauth-protected-resource") ||
    path.startsWith("/.well-known/oauth-authorization-server") ||
    ["/authorize", "/token", "/register"].includes(path);
  if (!isOAuthPath) return null;

  if (!loadConfig(env).ownerPassword) return oauthError("not_found", "OAuth is disabled on this server (OWNER_PASSWORD is not set). Use a static bearer token.", 404);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

  if (path.startsWith("/.well-known/oauth-protected-resource")) return oauthJson(prMetadata(origin));
  if (path.startsWith("/.well-known/oauth-authorization-server")) return oauthJson(asMetadata(origin));
  if (path === "/authorize") return authorize(req, env, origin);
  if (path === "/register" && req.method === "POST") return register(req, env);
  if (path === "/token" && req.method === "POST") return token(req, env);
  return new Response("Method Not Allowed", { status: 405 });
}

export async function verifyOAuthAccess(env: Env, token: string): Promise<{ scope: "full" | "read"; subject: string } | null> {
  if (!token.startsWith("wl_at_")) return null;
  const rec = await hubStub(env).oauthCheckAccess(await sha256Hex(token));
  if (!rec) return null;
  return { scope: rec.scope === "tasks:read" ? "read" : "full", subject: `oauth:${rec.client_id}` };
}
