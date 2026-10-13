import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vite-plus/test";
import {
  VERIFICATION_SLOT_ENV,
  verificationSlotEnvironment,
  withVerificationSlot,
} from "../src/lib/verification-slot.mjs";

type WaitStatus = { ahead: number; holder: string | null };

function signal<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

/**
 * Runs a scenario against a private slot root. Held operations are released and
 * every started landing settles before the root is removed, so a failing
 * assertion cannot leave a landing writing into a deleted fixture.
 */
async function withSlotFixture(
  name: string,
  scenario: (fixture: {
    root: string;
    env: NodeJS.ProcessEnv;
    track: <T>(landing: Promise<T>) => Promise<T>;
    hold: () => { promise: Promise<void>; resolve: () => void };
  }) => Promise<void>,
) {
  const root = await mkdtemp(path.join(tmpdir(), `verification-slot-${name}-`));
  const env = { ...process.env, [VERIFICATION_SLOT_ENV]: undefined };
  const landings: Promise<unknown>[] = [];
  const holds: Array<() => void> = [];
  try {
    await scenario({
      root,
      env,
      track: (landing) => { landings.push(landing); return landing; },
      hold: () => { const held = signal(); holds.push(held.resolve); return held; },
    });
  } finally {
    for (const release of holds) release();
    await Promise.allSettled(landings);
    await rm(root, { recursive: true, force: true });
  }
}

test("landing verifications on one machine run one at a time, in arrival order", () =>
  withSlotFixture("order", async ({ root, env, track, hold }) => {
    const events: string[] = [];
    const firstHeld = hold();
    const firstStarted = signal();
    const secondWaiting = signal<WaitStatus>();
    const first = track(withVerificationSlot(async () => {
      events.push("first:start");
      firstStarted.resolve();
      await firstHeld.promise;
      events.push("first:end");
    }, { root, env, pollMs: 10 }));
    await firstStarted.promise;
    const second = track(withVerificationSlot(async () => { events.push("second:start"); }, {
      root, env, pollMs: 10, onWait: secondWaiting.resolve,
    }));
    await secondWaiting.promise;
    assert.deepEqual(events, ["first:start"]);
    firstHeld.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(events, ["first:start", "first:end", "second:start"]);
  }));

test("a landing holding the slot runs its own verification without re-queueing, while others still wait", () =>
  withSlotFixture("reentrant", async ({ root, env, track, hold }) => {
    const events: string[] = [];
    const landingHeld = hold();
    const verified = signal();
    const otherWaiting = signal<WaitStatus>();
    const landing = track(withVerificationSlot(async () => {
      events.push("landing:rebase");
      await withVerificationSlot(async () => { events.push("landing:verify"); }, { root, env, pollMs: 10 });
      verified.resolve();
      await landingHeld.promise;
      events.push("landing:integrate");
    }, { root, env, pollMs: 10 }));
    await verified.promise;
    const other = track(withVerificationSlot(async () => { events.push("other:rebase"); }, {
      root, env, pollMs: 10, onWait: otherWaiting.resolve,
    }));
    await otherWaiting.promise;
    landingHeld.resolve();
    await Promise.all([landing, other]);
    assert.deepEqual(events, ["landing:rebase", "landing:verify", "landing:integrate", "other:rebase"]);
  }));

test("a landing started inside a held slot does not wait for its parent", () =>
  withSlotFixture("nested", async ({ root, env }) => {
    const nested = await withVerificationSlot(
      () => withVerificationSlot(async () => "nested ran", { root, env: verificationSlotEnvironment(env), pollMs: 10 }),
      { root, env, pollMs: 10 },
    );
    assert.equal(nested, "nested ran");
  }));

