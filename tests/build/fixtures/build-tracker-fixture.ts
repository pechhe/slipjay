import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { BuildItem } from "../../../src/lib/build/tracker.ts";

/** Waits until `condition` holds, failing after `timeoutMs`. */
export async function until(condition: () => boolean, label: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export const item = (fields: Partial<BuildItem> & Pick<BuildItem, "number">): BuildItem =>
  ({ id: `00000000-0000-4000-8000-${String(fields.number).padStart(12, "0")}`, kind: "ticket", status: "ready", parentId: null, title: `Item ${fields.number}`, ...fields });

/**
 * A stand-in for Build's runner route on loopback: reads from `items` and `binds` (by Spec id), and
 * accepts the runner's admissions and receipts, recording every request. Clearing `admits` leaves admissions
 * unanswered; clearing `answers` leaves every request unanswered. A `held` promise delays the next `binds` answer until it settles.
 */
export async function buildServer(token: string, items: BuildItem[], binds: Record<string, { generation: number; endedAt: string | null }[]> = {}) {
  const requests: { action: string; input: Record<string, unknown> }[] = [];
  const state: { admits: boolean; answers: boolean; held?: Promise<void> } = { admits: true, answers: true };
  const server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => { text += chunk; });
    request.on("end", async () => {
      const reply = (status: number, body: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
      if (request.url !== "/api/build/runner" || request.headers.authorization !== `Bearer ${token}`) return reply(401, { status: "unauthorised", code: "runner_unauthenticated" });
      const { action, input } = JSON.parse(text) as { action: string; input: Record<string, unknown> };
      requests.push({ action, input });
      if (!state.answers || action === "admitAttempt" && !state.admits) return reply(503, { status: "unavailable", code: "hq_build_store_unavailable" });
      if (action === "read") {
        const found = items.find((entry) => entry.number === input.number || entry.id === input.itemId);
        // As Build does: an unknown item is its `unavailable` outcome, which the route sends as 503.
        return found ? reply(200, { status: "succeeded", value: found }) : reply(503, { status: "unavailable", code: "build_item_unavailable" });
      }
      if (action === "binds" && state.held) { const held = state.held; state.held = undefined; await held; }
      if (action === "binds") return reply(200, { status: "succeeded", value: binds[input.specId as string] ?? [] });
      if (action === "admitAttempt") return reply(200, { status: "succeeded", value: { admission: { recordedAt: new Date().toISOString() } } });
      if (["recordAttempt", "recordAttemptRun", "recordChoreLanding"].includes(action)) return reply(200, { status: "succeeded", value: null });
      return reply(400, { status: "invalid", code: "runner_action_invalid" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, state, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

export const SESSION = "11111111-2222-4333-8444-555555555555";
