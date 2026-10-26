const express = require('express');
const db = require('../db');
const { requireAuth, resolveBranchScope } = require('../middleware/auth');
const { logAudit } = require('./auth');
const { postJournalEntry } = require('./accounts');

const router = express.Router();
router.use(requireAuth);

// HR/payroll is sensitive: salary data is visible only to these roles.
// A Branch Manager can run payroll for their own branch (and is branch-locked
// by resolveBranchScope), but a Sales Executive or Cashier never sees it.
const PAYROLL_ROLES = ['Super Admin', 'Company Admin', 'Accountant', 'Branch Manager', 'Auditor'];
router.use((req, res, next) => {
  if (!PAYROLL_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'You do not have access to Payroll' });
  }
  next();
});
function requireWriteRights(req, res, next) {
  if (req.user.role === 'Auditor') return res.status(403).json({ error: 'Auditor access is read-only' });
  next();
}

function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
function validPeriod(p) { return typeof p === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(p); }

// ---- Statutory rates (Indian payroll defaults, kept in one place so a
// ---- client whose rates differ changes them here, not across the codebase) ----
const PF_RATE = 0.12;            // employee PF contribution
const PF_WAGE_CEILING = 15000;   // PF is computed on Basic capped at this
const ESI_RATE = 0.0075;         // employee ESI contribution
const ESI_GROSS_CEILING = 21000; // ESI applies only if gross <= this
const OVERTIME_HOURLY_DIVISOR = 26 * 8; // monthly basic -> hourly rate

function getAccountId(companyId, code) {
  const row = db.prepare('SELECT AccountID FROM ChartOfAccounts WHERE CompanyID = ? AND AccountCode = ?').get(companyId, code);
  if (!row) throw new Error(`Chart of Accounts is missing required account ${code} - cannot post the payroll entry`);
  return row.AccountID;
}

/**
 * Computes one employee's payslip for a period. Pure function of the employee
 * row + attendance, so the same numbers come out whether you're previewing the
 * run or actually posting it (the preview endpoint and the post endpoint both
 * call this - they can't drift apart).
 */
function computePayslip(emp, attendance) {
  const workingDays = attendance ? attendance.WorkingDays : 26;
  const presentDays = attendance ? attendance.PresentDays : workingDays;
  const overtimeHours = attendance ? (attendance.OvertimeHours || 0) : 0;

  // Pro-rata on attendance. Guard against a zero/absent WorkingDays making this
  // divide by zero - fall back to paying the full month rather than NaN.
  const ratio = workingDays > 0 ? Math.min(1, presentDays / workingDays) : 1;

  const basic = round2(emp.Basic * ratio);
  const hra = round2(emp.HRA * ratio);
  const allowances = round2(emp.Allowances * ratio);
  const overtime = round2((emp.Basic / OVERTIME_HOURLY_DIVISOR) * overtimeHours);
  const gross = round2(basic + hra + allowances + overtime);

  const pf = emp.PFApplicable ? round2(Math.min(basic, PF_WAGE_CEILING) * PF_RATE) : 0;
  const esi = (emp.ESIApplicable && gross <= ESI_GROSS_CEILING) ? round2(gross * ESI_RATE) : 0;
  const tds = round2(emp.MonthlyTDS || 0);
  const deductions = round2(pf + esi + tds);
  const netPay = round2(gross - deductions);

  return {
    employeeId: emp.EmployeeID, empCode: emp.EmpCode, fullName: emp.FullName,
    designation: emp.Designation, branchId: emp.BranchID,
    workingDays, presentDays, overtimeHours,
    basic, hra, allowances, overtime, gross,
    pf, esi, tds, deductions, netPay
  };
}

// ---------------- Employees ----------------

