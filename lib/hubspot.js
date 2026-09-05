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
  'acceso_comercial_newsletter', 'acuerdo_contacto_directo_firmado', 'fecha_firma_acuerdo_directo',
];

// New custom properties this app depends on. Created (idempotently) via
// setupCustomProperties() -- only ever called from the explicit
// "Crear propiedades en HubSpot" button, never automatically.
const CUSTOM_PROPERTY_DEFS = [
  {
    name: 'acceso_comercial_newsletter',
    label: 'Acceso comercial / Newsletter',
    type: 'enumeration',
    fieldType: 'select',
    groupName: 'companyinformation',
    options: [
      { label: 'Directo', value: 'Directo', displayOrder: 0 },
      { label: 'Solo via Partner', value: 'Solo via Partner', displayOrder: 1 },
      { label: 'Excepcion de politica (revisar)', value: 'Excepcion de politica (revisar)', displayOrder: 2 },
    ],
  },
  {
    name: 'acuerdo_contacto_directo_firmado',
    label: 'Acuerdo de contacto directo firmado',
    type: 'bool',
    fieldType: 'booleancheckbox',
    groupName: 'companyinformation',
    options: [
      { label: 'True', value: 'true', displayOrder: 0 },
      { label: 'False', value: 'false', displayOrder: 1 },
    ],
  },
  {
    name: 'fecha_firma_acuerdo_directo',
    label: 'Fecha de firma del acuerdo directo',
    type: 'date',
    fieldType: 'date',
    groupName: 'companyinformation',
  },
];

// Fetches every company in the portal with the properties we need.
// Paginates with the `after` cursor until exhausted.
async function getAllCompanies() {
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
