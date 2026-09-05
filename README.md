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

- The only two endpoints that write to HubSpot are `POST /api/apply` and
  `POST /api/create-company` — both are only ever called from an explicit
  button click, never on page load.
- `HUBSPOT_TOKEN` needs Companies read+write scopes only — do not grant
  Contacts/Deals scopes to this app's private app token.
