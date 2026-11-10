import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { cachedSizeOf } from "../../src/lib/host-disk/size-cache.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "size-cache-"));
  return { file: join(dir, "sizes.json"), done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a size is measured once within the window, across passes, and again after it", async () => {
  const { file, done } = fixture();
  try {
    let clock = 0;
    let measured = 0;
    const measure = async () => { measured += 1; return 100 * measured; };
    const first = cachedSizeOf(measure, file, { now: () => clock, ttlMs: 1000 });
    assert.equal(await first("/a"), 100);
    assert.equal(await first("/a"), 100);
    clock = 500;
    assert.equal(await cachedSizeOf(measure, file, { now: () => clock, ttlMs: 1000 })("/a"), 100);
    assert.equal(measured, 1);
    clock = 1500;
    assert.equal(await cachedSizeOf(measure, file, { now: () => clock, ttlMs: 1000 })("/a"), 200);
  } finally { done(); }
});

test("an unreadable measurement is not cached, and a corrupt cache file is ignored", async () => {
  const { file, done } = fixture();
  try {
    writeFileSync(file, "{not json");
    let result: number | null = null;
    const sizeOf = cachedSizeOf(async () => result, file, { now: () => 0, ttlMs: 1000 });
    assert.equal(await sizeOf("/a"), null);
    result = 7;
    assert.equal(await sizeOf("/a"), 7);
  } finally { done(); }
});
