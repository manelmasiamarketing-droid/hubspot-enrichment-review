// Detects "branch clusters" -- companies whose name follows the
// "MARCA (sucursal)" pattern already used in this portal (FABORIT (Novapa),
// FABORIT (Fira), MUNS (Proaldama), ALTIMA (D'Inca)...). Only this explicit,
// deliberate parenthetical pattern is used -- NOT a generic shared-prefix
// heuristic (e.g. "AREAS ESPAÑA" vs "AREAS FRANCIA"), which would be far too
// prone to false positives (two unrelated companies starting with the same
// common word).
const PAREN_RE = /^(.*?)\s*\(([^)]+)\)\s*$/;
const MIN_BASE_LENGTH = 3;
const MIN_CLUSTER_SIZE = 2;

function detectBranchClusters(companies) {
  const byExactName = new Map();
  for (const c of companies) {
    const name = (c.properties.name || '').trim();
    if (name) byExactName.set(name, c);
  }

  const byBase = new Map();
  for (const c of companies) {
    const name = (c.properties.name || '').trim();
    const m = name.match(PAREN_RE);
    if (!m) continue;
    const base = m[1].trim();
    if (base.length < MIN_BASE_LENGTH) continue;
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(c);
  }

  const withParent = [];
  const withoutParent = [];
  for (const [base, children] of byBase.entries()) {
    if (children.length < MIN_CLUSTER_SIZE) continue;
    const parent = byExactName.get(base) || null;
    (parent ? withParent : withoutParent).push({ base, parent, children });
  }
  return { withParent, withoutParent };
}

module.exports = { detectBranchClusters };
