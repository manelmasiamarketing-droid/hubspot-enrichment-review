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
function matchClientsToCompanies(clientNames, companies) {
  const exactIndex = new Map();
  for (const c of companies) {
    const key = normalize(c.properties.name);
    if (key && !exactIndex.has(key)) exactIndex.set(key, c);
  }

  const matches = {};
  for (const clientName of clientNames) {
    const key = normalize(clientName);
    let best = exactIndex.get(key);
    let score = best ? 1 : 0;

    if (!best) {
      let bestScore = 0;
      for (const c of companies) {
        const s = similarity(clientName, c.properties.name);
        if (s > bestScore) {
          bestScore = s;
          best = c;
        }
      }
      score = bestScore;
    }

    if (best && score >= 0.5) {
      matches[clientName] = { company: best, score };
    }
  }
  return matches;
}

function partnerTierFromDevices(activeDevices) {
  if (activeDevices > 5000) return 'AAA (>5000 screens)';
  if (activeDevices >= 2000) return 'AA (2000 to 5000 screens)';
  return 'A (<2000 screens)';
}

const SPAIN_PORTUGAL = new Set(['Spain', 'España', 'Portugal']);

module.exports = { normalize, similarity, matchClientsToCompanies, partnerTierFromDevices, SPAIN_PORTUGAL };
