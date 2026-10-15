import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vite-plus/test";
import { menuNotificationFixture } from "../scripts/menu-notification-fixture.ts";
import { fixtureRelease, menuLifecycleFixture, swiftRunnerContract } from "../scripts/menu-lifecycle-fixture.ts";
import { TERMINAL_EVENT_TYPES } from "../src/lib/runner-contract.ts";
import type { WatchEnvelope } from "../src/lib/runner-watch.ts";

test("the Swift notification fixture matches the typed runner ledger projection", async () => {
  const committed = await readFile(new URL("../macos/fixtures/notification-events.jsonl", import.meta.url), "utf8");
  assert.equal(committed, menuNotificationFixture());
});

test("the Swift lifecycle fixture and terminal constants match the runner contract", async () => {
  assert.equal(await readFile(new URL("../macos/fixtures/lifecycle.jsonl", import.meta.url), "utf8"), menuLifecycleFixture());
  assert.equal(await readFile(new URL("../macos/RunnerContract.generated.swift", import.meta.url), "utf8"), swiftRunnerContract());
  const envelopes = menuLifecycleFixture().trim().split("\n").map((line): WatchEnvelope => JSON.parse(line));
  const events = envelopes.flatMap((envelope) => envelope.type === "event" ? [envelope.event.event] : []);
  assert.deepEqual(events.filter((event) => (TERMINAL_EVENT_TYPES as readonly string[]).includes(event.type)).map((event) => event.type), [...TERMINAL_EVENT_TYPES]);
  const release = events.find((event) => event.type === "released");
  assert.deepEqual(release?.result, fixtureRelease);
  assert.equal(release?.result.candidate, "approved-candidate");
  assert.equal(Object.hasOwn(release?.result ?? {}, "candidates"), false);
});
