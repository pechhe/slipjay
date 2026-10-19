/**
 * Map `items` through `map` with at most `limit` calls in flight, keeping input order.
 * For work that starts a process per item, such as a jj command per workspace:
 * a repository with a hundred workspaces must not start a hundred at once.
 */
export async function mapBounded<T, R>(items: readonly T[], limit: number, map: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await map(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return results;
}
