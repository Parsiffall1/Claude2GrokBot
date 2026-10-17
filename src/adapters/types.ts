/**
 * A wake adapter starts an executor that is not running.
 *
 * Rules every adapter must follow:
 *  - Never put task instructions in the wake signal. Send only ids and the claim URL;
 *    the executor pulls the task body with its own key. This keeps task content out of
 *    third-party logs and makes duplicate rings harmless (claims are atomic).
 *  - Return quickly (the hub waits for the outcome) and never throw.
 */
export interface WakeRequest {
  executor: string;
  taskIds: string[];
  reason: string;
  claimUrl: string;
  nonce: string;
}

export type WakeStatus =
  | "accepted" // executor confirmed it started (e.g. HTTP 2xx)
  | "rejected" // executor definitely did NOT start (4xx/5xx, DNS error, misconfig)
  | "unknown" // may or may not have started (timeout) - do not re-send immediately
  | "skipped"; // nothing to ring (poll-only executor)

export interface WakeOutcome {
  status: WakeStatus;
  httpStatus?: number;
  detail?: string;
}

export interface WakeAdapter {
  readonly type: string;
  wake(req: WakeRequest): Promise<WakeOutcome>;
}
