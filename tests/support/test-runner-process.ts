import { fork } from "node:child_process";
import { testRunnerEntryPath } from "./test-runner-entry.ts";
/** Run the fixture HTTP service under Bun, as the installed runner does. */
export async function startTestRunnerProcess({ home, env }: { home: string; env: NodeJS.ProcessEnv }) {
  const child = fork(testRunnerEntryPath, [home], {
    execPath: "bun", serialization: "json", cwd: home, env, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  child.stdout!.pipe(process.stdout, { end: false });
  child.stderr!.pipe(process.stderr, { end: false });
  let failure: Error | undefined;
  let requested = false;
  let ready!: (url: string) => void;
  let rejectReady!: (error: Error) => void;
  let closed!: () => void;
  let rejectClosed!: (error: Error) => void;
  const readiness = new Promise<string>((resolve, reject) => { ready = resolve; rejectReady = reject; });
  const shutdown = new Promise<void>((resolve, reject) => { closed = resolve; rejectClosed = reject; });
  void shutdown.catch(() => {});
  const fail = (error: Error) => { failure ??= error; rejectReady(error); rejectClosed(error); };
  // Node/Bun IPC disconnect can omit ChildProcess's aggregate close event.
  // Join process exit AND clean EOF on both pipes instead of dropping output.
  const outputClosed = Promise.all([child.stdout!, child.stderr!].map((stream) => new Promise<void>((resolve) => {
    stream.on("error", fail);
    stream.once("close", () => {
      if (!stream.readableEnded) fail(new Error("Runner child output closed before EOF"));
      resolve();
    });
  })));
  let spawned = false;
  child.once("spawn", () => { spawned = true; });
  const exited = new Promise<void>((resolve) => {
    child.once("error", () => { if (!spawned) resolve(); });
    child.once("exit", (code, signal) => {
      if (!requested || code !== 0 || signal) fail(new Error(`Runner child exited: code=${code}, signal=${signal}`));
      resolve();
    });
  });
  child.on("error", fail);
  child.on("message", (value: unknown) => {
    const message = value as { type?: string; url?: string; error?: string };
    if (message.type === "ready" && typeof message.url === "string") ready(message.url);
    if (message.type === "closed") { requested = true; closed(); child.disconnect(); }
    if (message.type === "fatal") fail(new Error(`Runner child: ${message.error}`));
  });
  async function bounded<T>(promise: Promise<T>, phase: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    try { return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`Runner child ${phase} timed out`)); }, 30_000);
    })]); } finally { clearTimeout(timer!); }
  }
  const joined = Promise.all([exited, outputClosed]);
  async function stopAndJoin(original?: unknown) {
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await bounded(joined, "cleanup");
    } catch (error) {
      if (original) throw new AggregateError([original, error], "Runner child failure and incomplete cleanup");
      throw error;
    }
  }
  let url: string;
  try { url = await bounded(readiness, "startup"); }
  catch (error) { await stopAndJoin(error); throw error; }
  return { url, pid: child.pid!, async close() {
    let original: unknown;
    try {
      if (failure) throw failure;
      child.send({ type: "close" });
      await bounded(shutdown, "shutdown");
      await bounded(joined, "exit and output drain");
      if (failure) throw failure;
    } catch (error) { original = error; throw error; }
    finally { await stopAndJoin(original); }
  } };
}
