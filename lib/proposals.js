const fs = require('fs');
const path = require('path');
const { getAllCompanies } = require('./hubspot');
const { matchClientsToCompanies, partnerTierFromDevices, SPAIN_PORTUGAL, COUNTRY_TO_LANGUAGE, countryToSlug, deviceCountBucket } = require('./matching');
const { detectBranchClusters } = require('./branchDetection');

const clientHistory = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'data', 'device_history_by_client.json'), 'utf8'),
);
const churnedHistory = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'data', 'device_history_churned_clients.json'), 'utf8'),
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

// "Corporate" was the Excel research script's fallback label whenever no
// specific pattern matched -- Manel confirmed (06/09/2026, Boldú case: a QSR
// bakery mislabeled Corporate) that it's mostly noise at low confidence, and
// that nsign genuinely has few Corporate clients. Only trust it at "high"
// confidence; at medium/low, treat as unmapped so it doesn't get written.
const LOW_TRUST_SECTORS = new Set(['Corporate']);

// sector__vertical_ is a second, broader vertical taxonomy (distinct from
// industry_sector) -- real enum options confirmed via the property config
// screenshots Manel sent 06/09/2026: Quick Service Restaurants, Food &
// Beverage, Corporate Comms, Retail, Healthcare, Hospitality,
// Travel-Transportation-Concessions, Others, Centros Comerciales y Espacios
// Públicos, Entretenimiento y Ocio, Educación, Educación Secundaria y
// Superior, Franquicias, Retail Beauty. Same "Corporate" low-trust gate
// applies here (mapped to "Corporate Comms").
const EXCEL_SECTOR_TO_SECTOR_VERTICAL = {
  'QSR': 'Quick Service Restaurants',
  'Corporate': 'Corporate Comms',
  'Salut': 'Healthcare',
  'Educación': 'Educación',
  'Fashion Retail': 'Retail',
  'Retail Fashion & Apparel': 'Retail',
  'Beauty & Cosmetics': 'Retail Beauty',
  'Beauty & Cosmetics Retail': 'Retail Beauty',
  'Travel Retail': 'Travel-Transportation-Concessions',
  'Retail Alimentari': 'Food & Beverage',
};

const LIFECYCLESTAGE_CHURN = '1741627641'; // internal value for "Churn" (confirmed via get_properties)

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

