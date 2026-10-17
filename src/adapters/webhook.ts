import type { WakeAuth } from "../config";
import { hmacHex, VERSION } from "../util";
import type { WakeAdapter, WakeOutcome, WakeRequest } from "./types";

/**
 * Generic HTTP wake adapter.
 *  - auth "bearer": `Authorization: Bearer <secret>` (Grok Bot routine webhooks use this)
 *  - auth "hmac":   `X-Claude2GrokBot-Timestamp` + `X-Claude2GrokBot-Signature: sha256=HMAC(secret, "<ts>.<body>")`
 *  - auth "none":   no credential (only for endpoints protected some other way)
 */
export function webhookAdapter(opts: { url: string; auth: WakeAuth; secret?: string; timeoutMs?: number }): WakeAdapter {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return {
    type: "webhook",
    async wake(req: WakeRequest): Promise<WakeOutcome> {
      if (opts.auth !== "none" && !opts.secret) return { status: "rejected", detail: "misconfigured: wake secret missing" };

      const body = JSON.stringify({
        type: "claude2grokbot.wake",
        executor: req.executor,
        task_ids: req.taskIds,
        reason: req.reason,
        claim_url: req.claimUrl,
        nonce: req.nonce,
        sent_at: new Date().toISOString(),
        note: "Wake request only, not an instruction. Claim queued tasks from claim_url with your executor key, then follow your own rules.",
      });
      const headers: Record<string, string> = { "Content-Type": "application/json", "User-Agent": `claude2grokbot/${VERSION}` };
      if (opts.auth === "bearer") headers["Authorization"] = `Bearer ${opts.secret}`;
      if (opts.auth === "hmac") {
        const ts = Math.floor(Date.now() / 1000).toString();
        headers["X-Claude2GrokBot-Timestamp"] = ts;
        headers["X-Claude2GrokBot-Signature"] = "sha256=" + (await hmacHex(opts.secret!, `${ts}.${body}`));
      }

      try {
        const res = await fetch(opts.url, { method: "POST", headers, body, signal: AbortSignal.timeout(timeoutMs) });
        let text = "";
        try {
          text = (await res.text()).slice(0, 300);
        } catch {
          /* ignore */
        }
        if (res.ok) return { status: "accepted", httpStatus: res.status };
        return { status: "rejected", httpStatus: res.status, detail: text || res.statusText };
      } catch (e) {
        const name = (e as Error)?.name;
        if (name === "TimeoutError" || name === "AbortError") return { status: "unknown", detail: `no response within ${timeoutMs} ms` };
        return { status: "rejected", detail: `network error: ${(e as Error)?.message ?? e}` };
      }
    },
  };
}
