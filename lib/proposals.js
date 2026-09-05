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

// Newsletter/comms-access proposal. Values must match the enumeration options
// defined in CUSTOM_PROPERTY_DEFS (hubspot.js) exactly, or the write fails.
// A signed direct-contact agreement (acuerdo_contacto_directo_firmado) always
// overrides the default "Solo via Partner" -- that's the whole point of the
// agreement: permission to email the end client even though a partner serves
// them.
function proposeCommsAccess({ isDirectChannel, country, hasExternalPartner, agreementSigned, agreementDate }) {
  if (hasExternalPartner) {
    if (agreementSigned) {
      return { value: 'Directo', reason: `Acuerdo de contacto directo firmado con el partner${agreementDate ? ` (${agreementDate})` : ''} -- permite enviar directo pese a ser cliente de partner` };
    }
    return { value: 'Solo via Partner', reason: 'Sin acuerdo de contacto directo firmado -- respetar el canal del partner' };
  }
  if (isDirectChannel && !SPAIN_PORTUGAL.has(country)) {
    return { value: 'Excepcion de politica (revisar)', reason: 'Relación directa fuera de España/Portugal -- rompe la política partner-only', isPolicyFlag: true };
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
    const agreementSigned = String(p.current.acuerdo_contacto_directo_firmado).toLowerCase() === 'true';
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
