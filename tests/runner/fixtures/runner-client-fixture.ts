import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, vi } from "vite-plus/test";
import { createWorkspace } from "../../../src/lib/workspace/workspace-create.ts";
import { createRunnerHandler } from "../../../src/lib/runner/runner-api.ts";
import type { KillOutcome, Operation, OperationEvent, StoredEvent } from "../../../src/lib/runner/runner-contract.ts";
import { serveRunner } from "../../../src/lib/runner/runner-http.ts";
import { openOperationLog } from "../../../src/lib/runner/runner-log.ts";
import type { BuildAdmitter } from "../../../src/lib/build/build-admission.ts";
import { configureLocalGithubTransport, jj, project } from "../../support/workspace-project.ts";

export async function fixture(dropStream = false, racedSubmission = false, loseSubmissionResponse: boolean | 400 | 401 = false, admitBuild?: BuildAdmitter) {
  const f = await project();
  const transport = await configureLocalGithubTransport(f);
  try {
    const workspace = await createWorkspace("runner client fixture", f.repo);
    const cwd = workspace.workspacePath;
    await writeFile(join(cwd, "change.txt"), "candidate\n");
    jj(cwd, ["describe", "-m", "Implement candidate"]);
    const commit = jj(cwd, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
    const change = jj(cwd, ["log", "-r", "@", "--no-graph", "-T", "change_id"]);
    const log = openOperationLog(":memory:");
    const listeners = new Set<(event: StoredEvent) => void>();
    const append = (id: string, event: OperationEvent) => {
      const stored = log.append(id, event);
      for (const listener of listeners) listener(stored);
    };
    let killed: KillOutcome = { status: "idle" };
    const killRequests: (string | undefined)[] = [];
    const handler = createRunnerHandler({ log, token: "test-token", runnerName: "test-runner",
      readLog: async () => "test log", onSubmitted: () => {}, kill: (operationId) => { killRequests.push(operationId); return killed; },
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      ...admitBuild ? { admitBuild } : {},
    });
    const streamRequests: number[] = [];
    let droppedSeq = 0;
    const requestIds: string[] = [];
    const route = async (request: Request) => {
      if (request.method === "GET" && new URL(request.url).pathname.endsWith("/events")) {
        streamRequests.push(Number(new URL(request.url).searchParams.get("after")));
        if (dropStream && streamRequests.length === 1) {
          const operation = log.openOperations()[0]!;
          const stored = log.append(operation.id, { type: "progress", line: "before reconnect" });
          droppedSeq = stored.seq;
          return new Response(`data: ${JSON.stringify(stored)}\n\n`, { headers: { "content-type": "text/event-stream" } });
        }
      }
      const isSubmission = request.method === "POST" && new URL(request.url).pathname.endsWith("/operations");
      if (isSubmission) requestIds.push((await request.clone().json() as { requestId: string }).requestId);
      if (isSubmission && typeof loseSubmissionResponse === "number")
        return Response.json({ error: "fixture refusal" }, { status: loseSubmissionResponse });
      const response = await handler(request);
      if (loseSubmissionResponse && isSubmission && requestIds.length === 1) {
        const body = await response.json() as { operation: Operation };
        append(body.operation.id, { type: "failed", stage: "verifying", reason: "fixture gate failed before response recovery" });
        return new Response("lost response body", { status: 200 });
      }
      if (racedSubmission && request.method === "POST" && new URL(request.url).pathname.endsWith("/operations")) {
        const body = await response.json() as { operation: Operation; reattached: boolean };
        return Response.json({ ...body, reattached: true });
      }
      return response;
    };
    let server = await serveRunner(route, { host: "127.0.0.1", port: 0 });
    // The runner is unreachable until `back()`, as during a service restart.
    const goDown = async () => {
      const { port } = server;
      await server.close();
      return async () => { server = await serveRunner(route, { host: "127.0.0.1", port }); };
    };
    const lines: string[] = [];
    const options = { location: server.url, env: { ...process.env, SLIPJAY_RUNNER_TOKEN: "test-token" },
      onLine: (line: string) => { lines.push(line); } };
    return { ...f, cwd, commit, change, log, append, server, lines, options, streamRequests, droppedSeq: () => droppedSeq, goDown,
      setKill: (outcome: KillOutcome) => { killed = outcome; },
      killRequests, requestIds,
      dispose: async () => {
        try { await server.close(); log.close(); }
        finally { try { transport.restore(); } finally { await f.dispose(); } }
      } };
  } catch (error) {
    try { transport.restore(); } finally { await f.dispose(); }
    throw error;
  }
}

export const waitFor = (condition: () => unknown) => vi.waitFor(() => assert.ok(condition()), { timeout: 10_000, interval: 20 });
/** The landing releases its checkout after its verdict, in a detached child: wait until it is gone. */
export const released = (path: string) => vi.waitFor(() => assert.rejects(access(path), { code: "ENOENT" }), { timeout: 120_000, interval: 100 });
