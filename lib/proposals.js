const fs = require('fs');
const path = require('path');
const { getAllCompanies } = require('./hubspot');
const { matchClientsToCompanies, partnerTierFromDevices, SPAIN_PORTUGAL } = require('./matching');

const clientHistory = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'data', 'device_history_by_client.json'), 'utf8'),
);
const partnerHistory = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'data', 'device_history_by_partner.json'), 'utf8'),
);
const excelEnrichment = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'data', 'excel_enrichment_by_id.json'), 'utf8'),
);

// Manel's Excel test used its own free-text vertical labels, not HubSpot's
// industry_sector enum values. Only propose industry_sector where the
// mapping is unambiguous -- otherwise leave it as an informational reason so
// Manel picks the right option by hand rather than risk writing the wrong one.
const EXCEL_SECTOR_TO_HUBSPOT = {
  'QSR': 'qsr_restaurants',
  'Corporate': 'corporate',
  'Salut': 'healthcare',
  'Educación': 'Education',
  'Multisector': 'Multisector',
  'Fashion Retail': 'retail_apparel_fashion',
  'Retail Fashion & Apparel': 'retail_apparel_fashion',
  'Beauty & Cosmetics': 'retail_beauty_wellness',
  'Beauty & Cosmetics Retail': 'retail_beauty_wellness',
  'Travel Retail': 'retail_food_beverage_travel_retail',
  'Retail Alimentari': 'retail_supermarkets',
};

// Newsletter/comms-access proposal. Values must match the enumeration options
// that actually exist on acceso_comercial_newsletter in HubSpot: "Directo",
// "Vía partner", "Directo / Vía partner" (Manel created the property himself
// with this wording -- confirmed via get_properties 05/09/2026).
// A signed direct-contact agreement (acuerdo_de_contacto_directo_firmado)
// always overrides the default "Vía partner" -- that's the whole point of the
// agreement: permission to email the end client even though a partner serves
// them. A direct relationship outside Spain/Portugal is still proposed as
// "Directo" (that's the actual current state) but raised as a policyFlag,
// since there's no separate "exception" option in the real field.
function proposeCommsAccess({ isDirectChannel, country, hasExternalPartner, agreementSigned, agreementDate }) {
  if (hasExternalPartner) {
    if (agreementSigned) {
      return { value: 'Directo', reason: `Acuerdo de contacto directo firmado con el partner${agreementDate ? ` (${agreementDate})` : ''} -- permite enviar directo pese a ser cliente de partner` };
    }
    return { value: 'Vía partner', reason: 'Sin acuerdo de contacto directo firmado -- respetar el canal del partner' };
  }
  if (isDirectChannel && !SPAIN_PORTUGAL.has(country)) {
    return { value: 'Directo', reason: 'Relación directa fuera de España/Portugal -- rompe la política partner-only, revisar', isPolicyFlag: true };
  }
  if (isDirectChannel) {
    return { value: 'Directo', reason: 'Relación directa (canal Netipbox) dentro de España/Portugal' };
  }
  return null; // not enough data in the device history to propose anything
}

