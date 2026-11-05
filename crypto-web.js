// Browser-side Web Crypto implementation. Also importable from Node 22 for interop tests.
// Byte-compatible with scripts/crypto.mjs on purpose: both sides share the envelope format.
export const VAULT_VERSION = 1;
export const KDF = 'PBKDF2-HMAC-SHA256';
export const ITERATIONS = 600000;
export const ALG = 'AES-GCM-256';
export const SALT_BYTES = 16;
export const IV_BYTES = 12;
export const AAD = 'reading-workbench/v1';
export const VERIFY_PLAINTEXT = 'OK';

const enc = new TextEncoder();
const dec = new TextDecoder();
const subtle = () => globalThis.crypto.subtle;

export function b64encode(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function b64decode(s) {
  const bin = atob(String(s).replace(/\s/g, ''));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function saltBytes(salt) {
  return typeof salt === 'string' ? b64decode(salt) : new Uint8Array(salt);
}

export async function deriveKey(passphrase, salt) {
  const material = await subtle().importKey(
    'raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey'],
  );
  return subtle().deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes(salt), iterations: ITERATIONS },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptJSON(value, key, salt) {
  const sb = saltBytes(salt);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const out = await subtle().encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(AAD), tagLength: 128 },
    key,
    enc.encode(JSON.stringify(value)),
  );
  return {
    v: VAULT_VERSION, kdf: KDF, iter: ITERATIONS, alg: ALG,
    salt: b64encode(sb), iv: b64encode(iv), aad: AAD,
    ct: b64encode(new Uint8Array(out)),
  };
}

export async function decryptJSON(env, key) {
  if (!env || env.v !== VAULT_VERSION) throw new Error('unsupported envelope version');
  if (env.iter !== ITERATIONS || env.alg !== ALG) throw new Error('unsupported envelope parameters');
  const out = await subtle().decrypt(
    {
      name: 'AES-GCM',
      iv: b64decode(env.iv),
      additionalData: enc.encode(env.aad || AAD),
      tagLength: 128,
    },
    key,
    b64decode(env.ct),
  );
  return JSON.parse(dec.decode(out));
}

export async function openVault(meta, passphrase) {
  if (!meta || meta.v !== VAULT_VERSION) throw new Error('unsupported vault version');
  if (meta.iter !== ITERATIONS || meta.alg !== ALG) throw new Error('unsupported vault parameters');
  const salt = b64decode(meta.salt);
  const key = await deriveKey(passphrase, salt);
  if ((await decryptJSON(meta.verify, key)) !== VERIFY_PLAINTEXT) {
    throw new Error('passphrase mismatch');
  }
  return { key, salt };
}
