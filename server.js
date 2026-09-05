const express = require('express');
const path = require('path');
const { buildProposals } = require('./lib/proposals');
const { updateCompany, createCompany } = require('./lib/hubspot');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Cached in memory for the process lifetime -- click "Actualizar" to refresh.
let cache = null;

app.get('/api/proposals', async (req, res) => {
  try {
    if (!cache || req.query.refresh === '1') {
      cache = await buildProposals();
    }
    res.json(cache);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// The ONLY endpoint that writes to HubSpot. Only ever called by the explicit
// "Verificar y aplicar a HubSpot" button, and only for the rows the user
// checked in the browser -- nothing here runs automatically.
app.post('/api/apply', async (req, res) => {
  const { updates } = req.body; // [{ companyId, properties }]
  if (!Array.isArray(updates) || updates.length === 0) {
    return res.status(400).json({ error: 'No updates provided' });
  }
  const results = [];
  for (const u of updates) {
    try {
      const r = await updateCompany(u.companyId, u.properties);
      results.push({ companyId: u.companyId, ok: true, result: r });
    } catch (e) {
      results.push({ companyId: u.companyId, ok: false, error: String(e.message || e) });
    }
  }
  cache = null; // force a fresh pull next time so the review reflects reality
  res.json({ results });
});

// Creates a brand-new company record (e.g. the Alcampo case: real active
// deployment, no matching company found). Same explicit-confirmation gate as
// /api/apply -- only called from the "Crear" button per unmatched client.
app.post('/api/create-company', async (req, res) => {
  try {
    const r = await createCompany(req.body.properties);
    cache = null;
    res.json({ ok: true, result: r });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Enrichment review app listening on :${port}`));
