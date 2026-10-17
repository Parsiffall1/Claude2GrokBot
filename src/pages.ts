import { escapeHtml, VERSION } from "./util";

const CSS = `
:root{--bg:#f7f6f3;--card:#fff;--fg:#1d1d1b;--muted:#6b6a66;--line:#e3e1db;--accent:#2f5d50;--accent-fg:#fff;--warn:#9a3b1b;--code:#f0eee8}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--card:#1f1f1d;--fg:#ecebe6;--muted:#a3a29c;--line:#34332f;--accent:#7fb8a4;--accent-fg:#111;--warn:#f0a483;--code:#2a2a27}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:640px;margin:0 auto;padding:32px 16px 64px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:22px}
h1{font-size:22px;margin:0 0 6px}p{margin:8px 0}.muted{color:var(--muted);font-size:14px}
pre{background:var(--code);border-radius:8px;padding:12px;white-space:pre-wrap;word-break:break-word;font-size:14px;max-height:340px;overflow:auto}
code{background:var(--code);border-radius:4px;padding:1px 5px;font-size:14px}
label{display:block;font-weight:600;margin:16px 0 6px}
input[type=password]{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:9px;background:var(--bg);color:var(--fg);font-size:16px}
.row{display:flex;gap:10px;margin-top:18px;flex-wrap:wrap}
button{flex:1;min-width:130px;padding:12px;border-radius:9px;border:1px solid var(--line);background:var(--card);color:var(--fg);font-size:16px;font-weight:600;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-fg)}
.flag{display:inline-block;border:1px solid var(--warn);color:var(--warn);border-radius:99px;padding:1px 9px;font-size:13px;margin:2px 4px 2px 0}
.err{color:var(--warn);font-weight:600}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px;margin:12px 0}dt{color:var(--muted)}dd{margin:0;word-break:break-all}
`;

export function page(title: string, body: string, status = 200): Response {
  const doc = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>${CSS}</style></head>
<body><main>${body}<p class="muted" style="margin-top:24px">Claude2GrokBot ${VERSION}</p></main></body></html>`;
  return new Response(doc, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
      "Referrer-Policy": "no-referrer",
    },
  });
}
