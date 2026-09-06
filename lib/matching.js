const fs = require('fs');
const path = require('path');

// Manual overrides for cases the algorithm can't and shouldn't try to guess:
// trade name vs legal name (e.g. "HMY YUDIGAR EQUIPAMIENTO SLU" is the legal
// name of the company that trades as "HMY España" in HubSpot). Confirmed by
// Manel case by case -- add an entry here whenever a real equivalence like
// this is found; do NOT loosen the generic similarity threshold instead, that
// would create false positives across the board.
const NAME_ALIASES = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'data', 'name_aliases.json'), 'utf8'),
);

const SUFFIXES = [
  'S.A.U.', 'S.A.', 'S.L.U.', 'S.L.', 'SLU', 'SAU', 'SA', 'SL', 'SAS', 'SPA',
  'GMBH', 'INC', 'LTD', 'LIMITED', 'LLC', 'CORP', 'CORPORATION', 'GROUP', 'GRUPO',
];

function normalize(name) {
  if (!name) return '';
  let n = name
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents
    .toUpperCase()
    .replace(/[.,()\-_/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (const suf of SUFFIXES) {
    const re = new RegExp(`\\b${suf}\\b`, 'g');
    n = n.replace(re, '');
  }
  return n.replace(/\s+/g, ' ').trim();
}

function tokenSet(name) {
  return new Set(normalize(name).split(' ').filter((t) => t.length > 1));
}

// Jaccard similarity between token sets -- good enough for short company names.
function similarity(a, b) {
  const ta = tokenSet(a);
  const tb = tokenSet(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  const union = new Set([...ta, ...tb]).size;
  return inter / union;
}

// For each device-history client name, finds the best-matching HubSpot
// company by normalized-name similarity. Returns { clientName -> {company, score} }
// only above a confidence threshold; below it, treated as "no match" (candidate
// for manual review / creation, same pattern as the Alcampo case).
// onProgress(done, total) is called periodically for the slow (unmatched)
// path so the UI can show something better than a frozen spinner.
function matchClientsToCompanies(clientNames, companies, onProgress) {
  const exactIndex = new Map();
  // Precomputed once and reused across every clientName's fallback scan --
  // recomputing each company's token set per comparison was the main cost.
  const companyTokens = [];
  for (const c of companies) {
    const key = normalize(c.properties.name);
    if (key && !exactIndex.has(key)) exactIndex.set(key, c);
    companyTokens.push({ company: c, tokens: tokenSet(c.properties.name) });
  }

  function jaccard(ta, tb) {
    if (ta.size === 0 || tb.size === 0) return 0;
    let inter = 0;
    for (const t of ta) if (tb.has(t)) inter += 1;
    return inter / (ta.size + tb.size - inter);
  }

  const matches = {};
  let processed = 0;
  for (const clientName of clientNames) {
    const key = normalize(clientName);
    let best = exactIndex.get(key);
    let score = best ? 1 : 0;

    if (!best && NAME_ALIASES[clientName]) {
      const aliasKey = normalize(NAME_ALIASES[clientName]);
      const aliasMatch = exactIndex.get(aliasKey);
      if (aliasMatch) {
        best = aliasMatch;
        score = 1; // manually confirmed -- treat as exact
      }
    }

    if (!best) {
      const clientTokens = tokenSet(clientName);
      let bestScore = 0;
      for (const { company, tokens } of companyTokens) {
        const s = jaccard(clientTokens, tokens);
        if (s > bestScore) {
          bestScore = s;
          best = company;
        }
      }
      score = bestScore;
    }

    if (best && score >= 0.5) {
      matches[clientName] = { company: best, score };
    }

    processed += 1;
    if (onProgress && processed % 100 === 0) onProgress(processed, clientNames.length);
  }
  if (onProgress) onProgress(clientNames.length, clientNames.length);
  return matches;
}

function partnerTierFromDevices(activeDevices) {
  if (activeDevices > 5000) return 'AAA (>5000 screens)';
  if (activeDevices >= 2000) return 'AA (2000 to 5000 screens)';
  return 'A (<2000 screens)';
}

const SPAIN_PORTUGAL = new Set(['Spain', 'España', 'Portugal']);

// Country -> primary business language, for the countries that actually
// appear in the device-history export. Deliberately conservative: countries
// not listed here (or genuinely multilingual ones) are left unmapped rather
// than guessed, so the "idioma" proposal is never wrong outright.
const COUNTRY_TO_LANGUAGE = {
  'Spain': 'Español', 'España': 'Español', 'Mexico': 'Español', 'México': 'Español',
  'Argentina': 'Español', 'Chile': 'Español', 'Colombia': 'Español', 'Costa Rica': 'Español',
  'Ecuador': 'Español', 'El Salvador': 'Español', 'Guatemala': 'Español', 'Honduras': 'Español',
  'Nicaragua': 'Español', 'Panama': 'Español', 'Panamá': 'Español',
  'Dominican Republic': 'Español', 'Peru': 'Español', 'Perú': 'Español', 'Uruguay': 'Español',
  'Bolivia': 'Español', 'Paraguay': 'Español', 'Venezuela': 'Español', 'Cuba': 'Español',
  'Portugal': 'Portugués', 'Brazil': 'Portugués', 'Brasil': 'Portugués',
  'France': 'Francés',
  'Germany': 'Alemán', 'Austria': 'Alemán', 'Switzerland': 'Alemán',
  'Italy': 'Italiano',
  'Poland': 'Polaco',
  'Netherlands': 'Neerlandés', 'Belgium': 'Neerlandés',
  'United Kingdom of Great Britain and Northern Ireland': 'Inglés', 'United States of America': 'Inglés',
  'Ireland': 'Inglés',
  // Czech Republic / Romania deliberately left unmapped -- no confident
  // enum option for Checo/Rumano exists yet, and assuming English would be
  // a guess, not a fact.
};

// Converts a raw country name from the device history (e.g. "United States
// of America", "Costa Rica") into the slug HubSpot's company_countries
// (multi-select) enumeration actually uses (e.g. "united_states",
// "costa_rica") -- confirmed via get_properties 06/09/2026.
const COUNTRY_NAME_OVERRIDES = {
  'United Kingdom of Great Britain and Northern Ireland': 'united_kingdom',
  'United States of America': 'united_states',
  'México': 'mexico',
  'España': 'spain',
};
function countryToSlug(name) {
  if (!name) return null;
  if (COUNTRY_NAME_OVERRIDES[name]) return COUNTRY_NAME_OVERRIDES[name];
  return name
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

module.exports = {
  normalize, similarity, matchClientsToCompanies, partnerTierFromDevices,
  SPAIN_PORTUGAL, COUNTRY_TO_LANGUAGE, countryToSlug,
};
