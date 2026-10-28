import "server-only";

// Best-effort per-instance limiter. The database is the real guard: each
// question can be answered once, by the user it was served to, in time.
const hits = new Map<string, number[]>();

export function rateLimited(key: string, max = 20, windowMs = 10_000): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 10_000) hits.clear();
  return recent.length > max;
}
