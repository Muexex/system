function bounded(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < minimum || n > maximum) throw new Error(`${name} 配置无效`);
  return n;
}
export const config = {
  waitMs: bounded('MATCH_WAIT_MS', 60_000, 500, 300_000),
  offerMs: bounded('MATCH_OFFER_MS', 20_000, 200, 120_000),
  heartbeatMs: 10_000,
  heartbeatTtlMs: bounded('HEARTBEAT_TTL_MS', 35_000, 500, 120_000),
  pollMs: 2_000,
  abandonedMs: bounded('SESSION_ABANDONED_MS', 30 * 60_000, 2_000, 24 * 60 * 60_000),
};
export type DomainConfig = typeof config;
