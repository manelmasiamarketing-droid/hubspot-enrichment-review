const fetch = require('node-fetch');

const BASE = 'https://api.hubapi.com';

function token() {
  const t = process.env.HUBSPOT_TOKEN;
  if (!t) throw new Error('HUBSPOT_TOKEN env var is not set');
  return t;
}

async function hsFetch(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token()}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HubSpot ${opts.method || 'GET'} ${path} -> ${res.status}: ${body}`);
  }
  return res.json();
}

const COMPANY_PROPERTIES = [
  'name', 'tipo_de_empresa', 'company_score', 'numero_de_dispositivos',
  'country', 'industry_sector', 'sector__vertical_', 'relacion',
  'acceso_comercial_newsletter', 'acuerdo_de_contacto_directo_firmado', 'fecha_firma_acuerdo_directo',
  'website', 'hs_employee_range', 'idioma',
];

// New custom properties this app depends on. Created (idempotently) via
// setupCustomProperties() -- only ever called from the explicit
// "Crear propiedades en HubSpot" button, never automatically.
// NOTE (05/09/2026): Manel already created these 3 manually in HubSpot --
// names/options below match what actually exists in the portal, confirmed
// via get_properties, not the original design. HubSpot auto-generates the
// internal name from the label and doesn't always match what you typed
// (e.g. "acuerdo_contacto..." became "acuerdo_DE_contacto...").
const CUSTOM_PROPERTY_DEFS = [
  {
    name: 'acceso_comercial_newsletter',
    label: 'Acceso comercial / Newsletter',
    type: 'enumeration',
    fieldType: 'select',
    groupName: 'companyinformation',
    options: [
      { label: 'Directo', value: 'Directo', displayOrder: 0 },
      { label: 'Vía partner', value: 'Vía partner', displayOrder: 1 },
      { label: 'Directo / Vía partner', value: 'Directo / Vía partner', displayOrder: 2 },
    ],
  },
  {
    name: 'acuerdo_de_contacto_directo_firmado',
    label: 'Acuerdo de contacto directo firmado',
    type: 'bool',
    fieldType: 'booleancheckbox',
    groupName: 'companyinformation',
    options: [
      { label: 'Sí', value: 'true', displayOrder: 0 },
      { label: 'No', value: 'false', displayOrder: 1 },
    ],
  },
  {
    name: 'fecha_firma_acuerdo_directo',
    label: 'Fecha de firma del acuerdo directo',
    type: 'date',
    fieldType: 'date',
    groupName: 'companyinformation',
  },
  {
    name: 'idioma',
    label: 'Idioma',
    type: 'enumeration',
    fieldType: 'select',
    groupName: 'companyinformation',
    options: [
      { label: 'Español', value: 'Español', displayOrder: 0 },
      { label: 'Inglés', value: 'Inglés', displayOrder: 1 },
      { label: 'Francés', value: 'Francés', displayOrder: 2 },
      { label: 'Alemán', value: 'Alemán', displayOrder: 3 },
      { label: 'Portugués', value: 'Portugués', displayOrder: 4 },
      { label: 'Italiano', value: 'Italiano', displayOrder: 5 },
      { label: 'Polaco', value: 'Polaco', displayOrder: 6 },
      { label: 'Neerlandés', value: 'Neerlandés', displayOrder: 7 },
      { label: 'Otro', value: 'Otro', displayOrder: 8 },
    ],
  },
];

// Fetches every company in the portal with the properties we need.
// Paginates with the `after` cursor until exhausted.
// onProgress(fetchedSoFar) lets the caller report status while this runs.
async function getAllCompanies(onProgress) {
  const all = [];
  let after;
  do {
    const params = new URLSearchParams();
    params.set('limit', '100');
    COMPANY_PROPERTIES.forEach((p) => params.append('properties', p));
    if (after) params.set('after', after);
    const page = await hsFetch(`/crm/v3/objects/companies?${params.toString()}`);
    all.push(...page.results);
    after = page.paging && page.paging.next ? page.paging.next.after : undefined;
    if (onProgress) onProgress(all.length);
  } while (after);
  return all;
}

async function updateCompany(id, properties) {
  return hsFetch(`/crm/v3/objects/companies/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ properties }),
  });
}

