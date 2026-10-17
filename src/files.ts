/**
 * Signed, expiring download links for executor attachments: GET /files/<attachment_id>?exp=<unix>&sig=<hex>
 * Raster images are shown inline; everything else is served as a download, so an uploaded HTML or SVG file can
 * never run as a page on this origin (which also hosts the OAuth consent page).
 */
import { hubStub, loadConfig, type Env } from "./config";
import { equalHashes, hmacHex } from "./util";

const LINK_TTL_S = 24 * 3600;
export const INLINE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

function signingKey(env: Env): string | null {
  const cfg = loadConfig(env);
  return cfg.executorKey ?? cfg.mcpTokens[0] ?? cfg.ownerPassword;
}

export async function signedFileUrl(env: Env, origin: string, id: string): Promise<string | null> {
  const key = signingKey(env);
  if (!key) return null;
  const exp = Math.floor(Date.now() / 1000) + LINK_TTL_S;
  const sig = await hmacHex(key, `file:${id}:${exp}`);
  return `${origin}/files/${encodeURIComponent(id)}?exp=${exp}&sig=${sig}`;
}

export async function handleFile(req: Request, env: Env): Promise<Response> {
  if (req.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
  const url = new URL(req.url);
  const id = url.pathname.slice("/files/".length);
  const exp = Number(url.searchParams.get("exp") ?? 0);
  const sig = url.searchParams.get("sig") ?? "";
  const key = signingKey(env);
  const forbidden = () => new Response("Link not valid or expired", { status: 403 });
  if (!key || !/^a_[A-Za-z0-9_-]{4,40}$/.test(id) || !Number.isFinite(exp) || exp < Date.now() / 1000) return forbidden();
  if (!equalHashes(await hmacHex(key, `file:${id}:${exp}`), sig)) return forbidden();

  const file = await hubStub(env).getAttachment(id);
  if (!file) return new Response("Not found", { status: 404 });
  const inline = INLINE_IMAGE_TYPES.includes(file.meta.content_type);
  const encoded = encodeURIComponent(file.meta.name);
  return new Response(file.data, {
    headers: {
      "Content-Type": inline ? file.meta.content_type : "application/octet-stream",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encoded}`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "private, max-age=3600",
    },
  });
}
