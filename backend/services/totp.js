/**
 * Time-based one-time passwords (ROL-02), RFC 6238, with no external packages.
 * SHA-1 HMAC, 6 digits, 30-second step. A +/-1 step window absorbs clock skew.
 */
const crypto = require('crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function randomSecret(len = 20) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += B32[bytes[i] % 32];
  return out;
}

function base32Decode(s) {
  const clean = String(s).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const c of clean) bits += B32.indexOf(c).toString(2).padStart(5, '0');
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function hotp(secret, counter) {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeBigInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return (bin % 1000000).toString().padStart(6, '0');
}

/** Verify a 6-digit code against the secret, allowing +/-1 time step. */
function verify(secret, token, { window = 1, step = 30, now = Date.now() } = {}) {
  if (!secret || !/^\d{6}$/.test(String(token || '').trim())) return false;
  const counter = Math.floor(now / 1000 / step);
  for (let w = -window; w <= window; w++) {
    if (hotp(secret, counter + w) === String(token).trim()) return true;
  }
  return false;
}

/** otpauth:// URI for QR apps (Google Authenticator, Authy, …). */
function otpauthUri(secret, label, issuer = 'Mfynix') {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

function recoveryCodes(n = 8) {
  return Array.from({ length: n }, () => crypto.randomBytes(5).toString('hex'));
}

module.exports = { randomSecret, verify, hotp, otpauthUri, recoveryCodes, base32Decode };
