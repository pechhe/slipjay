import assert from "node:assert/strict";
import { test, fixture } from "./fixtures/runner-queue-fixture.ts";

test("each stage of a landing records how many jj and git commands it ran, their total time and the slowest", async () => {
  const f = await fixture();
  try {
    const id = f.submit(await f.candidate("timed.txt"));
    assert.equal((await f.land(id))?.type, "landed");
    const details = f.log.events({ operationId: id }).flatMap(({ event }) => event.type === "stage_detail" ? [event] : []);
    const fetching = details.find((detail) => detail.stage === "fetching");
    assert.ok(fetching?.commands && fetching.commands.count > 0, "fetching ran jj and git commands");
    assert.ok(fetching.commands.slowest.length > 0 && fetching.commands.slowest.length <= 5);
    assert.ok(fetching.commands.slowest.every((entry) => /^(jj|git|gh)\b/.test(entry.command) && entry.ms >= 0));
    assert.ok(fetching.commands.slowest.some((entry) => entry.command.startsWith("jj git")), "the fetch itself is named");
    // Slowest first, and the total covers them.
    const ms = fetching.commands.slowest.map((entry) => entry.ms);
    assert.deepEqual(ms, [...ms].sort((left, right) => right - left));
    assert.ok(fetching.commands.ms >= ms.reduce((total, value) => total + value, 0));
    // A command belongs to one stage only.
    const counted = details.reduce((total, detail) => total + (detail.commands?.count ?? 0), 0);
    assert.ok(counted >= fetching.commands.count);
  } finally { await f.dispose(); }
});
