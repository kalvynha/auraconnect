/** Bounded-concurrency helpers for fan-out work in callables and scheduled jobs. */

/**
 * Maps `items` through `fn` with at most `limit` calls in flight and returns
 * the results in input order (like `Promise.all(items.map(fn))`, but bounded).
 *
 * On the first rejection no new items are started; calls already in flight
 * are allowed to settle, then the first error is rethrown. This keeps
 * "stop at the first failure" loops close to their sequential behavior.
 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  let next = 0;
  let failed = false;
  let firstError: unknown;
  const worker = async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i]!, i);
      } catch (e) {
        if (!failed) {
          failed = true;
          firstError = e;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
  if (failed) throw firstError;
  return results;
}
