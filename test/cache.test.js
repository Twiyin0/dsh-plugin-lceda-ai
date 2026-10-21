// The library cache must make a second lookup network-free and stay inspectable.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lceda-cache-'));
process.env.LCEDA_CACHE_DIR = tmp;
delete process.env.LCEDA_NO_CACHE;

const { readCache, writeCache, cacheStats, clearCache, cacheDir } = await import('../src/cache.js');

test('write then read a cache entry', async () => {
  assert.equal(await readCache('std', 'abc'), null);
  assert.equal(await writeCache('std', 'abc', { hello: 'world' }), true);
  assert.deepEqual(await readCache('std', 'abc'), { hello: 'world' });
  const file = path.join(cacheDir(), 'std', 'abc.json');
  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(typeof raw.savedAt, 'number');
  assert.deepEqual(raw.data, { hello: 'world' });
});

test('expired entries read as null', async () => {
  await writeCache('search', 'resistor', [{ uuid: '1' }]);
  assert.deepEqual(await readCache('search', 'resistor'), [{ uuid: '1' }]);
  assert.equal(await readCache('search', 'resistor', { maxAgeMs: -1 }), null);
});

test('stats and clear', async () => {
  const stats = await cacheStats();
  assert.equal(stats.kinds.std.entries, 1);
  assert.equal(stats.kinds.search.entries, 1);
  assert.ok(stats.totalBytes > 0);
  const removed = await clearCache();
  assert.equal(removed, 2);
  assert.equal((await cacheStats()).totalBytes, 0);
});

test('fetchStandard answers from the cache without any network', async () => {
  const { fetchStandard } = await import('../src/library.js');
  const uuid = 'ffffffffffffffffffffffffffffffff';
  const doc = {
    head: { docType: '2', c_para: { package: 'R0603', name: 'CACHED_R' } },
    shape: ['P~show~0~1~0~0~180~g1~0^^0 0^^M 0 0 h 10~#880000^^0~2~2~0~1~start~~~#0000FF^^0~0~0~9~1~end~~~#000080^^0~0~0'],
    canvas: 'CA~1000~1000~#FFFFFF~yes~#CCCCCC~5~1000~1000~line~5~pixel~5~0~0',
    BBox: { x: -10, y: -10, width: 20, height: 20 },
  };
  await writeCache('std', uuid, doc);
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('network must not be used when the cache hits'); };
  try {
    const part = await fetchStandard(uuid);
    assert.equal(part.doc.head.c_para.name, 'CACHED_R');
    assert.equal(part.doc.head.c_para.package, 'R0603');
  } finally {
    globalThis.fetch = realFetch;
  }
});
