// Bounded read-only work. Drain in-flight reads before releasing the caller's school session.
async function mapRead(items, fn, { limit = 2, cancelled = () => false } = {}) {
  const results = new Array(items.length);
  let next = 0,
    error = null;
  await Promise.allSettled(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (!error && !cancelled()) {
        const index = next++;
        if (index >= items.length) return;
        try {
          results[index] = await fn(items[index], index);
        } catch (e) {
          error ??= e;
        }
      }
    }),
  );
  if (error) throw error;
  return results;
}
module.exports = { mapRead };
