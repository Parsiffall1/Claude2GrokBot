/**
 * Minimal in-memory stand-in for the Cloudflare Workers runtime pieces Claude2GrokBot uses,
 * so the full request flow can be tested with plain `bun test` (no network, no account).
 * It is NOT workerd: it does not emulate input/output gates, limits, or RPC serialization.
 * Loaded via bunfig.toml [test] preload.
 */
import { plugin } from "bun";
import { Database } from "bun:sqlite";

plugin({
  name: "cloudflare-workers-shim",
  setup(build) {
    build.module("cloudflare:workers", () => ({
      exports: {
        DurableObject: class DurableObject {
          ctx: unknown;
          env: unknown;
          constructor(ctx: unknown, env: unknown) {
            this.ctx = ctx;
            this.env = env;
          }
        },
      },
      loader: "object",
    }));
    // Same as the wrangler "rules" Text entry: executor-kit files are imported as strings.
    build.onLoad({ filter: /\.(py|md|sh)$/ }, async (args) => ({ exports: { default: await Bun.file(args.path).text() }, loader: "object" }));
  },
});

export class FakeStorage {
  db = new Database(":memory:");
  alarm: number | null = null;
  sql = {
    exec: (query: string, ...bindings: unknown[]) => {
      const stmt = this.db.query(query);
      const rows = stmt.all(...(bindings as never[])) as Record<string, unknown>[];
      return { toArray: () => rows, one: () => rows[0] };
    },
  };
  async getAlarm() {
    return this.alarm;
  }
  async setAlarm(t: number | Date) {
    this.alarm = typeof t === "number" ? t : t.getTime();
  }
}

/** A namespace whose single object is created lazily with the given class. */
export function fakeNamespace<T>(Cls: new (ctx: unknown, env: unknown) => T, envRef: { env: unknown }) {
  let instance: T | null = null;
  const storage = new FakeStorage();
  return {
    storage,
    idFromName: (n: string) => n,
    get: () => {
      if (!instance) instance = new Cls({ storage }, envRef.env);
      return instance;
    },
  };
}