test("verification commands see the held slot as SLIPJAY_VERIFICATION_SLOT, which alone passes through", () =>
  withSlotFixture("names", async ({ root, env, track, hold }) => {
    const held = verificationSlotEnvironment(env);
    assert.equal(held.SLIPJAY_VERIFICATION_SLOT, "held");
    assert.equal("PEACH_VERIFICATION_SLOT" in held, false, "the retired name is not set");
    const holderHeld = hold();
    const holding = signal();
    track(withVerificationSlot(async () => { holding.resolve(); await holderHeld.promise; }, { root, env, pollMs: 10 }));
    await holding.promise;
    // The slot is held by another landing, so only the env pass-through lets these run.
    assert.equal(await withVerificationSlot(async () => "passed", { root, env: { ...env, SLIPJAY_VERIFICATION_SLOT: "held" }, pollMs: 10 }), "passed");
    // The retired name no longer passes through: this landing waits for the held slot.
    let retiredRan = false;
    const retired = track(withVerificationSlot(async () => { retiredRan = true; }, { root, env: { ...env, PEACH_VERIFICATION_SLOT: "held" }, pollMs: 10 }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(retiredRan, false);
    holderHeld.resolve();
    await retired;
    assert.equal(retiredRan, true);
  }));

test("a waiting landing reports how many landings are ahead and who holds the slot", () =>
  withSlotFixture("ahead", async ({ root, env, track, hold }) => {
    const holderHeld = hold();
    const holding = signal();
    const firstWaiting = signal();
    const secondWaiting = signal();
    const firstStatuses: WaitStatus[] = [];
    const secondStatuses: WaitStatus[] = [];
    const holder = track(withVerificationSlot(async () => { holding.resolve(); await holderHeld.promise; }, {
      root, env, pollMs: 10, label: "jj:holder",
    }));
    await holding.promise;
    const first = track(withVerificationSlot(async () => {}, {
      root, env, pollMs: 10, label: "jj:first",
      onWait: (status) => { firstStatuses.push(status); firstWaiting.resolve(); },
    }));
    await firstWaiting.promise;
    const second = track(withVerificationSlot(async () => {}, {
      root, env, pollMs: 10, label: "jj:second",
      onWait: (status) => { secondStatuses.push(status); secondWaiting.resolve(); },
    }));
    await secondWaiting.promise;
    assert.deepEqual(firstStatuses[0], { ahead: 1, holder: "jj:holder" });
    assert.deepEqual(secondStatuses[0], { ahead: 2, holder: "jj:holder" });
    holderHeld.resolve();
    await Promise.all([holder, first, second]);
    // The slot is not first-come-first-served, so only the count shrinking is guaranteed.
    assert.ok(secondStatuses.every((status, index) => index === 0 || status.ahead <= secondStatuses[index - 1]!.ahead));
  }));

test("landings of different integration roots hold separate slots and run concurrently", () =>
  withSlotFixture("scope", async ({ root, env, track, hold }) => {
    const events: string[] = [];
    const firstHeld = hold();
    const firstStarted = signal();
    const first = track(withVerificationSlot(async () => {
      events.push("repo-a:start");
      firstStarted.resolve();
      await firstHeld.promise;
      events.push("repo-a:end");
    }, { root, env, pollMs: 10, scope: "/repos/a" }));
    await firstStarted.promise;
    await track(withVerificationSlot(async () => { events.push("repo-b:start"); }, {
      root, env, pollMs: 10, scope: "/repos/b",
      onWait: () => assert.fail("a landing in another repository must not wait"),
    }));
    assert.deepEqual(events, ["repo-a:start", "repo-b:start"]);
    const sameRepoWaiting = signal<WaitStatus>();
    const sameRepo = track(withVerificationSlot(async () => { events.push("repo-a:second"); }, {
      root, env, pollMs: 10, scope: "/repos/a", onWait: sameRepoWaiting.resolve,
    }));
    assert.deepEqual(await sameRepoWaiting.promise, { ahead: 1, holder: null });
    firstHeld.resolve();
    await Promise.all([first, sameRepo]);
    assert.deepEqual(events, ["repo-a:start", "repo-b:start", "repo-a:end", "repo-a:second"]);
  }));

test("a waiting record left by a dead landing is purged and never counted as ahead", () =>
  withSlotFixture("dead", async ({ root, env, track, hold }) => {
    const holderHeld = hold();
    const holding = signal();
    const holder = track(withVerificationSlot(async () => { holding.resolve(); await holderHeld.promise; }, {
      root, env, pollMs: 10, scope: "/repos/a", label: "jj:holder",
    }));
    await holding.promise;
    const holderFile = (await readdir(root)).find((name) => name.endsWith(".holder.json"))!;
    const waitingDir = path.join(root, `${holderFile.replace(/\.holder\.json$/, "")}.waiting`);
    await mkdir(waitingDir, { recursive: true });
    await writeFile(path.join(waitingDir, "dead.json"), JSON.stringify({ id: "dead", pid: 2 ** 22 - 1, since: 0, label: "jj:dead" }));
    const waiting = signal<WaitStatus>();
    const waiter = track(withVerificationSlot(async () => {}, {
      root, env, pollMs: 10, scope: "/repos/a", label: "jj:live", onWait: waiting.resolve,
    }));
    assert.deepEqual(await waiting.promise, { ahead: 1, holder: "jj:holder" });
    assert.ok(!(await readdir(waitingDir)).includes("dead.json"), "dead record is removed");
    holderHeld.resolve();
    await Promise.all([holder, waiter]);
  }));

test("a yielding contender stands aside for a waiter it defers to, handing back a slot it took first", () =>
  withSlotFixture("yield", async ({ root, env, track }) => {
    const events: string[] = [];
    // A waiter that outranks the contender but never takes the slot itself.
    const waitingDir = path.join(root, "verification-slot.waiting");
    await mkdir(waitingDir, { recursive: true });
    const outranking = path.join(waitingDir, "outranking.json");
    await writeFile(outranking, JSON.stringify({ id: "outranking", pid: process.pid, since: 0, label: "jj:outranking", rank: 2 }));
    let asked = 0;
    const seen: unknown[] = [];
    const deferring = signal();
    const contender = track(withVerificationSlot(async () => { events.push("contender"); }, {
      root, env, pollMs: 10, label: "jj:contender", record: { rank: 1 },
      yieldTo: ({ own, waiters }) => {
        seen.push(own.rank);
        asked += 1;
        // The first answer misses the waiter, as when it arrives just before the lock is taken.
        if (asked === 1) return false;
        if (asked >= 3) deferring.resolve();
        return waiters.some((waiter) => (waiter.rank as number) > (own.rank as number));
      },
    }));
    await deferring.promise;
    // The contender took the slot, handed it back and still defers: the slot is free.
    await track(withVerificationSlot(async () => { events.push("other"); }, {
      root, env, pollMs: 10, onWait: () => assert.fail("the slot was not handed back"),
    }));
    await rm(outranking);
    await contender;
    assert.deepEqual(events, ["other", "contender"]);
    assert.ok(seen.every((rank) => rank === 1), "the hook sees its own structured record");
  }));

test("a holder's record carries its structured fields to the contenders waiting behind it", () =>
  withSlotFixture("record", async ({ root, env, track, hold }) => {
    const holderHeld = hold();
    const holding = signal();
    track(withVerificationSlot(async () => { holding.resolve(); await holderHeld.promise; }, {
      root, env, pollMs: 10, label: "release a", record: { candidate: "a".repeat(40) },
    }));
    await holding.promise;
    const holders = signal<unknown>();
    const waiter = track(withVerificationSlot(async () => {}, {
      root, env, pollMs: 10, record: { candidate: "b".repeat(40) },
      yieldTo: ({ holder }) => { if (holder) holders.resolve(holder.candidate); return false; },
    }));
    assert.equal(await holders.promise, "a".repeat(40));
    holderHeld.resolve();
    await waiter;
  }));

test("a yielding contender ignores a waiting record its waiter stopped touching", () =>
  withSlotFixture("stale", async ({ root, env }) => {
    // A live pid, as a stopped session or a reused pid would leave it, but untouched for two minutes.
    const waitingDir = path.join(root, "verification-slot.waiting");
    await mkdir(waitingDir, { recursive: true });
    const stale = path.join(waitingDir, "stale.json");
    await writeFile(stale, JSON.stringify({ id: "stale", pid: process.pid, since: 0, label: "jj:stale", rank: 2 }));
    const past = new Date(Date.now() - 120_000);
    await utimes(stale, past, past);
    const ran = await withVerificationSlot(async () => "ran", {
      root, env, pollMs: 10, record: { rank: 1 },
      yieldTo: ({ own, waiters }) => waiters.some((waiter) => (waiter.rank as number) > (own.rank as number)),
    });
    assert.equal(ran, "ran");
    assert.ok(!(await readdir(waitingDir)).includes("stale.json"), "the stale record is removed");
  }));
