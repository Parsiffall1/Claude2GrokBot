import type { ExecutorConfig } from "../config";
import type { WakeAdapter } from "./types";
import { webhookAdapter } from "./webhook";

export type { WakeAdapter, WakeOutcome, WakeRequest, WakeStatus } from "./types";

/** Poll-only executors (e.g. a scheduled routine that claims every N hours). */
const pollOnly: WakeAdapter = {
  type: "none",
  async wake() {
    return { status: "skipped", detail: "poll-only executor: it will claim on its own schedule" };
  },
};

/**
 * Map an executor config to its wake adapter. To add a new kind (GitHub issue, email, Slack...),
 * implement WakeAdapter in this folder and add a branch here. See docs/adapters.md.
 */
export function createAdapter(exec: ExecutorConfig): WakeAdapter {
  switch (exec.wake.type) {
    case "webhook":
      return webhookAdapter(exec.wake);
    case "none":
    default:
      return pollOnly;
  }
}
