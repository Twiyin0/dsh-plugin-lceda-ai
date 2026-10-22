// On-disk cache for component-library lookups.
//
// Building a board asks for the same symbols over and over (one resistor symbol
// for every 0603 resistor), and every lookup used to be a network round trip.
// Cached files are plain JSON so they can be inspected, copied between machines,
// or seeded by hand:
//
//   <cacheDir>/std/<uuid>.json      one component document
//   <cacheDir>/search/<hash>.json   one keyword search result
//
// Location: $LCEDA_CACHE_DIR, else $XDG_CACHE_HOME/lceda-ai, else ~/.cache/lceda-ai.
// Set LCEDA_NO_CACHE=1 to bypass reads and writes entirely.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const DEFAULT_TTL = {
  std: 30 * 24 * 3600 * 1000,     // one component: rarely changes
  fp: 30 * 24 * 3600 * 1000,      // one footprint document
  search: 7 * 24 * 3600 * 1000,   // keyword ranking drifts, refresh weekly
};
export const CACHE_KINDS = ['std', 'fp', 'search'];

export function cacheDir() {
  if (process.env.LCEDA_CACHE_DIR) return process.env.LCEDA_CACHE_DIR;
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'lceda-ai');
}

export const cacheDisabled = () => process.env.LCEDA_NO_CACHE === '1' || process.env.LCEDA_NO_CACHE === 'true';

const hash = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');
const fileFor = (kind, key) => path.join(cacheDir(), kind, kind === 'search' ? `${hash(key)}.json` : `${key}.json`);

/** Read one cache entry, or null when missing / expired / disabled. */
export async function readCache(kind, key, { maxAgeMs = DEFAULT_TTL[kind] ?? DEFAULT_TTL.std } = {}) {
  if (cacheDisabled()) return null;
  try {
    const raw = await fs.readFile(fileFor(kind, key), 'utf8');
    const entry = JSON.parse(raw);
    if (!entry || typeof entry.savedAt !== 'number') return null;
    if (Date.now() - entry.savedAt > maxAgeMs) return null;
    return entry.data;
  } catch {
    return null;
  }
}

/** Write one cache entry; failures are ignored (a cache must never break a build). */
export async function writeCache(kind, key, data) {
  if (cacheDisabled()) return false;
  try {
    const file = fileFor(kind, key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    await fs.writeFile(tmp, JSON.stringify({ savedAt: Date.now(), key, data }), 'utf8');
    await fs.rename(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/** Count entries and total bytes per kind. */
export async function cacheStats() {
  const out = { dir: cacheDir(), disabled: cacheDisabled(), kinds: {} };
  for (const kind of CACHE_KINDS) {
    const dir = path.join(cacheDir(), kind);
    let names = [];
    try { names = await fs.readdir(dir); } catch { /* empty */ }
    let bytes = 0;
    for (const name of names) {
      try { bytes += (await fs.stat(path.join(dir, name))).size; } catch { /* skip */ }
    }
    out.kinds[kind] = { entries: names.length, bytes };
  }
  out.totalBytes = Object.values(out.kinds).reduce((n, k) => n + k.bytes, 0);
  return out;
}

/** Remove every cached entry (returns how many files were deleted). */
export async function clearCache() {
  let removed = 0;
  for (const kind of CACHE_KINDS) {
    const dir = path.join(cacheDir(), kind);
    let names = [];
    try { names = await fs.readdir(dir); } catch { continue; }
    for (const name of names) {
      try { await fs.unlink(path.join(dir, name)); removed++; } catch { /* skip */ }
    }
  }
  return removed;
}