async function createCompany(properties) {
  return hsFetch('/crm/v3/objects/companies', {
    method: 'POST',
    body: JSON.stringify({ properties }),
  });
}

async function associateCompanies(fromId, toId) {
  // Default, unlabeled company-to-company association.
  return hsFetch(
    `/crm/v3/objects/companies/${fromId}/associations/default/companies/${toId}`,
    { method: 'PUT' },
  );
}

// Looks up the real association typeIds for company<->company from HubSpot
// itself (never hardcode these -- they're queried at runtime so we can't get
// the direction/id wrong). Returns { parentToChildTypeId, childToParentTypeId }
// for the built-in "Parent Company"/"Child Company" pair, or null if this
// portal doesn't have it (shouldn't happen -- it's a HubSpot default).
let parentChildLabelsCache = null;
async function getParentChildAssociationTypeIds() {
  if (parentChildLabelsCache) return parentChildLabelsCache;
  const labels = await hsFetch('/crm/v4/associations/companies/companies/labels');
  const results = labels.results || [];
  const parentLabel = results.find((r) => /parent company/i.test(r.label || ''));
  const childLabel = results.find((r) => /child company/i.test(r.label || ''));
  if (!parentLabel || !childLabel) {
    throw new Error(`Could not find Parent/Child Company association labels in HubSpot. Got: ${JSON.stringify(results)}`);
  }
  parentChildLabelsCache = { parentToChildTypeId: parentLabel.typeId, childToParentTypeId: childLabel.typeId };
  return parentChildLabelsCache;
}

// Associates childId as a child of parentId using HubSpot's native
// Parent/Child Company hierarchy (shows as a branch tree on both records).
async function associateParentChildCompany(parentId, childId) {
  const { parentToChildTypeId, childToParentTypeId } = await getParentChildAssociationTypeIds();
  return hsFetch(`/crm/v4/objects/companies/${parentId}/associations/companies/${childId}`, {
    method: 'PUT',
    body: JSON.stringify([
      { associationCategory: 'HUBSPOT_DEFINED', associationTypeId: parentToChildTypeId },
    ]),
  }).then(() => hsFetch(`/crm/v4/objects/companies/${childId}/associations/companies/${parentId}`, {
    method: 'PUT',
    body: JSON.stringify([
      { associationCategory: 'HUBSPOT_DEFINED', associationTypeId: childToParentTypeId },
    ]),
  }));
}

async function getCompanyPropertyDefinition(name) {
  try {
    return await hsFetch(`/crm/v3/properties/companies/${name}`);
  } catch (e) {
    if (String(e.message).includes('404')) return null;
    throw e;
  }
}

async function createCompanyPropertyDefinition(def) {
  return hsFetch('/crm/v3/properties/companies', {
    method: 'POST',
    body: JSON.stringify(def),
  });
}

// Creates the 3 custom properties this app proposes values for, skipping any
// that already exist. Safe to call more than once. Only ever triggered by the
// explicit "Crear propiedades en HubSpot" button.
async function setupCustomProperties() {
  const results = [];
  for (const def of CUSTOM_PROPERTY_DEFS) {
    const existing = await getCompanyPropertyDefinition(def.name);
    if (existing) {
      results.push({ name: def.name, status: 'already existed' });
      continue;
    }
    await createCompanyPropertyDefinition(def);
    results.push({ name: def.name, status: 'created' });
  }
  return results;
}

module.exports = {
  getAllCompanies,
  updateCompany,
  createCompany,
  associateCompanies,
  getCompanyPropertyDefinition,
  createCompanyPropertyDefinition,
  setupCustomProperties,
};
