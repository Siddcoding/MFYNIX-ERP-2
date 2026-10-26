/**
 * GSTIN validation (MD-03): format, state code and the check character.
 * The 15th character is a checksum over the first 14 (mod-36 Luhn variant), so
 * most typing errors are caught here, not at filing time.
 */
const { stateNameForCode } = require('./tax');

const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const FORMAT = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

function checkChar(first14) {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = CHARS.indexOf(first14[i]);
    if (v < 0) return null;
    const p = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return CHARS[(36 - (sum % 36)) % 36];
}

/** Returns { ok, error?, stateCode?, pan? } */
function validateGstin(raw) {
  const g = String(raw || '').trim().toUpperCase();
  if (!g) return { ok: true, empty: true };
  if (g.length !== 15) return { ok: false, error: 'A GSTIN has exactly 15 characters' };
  if (!FORMAT.test(g)) return { ok: false, error: 'This is not in GSTIN format (2 digits, 5 letters, 4 digits, letter, entity code, Z, check character)' };
  if (!stateNameForCode(g.slice(0, 2))) return { ok: false, error: `The first two digits (${g.slice(0, 2)}) are not a GST state code` };
  if (checkChar(g.slice(0, 14)) !== g[14]) return { ok: false, error: 'The GSTIN check character does not match - one of the characters is mistyped' };
  return { ok: true, gstin: g, stateCode: g.slice(0, 2), pan: g.slice(2, 12) };
}

module.exports = { validateGstin, checkChar };
