// Interop regression test: node:crypto (sync script) <-> Web Crypto (browser).
// The test passphrase is random, generated in memory, and never written anywhere.
// Run: node scripts/selftest_crypto.mjs
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import * as node from './crypto.mjs';
import * as web from '../crypto-web.js';

const passphrase = randomBytes(24).toString('hex');
const sample = {
  schema: 1,
  type: 'notes',
  title: '中文与符号测试 · «» — ①②③',
  body: '第一行\n第二行 **粗体** `code`\n> 引用',
  nested: { list: [1, 2, 3], flag: true, empty: null },
};

async function main() {
  const meta = node.createVault(passphrase);

  const webOpened = await web.openVault(meta, passphrase);
  assert.ok(webOpened.key, 'web should open a node-created vault');
  console.log('PASS  node.createVault -> web.openVault');

  await assert.rejects(
    () => web.openVault(meta, passphrase + 'x'),
    /mismatch|decrypt|operation/i,
  );
  console.log('PASS  wrong passphrase rejected by web.openVault');
  await assert.rejects(
    () => Promise.resolve().then(() => node.openVault(meta, passphrase + 'x')),
    /mismatch|decrypt|auth/i,
  );

  const nodeKey = node.openVault(meta, passphrase);
  const envFromNode = node.encryptJSON(sample, nodeKey.key, nodeKey.salt);
  const backOnWeb = await web.decryptJSON(envFromNode, webOpened.key);
  assert.deepEqual(backOnWeb, sample);
  console.log('PASS  node.encryptJSON -> web.decryptJSON (UTF-8 round trip)');

  const envFromWeb = await web.encryptJSON(sample, webOpened.key, webOpened.salt);
  const backOnNode = node.decryptJSON(envFromWeb, nodeKey.key);
  assert.deepEqual(backOnNode, sample);
  console.log('PASS  web.encryptJSON -> node.decryptJSON (UTF-8 round trip)');

  const again = await web.encryptJSON(sample, webOpened.key, webOpened.salt);
  assert.notEqual(again.iv, envFromWeb.iv, 'IV must never be reused');
  console.log('PASS  IV is fresh on every encryption');

  const tampered = { ...envFromWeb, ct: envFromWeb.ct.slice(0, -8) + 'AAAAAAAA' };
  await assert.rejects(() => web.decryptJSON(tampered, webOpened.key));
  console.log('PASS  tampered ciphertext rejected (GCM auth tag)');

  assert.equal(meta.salt, envFromNode.salt, 'envelope carries the shared vault salt');
  assert.ok(!JSON.stringify(meta).includes(passphrase), 'vault descriptor contains no passphrase');
  console.log('PASS  vault descriptor is free of passphrase material');

  console.log('\nAll crypto interop checks passed.');
}

main().catch((e) => { console.error('FAIL', e); process.exit(1); });
