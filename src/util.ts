// Small, dependency-free helpers built on standard Web APIs (Workers, Bun, Deno, Node 20+).

export const VERSION = "0.1.0";

const enc = new TextEncoder();

export function now(): number {
  return Date.now();
}

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Cryptographically random URL-safe token. 32 bytes = 256 bits. */
export function randomToken(prefix = "", bytes = 32): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return prefix + b64url(a);
}

/** Sortable-ish, unguessable task id: time prefix + 80 random bits. */
export function newTaskId(): string {
  const a = new Uint8Array(10);
  crypto.getRandomValues(a);
  return "t_" + Date.now().toString(36) + "_" + b64url(a);
}

export async function sha256Hex(s: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

export async function sha256HexBytes(b: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", b));
}

/** Standard base64 (for MCP image content). Works in chunks so large buffers don't overflow the call stack. */
export function toBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function sha256B64url(s: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s))));
}

export async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}

/** Constant-time comparison of two equal-length strings (use on hashes). */
export function equalHashes(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Constant-time comparison of two secrets of any length (hash first). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  return equalHashes(ha, hb);
}

/** Best-effort client IP (Cloudflare sets CF-Connecting-IP). Used only for rate limiting. */
export function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
}

export function bearer(req: Request): string | null {
  const h = req.headers.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id",
  "Access-Control-Max-Age": "86400",
};

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

export function escapeHtml(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function iso(ms: number | null | undefined): string | null {
  return ms ? new Date(ms).toISOString() : null;
}

/** Split a secret list like "tok1,tok2" or "tok1 tok2". */
export function splitList(v: string | undefined): string[] {
  return (v || "").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}

export async function readBody(req: Request, maxBytes: number): Promise<string> {
  const text = await req.text();
  if (enc.encode(text).length > maxBytes) throw new HttpError(413, "payload_too_large", `Body exceeds ${maxBytes} bytes`);
  return text;
}

export function byteLength(s: string): number {
  return enc.encode(s).length;
}

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}
