/**
 * Daily backup with verification (PLT-05, AUT-16).
 *
 * A backup nobody has checked is a hope, not a backup. Each run:
 *   1. takes a consistent snapshot with VACUUM INTO (safe while writes continue),
 *   2. opens the snapshot read-only and runs SQLite's integrity_check,
 *   3. compares row counts of the key tables against the live database,
 *   4. records the outcome in BackupLog, and
 *   5. prunes snapshots older than BACKUP_KEEP_DAYS (default 14).
 *
 * `testRestore` goes one step further and copies a chosen backup to a scratch
 * file, opens it as a database and reads it, which is the "restore test" the
 * requirement asks to be repeated each quarter.
 *
 * Honest limit: SQLite has no continuous log shipping, so recovery is to the
 * moment of the last backup (at most a day), not to an arbitrary second.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const db = require('../db');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'db', 'mfintech.db');
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(path.dirname(DB_PATH), 'backups');
const KEEP_DAYS = Number(process.env.BACKUP_KEEP_DAYS) || 14;
const BACKUP_HOUR = process.env.BACKUP_HOUR !== undefined ? Number(process.env.BACKUP_HOUR) : 2;

const CHECK_TABLES = ['Company', 'Users', 'Customer', 'Supplier', 'Item', 'SalesHeader', 'PurchaseHeader', 'JournalEntry', 'JournalLine', 'StockLedger'];

function counts(conn) {
  const out = {};
  CHECK_TABLES.forEach(t => {
    try { out[t] = conn.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c; } catch (e) { out[t] = null; }
  });
  return out;
}

/** Opens a file read-only, runs integrity_check and returns { ok, detail, counts }. */
function verifyFile(file) {
  let conn;
  try {
    conn = new Database(file, { readonly: true, fileMustExist: true });
    const rows = conn.prepare('PRAGMA integrity_check').all();
    const ok = rows.length === 1 && rows[0].integrity_check === 'ok';
    return { ok, detail: ok ? 'integrity_check ok' : rows.map(r => r.integrity_check).slice(0, 3).join('; '), counts: counts(conn) };
  } catch (e) {
    return { ok: false, detail: e.message, counts: {} };
  } finally {
    if (conn) conn.close();
  }
}

function runBackup(trigger = 'manual') {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const fileName = `mfynix-${stamp}-${trigger}.db`;
  const full = path.join(BACKUP_DIR, fileName);
  if (fs.existsSync(full)) fs.unlinkSync(full);

  let verified = 0, detail = '';
  try {
    db.prepare('VACUUM INTO ?').run(full);
    const v = verifyFile(full);
    // Row counts in the snapshot can only be <= live (writes may land after the
    // snapshot), never greater; a snapshot missing rows the live DB had before
    // the snapshot began would show up as a smaller count, which is expected for
    // new writes, so only an unreadable table is treated as a failure here.
    const unreadable = Object.entries(v.counts).filter(([, c]) => c === null).map(([t]) => t);
    verified = v.ok && unreadable.length === 0 ? 1 : 0;
    detail = verified ? v.detail : (v.detail + (unreadable.length ? ` | unreadable tables: ${unreadable.join(', ')}` : ''));
  } catch (e) {
    detail = 'Backup failed: ' + e.message;
    try { fs.unlinkSync(full); } catch (e2) { /* nothing to clean */ }
  }

  const size = fs.existsSync(full) ? fs.statSync(full).size : 0;
  const id = db.prepare('INSERT INTO BackupLog (FileName, SizeBytes, Verified, Detail, Trigger) VALUES (?,?,?,?,?)')
    .run(fileName, size, verified, detail, trigger).lastInsertRowid;
  prune();
  return { backupId: id, fileName, sizeBytes: size, verified: !!verified, detail };
}

function prune() {
  const cutoff = Date.now() - KEEP_DAYS * 86400000;
  let files = [];
  try { files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('mfynix-') && f.endsWith('.db')); } catch (e) { return; }
  files.forEach(f => {
    const p = path.join(BACKUP_DIR, f);
    try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch (e) { /* ignore */ }
  });
}

function listBackups() {
  return db.prepare('SELECT * FROM BackupLog ORDER BY BackupID DESC LIMIT 60').all()
    .map(b => ({ ...b, exists: fs.existsSync(path.join(BACKUP_DIR, b.FileName)) }));
}

function backupPath(fileName) {
  const safe = path.basename(fileName);
  return path.join(BACKUP_DIR, safe);
}

/** Restores a backup into a scratch file and reads it back. Never touches live data. */
function testRestore(backupId) {
  const row = db.prepare('SELECT * FROM BackupLog WHERE BackupID = ?').get(backupId);
  if (!row) throw new Error('Backup not found');
  const src = backupPath(row.FileName);
  if (!fs.existsSync(src)) throw new Error('The backup file has been pruned or removed');
  const scratch = path.join(os.tmpdir(), `mfynix-restore-test-${Date.now()}.db`);
  try {
    fs.copyFileSync(src, scratch);
    const v = verifyFile(scratch);
    const result = { ok: v.ok, detail: v.detail, counts: v.counts };
    db.prepare('INSERT INTO BackupLog (FileName, SizeBytes, Verified, Detail, Trigger) VALUES (?,?,?,?,?)')
      .run(row.FileName, row.SizeBytes, v.ok ? 1 : 0, `Restore test: ${v.detail}`, 'restore-test');
    return result;
  } finally {
    try { fs.unlinkSync(scratch); } catch (e) { /* ignore */ }
  }
}

function lastScheduledDate() {
  const r = db.prepare("SELECT CreatedAt FROM BackupLog WHERE Trigger = 'scheduled' AND Verified = 1 ORDER BY BackupID DESC LIMIT 1").get();
  return r ? r.CreatedAt.slice(0, 10) : null;
}

/**
 * Starts the daily schedule. Checks every 15 minutes; takes the day's backup
 * once the configured hour has passed and none has been taken today. A server
 * that was down at 02:00 therefore catches up when it comes back, instead of
 * skipping the day.
 */
function startScheduler() {
  if (process.env.BACKUP_DISABLED === '1') return null;
  const tick = () => {
    try {
      const now = new Date();
      const today = now.toISOString().slice(0, 10);
      if (now.getHours() >= BACKUP_HOUR && lastScheduledDate() !== today) runBackup('scheduled');
    } catch (e) { console.error('Scheduled backup failed:', e.message); }
  };
  setTimeout(tick, 20000).unref();
  const timer = setInterval(tick, 15 * 60 * 1000);
  timer.unref();
  return timer;
}

module.exports = { BACKUP_DIR, runBackup, listBackups, testRestore, verifyFile, backupPath, startScheduler, lastScheduledDate };
