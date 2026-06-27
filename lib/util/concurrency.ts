/**
 * Run `fn` over `items` with a bounded number of concurrent executions, in
 * order-preserving fashion. Used to batch large fan-out (e.g. emailing
 * thousands of recipients from a cron/broadcast) so a single invocation neither
 * runs everything serially (slow → Worker timeout) nor all at once (overwhelms
 * SMTP / hits subrequest limits).
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