router.get('/employees', (req, res) => {
  const branchId = resolveBranchScope(req);
  const rows = db.prepare(
    `SELECT e.*, b.BranchName, b.BranchCode FROM Employee e JOIN Branch b ON b.BranchID = e.BranchID
     WHERE e.CompanyID = ? AND e.IsActive = 1 ${branchId ? 'AND e.BranchID = ?' : ''}
     ORDER BY e.EmpCode`
  ).all(...(branchId ? [req.user.companyId, branchId] : [req.user.companyId]));
  res.json(rows);
});

// Branch-wise employee codes, e.g. HYD-E001 - mirrors the invoice numbering pattern.
function nextEmpCode(branchId) {
  const branch = db.prepare('SELECT BranchCode FROM Branch WHERE BranchID = ?').get(branchId);
  const count = db.prepare('SELECT COUNT(*) AS c FROM Employee WHERE BranchID = ?').get(branchId).c;
  return `${branch.BranchCode}-E${String(count + 1).padStart(3, '0')}`;
}

router.post('/employees', requireWriteRights, (req, res) => {
  const branchId = req.user.branchId || req.body.branchId;
  if (!branchId) return res.status(400).json({ error: 'branchId is required (head-office users must specify one)' });

  const { fullName, designation, department, mobile, email, pan, bankAccount, ifsc,
          dateOfJoining, basic, hra, allowances, pfApplicable, esiApplicable, monthlyTDS } = req.body;
  if (!fullName || !(Number(basic) > 0)) {
    return res.status(400).json({ error: 'fullName and a basic salary greater than zero are required' });
  }

  try {
    const result = db.prepare(
      `INSERT INTO Employee (CompanyID, BranchID, EmpCode, FullName, Designation, Department, Mobile, Email,
                             PAN, BankAccount, IFSC, DateOfJoining, Basic, HRA, Allowances,
                             PFApplicable, ESIApplicable, MonthlyTDS)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(req.user.companyId, branchId, nextEmpCode(branchId), fullName, designation || null, department || null,
          mobile || null, email || null, pan || null, bankAccount || null, ifsc || null, dateOfJoining || null,
          Number(basic), Number(hra || 0), Number(allowances || 0),
          pfApplicable === false ? 0 : 1, esiApplicable === false ? 0 : 1, Number(monthlyTDS || 0));

    logAudit({ companyId: req.user.companyId, branchId, userId: req.user.userId,
      action: 'CREATE_EMPLOYEE', entityType: 'Employee', entityId: result.lastInsertRowid, details: fullName, ip: req.ip });
    res.status(201).json({ employeeId: result.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ error: 'Failed to create employee: ' + e.message });
  }
});

router.put('/employees/:id', requireWriteRights, (req, res) => {
  const emp = db.prepare('SELECT * FROM Employee WHERE EmployeeID = ? AND CompanyID = ?').get(req.params.id, req.user.companyId);
  if (!emp) return res.status(404).json({ error: 'Employee not found' });
  if (req.user.branchId && emp.BranchID !== req.user.branchId) {
    return res.status(403).json({ error: 'You can only edit employees of your own branch' });
  }
  const allowed = ['FullName', 'Designation', 'Department', 'Mobile', 'Email', 'PAN', 'BankAccount', 'IFSC',
                   'DateOfJoining', 'DateOfLeaving', 'Basic', 'HRA', 'Allowances', 'PFApplicable', 'ESIApplicable', 'MonthlyTDS'];
  const cols = allowed.filter(c => req.body[c] !== undefined);
  if (cols.length === 0) return res.status(400).json({ error: 'No fields provided' });
  db.prepare(`UPDATE Employee SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE EmployeeID = ?`)
    .run(...cols.map(c => req.body[c]), req.params.id);
  logAudit({ companyId: req.user.companyId, branchId: emp.BranchID, userId: req.user.userId,
    action: 'UPDATE_EMPLOYEE', entityType: 'Employee', entityId: Number(req.params.id), ip: req.ip });
  res.json({ success: true });
});

router.delete('/employees/:id', requireWriteRights, (req, res) => {
  const emp = db.prepare('SELECT * FROM Employee WHERE EmployeeID = ? AND CompanyID = ?').get(req.params.id, req.user.companyId);
  if (!emp) return res.status(404).json({ error: 'Employee not found' });
  if (req.user.branchId && emp.BranchID !== req.user.branchId) {
    return res.status(403).json({ error: 'You can only remove employees of your own branch' });
  }
  // PAY-01: deactivating records the date of leaving; past payroll stays intact.
  const leaving = (req.body && req.body.dateOfLeaving) ? String(req.body.dateOfLeaving).slice(0, 10) : new Date().toISOString().slice(0, 10);
  db.prepare('UPDATE Employee SET IsActive = 0, DateOfLeaving = ? WHERE EmployeeID = ?').run(leaving, req.params.id);
  logAudit({ companyId: req.user.companyId, branchId: emp.BranchID, userId: req.user.userId,
    action: 'DEACTIVATE_EMPLOYEE', entityType: 'Employee', entityId: Number(req.params.id), details: `left ${leaving}`, ip: req.ip });
  res.json({ success: true, dateOfLeaving: leaving });
});

// ---------------- Attendance ----------------

router.get('/attendance', (req, res) => {
  const period = req.query.period;
  if (!validPeriod(period)) return res.status(400).json({ error: 'period must be in YYYY-MM format' });
  const branchId = resolveBranchScope(req);

  // Every active employee appears, with their attendance row if one exists -
  // so the UI can show a full editable grid rather than only saved rows.
  const rows = db.prepare(
    `SELECT e.EmployeeID, e.EmpCode, e.FullName, e.BranchID, b.BranchName,
            a.AttendanceID, a.WorkingDays, a.PresentDays, a.LeaveDays, a.OvertimeHours
     FROM Employee e
     JOIN Branch b ON b.BranchID = e.BranchID
     LEFT JOIN Attendance a ON a.EmployeeID = e.EmployeeID AND a.Period = ?
     WHERE e.CompanyID = ? AND e.IsActive = 1 ${branchId ? 'AND e.BranchID = ?' : ''}
     ORDER BY e.EmpCode`
  ).all(...(branchId ? [period, req.user.companyId, branchId] : [period, req.user.companyId]));

  res.json(rows.map(r => ({
    ...r,
    WorkingDays: r.WorkingDays === null ? 26 : r.WorkingDays,
    PresentDays: r.PresentDays === null ? 26 : r.PresentDays,
    LeaveDays: r.LeaveDays || 0,
    OvertimeHours: r.OvertimeHours || 0,
    saved: r.AttendanceID !== null
  })));
});

// Upsert attendance for one period. body: { period, rows: [{employeeId, workingDays, presentDays, leaveDays, overtimeHours}] }
router.post('/attendance', requireWriteRights, (req, res) => {
  const { period, rows } = req.body;
  if (!validPeriod(period)) return res.status(400).json({ error: 'period must be in YYYY-MM format' });
  if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: 'At least one attendance row is required' });

  for (const r of rows) {
    if (!r.employeeId) return res.status(400).json({ error: 'Each row needs an employeeId' });
    if (Number(r.presentDays) > Number(r.workingDays)) {
      return res.status(400).json({ error: `Present days cannot exceed working days (employee ${r.employeeId})` });
    }
  }

  // A locked (already-posted) payroll must not have its inputs changed underneath it.
  const locked = db.prepare('SELECT COUNT(*) AS c FROM PayrollRun WHERE CompanyID = ? AND Period = ?').get(req.user.companyId, period).c;

  const tx = db.transaction(() => {
    const upsert = db.prepare(
      `INSERT INTO Attendance (CompanyID, BranchID, EmployeeID, Period, WorkingDays, PresentDays, LeaveDays, OvertimeHours)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(EmployeeID, Period) DO UPDATE SET
         WorkingDays=excluded.WorkingDays, PresentDays=excluded.PresentDays,
         LeaveDays=excluded.LeaveDays, OvertimeHours=excluded.OvertimeHours`
    );
    rows.forEach(r => {
      const emp = db.prepare('SELECT BranchID FROM Employee WHERE EmployeeID = ? AND CompanyID = ?').get(r.employeeId, req.user.companyId);
      if (!emp) throw new Error(`Employee ${r.employeeId} not found`);
      if (req.user.branchId && emp.BranchID !== req.user.branchId) {
        throw new Error('You can only record attendance for your own branch');
      }
      const runExists = db.prepare('SELECT COUNT(*) AS c FROM PayrollRun WHERE BranchID = ? AND Period = ?').get(emp.BranchID, period).c;
      if (runExists > 0) throw new Error(`Payroll for ${period} has already been posted for this branch - attendance is locked`);

      upsert.run(req.user.companyId, emp.BranchID, r.employeeId, period,
        Number(r.workingDays ?? 26), Number(r.presentDays ?? 26), Number(r.leaveDays || 0), Number(r.overtimeHours || 0));
    });
  });

  try {
    tx();
    res.json({ success: true, lockedRunsExisting: locked });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------------- Payroll run ----------------

// Preview: compute the payslips without saving anything. Same math as posting.
router.get('/preview', (req, res) => {
  const period = req.query.period;
  if (!validPeriod(period)) return res.status(400).json({ error: 'period must be in YYYY-MM format' });
  const branchId = req.user.branchId || (req.query.branchId ? Number(req.query.branchId) : null);
  if (!branchId) return res.status(400).json({ error: 'branchId is required - payroll is run one branch at a time' });

  const employees = db.prepare('SELECT * FROM Employee WHERE CompanyID = ? AND BranchID = ? AND IsActive = 1 ORDER BY EmpCode')
    .all(req.user.companyId, branchId);
  const attStmt = db.prepare('SELECT * FROM Attendance WHERE EmployeeID = ? AND Period = ?');

  const payslips = employees.map(e => computePayslip(e, attStmt.get(e.EmployeeID, period)));
  const totals = payslips.reduce((t, p) => ({
    gross: round2(t.gross + p.gross), pf: round2(t.pf + p.pf), esi: round2(t.esi + p.esi),
    tds: round2(t.tds + p.tds), deductions: round2(t.deductions + p.deductions), netPay: round2(t.netPay + p.netPay)
  }), { gross: 0, pf: 0, esi: 0, tds: 0, deductions: 0, netPay: 0 });

  const alreadyPosted = db.prepare('SELECT PayrollRunID, Status FROM PayrollRun WHERE BranchID = ? AND Period = ?').get(branchId, period);

  res.json({ period, branchId, payslips, totals, employeeCount: payslips.length, alreadyPosted: alreadyPosted || null });
});

// Post the run: saves payslips AND posts the accounting entry in one transaction.
router.post('/run', requireWriteRights, (req, res) => {
  const { period } = req.body;
  if (!validPeriod(period)) return res.status(400).json({ error: 'period must be in YYYY-MM format' });
  const branchId = req.user.branchId || (req.body.branchId ? Number(req.body.branchId) : null);
  if (!branchId) return res.status(400).json({ error: 'branchId is required - payroll is run one branch at a time' });

  const existing = db.prepare('SELECT PayrollRunID FROM PayrollRun WHERE BranchID = ? AND Period = ?').get(branchId, period);
  if (existing) return res.status(409).json({ error: `Payroll for ${period} has already been posted for this branch` });

  const employees = db.prepare('SELECT * FROM Employee WHERE CompanyID = ? AND BranchID = ? AND IsActive = 1 ORDER BY EmpCode')
    .all(req.user.companyId, branchId);
  if (employees.length === 0) return res.status(400).json({ error: 'This branch has no active employees to pay' });

  const tx = db.transaction(() => {
    const attStmt = db.prepare('SELECT * FROM Attendance WHERE EmployeeID = ? AND Period = ?');
    const payslips = employees.map(e => computePayslip(e, attStmt.get(e.EmployeeID, period)));

    const totals = payslips.reduce((t, p) => ({
      gross: t.gross + p.gross, pf: t.pf + p.pf, esi: t.esi + p.esi,
      tds: t.tds + p.tds, deductions: t.deductions + p.deductions, netPay: t.netPay + p.netPay
    }), { gross: 0, pf: 0, esi: 0, tds: 0, deductions: 0, netPay: 0 });

    const runId = db.prepare(
      `INSERT INTO PayrollRun (CompanyID, BranchID, Period, GrossTotal, DeductionTotal, NetTotal, EmployeeCount, CreatedBy)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(req.user.companyId, branchId, period, round2(totals.gross), round2(totals.deductions),
          round2(totals.netPay), payslips.length, req.user.userId).lastInsertRowid;

    const insertDetail = db.prepare(
      `INSERT INTO PayrollDetail (PayrollRunID, EmployeeID, WorkingDays, PresentDays, Basic, HRA, Allowances,
                                  Overtime, Gross, PF, ESI, TDS, Deductions, NetPay)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    payslips.forEach(p => insertDetail.run(runId, p.employeeId, p.workingDays, p.presentDays, p.basic, p.hra,
      p.allowances, p.overtime, p.gross, p.pf, p.esi, p.tds, p.deductions, p.netPay));

    // Accounting entry, in the same transaction as the run:
    //   Dr Salaries & Wages           (gross cost to the company)
    //     Cr PF Payable / ESI Payable / TDS Payable   (statutory dues withheld)
    //     Cr Salaries Payable                          (what the staff are owed)
    // Gross always equals PF + ESI + TDS + Net, so this balances by construction -
    // and postJournalEntry re-checks it anyway before writing.
    const lines = [{ accountId: getAccountId(req.user.companyId, '5100'), debit: round2(totals.gross), credit: 0 }];
    const credit = (code, amount) => { if (amount > 0) lines.push({ accountId: getAccountId(req.user.companyId, code), debit: 0, credit: round2(amount) }); };
    credit('2210', totals.pf);
    credit('2220', totals.esi);
    credit('2230', totals.tds);
    credit('2200', totals.netPay);

    const journalId = postJournalEntry(db, {
      companyId: req.user.companyId, branchId,
      entryDate: `${period}-01`,
      narration: `Payroll for ${period} (${payslips.length} employees)`,
      sourceType: 'Payroll', sourceId: runId, createdBy: req.user.userId, lines
    });
    db.prepare('UPDATE PayrollRun SET JournalID = ? WHERE PayrollRunID = ?').run(journalId, runId);

    logAudit({ companyId: req.user.companyId, branchId, userId: req.user.userId,
      action: 'POST_PAYROLL', entityType: 'PayrollRun', entityId: runId,
      details: `${period} gross ${round2(totals.gross)}`, ip: req.ip });

    return { payrollRunId: runId, journalId, employeeCount: payslips.length, netTotal: round2(totals.netPay) };
  });

  try {
    res.status(201).json(tx());
  } catch (e) {
    res.status(400).json({ error: 'Payroll run failed: ' + e.message });
  }
});

// Mark a posted run as paid: Dr Salaries Payable / Cr Bank.
router.post('/runs/:id/pay', requireWriteRights, (req, res) => {
  const run = db.prepare('SELECT * FROM PayrollRun WHERE PayrollRunID = ? AND CompanyID = ?').get(req.params.id, req.user.companyId);
  if (!run) return res.status(404).json({ error: 'Payroll run not found' });
  if (run.Status === 'Paid') return res.status(409).json({ error: 'This payroll run is already marked as paid' });
  if (req.user.branchId && run.BranchID !== req.user.branchId) {
    return res.status(403).json({ error: 'You can only pay payroll for your own branch' });
  }

  const tx = db.transaction(() => {
    postJournalEntry(db, {
      companyId: req.user.companyId, branchId: run.BranchID, entryDate: new Date().toISOString().slice(0, 10),
      narration: `Salary payment for ${run.Period}`, sourceType: 'PayrollPayment', sourceId: run.PayrollRunID,
      createdBy: req.user.userId,
      lines: [
        { accountId: getAccountId(req.user.companyId, '2200'), debit: run.NetTotal, credit: 0 },
        { accountId: getAccountId(req.user.companyId, '1010'), debit: 0, credit: run.NetTotal }
      ]
    });
    db.prepare(`UPDATE PayrollRun SET Status = 'Paid' WHERE PayrollRunID = ?`).run(run.PayrollRunID);
  });

  try {
    tx();
    logAudit({ companyId: req.user.companyId, branchId: run.BranchID, userId: req.user.userId,
      action: 'PAY_PAYROLL', entityType: 'PayrollRun', entityId: run.PayrollRunID, ip: req.ip });
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/runs', (req, res) => {
  const branchId = resolveBranchScope(req);
  const rows = db.prepare(
    `SELECT r.*, b.BranchName, b.BranchCode FROM PayrollRun r JOIN Branch b ON b.BranchID = r.BranchID
     WHERE r.CompanyID = ? ${branchId ? 'AND r.BranchID = ?' : ''}
     ORDER BY r.Period DESC, r.PayrollRunID DESC`
  ).all(...(branchId ? [req.user.companyId, branchId] : [req.user.companyId]));
  res.json(rows);
});

// Payslips for one posted run.
router.get('/runs/:id', (req, res) => {
  const run = db.prepare(
    `SELECT r.*, b.BranchName, b.BranchCode FROM PayrollRun r JOIN Branch b ON b.BranchID = r.BranchID
     WHERE r.PayrollRunID = ? AND r.CompanyID = ?`
  ).get(req.params.id, req.user.companyId);
  if (!run) return res.status(404).json({ error: 'Payroll run not found' });
  if (req.user.branchId && run.BranchID !== req.user.branchId) {
    return res.status(403).json({ error: 'You can only view payroll for your own branch' });
  }
  const payslips = db.prepare(
    `SELECT d.*, e.EmpCode, e.FullName, e.Designation, e.PAN, e.BankAccount
     FROM PayrollDetail d JOIN Employee e ON e.EmployeeID = d.EmployeeID
     WHERE d.PayrollRunID = ? ORDER BY e.EmpCode`
  ).all(req.params.id);
  res.json({ run, payslips });
});

// ---------------- Statutory registers ----------------
// PF/ESI/TDS totals per branch for a period - what gets filed with EPFO/ESIC.
router.get('/statutory', (req, res) => {
  const period = req.query.period;
  if (!validPeriod(period)) return res.status(400).json({ error: 'period must be in YYYY-MM format' });
  const branchId = resolveBranchScope(req);

  const rows = db.prepare(
    `SELECT b.BranchName, b.BranchCode, r.Period,
            SUM(d.Gross) AS Gross, SUM(d.PF) AS PF, SUM(d.ESI) AS ESI, SUM(d.TDS) AS TDS,
            SUM(d.NetPay) AS NetPay, COUNT(*) AS Employees
     FROM PayrollDetail d
     JOIN PayrollRun r ON r.PayrollRunID = d.PayrollRunID
     JOIN Branch b ON b.BranchID = r.BranchID
     WHERE r.CompanyID = ? AND r.Period = ? ${branchId ? 'AND r.BranchID = ?' : ''}
     GROUP BY r.BranchID`
  ).all(...(branchId ? [req.user.companyId, period, branchId] : [req.user.companyId, period]));

  res.json(rows);
});

module.exports = router;
