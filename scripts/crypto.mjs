// Node-side crypto. Must stay byte-compatible with the Web Crypto code in app.js.
// PBKDF2-HMAC-SHA256 / 600000 iterations / AES-GCM-256 / 12-byte IV / 128-bit tag.
import { randomBytes, pbkdf2Sync, createCipheriv, createDecipheriv } from 'node:crypto';

export const VAULT_VERSION = 1;
export const KDF = 'PBKDF2-HMAC-SHA256';
export const ITERATIONS = 600000;
export const ALG = 'AES-GCM-256';
export const SALT_BYTES = 16;
export const IV_BYTES = 12;
export const TAG_BYTES = 16;
export const AAD = 'reading-workbench/v1';
export const VERIFY_PLAINTEXT = 'OK';

const b64 = (buf) => Buffer.from(buf).toString('base64');
const unb64 = (s) => Buffer.from(s, 'base64');
const asSalt = (salt) => (typeof salt === 'string' ? unb64(salt) : Buffer.from(salt));

/** Derive a 32-byte AES key from a passphrase. */
export function deriveKey(passphrase, salt) {
  return pbkdf2Sync(Buffer.from(passphrase, 'utf8'), asSalt(salt), ITERATIONS, 32, 'sha256');
}

/** Encrypt any JSON-serialisable value into a self-contained envelope. */
export function encryptJSON(value, key, salt) {
  const saltBuf = asSalt(salt);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(AAD, 'utf8'));
  const body = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(value), 'utf8')),
    cipher.final(),
  ]);
  return {
    v: VAULT_VERSION,
    kdf: KDF,
    iter: ITERATIONS,
    alg: ALG,
    salt: b64(saltBuf),
    iv: b64(iv),
    aad: AAD,
    ct: b64(Buffer.concat([body, cipher.getAuthTag()])),
  };
}

/** Decrypt an envelope. Throws on a wrong passphrase or tampered ciphertext. */
export function decryptJSON(env, key) {
  if (!env || env.v !== VAULT_VERSION) throw new Error('unsupported envelope version');
  if (env.iter !== ITERATIONS || env.alg !== ALG) throw new Error('unsupported envelope parameters');
  const combined = unb64(env.ct);
  if (combined.length < TAG_BYTES) throw new Error('truncated ciphertext');
  const tag = combined.subarray(combined.length - TAG_BYTES);
  const body = combined.subarray(0, combined.length - TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, unb64(env.iv), { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(env.aad || AAD, 'utf8'));
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(body), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

/** Create a fresh vault descriptor. The passphrase is never stored, only a verification block. */
export function createVault(passphrase) {
  const salt = randomBytes(SALT_BYTES);
  const key = deriveKey(passphrase, salt);
  return {
    v: VAULT_VERSION,
    kdf: KDF,
    iter: ITERATIONS,
    alg: ALG,
    salt: b64(salt),
    aad: AAD,
    verify: encryptJSON(VERIFY_PLAINTEXT, key, salt),
  };
}

/** Check a passphrase against a vault descriptor. Returns the derived key on success. */
export function openVault(meta, passphrase) {
  if (!meta || meta.v !== VAULT_VERSION) throw new Error('unsupported vault version');
  if (meta.iter !== ITERATIONS || meta.alg !== ALG) throw new Error('unsupported vault parameters');
  const salt = unb64(meta.salt);
  const key = deriveKey(passphrase, salt);
  if (decryptJSON(meta.verify, key) !== VERIFY_PLAINTEXT) throw new Error('passphrase mismatch');
  return { key, salt };
}
