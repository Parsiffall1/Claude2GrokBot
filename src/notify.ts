import type { Env } from "./config";

/**
 * Optional push notification to the owner (executor unreachable or not claiming).
 * NOTIFY_URL is any ntfy-compatible endpoint, e.g. https://ntfy.sh/<long-random-topic>
 * or a self-hosted ntfy. Never includes task titles or instructions.
 */
export async function notify(env: Env, title: string, message: string): Promise<void> {
  if (!env.NOTIFY_URL) return;
  const headers: Record<string, string> = {
    "Content-Type": "text/plain; charset=utf-8",
    Title: title.replace(/[^\x20-\x7e]/g, "?").slice(0, 120),
    Tags: "bell",
  };
  if (env.NOTIFY_TOKEN) headers["Authorization"] = `Bearer ${env.NOTIFY_TOKEN}`;
  try {
    await fetch(env.NOTIFY_URL, { method: "POST", headers, body: message, signal: AbortSignal.timeout(5000) });
  } catch (e) {
    console.warn("notify failed", (e as Error)?.message);
  }
}
