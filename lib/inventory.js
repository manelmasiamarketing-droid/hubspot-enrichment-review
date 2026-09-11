const fetch = require('node-fetch');
const { getAllCompanies } = require('./hubspot');
const { matchClientsToCompanies } = require('./matching');

const BASE = 'https://api.hubapi.com';

// Independent from lib/hubspot.js's hsFetch on purpose -- that one is hardwired
// to the main account's HUBSPOT_TOKEN env var. This tool talks to a SECOND,
// separate HubSpot account (its own portal, its own Private App token), so the
// token has to be an explicit parameter, never an env var baked into the client.
function hsFetchWithToken(token) {
  return async function hsFetch(path, opts = {}) {
    const res = await fetch(`${BASE}${path}`, {
      ...opts,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HubSpot (cuenta B) ${opts.method || 'GET'} ${path} -> ${res.status}: ${body}`);
    }
    return res.json();
  };
}

// Every object type this read-only inventory reports on. Deals/notes/tasks/
// emails/calls/meetings only get a total count (via the search endpoint's
// `total`, not full pagination -- an account can have tens of thousands of
// engagements and this tool only needs the scale, not the records).
// Companies additionally get fully paginated below because the cross-account
// comparison needs the actual records, not just a count.
const COUNT_ONLY_OBJECT_TYPES = ['contacts', 'deals', 'notes', 'tasks', 'emails', 'calls', 'meetings'];

// Manel asked (09/09/2026, then extended the same day) to scope the
// inventory to a recency window instead of the whole account, and to be able
// to compare several windows side by side ("Todo" / 12 / 6 / 3 meses) to see
// which cutoff is actually worth migrating. `hs_lastmodifieddate` is the
// standard "last touched" property HubSpot maintains on every CRM object
// type (companies, contacts, deals, and every engagement type), so the same
// filter works unchanged across all of them. `monthsBack` falsy (0/null/
// undefined) means "Todo" -- no date filter at all.
function cutoffTimestamp(monthsBack) {
  if (!monthsBack) return null;
  const d = new Date();
  d.setMonth(d.getMonth() - monthsBack);
  return d.getTime();
}

// Contacts is the one legacy holdout: in practice its `hs_lastmodifieddate`
// often isn't kept in sync the way it is on every other CRM object, so
// filtering by it silently returned 0 contacts in every time window even
// though the account has 14k+ of them (found 09/09/2026 comparing the "Todo"
// vs windowed tabs). `lastmodifieddate` is the property HubSpot has
// maintained on contacts since before hs_lastmodifieddate existed.
const LAST_MODIFIED_PROPERTY = { contacts: 'lastmodifieddate' };
function lastModifiedPropertyFor(objectType) {
  return LAST_MODIFIED_PROPERTY[objectType] || 'hs_lastmodifieddate';
}

function filterGroupsFor(monthsBack, objectType) {
  const cutoff = cutoffTimestamp(monthsBack);
  if (cutoff === null) return [];
  return [{ filters: [{ propertyName: lastModifiedPropertyFor(objectType), operator: 'GTE', value: cutoff }] }];
}

async function countTotal(hsFetch, objectType, filterGroups) {
  const page = await hsFetch(`/crm/v3/objects/${objectType}/search`, {
    method: 'POST',
    body: JSON.stringify({ limit: 1, filterGroups }),
  });
  return page.total;
}

async function fetchAllCompaniesB(hsFetch, filterGroups, onProgress) {
  const all = [];
  let after;
  do {
    const body = {
      limit: 100,
      properties: ['name'],
      filterGroups,
      ...(after ? { after } : {}),
    };
    const page = await hsFetch('/crm/v3/objects/companies/search', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    all.push(...page.results);
    after = page.paging && page.paging.next ? page.paging.next.after : undefined;
    if (onProgress) onProgress(all.length);
  } while (after);
  return all;
}

// Manel's own numbers (09/09/2026) showed companies/deals get touched almost
// wholesale by something automated, so `hs_lastmodifieddate` on the COMPANY
// itself is not a trustworthy "is this still a live account" signal. The
// same date checked on directly-associated ENGAGEMENT/DEAL records is a much
// more honest "worth migrating" signal -- but the email variant of this
// check turned out to be a dead end (see below), so it's generalized to try
// several signals: Emails (dead end, kept for transparency in the UI),
// Deals (by createdate, which -- unlike hs_lastmodifieddate -- is immutable
// and can't be bulk-touched by a sync), and Tasks (by hs_timestamp, the
// standard engagement-activity date). Configurable window (Manel asked
// 09/09/2026 to compare 12 vs 24 meses) -- defaults to 12.
const DEFAULT_EMAIL_ACTIVITY_MONTHS = 12;

// One signal = one object type + the date property on it that actually
// reflects real activity (not a bulk-touched field). Checked via CONTACTS,
// not directly on the Company -- Manel's control check (09/09/2026) proved
// this portal doesn't associate Emails, Deals, OR Tasks directly to
// Companies at all (0% even on 672 KNOWN-real duplicate companies, for all
// three, verified against HubSpot's own v4 associations API docs so it
// isn't a bug in this code -- see README). Contacts is the one object with
// genuine, non-bulk-touched activity in this portal, so the real path is
// Company -> Contact -> (Deal/Task/Email).
const ACTIVITY_SIGNALS = [
  { key: 'emails', toObjectType: 'emails', timestampProperty: 'hs_timestamp', label: 'email' },
  { key: 'deals', toObjectType: 'deals', timestampProperty: 'createdate', label: 'deal creado' },
  { key: 'tasks', toObjectType: 'tasks', timestampProperty: 'hs_timestamp', label: 'tarea' },
];

// Generic "fromObjectType batch-read associations to toObjectType" helper,
// shared by both hops (company->contact and contact->{emails,deals,tasks}).
// v4 associations batch-read takes up to 1000 ids per call.
//
// IMPORTANT: HubSpot returns `from.id` as a STRING but `to[].toObjectId` as a
// raw JSON NUMBER (verified live via /api/debug/associations, 11/09/2026 --
// e.g. `"from":{"id":"7698224028"}` vs `"to":[{"toObjectId":6901}]`). The v3
// object batch-read endpoint returns ITS `id` as a STRING too. Every id is
// normalized to a string the moment it's read here, otherwise a Map/Set
// lookup that mixes a numeric toObjectId against a string id silently never
// matches -- no error, just a false "0% activity" result. This is exactly
// what happened before this fix: real activity existed (confirmed live on
// known-real duplicate companies like SERUNION, which has 100+ contacts with
// real emails/deals) but every signal still read 0%, because the join
// between hop 1's contact ids (numbers) and hop 2's own contact ids
// (strings, from `from.id`) never matched, and likewise between hop 2's
// target ids (numbers) and the timestamp lookup's ids (strings, from v3
// batch/read). Manel's control-group check (duplicates always at 0%) is what
// made this catchable instead of silently wrong.
async function batchReadAssociations(hsFetch, fromObjectType, toObjectType, fromIds, report) {
  const fromToIds = new Map();
  const allToIds = new Set();
  for (let i = 0; i < fromIds.length; i += 1000) {
    const chunk = fromIds.slice(i, i + 1000);
    if (report) report(`Cuenta B: buscando ${toObjectType} asociados a ${fromObjectType}… (${Math.min(i + 1000, fromIds.length)}/${fromIds.length})`);
    const page = await hsFetch(`/crm/v4/associations/${fromObjectType}/${toObjectType}/batch/read`, {
      method: 'POST',
      body: JSON.stringify({ inputs: chunk.map((id) => ({ id })) }),
    });
    for (const r of page.results || []) {
      const toIds = (r.to || []).map((t) => String(t.toObjectId));
      if (toIds.length) {
        fromToIds.set(String(r.from.id), toIds);
        toIds.forEach((id) => allToIds.add(id));
      }
    }
  }
  return { fromToIds, allToIds };
}

// v3 object batch-read takes up to 100 ids per call.
async function batchReadTimestamps(hsFetch, objectType, ids, timestampProperty, report) {
  const idTimestamp = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    if (report) report(`Cuenta B: leyendo fecha de ${ids.length} ${objectType}…`);
    const page = await hsFetch(`/crm/v3/objects/${objectType}/batch/read`, {
      method: 'POST',
      body: JSON.stringify({ properties: [timestampProperty], inputs: chunk.map((id) => ({ id })) }),
    });
    for (const r of page.results || []) {
      const raw = r.properties && r.properties[timestampProperty];
      const ts = raw ? new Date(raw).getTime() : null;
      if (ts) idTimestamp.set(String(r.id), ts);
    }
  }
  return idTimestamp;
}

// Hop 1 (company -> contact), done ONCE and reused across all 3 signals in
// buildInventory -- no reason to re-fetch the same company->contact
// associations three times.
async function fetchCompanyContactMap(hsFetch, companyIds, report) {
  try {
    const { fromToIds, allToIds } = await batchReadAssociations(hsFetch, 'companies', 'contacts', companyIds, report);
    return { companyToContactIds: fromToIds, allContactIds: allToIds };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

// Hop 2 (contact -> toObjectType) + timestamp check, then rolled back up to
// which COMPANIES have at least one contact with real recent activity.
async function evaluateRecentActivityViaContacts(hsFetch, companyToContactIds, allContactIds, toObjectType, timestampProperty, activityMonths, report) {
  if (allContactIds.size === 0) return { activeCompanyIds: new Set() };
  const cutoff = cutoffTimestamp(activityMonths);
  const contactIdsArr = [...allContactIds];

  let contactToTargetIds;
  let allTargetIds;
  try {
    ({ fromToIds: contactToTargetIds, allToIds: allTargetIds } = await batchReadAssociations(hsFetch, 'contacts', toObjectType, contactIdsArr, report));
  } catch (e) {
    return { error: String(e.message || e) };
  }

  if (allTargetIds.size === 0) return { activeCompanyIds: new Set() };

  let targetTimestamp;
  try {
    targetTimestamp = await batchReadTimestamps(hsFetch, toObjectType, [...allTargetIds], timestampProperty, report);
  } catch (e) {
    return { error: String(e.message || e) };
  }

  const activeContactIds = new Set();
  for (const [contactId, targetIds] of contactToTargetIds.entries()) {
    if (targetIds.some((id) => targetTimestamp.has(id) && targetTimestamp.get(id) >= cutoff)) {
      activeContactIds.add(contactId);
    }
  }

  const activeCompanyIds = new Set();
  for (const [companyId, contactIds] of companyToContactIds.entries()) {
    if (contactIds.some((id) => activeContactIds.has(id))) {
      activeCompanyIds.add(companyId);
    }
  }
  return { activeCompanyIds };
}

// Read-only inventory + comparison of a second ("B") HubSpot account against
// the main nsign account ("A"). Never writes anything, to either account --
// this is step 1 (verification/inventory) of a one-time full-CRM migration
// that Manel asked for; the actual merge/write engine is a separate, later
// step designed only once these real numbers are known (see the project plan
// -- "Fase 2" is deliberately not built yet).
async function buildInventory(tokenB, monthsBack, onProgress, activityMonths) {
  const report = onProgress || (() => {});
  const emailActivityMonths = activityMonths || DEFAULT_EMAIL_ACTIVITY_MONTHS;
  const hsFetchB = hsFetchWithToken(tokenB);
  const filterGroups = filterGroupsFor(monthsBack, 'companies');
  const cutoff = cutoffTimestamp(monthsBack);
  const sinceIso = cutoff === null ? null : new Date(cutoff).toISOString().slice(0, 10);
  const windowLabel = sinceIso ? `actualizados desde ${sinceIso}` : 'sin filtro de fecha (todo)';

  const objectCounts = {};
  for (const objectType of COUNT_ONLY_OBJECT_TYPES) {
    report({ stage: `Cuenta B: contando ${objectType} (${windowLabel})…` });
    try {
      objectCounts[objectType] = await countTotal(hsFetchB, objectType, filterGroupsFor(monthsBack, objectType));
    } catch (e) {
      objectCounts[objectType] = { error: String(e.message || e) };
    }
  }

  report({ stage: `Cuenta B: descargando companies (${windowLabel})…`, done: 0, total: null });
  let companiesB = [];
  try {
    companiesB = await fetchAllCompaniesB(hsFetchB, filterGroups, (n) => report({ stage: `Cuenta B: descargando companies… (${n} traídas)`, done: n, total: null }));
  } catch (e) {
    return {
      error: `No se pudo leer companies de la cuenta B: ${String(e.message || e)}`,
      accountB: { objectCounts: { ...objectCounts, companies: { error: String(e.message || e) } } },
    };
  }
  objectCounts.companies = companiesB.length;

  report({ stage: 'Descargando companies de la cuenta A (nsign) para comparar…', done: 0, total: null });
  const companiesA = await getAllCompanies((n) => report({ stage: `Cuenta A: descargando companies… (${n} traídas)`, done: n, total: null }));

  report({ stage: `Cruzando ${companiesB.length} companies de la cuenta B contra ${companiesA.length} de la cuenta A…`, done: 0, total: companiesB.length });
  const namesB = companiesB.map((c) => c.properties.name).filter(Boolean);
  const matches = matchClientsToCompanies(
    namesB,
    companiesA,
    (done, total) => report({ stage: 'Cruzando companies…', done, total }),
  );

  // "Duplicado claro" = match de nombre casi exacto (score >= 0.99, mismo
  // umbral que ya usa el resto de la app para tratar un match como
  // seguro). Todo lo demás son candidatos net-new o ambiguos a revisar a
  // mano -- nunca se decide aquí cuál de las dos gana, eso es la Fase 2.
  const duplicates = [];
  const netNew = [];
  for (const c of companiesB) {
    const name = c.properties.name;
    const match = name ? matches[name] : null;
    if (match && match.score >= 0.99) {
      duplicates.push({
        nameInB: name, idInB: c.id,
        matchedNameInA: match.company.properties.name, matchedIdInA: match.company.id,
        score: match.score,
      });
    } else if (match) {
      netNew.push({ nameInB: name, idInB: c.id, possibleMatchInA: match.company.properties.name, score: match.score, ambiguous: true });
    } else {
      netNew.push({ nameInB: name, idInB: c.id, ambiguous: false });
    }
  }

  // Two-hop check: Company -> Contact -> (Email/Deal/Task). Manel confirmed
  // (09/09/2026, verified against HubSpot's own v4 associations API docs) a
  // direct Company->X check is a dead end in this portal -- 0% even on 672
  // KNOWN-real duplicate companies for all three object types, because this
  // account only associates engagements/deals to Contacts, never directly
  // to Companies. So hop 1 (company->contacts) is fetched ONCE and reused
  // for all 3 signals; each signal's own control-group result (duplicates)
  // still tells you whether to trust its net-new result.
  const allForActivityCheck = [...duplicates, ...netNew];
  const signals = {};
  report({ stage: `Cuenta B: buscando contactos asociados a ${allForActivityCheck.length} companies (duplicados + net-new)…`, done: 0, total: null });
  const contactMap = await fetchCompanyContactMap(
    hsFetchB,
    allForActivityCheck.map((c) => c.idInB),
    (stage) => report({ stage, done: 0, total: null }),
  );

  netNew.forEach((n) => { n.recentActivity = {}; });
  duplicates.forEach((d) => { d.recentActivity = {}; });

  if (contactMap.error) {
    for (const sig of ACTIVITY_SIGNALS) {
      signals[sig.key] = { activityMonths: emailActivityMonths, error: contactMap.error, netNewWithRealActivity: null, duplicatesWithRealActivity: null };
      netNew.forEach((n) => { n.recentActivity[sig.key] = 'error'; });
      duplicates.forEach((d) => { d.recentActivity[sig.key] = 'error'; });
    }
  } else {
    for (const sig of ACTIVITY_SIGNALS) {
      report({ stage: `Cruzando contactos contra actividad real de ${sig.label} (últimos ${emailActivityMonths} meses)…`, done: 0, total: null });
      const result = await evaluateRecentActivityViaContacts(
        hsFetchB,
        contactMap.companyToContactIds,
        contactMap.allContactIds,
        sig.toObjectType,
        sig.timestampProperty,
        emailActivityMonths,
        (stage) => report({ stage, done: 0, total: null }),
      );
      if (result.error) {
        signals[sig.key] = { activityMonths: emailActivityMonths, error: result.error, netNewWithRealActivity: null, duplicatesWithRealActivity: null };
        netNew.forEach((n) => { n.recentActivity[sig.key] = 'error'; });
        duplicates.forEach((d) => { d.recentActivity[sig.key] = 'error'; });
      } else {
        let netNewCount = 0;
        let dupCount = 0;
        for (const n of netNew) {
          const active = result.activeCompanyIds.has(n.idInB);
          n.recentActivity[sig.key] = active;
          if (active) netNewCount += 1;
        }
        for (const d of duplicates) {
          const active = result.activeCompanyIds.has(d.idInB);
          d.recentActivity[sig.key] = active;
          if (active) dupCount += 1;
        }
        signals[sig.key] = { activityMonths: emailActivityMonths, error: null, netNewWithRealActivity: netNewCount, duplicatesWithRealActivity: dupCount };
      }
    }
  }

  report({ stage: 'Listo', done: 1, total: 1 });
  return {
    filter: {
      monthsBack: monthsBack || null,
      description: sinceIso
        ? `Solo objetos de la cuenta B con última modificación en los últimos ${monthsBack} meses`
        : 'Todos los objetos de la cuenta B, sin filtro de fecha',
      sinceDate: sinceIso,
    },
    accountB: { objectCounts },
    accountA: { totalCompanies: companiesA.length },
    companiesComparison: {
      totalInAccountB: companiesB.length,
      clearDuplicates: duplicates.length,
      netNewOrAmbiguous: netNew.length,
      signals,
      duplicates,
      netNew,
    },
  };
}

// Raw, unprocessed association batch-read -- used only by the /api/debug/
// associations route to inspect exactly what HubSpot returns for a handful of
// real IDs (association types included), when a signal's result is
// surprising enough (e.g. 0% even on known-real duplicates) that it's worth
// checking the raw API response instead of trusting this file's own
// aggregation logic.
async function debugAssociations(tokenB, fromObjectType, toObjectType, ids) {
  const hsFetch = hsFetchWithToken(tokenB);
  return hsFetch(`/crm/v4/associations/${fromObjectType}/${toObjectType}/batch/read`, {
    method: 'POST',
    body: JSON.stringify({ inputs: ids.map((id) => ({ id })) }),
  });
}

// Same spirit as debugAssociations: raw, unprocessed v3 object batch-read,
// used to inspect real property values (contact name/email, timestamps) for
// a handful of IDs while planning the pilot migration, without writing
// anything anywhere.
async function debugObjectRead(tokenB, objectType, ids, properties) {
  const hsFetch = hsFetchWithToken(tokenB);
  return hsFetch(`/crm/v3/objects/${objectType}/batch/read`, {
    method: 'POST',
    body: JSON.stringify({ properties, inputs: ids.map((id) => ({ id })) }),
  });
}

// Same spirit again: a bare count (no filter) for an arbitrary object type,
// used to check whether this account has any data at all in object types
// COUNT_ONLY_OBJECT_TYPES doesn't cover (tickets, quotes, line_items,
// communications...) before deciding whether they're worth adding to the
// real inventory/migration scope.
async function debugCount(tokenB, objectType) {
  const hsFetch = hsFetchWithToken(tokenB);
  return countTotal(hsFetch, objectType, []);
}

module.exports = { buildInventory, debugAssociations, debugObjectRead, debugCount };