async function buildProposals() {
  const companies = await getAllCompanies();

  const clientNames = Object.keys(clientHistory);
  const clientMatches = matchClientsToCompanies(clientNames, companies);

  const partnerNames = Object.keys(partnerHistory);
  const partnerMatches = matchClientsToCompanies(partnerNames, companies);

  const proposalsByCompanyId = new Map();

  function getOrInit(company) {
    if (!proposalsByCompanyId.has(company.id)) {
      proposalsByCompanyId.set(company.id, {
        companyId: company.id,
        companyName: company.properties.name,
        url: `https://app.hubspot.com/contacts/${process.env.HUBSPOT_PORTAL_ID || ''}/record/0-2/${company.id}`,
        current: { ...company.properties },
        proposed: {},
        reasons: [],
        policyFlags: [],
        confidence: 'low',
      });
    }
    return proposalsByCompanyId.get(company.id);
  }

  // End-client role: propose country + tipo_de_empresa + comms access.
  for (const clientName of clientNames) {
    const match = clientMatches[clientName];
    if (!match) continue;
    const hist = clientHistory[clientName];
    const p = getOrInit(match.company);
    p.role = 'end_client';
    p.deviceInfo = { ...(p.deviceInfo || {}), asEndClient: hist };

    if (!p.current.country && hist.country) {
      p.proposed.country = hist.country;
      p.reasons.push(`País "${hist.country}" tomado del historial de players (${hist.active_devices} dispositivos activos)`);
    }
    if (!p.current.tipo_de_empresa) {
      p.proposed.tipo_de_empresa = 'Cliente Final';
      p.reasons.push('Aparece como Cliente en el historial de players (no como grupo partner/reseller)');
    }

    const hasExternalPartner = !!hist.partner_group && !hist.is_direct_channel;
    const agreementSigned = String(p.current.acuerdo_de_contacto_directo_firmado).toLowerCase() === 'true';
    const commsAccess = proposeCommsAccess({
      isDirectChannel: hist.is_direct_channel,
      country: hist.country,
      hasExternalPartner,
      agreementSigned,
      agreementDate: p.current.fecha_firma_acuerdo_directo,
    });
    if (commsAccess && !p.current.acceso_comercial_newsletter) {
      p.proposed.acceso_comercial_newsletter = commsAccess.value;
      p.reasons.push(commsAccess.reason);
      if (commsAccess.isPolicyFlag) {
        p.policyFlags.push('Venta/relación directa fuera de España/Portugal — revisar política partner-only');
      }
    }
    if (hist.partner_group) {
      p.reasons.push(
        hist.is_direct_channel
          ? 'Servido directamente por nsign (grupo Netipbox) según historial'
          : `Servido vía partner "${hist.partner_group}" según historial (${hist.active_devices} dispositivos activos)`,
      );
    }

    p.confidence = match.score >= 0.99 ? 'high' : match.score >= 0.75 ? 'medium' : 'low';
  }

  // Partner role: propose company_score tier from total managed devices.
  for (const partnerName of partnerNames) {
    const match = partnerMatches[partnerName];
    if (!match) continue;
    const hist = partnerHistory[partnerName];
    const p = getOrInit(match.company);
    p.role = p.role === 'end_client' ? 'end_client+partner' : 'partner';
    p.deviceInfo = { ...(p.deviceInfo || {}), asPartner: hist };

    if (!p.current.tipo_de_empresa) {
      p.proposed.tipo_de_empresa = 'Partner';
      p.reasons.push(`Aparece como grupo partner/reseller gestionando ${hist.managed_client_count} clientes en el historial`);
    }
    if (!p.current.company_score) {
      const tier = partnerTierFromDevices(hist.active_devices);
      p.proposed.company_score = tier;
      p.reasons.push(`${hist.active_devices} pantallas activas gestionadas en total (${hist.managed_client_count} clientes) → tier ${tier}`);
    }
    p.confidence = match.score >= 0.99 ? 'high' : match.score >= 0.75 ? 'medium' : 'low';
  }

  // Excel enrichment test (websearch/domain/LinkedIn-specialties research,
  // done manually by Manel) -- matched directly by hs_object_id, no name
  // matching needed. Only fills blanks; never overwrites.
  const companiesById = new Map(companies.map((c) => [String(c.id), c]));
  for (const [objectId, row] of Object.entries(excelEnrichment)) {
    const company = companiesById.get(String(objectId));
    if (!company) continue; // company since deleted/merged in HubSpot
    const p = getOrInit(company);
    p.role = p.role || 'excel_enrichment';
    p.deviceInfo = { ...(p.deviceInfo || {}), excel: row };

    const sourceNote = `Excel enrichment (${row.research_source}/${row.research_method}, confianza ${row.research_confidence})`;

    if (!p.current.website && row.website) {
      p.proposed.website = row.website;
      p.reasons.push(`Website "${row.website}" — ${sourceNote}`);
    }
    if (!p.current.hs_employee_range && row.company_size && row.company_size !== 'unknown' && row.company_size !== 'Unknown') {
      p.proposed.hs_employee_range = row.company_size;
      p.reasons.push(`Tamaño "${row.company_size}" — ${sourceNote}`);
    }
    if (!p.current.industry_sector) {
      const mapped = EXCEL_SECTOR_TO_HUBSPOT[row.industry_sector_excel];
      if (mapped) {
        p.proposed.industry_sector = mapped;
        p.reasons.push(`Vertical "${row.industry_sector_excel}" → ${mapped} — ${sourceNote}`);
      } else if (row.industry_sector_excel) {
        p.reasons.push(`Vertical sugerido "${row.industry_sector_excel}" (${sourceNote}) — sin mapeo directo a un valor de industry_sector, elegir a mano`);
      }
    }

    if (Object.keys(p.proposed).length > 0 && p.confidence === 'low' && row.research_confidence === 'high') {
      p.confidence = 'medium'; // don't let a high-confidence Excel source get lost under the default 'low'
    }
  }

  // Unmatched clients -- same situation as the Alcampo case: real active
  // deployment, no company record found under this name.
  const unmatchedClients = clientNames
    .filter((n) => !clientMatches[n])
    .map((n) => ({ name: n, ...clientHistory[n] }))
    .sort((a, b) => b.active_devices - a.active_devices);

  const proposals = [...proposalsByCompanyId.values()]
    .filter((p) => Object.keys(p.proposed).length > 0 || p.policyFlags.length > 0)
    .sort((a, b) => (b.deviceInfo?.asPartner?.active_devices || b.deviceInfo?.asEndClient?.active_devices || 0)
      - (a.deviceInfo?.asPartner?.active_devices || a.deviceInfo?.asEndClient?.active_devices || 0));

  return { proposals, unmatchedClients, totalCompaniesScanned: companies.length };
}

module.exports = { buildProposals };