async function buildProposals(onProgress) {
  const report = onProgress || (() => {});
  report({ stage: 'Descargando companies de HubSpot…', done: 0, total: null });
  const companies = await getAllCompanies((fetched) => report({ stage: `Descargando companies de HubSpot… (${fetched} traídas)`, done: fetched, total: null }));

  // Partners are matched and processed FIRST, deliberately: you need to know
  // who the partners are before you can attribute which end-clients they
  // distribute to (Manel, 06/09/2026).
  const partnerNames = Object.keys(partnerHistory);
  report({ stage: `Cruzando ${partnerNames.length} grupos partner/reseller…`, done: 0, total: partnerNames.length });
  const partnerMatches = matchClientsToCompanies(partnerNames, companies, (done, total) => report({ stage: 'Cruzando grupos partner/reseller…', done, total }));

  const clientNames = Object.keys(clientHistory);
  report({ stage: `Cruzando ${clientNames.length} clientes del historial de players…`, done: 0, total: clientNames.length });
  const clientMatches = matchClientsToCompanies(clientNames, companies, (done, total) => report({ stage: `Cruzando clientes del historial de players…`, done, total }));

  const churnedNames = Object.keys(churnedHistory);
  report({ stage: `Cruzando ${churnedNames.length} exclientes (0 dispositivos activos hoy)…`, done: 0, total: churnedNames.length });
  const churnedMatches = matchClientsToCompanies(churnedNames, companies, (done, total) => report({ stage: 'Cruzando exclientes…', done, total }));

  const proposalsByCompanyId = new Map();
  const countryAgg = new Map(); // companyId -> { bestCountry, bestDevices, allCountries: Set }

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
        proposedAssociations: [],
        confidence: 'low',
      });
    }
    return proposalsByCompanyId.get(company.id);
  }

  function trackCountry(p, hist) {
    let agg = countryAgg.get(p.companyId);
    if (!agg) {
      agg = { bestCountry: null, bestDevices: -1, allCountries: new Set(), deviceSum: 0 };
      countryAgg.set(p.companyId, agg);
    }
    if ((hist.active_devices || 0) > agg.bestDevices) {
      agg.bestDevices = hist.active_devices || 0;
      agg.bestCountry = hist.country;
    }
    (hist.countries || (hist.country ? [hist.country] : [])).forEach((c) => agg.allCountries.add(c));
    // Summed across every matched history entry (a company can have several
    // raw client-history rows -- e.g. one per location) so numero_de_dispositivos
    // reflects the company's total active screens, not just one location.
    agg.deviceSum += hist.active_devices || 0;
  }

  // Partner role: propose company_score tier from total managed devices.
  for (const partnerName of partnerNames) {
    const match = partnerMatches[partnerName];
    if (!match) continue;
    const hist = partnerHistory[partnerName];
    const p = getOrInit(match.company);
    p.role = 'partner';
    p.deviceInfo = { ...(p.deviceInfo || {}), asPartner: hist };

    if (!p.current.tipo_de_empresa) {
      p.proposed.tipo_de_empresa = 'Partner';
      p.reasons.push(`Aparece como grupo partner/reseller gestionando ${hist.managed_client_count} clientes en el historial`);
    }
    if (!p.current.relacion) {
      p.proposed.relacion = 'Partner';
    }
    if (!p.current.company_score) {
      const tier = partnerTierFromDevices(hist.active_devices);
      p.proposed.company_score = tier;
      p.reasons.push(`${hist.active_devices} pantallas activas gestionadas en total (${hist.managed_client_count} clientes) → tier ${tier}`);
    }
    // Life-Cycle Stage for partners uses a different value than end clients:
    // "CURRENT CUSTOMER" is reserved for companies buying/using nsign
    // themselves. An active partner/reseller channel (real managed devices in
    // the history) is "ACTIVATION" -- confirmed by Manel 06/09/2026 against
    // an existing partner record in HubSpot.
    if (!p.current.estado_del_partner) {
      p.proposed.estado_del_partner = 'ACTIVATION';
      p.reasons.push('Partner activo con dispositivos gestionados en el historial → Life-Cycle Stage "ACTIVATION"');
    }
    p.confidence = match.score >= 0.99 ? 'high' : match.score >= 0.75 ? 'medium' : 'low';
  }

  // End-client role (active today): tipo_de_empresa + comms access + partner
  // association + estado_del_partner. Country/idioma/company_countries are
  // NOT set here -- accumulated via trackCountry() and finalized once all
  // passes are done, so a company matched by several raw client-history rows
  // (different countries/locations) doesn't just keep whichever row happened
  // to run last.
  for (const clientName of clientNames) {
    const match = clientMatches[clientName];
    if (!match) continue;
    const hist = clientHistory[clientName];
    const p = getOrInit(match.company);
    p.role = p.role === 'partner' ? 'end_client+partner' : 'end_client';
    p.deviceInfo = { ...(p.deviceInfo || {}), asEndClient: hist };
    trackCountry(p, hist);

    if (!p.current.tipo_de_empresa) {
      p.proposed.tipo_de_empresa = 'Cliente Final';
      p.reasons.push('Aparece como Cliente en el historial de players (no como grupo partner/reseller)');
    }
    if (!p.current.relacion) {
      p.proposed.relacion = 'End-user';
    }
    if (!p.current.estado_del_partner) {
      p.proposed.estado_del_partner = 'CURRENT CUSTOMER';
      p.reasons.push(`Tiene ${hist.active_devices} dispositivos activos hoy → cliente actual`);
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
      if (hasExternalPartner) {
        const partnerMatch = partnerMatches[hist.partner_group];
        const alreadyProposed = partnerMatch && p.proposedAssociations.some((a) => a.targetId === partnerMatch.company.id);
        // Skip self-association (a company's own name can fuzzy-match its
        // "partner group" string when both share generic tokens, e.g. a
        // retail chain's own name vs "<CHAIN> SATURN SAU") and de-dupe
        // repeat proposals when several device-history rows for the same
        // company resolve to the same partner.
        if (partnerMatch && String(partnerMatch.company.id) !== String(p.companyId) && !alreadyProposed) {
          p.proposedAssociations.push({
            targetId: partnerMatch.company.id,
            targetName: partnerMatch.company.properties.name,
            targetUrl: `https://app.hubspot.com/contacts/${process.env.HUBSPOT_PORTAL_ID || ''}/record/0-2/${partnerMatch.company.id}`,
            reason: `Vincular como cliente gestionado por "${partnerMatch.company.properties.name}" — visible en el panel de Associated Companies de ambas fichas`,
          });
        }
      }
    }

    p.confidence = match.score >= 0.99 ? 'high' : match.score >= 0.75 ? 'medium' : 'low';
  }

  // Ex-clients: had devices historically, none active today. Proposed as
  // lifecyclestage = Churn -- but only for companies that don't ALSO have an
  // active deployment elsewhere (a company can have one churned location and
  // one active one; it's still a current customer overall, not churned).
  for (const churnedName of churnedNames) {
    const match = churnedMatches[churnedName];
    if (!match) continue;
    const hist = churnedHistory[churnedName];
    const p = getOrInit(match.company);
    if (p.role === 'end_client' || p.role === 'end_client+partner') continue; // still active elsewhere
    p.role = p.role || 'ex_client';
    p.deviceInfo = { ...(p.deviceInfo || {}), asExClient: hist };
    trackCountry(p, hist);

    if (!p.current.lifecyclestage) {
      p.proposed.lifecyclestage = LIFECYCLESTAGE_CHURN;
      p.reasons.push(`Tuvo ${hist.total_devices_ever} dispositivos históricos (última actividad: ${hist.last_movement || 'desconocida'}), 0 activos hoy → Churn`);
    }
    if (p.confidence === 'low') {
      p.confidence = match.score >= 0.99 ? 'medium' : 'low'; // churn signal alone is never "high" confidence
    }
  }

  // Excel enrichment test (websearch/domain/LinkedIn-specialties research,
  // done manually by Manel) -- matched directly by hs_object_id, no name
  // matching needed. Only fills blanks; never overwrites.
  report({ stage: 'Cruzando datos del Excel de enriquecimiento…', done: 0, total: null });
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
      const lowTrust = LOW_TRUST_SECTORS.has(row.industry_sector_excel) && row.research_confidence !== 'high';
      if (mapped && !lowTrust) {
        p.proposed.industry_sector = mapped;
        p.reasons.push(`Vertical "${row.industry_sector_excel}" → ${mapped} — ${sourceNote}`);
      } else if (row.industry_sector_excel) {
        const note = lowTrust
          ? ` -- "${row.industry_sector_excel}" a confianza ${row.research_confidence} es el fallback del script cuando no reconoce el patrón, no una clasificación real (nsign tiene pocos clientes Corporate genuinos); revisar a mano`
          : ' -- sin mapeo directo a un valor de industry_sector, elegir a mano';
        p.reasons.push(`Vertical sugerido "${row.industry_sector_excel}" (${sourceNote})${note}`);
      }
    }
    if (!p.current.sector__vertical_) {
      const mappedVertical = EXCEL_SECTOR_TO_SECTOR_VERTICAL[row.industry_sector_excel];
      const lowTrustVertical = LOW_TRUST_SECTORS.has(row.industry_sector_excel) && row.research_confidence !== 'high';
      if (mappedVertical && !lowTrustVertical) {
        p.proposed.sector__vertical_ = mappedVertical;
        p.reasons.push(`Sector (Vertical) "${row.industry_sector_excel}" → ${mappedVertical} — ${sourceNote}`);
      }
    }

    if (Object.keys(p.proposed).length > 0 && p.confidence === 'low' && row.research_confidence === 'high') {
      p.confidence = 'medium'; // don't let a high-confidence Excel source get lost under the default 'low'
    }
  }

  // Finalize country / idioma / company_countries from the accumulated data
  // (highest-device-count entry wins the single-value fields; the full set
  // of countries seen goes into the multi-select).
  for (const [companyId, agg] of countryAgg.entries()) {
    const p = proposalsByCompanyId.get(companyId);
    if (!p) continue;
    if (!p.current.country && agg.bestCountry) {
      p.proposed.country = agg.bestCountry;
      p.reasons.push(`País "${agg.bestCountry}" tomado del historial de players (mayor volumen de dispositivos)`);
    }
    const effectiveCountry = p.current.country || agg.bestCountry;
    if (!p.current.idioma && effectiveCountry && COUNTRY_TO_LANGUAGE[effectiveCountry]) {
      p.proposed.idioma = COUNTRY_TO_LANGUAGE[effectiveCountry];
      p.reasons.push(`Idioma "${COUNTRY_TO_LANGUAGE[effectiveCountry]}" derivado del país (${effectiveCountry})`);
    }
    if (!p.current.company_countries && agg.allCountries.size > 0) {
      const slugs = [...agg.allCountries].map(countryToSlug).filter(Boolean).sort();
      p.proposed.company_countries = slugs.join(';');
      p.reasons.push(`Country Location: ${[...agg.allCountries].sort().join(', ')} (todas las ubicaciones vistas en el historial de players)`);
    }
    if (!p.current.numero_de_dispositivos && agg.deviceSum > 0) {
      const bucket = deviceCountBucket(agg.deviceSum);
      p.proposed.numero_de_dispositivos = bucket;
      p.reasons.push(`${agg.deviceSum} dispositivos activos hoy según el historial de players → rango ${bucket}`);
    }
  }

  // Unmatched clients -- same situation as the Alcampo case: real active
  // deployment, no company record found under this name.
  const unmatchedClients = clientNames
    .filter((n) => !clientMatches[n])
    .map((n) => ({ name: n, ...clientHistory[n] }))
    .sort((a, b) => b.active_devices - a.active_devices);

  // Unmatched partners -- same idea, but for reseller/integrator groups (e.g.
  // "DIGITAL SIGNAGE SOLUTIONS SA DE CV", nsign's single biggest partner by
  // device volume, has no company record at all -- found 06/09/2026). Each
  // entry gets its company_score tier pre-computed so creating it is a
  // one-click action, same as the end-client case.
  const unmatchedPartners = partnerNames
    .filter((n) => !partnerMatches[n])
    .map((n) => ({
      name: n,
      ...partnerHistory[n],
      suggestedTier: partnerTierFromDevices(partnerHistory[n].active_devices),
    }))
    .sort((a, b) => b.active_devices - a.active_devices);

  // Partners first, then clients, then everything else -- same "identify
  // partners before attributing their clients" ordering Manel asked for.
  const roleOrder = { partner: 0, 'end_client+partner': 1, end_client: 2, ex_client: 3, excel_enrichment: 4 };
  const proposals = [...proposalsByCompanyId.values()]
    .filter((p) => Object.keys(p.proposed).length > 0 || p.policyFlags.length > 0 || p.proposedAssociations.length > 0)
    .sort((a, b) => {
      const roleDiff = (roleOrder[a.role] ?? 9) - (roleOrder[b.role] ?? 9);
      if (roleDiff !== 0) return roleDiff;
      return (b.deviceInfo?.asPartner?.active_devices || b.deviceInfo?.asEndClient?.active_devices || 0)
        - (a.deviceInfo?.asPartner?.active_devices || a.deviceInfo?.asEndClient?.active_devices || 0);
    });

  report({ stage: 'Detectando sucursales (patrón "MARCA (sucursal)")…', done: 0, total: null });
  const { withParent, withoutParent } = detectBranchClusters(companies);
  const branchClusters = withParent.map(({ base, parent, children }) => ({
    base,
    parentId: parent.id,
    parentName: parent.properties.name,
    parentUrl: `https://app.hubspot.com/contacts/${process.env.HUBSPOT_PORTAL_ID || ''}/record/0-2/${parent.id}`,
    children: children.map((c) => ({
      id: c.id,
      name: c.properties.name,
      url: `https://app.hubspot.com/contacts/${process.env.HUBSPOT_PORTAL_ID || ''}/record/0-2/${c.id}`,
    })),
  }));
  const branchClustersWithoutParent = withoutParent.map(({ base, children }) => ({
    base,
    children: children.map((c) => c.properties.name),
  }));

  report({ stage: 'Listo', done: 1, total: 1 });
  return {
    proposals, unmatchedClients, unmatchedPartners, totalCompaniesScanned: companies.length,
    branchClusters, branchClustersWithoutParent,
  };
}

module.exports = { buildProposals };
