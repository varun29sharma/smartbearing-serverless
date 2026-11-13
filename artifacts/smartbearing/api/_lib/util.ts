// Shared helpers for the SmartBearing serverless API.
//
// The serverless backend has no long-lived process and no database, so all
// "live" state is derived deterministically from the current time plus a
// seeded PRNG. The same inputs always produce the same outputs, which keeps
// every Vercel function instance in agreement without any shared store.

/** FNV-1a string hash -> unsigned 32-bit int. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — small, fast, deterministic PRNG. Returns [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic RNG seeded from arbitrary parts (machine, spindle, bucket…). */
export function rngFor(...parts: (string | number)[]): () => number {
  return mulberry32(hashString(parts.join('|')));
}

/** Deterministic gaussian-ish sample in [-1, 1] from a seeded RNG (Box–Muller). */
export function gaussian(rng: () => number): number {
  const u1 = Math.max(1e-9, rng());
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function round(v: number, decimals = 3): number {
  const p = 10 ** decimals;
  return Math.round(v * p) / p;
}

/** "YYYY-MM-DD HH:MM:SS" — the timestamp format the alerts list renders. */
export function fmtTimestamp(d: Date): string {
  return d.toISOString().replace('T', ' ').substring(0, 19);
}

export function startOfDay(d = new Date()): Date {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c;
}

export function hoursAgo(hours: number, now = Date.now()): Date {
  return new Date(now - hours * 3600_000);
}

export function daysAgo(days: number, now = Date.now()): Date {
  return new Date(now - days * 86400_000);
}

let uidCounter = 0;
/** Unique-enough id for records created at runtime (alerts, incidents…). */
export function uid(prefix: string): string {
  uidCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${uidCounter.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

/** Seeded deterministic pseudo-random in [0, 1) — the same helper the
 *  original analytics routes use for projected (pre-history) days. */
export function seededRand(seed: number, i: number): number {
  const x = Math.sin(seed * 9301 + i * 49297 + 233280) * 233280;
  return x - Math.floor(x);
}
