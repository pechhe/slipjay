/**
 * When a checkout was last known to be in use, which is what every idle rule measures from: idle
 * eviction, host-disk retirement, and the settlement of abandoned custody. Its recorded idle clock
 * is authoritative where one exists, but a checkout whose harness never wrote one — a delegate
 * workspace claimed and then left behind by a restarted controller, for instance — still carries
 * stamps for its own creation, claiming, attachment and last metadata update, and the newest of
 * those is the latest moment anything demonstrably touched it. Without that fallback such a
 * checkout has no age at all, so every interval rule either never fires or fires immediately.
 *
 * `null` means nothing has ever been observed, not that the checkout is idle for ever: a caller
 * that starts its clock, refuses, or names the missing time decides what an unknown age means.
 */
export function lastKnownTouch(metadata: Record<string, unknown> | null | undefined): number | null {
  const recorded = stamp(metadata?.lastActivityAt);
  if (recorded !== null) return recorded;
  const stamps = [metadata?.updatedAt, metadata?.claimedAt, metadata?.createdAt, metadata?.attachedAt]
    .map(stamp).filter((value): value is number => value !== null);
  return stamps.length ? Math.max(...stamps) : null;
}

function stamp(value: unknown): number | null {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}
