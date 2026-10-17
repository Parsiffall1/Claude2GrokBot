/**
 * Runs the real executor scripts (relay.py, relay.sh) against Claude2GrokBot served on localhost.
 * Skips a script if its interpreter (python3 / curl+jq) is not installed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeNamespace } from "./shim";

const MCP_TOKEN = "m".repeat(40);
const EXECUTOR_KEY = "e".repeat(40);
const envRef: { env: any } = { env: null };
let server: ReturnType<typeof Bun.serve>;
let base = "";

beforeAll(async () => {
  const { TaskHub } = await import("../src/hub");
  const worker = (await import("../src/index")).default;
  server = Bun.serve({ port: 0, fetch: (req) => worker.fetch(req, envRef.env, { waitUntil() {} } as any) });
  base = `http://localhost:${server.port}`;
  envRef.env = { HUB: fakeNamespace(TaskHub as any, envRef), MCP_TOKENS: MCP_TOKEN, EXECUTOR_KEY, WAKE_URL: "none", PUBLIC_URL: base };
});
afterAll(() => server.stop(true));

async function submit(title: string, instructions: string) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${MCP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "submit_task", arguments: { title, instructions } } }),
  });
  const text = (await res.json()).result.content[0].text as string;
  return JSON.parse(text.slice(text.indexOf("\n{") + 1)).task_id as string;
}
async function result(id: string) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${MCP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_result", arguments: { task_id: id } } }),
  });
  return (await res.json()).result.content[0].text as string;
}

function run(cmd: string[], home: string, input?: string, extraEnv: Record<string, string> = {}) {
  const p = Bun.spawn(cmd, {
    env: { PATH: process.env.PATH!, HOME: home, ...extraEnv },
    stdin: input ? new Blob([input]) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return p.exited.then(async (code) => ({ code, out: await new Response(p.stdout).text(), err: await new Response(p.stderr).text() }));
}

const has = (bin: string) => Bun.which(bin) !== null;
const kits: Array<[string, string[], boolean]> = [
  ["relay.py", ["python3", "executor-kit/relay.py"], has("python3")],
  ["relay.sh", ["bash", "executor-kit/relay.sh"], has("curl") && has("jq") && has("bash")],
];

for (const [name, argv, available] of kits) {
  describe.skipIf(!available)(name, () => {
    test("config from file, ping, next, heartbeat, block, done", async () => {
      const home = mkdtempSync(join(tmpdir(), "wl-home-"));
      const cfgDir = join(home, ".config", "claude2grokbot");
      await Bun.$`mkdir -p ${cfgDir}`;
      writeFileSync(join(cfgDir, "executor.env"), `RELAY_URL=${base}\nRELAY_EXECUTOR_KEY=${EXECUTOR_KEY}\n`, { mode: 0o600 });

      expect((await run([...argv, "ping"], home)).code).toBe(0);
      expect((await run([...argv, "next"], home)).code).toBe(3); // empty queue

      const id = await submit(`via ${name}`, "Say hello in Chinese");
      const next = await run([...argv, "next"], home);
      expect(next.code).toBe(0);
      const task = JSON.parse(next.out);
      expect(task.id).toBe(id);
      expect(next.out).not.toContain("wl_rt_"); // the result token is not printed
      expect(next.out).not.toContain(EXECUTOR_KEY);

      expect((await run([...argv, "heartbeat", "still going"], home)).code).toBe(0);
      expect((await run([...argv, "block", "asking user to confirm"], home)).code).toBe(0);
      expect((await run([...argv, "heartbeat", "user answered"], home)).code).toBe(0); // resumes, keeps the token
      const shot = join(home, "shot 1.png");
      writeFileSync(shot, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
      const att = await run([...argv, "attach", shot], home);
      expect(att.code).toBe(0);
      expect(att.out).toContain("shot 1.png");
      expect(att.out).toContain("image/png");
      const done = await run([...argv, "done", "completed", "-"], home, "你好 👋\nline 2 with \"quotes\"");
      expect(done.code).toBe(0);
      const res = await result(id);
      expect(res).toContain('你好 👋\nline 2 with "quotes"');
      expect(res).toContain("shot 1.png");
      expect((await run([...argv, "done", "completed", "-"], home, "x")).code).toBe(2); // no current task

      const bad = await run([...argv, "ping"], home, undefined, { RELAY_EXECUTOR_KEY: "wrong".repeat(10) });
      expect(bad.code).toBe(1);
    });

    test("canceled task: result is refused and state is cleared", async () => {
      const home = mkdtempSync(join(tmpdir(), "wl-home-"));
      const env = { RELAY_URL: base, RELAY_EXECUTOR_KEY: EXECUTOR_KEY };
      const id = await submit("to cancel", "anything");
      expect((await run([...argv, "next"], home, undefined, env)).code).toBe(0);
      await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { Authorization: `Bearer ${MCP_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "cancel_task", arguments: { task_id: id } } }),
      });
      const r = await run([...argv, "done", "completed", "-"], home, "late", env);
      expect(r.code).toBe(1);
      expect(r.err).toContain("canceled");
      expect((await run([...argv, "heartbeat"], home, undefined, env)).code).toBe(2); // state file was removed
    });
  });
}

describe.skipIf(!(has("python3") && has("curl") && has("bash")))("kit served by the relay", () => {
  test("one-line install writes relay.py, the skill and the config, then pings", async () => {
    const home = mkdtempSync(join(tmpdir(), "wl-kit-"));
    const r = await run(["bash", "-c", `curl -fsSL ${base}/kit/install.sh | RELAY_EXECUTOR_KEY=${EXECUTOR_KEY} SKILL_LANG=zh-CN bash`], home);
    expect(r.code).toBe(0);
    expect(r.out).toContain('"ok": true');
    expect(await Bun.file(join(home, "claude2grokbot/relay.py")).text()).toBe(await Bun.file("executor-kit/relay.py").text());
    expect(await Bun.file(join(home, "claude2grokbot/SKILL.md")).text()).toBe(await Bun.file("executor-kit/grokbot/SKILL.zh-CN.md").text());
    expect(await Bun.file(join(home, ".config/claude2grokbot/executor.env")).text()).toBe(`RELAY_URL=${base}\nRELAY_EXECUTOR_KEY=${EXECUTOR_KEY}\n`);
    // re-running without a key keeps the existing config
    expect((await run(["bash", "-c", `curl -fsSL ${base}/kit/install.sh | bash`], home)).code).toBe(0);
    expect(await Bun.file(join(home, ".config/claude2grokbot/executor.env")).text()).toContain(EXECUTOR_KEY);
  });
});
