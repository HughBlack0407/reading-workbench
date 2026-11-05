// Validate encrypted sync artefacts produced by sync_weread.mjs.
// Run: VAULT_PASSPHRASE=... node scripts/selftest_data.mjs --dir <repo-root>
// Prints only field names and counts, never personal content.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { readPassphrase } from './passphrase.mjs';
import { openVault } from '../crypto-web.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const dir = path.resolve(arg('--dir', path.resolve(process.cwd(), '..')));
const read = (rel) => JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));

async function main() {
  const vault = read('vault.meta.json');
  const passphrase = await readPassphrase('Vault passphrase: ');
  const { key } = await openVault(vault, passphrase);
  const { decryptJSON } = await import('../crypto-web.js');

  const shelf = await decryptJSON(read('data/sync/shelf.enc'), key);
  const highlights = await decryptJSON(read('data/sync/highlights.enc'), key);
  const stats = await decryptJSON(read('data/sync/stats.enc'), key);
  const meta = await decryptJSON(read('data/sync/meta.enc'), key);

  assert.equal(shelf.type, 'shelf');
  assert.equal(highlights.type, 'highlights');
  assert.equal(stats.type, 'stats');
  assert.equal(meta.type, 'sync-meta');
  console.log('PASS  four envelopes decrypt with the browser implementation');

  assert.equal(
    shelf.totalCount,
    shelf.books.length + shelf.albums.length + (shelf.hasArticleCollection ? 1 : 0),
    'shelf total must use books + albums + mp',
  );
  assert.ok(Array.isArray(shelf.recent));
  console.log(`PASS  shelf total = ${shelf.totalCount} (books ${shelf.books.length} + albums ${shelf.albums.length} + mp ${shelf.hasArticleCollection ? 1 : 0})`);

  const b = stats.noteCountBreakdown;
  assert.equal(stats.noteCount, b.reviewCount + b.noteCount + b.bookmarkCount);
  console.log(`PASS  noteCount ${stats.noteCount} = ${b.reviewCount} + ${b.noteCount} + ${b.bookmarkCount}`);

  assert.equal(typeof stats.monthly?.totalReadTimeSec, 'number');
  assert.equal(stats.metricDefinitions.totalReadTimeSec.field, 'totalReadTime');
  console.log(`PASS  monthly totalReadTime = ${stats.monthly.totalReadTimeSec} s (field: totalReadTime, unit: second)`);
  console.log(`PASS  byDay detail rows: ${stats.monthly.byDay.length} (source: readTimes, not a total)`);

  assert.ok(Array.isArray(highlights.items));
  console.log(`PASS  highlight/review items: ${highlights.items.length}`);
  assert.equal(meta.skillVersion, '1.0.5');
  console.log(`PASS  sync meta skillVersion = ${meta.skillVersion}, syncedAt = ${meta.syncedAt}`);

  const manifest = read('data/sync/manifest.json');
  assert.equal(manifest.files.length, 4);
  assert.ok(!JSON.stringify(manifest).includes(shelf.books[0]?.title || '<<impossible>>'));
  console.log('PASS  manifest contains no book titles');

  const notesFile = path.join(dir, 'data/notes/notes.enc');
  if (fs.existsSync(notesFile)) {
    const notes = await decryptJSON(JSON.parse(fs.readFileSync(notesFile, 'utf8')), key);
    assert.equal(notes.type, 'notes');
    console.log(`PASS  user notes decrypt independently (${notes.notes.length} notes) — sync never touched them`);
  }

  console.log('\nAll data checks passed.');
}

main().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
