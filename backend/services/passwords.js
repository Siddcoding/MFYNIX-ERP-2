/** One password policy for every place a password can be set (ROL-01). */
const MIN_LENGTH = 8;

/** Returns an error message, or null when the password is acceptable. */
function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < MIN_LENGTH) return `Password must be at least ${MIN_LENGTH} characters`;
  if (pw.length > 128) return 'Password must be at most 128 characters';
  if (/^\s+$/.test(pw)) return 'Password cannot be only spaces';
  return null;
}

module.exports = { MIN_LENGTH, checkPassword };
