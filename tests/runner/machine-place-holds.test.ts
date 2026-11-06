import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { machinePlaceHolds } from "../../src/lib/runner/machine-place-holds.ts";

const live = () => new AbortController().signal;
const all = () => true;

test("gates take a machine's free places side by side, skipping places that are down", () => {
  const holds = machinePlaceHolds();
  assert.equal(holds.take("peach-box", 3, (place) => place !== 1), 0);
  assert.equal(holds.take("peach-box", 3, (place) => place !== 1), 2, "place 1 is down, so the second gate takes place 2");
  assert.equal(holds.take("peach-box", 3, (place) => place !== 1), null);
  assert.deepEqual([holds.holds("peach-box", 0), holds.holds("peach-box", 1), holds.holds("peach-box", 2)], [true, false, true]);
  assert.equal(holds.anyHeld("peach-box"), true);
  assert.equal(holds.anyHeld("other"), false, "machines are held separately");
});

test("with every place held, released places go to waiting gates in arrival order, each holding it in turn", async () => {
  const holds = machinePlaceHolds();
  holds.take("peach-box", 2, all); holds.take("peach-box", 2, all);
  const order: string[] = [];
  const first = holds.wait("peach-box", live()).then((result) => { order.push("first"); return result; });
  const second = holds.wait("peach-box", live()).then((result) => { order.push("second"); return result; });
  assert.equal(holds.queued("peach-box"), true);
  holds.release("peach-box", 1);
  assert.equal((await first).place, 1);
  assert.equal(holds.holds("peach-box", 1), true, "the first waiter now holds place 1; no newcomer can take it");
  holds.release("peach-box", 0);
  assert.equal((await second).place, 0);
  holds.release("peach-box", 0); holds.release("peach-box", 1);
  assert.equal(holds.anyHeld("peach-box"), false);
  assert.deepEqual(order, ["first", "second"]);
});

test("a waiting gate stops at once when its prefix is invalidated, and leaves the queue without taking a place", async () => {
  const holds = machinePlaceHolds();
  holds.take("peach-box", 1, all);
  // The queue passes AbortSignal.any of the attempt's controller and its prefix's invalidation.
  const attempt = new AbortController(), invalidation = new AbortController();
  const invalidated = holds.wait("peach-box", AbortSignal.any([attempt.signal, invalidation.signal]));
  const next = holds.wait("peach-box", live());
  invalidation.abort();
  assert.equal((await invalidated).place, null);
  holds.release("peach-box", 0);
  assert.equal((await next).place, 0, "the place passes over the gate that stopped");
  assert.equal((await holds.wait("peach-box", AbortSignal.abort())).place, null);
});

test("a place that went down is freed, not handed on, and every waiting gate is woken to look again", async () => {
  const holds = machinePlaceHolds();
  holds.take("peach-box", 1, all);
  const first = holds.wait("peach-box", live()), second = holds.wait("peach-box", live());
  holds.free("peach-box", 0);
  assert.deepEqual([(await first).place, (await second).place], [null, null], "woken, not handed the down place");
  assert.equal(holds.anyHeld("peach-box"), false);
  assert.equal(holds.queued("peach-box"), false);
});
