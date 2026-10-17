/**
 * Executor kit served by the relay: GET /kit/install.sh, /kit/relay.py, /kit/SKILL.md?lang=en|zh-CN
 * The files are bundled at deploy time (wrangler.jsonc "rules": Text), so the executor always gets the version that
 * matches this deployment. Nothing here is secret; the executor key is passed to install.sh by the caller.
 */
import installSh from "../executor-kit/kit-install.sh";
import relayPy from "../executor-kit/relay.py";
import skillEn from "../executor-kit/grokbot/SKILL.md";
import skillZh from "../executor-kit/grokbot/SKILL.zh-CN.md";

function text(body: string): Response {
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

export function handleKit(req: Request, origin: string): Response {
  const url = new URL(req.url);
  if (req.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
  switch (url.pathname) {
    case "/kit/install.sh":
      return text(installSh.replace("__RELAY_URL__", origin));
    case "/kit/relay.py":
      return text(relayPy);
    case "/kit/SKILL.md":
      return text(url.searchParams.get("lang") === "zh-CN" ? skillZh : skillEn);
    default:
      return new Response("Not found", { status: 404 });
  }
}
