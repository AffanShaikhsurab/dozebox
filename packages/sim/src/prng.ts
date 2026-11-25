// Seeded, dependency-free randomness (port of legacy sim/prng.mjs, same streams). The simulator never reads
// Math.random or a wall clock, so a seed replays a run exactly. `fork(label)` derives an independent stream: adding a
// consumer in one place does not shift the draws of another.

export type Rng = {
  readonly seed: number;
  readonly next: () => number;
  /** Integer in [lo, hi]. */
  readonly int: (lo: number, hi: number) => number;
  /** A `[lo, hi]` pair, as in MEASURED. */
  readonly range: (r: readonly [number, number]) => number;
  readonly chance: (p: number) => boolean;
  readonly fork: (label: string) => Rng;
};

const hash = (text: string): number => {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};

// sfc32: small, fast, passes the usual statistical batteries.
const sfc32 = (a0: number, b0: number, c0: number, d0: number): (() => number) => {
  let a = a0;
  let b = b0;
  let c = c0;
  let d = d0;
  return () => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    const t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    const r = (t + d) | 0;
    c = (c + r) | 0;
    return (r >>> 0) / 4294967296;
  };
};

export function createRng(seed: number, path = ""): Rng {
  const key = `${seed}/${path}`;
  const next = sfc32(hash(`${key}#a`), hash(`${key}#b`), hash(`${key}#c`), hash(`${key}#d`));
  for (let i = 0; i < 12; i += 1) next();
  return {
    seed,
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    range: ([lo, hi]) => lo + Math.floor(next() * (hi - lo + 1)),
    chance: (p) => next() < p,
    fork: (label) => createRng(seed, `${path}/${label}`),
  };
}
