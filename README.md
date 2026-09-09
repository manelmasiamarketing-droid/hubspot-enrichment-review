# HubSpot Enrichment Review — nsign

Review UI for company-data enrichment proposals before anything is written to
HubSpot. Nothing is applied automatically — every write goes through the
"Verificar y aplicar a HubSpot" button (or the per-row "Crear en HubSpot"
button for unmatched clients), and only for what you've checked.

## What it does

1. Fetches every Company from HubSpot (read-only).
2. Matches each one against nsign's internal device-deployment history
   (`data/device_history_by_client.json` / `device_history_by_partner.json`,
   built from `Historial_Players_Tableau.csv.gz` — see `scripts/build_device_history.py`).
3. Proposes fills for empty fields only (never overwrites something already set):
   - `tipo_de_empresa` (Cliente Final / Partner), from whether the name matches
     an end-client or a partner/reseller group in the history.
   - `company_score` for Partners, from the real total screens they manage
     (A <2000 / AA 2000-5000 / AAA >5000 — HubSpot's own tier definition).
   - `country`.
   - A **proposed** `acceso_comercial_newsletter` value (Directo / Solo via
     Partner / exception flag) — this is NOT written to HubSpot; the property
     doesn't exist there yet. It's shown so Manel can decide whether to create
     it in HubSpot Settings, matching the "partner-first ES/PT, partner-only
     elsewhere" policy.
4. Flags policy exceptions: a direct-channel relationship (Reseller/Partner
   Group = Netipbox in the history) outside Spain/Portugal breaks the
   partner-only rule for those markets.
5. Lists active clients from the device history with no matching HubSpot
   company at all (the "Alcampo case") as one-click create candidates.

## Running locally

```bash
npm install
cp .env.example .env   # fill in HUBSPOT_TOKEN (+ HUBSPOT_PORTAL_ID)
npm start
```

Open http://localhost:3000

## Refreshing the device-history data

Re-run this whenever `Historial_Players_Tableau.csv.gz` is re-exported:

```bash
python3 scripts/build_device_history.py
```

## Deploying to Render

1. Push this folder to a GitHub repo.
2. Render → New → Web Service → connect the repo.
3. Build command: `npm install` · Start command: `npm start`.
4. Environment variables: `HUBSPOT_TOKEN`, `HUBSPOT_PORTAL_ID` (set as secrets,
   never commit them).
5. That's it — no database needed. Review state (checkboxes) lives in the
   browser tab; proposals are recomputed from live HubSpot + the bundled CSV
   snapshot each time you load or hit "Actualizar".

## Safety notes

- The endpoints that write to HubSpot (`POST /api/apply`,
  `POST /api/create-company`, `POST /api/apply-associations`,
  `POST /api/link-branches`, `POST /api/setup-properties`) are only ever
  called from an explicit button click + confirmation dialog in the browser,
  never on page load or automatically.
- `HUBSPOT_TOKEN` needs Companies read+write scopes only — do not grant
  Contacts/Deals scopes to this app's private app token.

## Second-account inventory (`/inventory.html`)

Read-only tool, step 1 of a one-time full-CRM migration from a second HubSpot
account into the main nsign account — see `lib/inventory.js`. It never writes
anywhere, to either account: it only counts objects (companies, contacts,
deals, notes, tasks, emails, calls, meetings) in the second account and
cross-matches its companies against nsign's, so Manel and Hugo can see real
numbers before designing the actual merge/dedup rules (a separate, later
piece of work).

**Scoped to a chosen recency window:** `/inventory.html` has 4 tabs (Todo /
12 / 6 / 3 meses) filtering every object type by last-modified date, so
Manel and Hugo can compare windows side by side (Manel, 09/09/2026) instead
of trusting a single fixed cutoff. Contacts filters on `lastmodifieddate`
(the classic property) rather than `hs_lastmodifieddate` -- the latter
turned out not to be reliably populated on Contacts in the account tested,
which silently under-counted them in every windowed view until fixed.

**Companies/deals `hs_lastmodifieddate` is not a trustworthy recency signal
on its own** -- testing against a real account showed ~80-99% of companies
and deals reading as "recently modified" in every window, almost certainly
from an automated sync bumping the field rather than real activity. So for
every duplicate AND net-new company, the tool checks several independent
"real activity" signals -- an Email (`hs_timestamp`), a Deal (`createdate`,
immutable so it can't be bulk-touched), and a Task (`hs_timestamp`) directly
associated to that company within the chosen window (via the v4 associations
batch-read + v3 object batch-read endpoints, see `ACTIVITY_SIGNALS` in
`lib/inventory.js`).

**Each signal is self-validating.** Because the check runs on duplicates
too (companies already known to be real, active customers in both
accounts), the duplicates result works as a built-in control group: if a
signal reads ~0% even on those known-active companies, that signal is
useless in this portal (found 09/09/2026: emails aren't associated directly
to Companies here at all, only Deals/Tasks are candidates worth trusting)
and its net-new result should be ignored. If a signal is real, the
duplicates rate should be meaningfully higher than 0%, and its net-new
result becomes actionable.

To use it: create a **separate** Private App token in the other HubSpot
account (Private App tokens are portal-specific, so `HUBSPOT_TOKEN` from this
same app cannot be reused) with read scopes on companies/contacts/deals/notes/
tasks/emails/calls/meetings, set it as `HUBSPOT_TOKEN_B` (env var, never
committed), then open `/inventory.html` and click "Cargar inventario".
