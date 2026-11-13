/**
 * Runs `run` over `items` with at most `limit` in flight. A console with fifty
 * stations asks for fifty statuses on load; each request that lands on a cold
 * Worker isolate may need its own token exchange, and the API allows a key
 * only so many a minute (docs/AUTH.md), so the browser asks a few at a time.
 */
export async function mapLimit<T>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const lanes = Math.max(1, Math.min(Math.floor(limit), items.length));
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      while (next < items.length) {
        const item = items[next++] as T;
        await run(item);
      }
    }),
  );
}
