// One-time vault setup. Run: node scripts/init_vault.mjs
// The passphrase is read interactively (hidden), never stored, never printed,
// never written into any repository file.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPassphrase } from './passphrase.mjs';
import { createVault, openVault, encryptJSON } from './crypto.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIN_LENGTH = 12;

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const out = path.resolve(arg('--out', path.join(ROOT, 'vault.meta.json')));
  const notesOut = path.resolve(arg('--notes', path.join(ROOT, 'data/notes/notes.enc')));
  const force = process.argv.includes('--force');

  if (!force && (fs.existsSync(out) || fs.existsSync(notesOut))) {
    console.error('Refusing to overwrite an existing vault. Use --force only if you accept losing access to old data.');
    process.exit(1);
  }

  const p1 = await readPassphrase('Set vault passphrase (hidden, at least 12 characters): ');
  if (p1.length < MIN_LENGTH) {
    console.error(`Passphrase too short: ${p1.length} characters. Minimum is ${MIN_LENGTH}.`);
    process.exit(1);
  }
  const p2 = await readPassphrase('Repeat passphrase: ');
  if (p1 !== p2) {
    console.error('Passphrases do not match. Nothing was written.');
    process.exit(1);
  }

  const meta = createVault(p1);
  const { key, salt } = openVault(meta, p1);
  const emptyNotes = encryptJSON(
    { schema: 1, type: 'notes', updatedAt: new Date().toISOString(), notes: [] },
    key,
    salt,
  );

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.mkdirSync(path.dirname(notesOut), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(meta, null, 2) + '\n', 'utf8');
  fs.writeFileSync(notesOut, JSON.stringify(emptyNotes) + '\n', 'utf8');

  console.log('Vault created.');
  console.log('  ' + path.relative(ROOT, out));
  console.log('  ' + path.relative(ROOT, notesOut));
  console.log('The passphrase was not stored anywhere. Losing it means the data cannot be recovered.');
  console.log('Commit both files, then run scripts/sync_weread.mjs with the same passphrase.');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
