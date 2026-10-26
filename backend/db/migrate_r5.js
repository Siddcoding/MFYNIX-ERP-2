/**
 * R5 (access control): email-based login with a self-service signup that is
 * gated by an admin allowlist.
 *
 *   - Three emails are pre-approved ("allowlisted"). When one of them signs up,
 *     the account is active immediately.
 *   - Anyone else who signs up lands as Status = 'Pending' and cannot log in
 *     until an existing admin approves them.
 *   - Approved admins can add more emails to the allowlist and approve/reject
 *     pending requests.
 *
 * Login identity is the email address. The original seeded `admin` username
 * still works as an emergency backstop (the server accepts either an email or a
 * username); the UI only ever asks for an email.
 */
const ALLOWLIST_EMAILS = [
  'siddharthmahapatro140@gmail.com',
  'manas.padhy@mfintechs.com',
  'asish.mohapatro@mfintechs.com'
];

module.exports = function migrateR5(db) {
  // The allowlist: emails that are auto-approved as admins on signup.
  db.exec(`
    CREATE TABLE IF NOT EXISTS ApprovedAdminEmail (
      ID         INTEGER PRIMARY KEY AUTOINCREMENT,
      CompanyID  INTEGER NOT NULL REFERENCES Company(CompanyID),
      Email      TEXT NOT NULL,
      AddedBy    INTEGER REFERENCES Users(UserID),
      CreatedAt  TEXT DEFAULT (datetime('now')),
      UNIQUE(CompanyID, Email)
    );
  `);

  // A place to record who approved a pending signup and when (display only).
  const col = (t, c, d) => {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map(x => x.name);
    if (!cols.includes(c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`);
  };
  col('Users', 'ApprovedBy', 'INTEGER');
  col('Users', 'ApprovedAt', 'TEXT');
  col('Users', 'SignupAt', 'TEXT');

  // Seed the three allowlisted emails for every existing company (idempotent).
  const ins = db.prepare('INSERT OR IGNORE INTO ApprovedAdminEmail (CompanyID, Email) VALUES (?, ?)');
  db.prepare('SELECT CompanyID FROM Company').all().forEach(({ CompanyID }) => {
    ALLOWLIST_EMAILS.forEach(e => ins.run(CompanyID, e.toLowerCase()));
  });

  // So an existing deployment's bootstrap admin can be reached by a real email
  // (login is by email now), point the default seeded admin at the first
  // allowlisted address - but only if it is still the untouched default, so we
  // never clobber an email someone set on purpose.
  db.prepare(
    `UPDATE Users SET Email = ? WHERE UserName = 'admin' AND (Email = 'admin@mfintech.local' OR Email IS NULL)`
  ).run(ALLOWLIST_EMAILS[0]);
};

module.exports.ALLOWLIST_EMAILS = ALLOWLIST_EMAILS;
