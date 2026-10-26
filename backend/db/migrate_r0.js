/**
 * Release R0 (Stabilise) schema additions.
 * Idempotent: every statement is CREATE IF NOT EXISTS or a guarded ALTER, so it
 * upgrades an existing database in place and is a no-op on a current one.
 */
module.exports = function migrateR0(db) {
  const ensureColumn = (table, column, definition) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  };

  // ROL-01 / PLT-09: forced change at first sign-in, lockout, idle timeout.
  ensureColumn('Users', 'MustChangePassword', 'INTEGER DEFAULT 0');
  ensureColumn('Users', 'FailedLogins', 'INTEGER DEFAULT 0');
  ensureColumn('Users', 'LockedUntil', 'TEXT');
  ensureColumn('Users', 'LastActivity', 'TEXT');
  ensureColumn('Users', 'PasswordChangedAt', 'TEXT');

  // EIN-01: older databases carried "HYD/INV" style prefixes producing 22-character
  // numbers. Series that have not issued anything yet are moved to the compact form.
  db.prepare("UPDATE DocumentSequence SET Prefix = REPLACE(Prefix, '/', '-') WHERE Prefix LIKE '%/%' AND NextNumber = 1").run();
  db.prepare("UPDATE DocumentSequence SET Padding = 5 WHERE Padding = 6 AND NextNumber = 1").run();

  // PLT-08: messaging providers, templates and delivery log.
  db.exec(`
    CREATE TABLE IF NOT EXISTS MessageProvider (
      ProviderID  INTEGER PRIMARY KEY AUTOINCREMENT,
      CompanyID   INTEGER NOT NULL,
      Channel     TEXT NOT NULL,            -- Email / SMS / WhatsApp
      Kind        TEXT NOT NULL,            -- smtp / http
      Name        TEXT,
      ConfigJson  TEXT NOT NULL DEFAULT '{}',
      IsActive    INTEGER DEFAULT 1,
      UpdatedAt   TEXT DEFAULT (datetime('now')),
      UNIQUE(CompanyID, Channel)
    );
    CREATE TABLE IF NOT EXISTS MessageTemplate (
      TemplateID  INTEGER PRIMARY KEY AUTOINCREMENT,
      CompanyID   INTEGER NOT NULL,
      Code        TEXT NOT NULL,            -- PASSWORD_RESET, DUNNING_1, PORTAL_INVITE ...
      Channel     TEXT NOT NULL DEFAULT 'Email',
      Subject     TEXT,
      Body        TEXT NOT NULL,
      UpdatedAt   TEXT DEFAULT (datetime('now')),
      UNIQUE(CompanyID, Code, Channel)
    );
    CREATE TABLE IF NOT EXISTS MessageLog (
      MessageID   INTEGER PRIMARY KEY AUTOINCREMENT,
      CompanyID   INTEGER,
      Channel     TEXT NOT NULL,
      ToAddress   TEXT,
      Subject     TEXT,
      Body        TEXT,
      TemplateCode TEXT,
      Status      TEXT NOT NULL,            -- Sent / Failed / NotSent
      Detail      TEXT,
      RefType     TEXT,
      RefID       INTEGER,
      Sensitive   INTEGER DEFAULT 0,        -- body hidden in the UI (password resets)
      CreatedAt   TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS BackupLog (
      BackupID    INTEGER PRIMARY KEY AUTOINCREMENT,
      FileName    TEXT NOT NULL,
      SizeBytes   INTEGER,
      Verified    INTEGER DEFAULT 0,
      Detail      TEXT,
      Trigger     TEXT,                     -- scheduled / manual
      CreatedAt   TEXT DEFAULT (datetime('now'))
    );
  `);
};
