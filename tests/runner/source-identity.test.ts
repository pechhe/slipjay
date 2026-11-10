import assert from "node:assert/strict";
import { identifyRetainedSources, retainSubmissionSource } from "../../src/lib/landing/submission-source.ts";
import { test, fixture } from "./fixtures/runner-queue-fixture.ts";

test("a retained source's identity is the same for the same files on a moved base, and differs for other files", async () => {
  const f = await fixture();
  try {
    const retain = async (file: string) => {
      const request = await f.candidate(file);
      const id = f.submit(request);
      f.log.append(id, await retainSubmissionSource({ home: f.home, operationId: id, request, url: f.origin, executor: f.executor }));
      return { id, commitId: request.commitId };
    };
    const first = await retain("same.txt");
    assert.equal((await f.land(f.submit(await f.candidate("moves-the-base.txt"))))?.type, "landed");
    const rebased = await retain("same.txt");
    const other = await retain("other.txt");
    assert.notEqual(first.commitId, rebased.commitId);
    assert.equal(await identifyRetainedSources({ home: f.home, log: f.log, executor: f.executor }), 3);
    const digest = (id: string) => f.log.events({ operationId: id }).flatMap(({ event }) => event.type === "source_identity" ? [event.digest] : []);
    assert.deepEqual(digest(first.id), digest(rebased.id));
    assert.equal(digest(first.id).length, 1);
    assert.notDeepEqual(digest(other.id), digest(first.id));
    // Each is recorded once: a second pass finds nothing left to identify.
    assert.equal(await identifyRetainedSources({ home: f.home, log: f.log, executor: f.executor }), 0);
  } finally { await f.dispose(); }
}, 120_000);
