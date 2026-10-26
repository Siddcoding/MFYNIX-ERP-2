/* =========================================================================
   BRANDING
   -------------------------------------------------------------------------
   What the app chrome needs to draw itself: the company's name and its logo,
   if they have uploaded one. Deliberately a separate, slim endpoint rather
   than reusing /admin/company - that returns the whole company row including
   the bank account number, and every page in the app would be fetching it
   just to put a picture in the sidebar.

   The product's own Mfynix mark is the fallback and lives in the frontend as
   a static file, so a company that has not uploaded anything still gets a
   branded app rather than a placeholder box.
   ========================================================================= */
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const c = db.prepare(
    'SELECT CompanyName, LogoDataUrl, GSTIN, State, Phone, Email, Website FROM Company WHERE CompanyID = ?'
  ).get(req.user.companyId);
  if (!c) return res.status(404).json({ error: 'Company not found' });

  res.json({
    companyName: c.CompanyName,
    logoDataUrl: c.LogoDataUrl || null,      // null = fall back to the Mfynix mark
    hasCustomLogo: !!c.LogoDataUrl,
    gstin: c.GSTIN || null,
    state: c.State || null,
    phone: c.Phone || null,
    email: c.Email || null,
    website: c.Website || null
  });
});

module.exports = router;
