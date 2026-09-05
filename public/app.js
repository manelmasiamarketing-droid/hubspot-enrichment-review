const state = {
  data: null,
  selected: new Map(), // companyId -> properties object to apply
  page: 0,
};

const FIELD_LABELS = {
  tipo_de_empresa: 'Tipo de Empresa',
  company_score: 'Company Score',
  country: 'País',
  acceso_comercial_newsletter: 'Acceso comercial / Newsletter',
};

async function load(refresh) {
  document.getElementById('status').textContent = 'Cargando…';
  try {
    const res = await fetch(`/api/proposals${refresh ? '?refresh=1' : ''}`);
    const body = await res.json();
    if (!res.ok || body.error) {
      document.getElementById('headerSummary').textContent = `Error: ${body.error || res.status}`;
      document.getElementById('status').textContent = '';
      return;
    }
    state.data = body;
    document.getElementById('status').textContent = '';
    render();
  } catch (e) {
    document.getElementById('headerSummary').textContent = `Error de conexión: ${e.message}`;
    document.getElementById('status').textContent = '';
  }
}

function passesFilters(p) {
  const confidence = document.getElementById('confidenceFilter').value;
  const role = document.getElementById('roleFilter').value;
  const search = document.getElementById('searchBox').value.trim().toLowerCase();
  const onlyFlagged = document.getElementById('onlyFlagged').checked;
  if (confidence && p.confidence !== confidence) return false;
  if (role && p.role !== role) return false;
  if (search && !p.companyName.toLowerCase().includes(search)) return false;
  if (onlyFlagged && p.policyFlags.length === 0) return false;
  return true;
}

function fieldRow(field, current, proposed) {
  return `<div class="field"><span class="name">${FIELD_LABELS[field] || field}:</span> ${
    current ? `<span>${escapeHtml(current)}</span>` : '<span style="color:#9ca3af">(vacío)</span>'
  }<span class="arrow">→</span><span class="new">${escapeHtml(proposed)}</span></div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function render() {
  const { proposals, unmatchedClients, totalCompaniesScanned } = state.data;
  document.getElementById('headerSummary').textContent =
    `${totalCompaniesScanned} companies escaneadas · ${proposals.length} con cambios propuestos · ${unmatchedClients.length} clientes sin match`;

  const filtered = proposals.filter(passesFilters);
  const pageSize = Number(document.getElementById('pageSize').value); // 0 = all
  const totalPages = pageSize > 0 ? Math.max(1, Math.ceil(filtered.length / pageSize)) : 1;
  state.page = Math.min(state.page, totalPages - 1);
  const start = pageSize > 0 ? state.page * pageSize : 0;
  const end = pageSize > 0 ? start + pageSize : filtered.length;
  const pageItems = filtered.slice(start, end);

  document.getElementById('pageIndicator').textContent =
    pageSize > 0 ? `Página ${state.page + 1} de ${totalPages} (${filtered.length} filas)` : `${filtered.length} filas`;
  document.getElementById('prevPage').disabled = state.page === 0;
  document.getElementById('nextPage').disabled = state.page >= totalPages - 1;

  const rowsEl = document.getElementById('rows');
  rowsEl.innerHTML = '';
  for (const p of pageItems) {
    const tr = document.createElement('tr');
    const fieldsHtml = Object.entries(p.proposed)
      .map(([field, value]) => fieldRow(field, p.current[field], value))
      .join('');
    const reasonsHtml = p.reasons.length
      ? `<div class="reasons">${p.reasons.map(escapeHtml).join('<br/>')}</div>` : '';
    const flagsHtml = p.policyFlags.length
      ? `<div class="flag">⚠ ${p.policyFlags.map(escapeHtml).join('<br/>⚠ ')}</div>` : '';

    const asEndClient = p.deviceInfo && p.deviceInfo.asEndClient;
    const servedByExternalPartner = asEndClient && asEndClient.partner_group && !asEndClient.is_direct_channel;
    const agreementHtml = servedByExternalPartner ? `
      <div class="reasons" style="margin-top:8px;">
        <label><input type="checkbox" class="agreementCheck" data-id="${p.companyId}" /> Acuerdo de contacto directo firmado</label>
        <input type="date" class="agreementDate" data-id="${p.companyId}" style="margin-left:6px;" />
      </div>` : '';

    tr.innerHTML = `
      <td><input type="checkbox" class="rowCheck" data-id="${p.companyId}" /></td>
      <td><a class="company-link" href="${p.url}" target="_blank">${escapeHtml(p.companyName)}</a></td>
      <td>${p.role || ''}</td>
      <td>${fieldsHtml}${reasonsHtml}${flagsHtml}${agreementHtml}</td>
      <td><span class="badge ${p.confidence}">${p.confidence}</span></td>
    `;
    rowsEl.appendChild(tr);
  }

  function applyAgreementForRow(id) {
    const checkEl = document.querySelector(`.agreementCheck[data-id="${id}"]`);
    const dateEl = document.querySelector(`.agreementDate[data-id="${id}"]`);
    const p = proposals.find((x) => String(x.companyId) === String(id));
    const existing = state.selected.get(id) || { ...p.proposed };
    existing.acuerdo_contacto_directo_firmado = checkEl.checked ? 'true' : 'false';
    if (dateEl.value) existing.fecha_firma_acuerdo_directo = dateEl.value;
    state.selected.set(id, existing);
    const rowCheck = document.querySelector(`.rowCheck[data-id="${id}"]`);
    if (rowCheck) rowCheck.checked = true;
    updateSelectionSummary();
  }
  document.querySelectorAll('.agreementCheck, .agreementDate').forEach((el) => {
    el.addEventListener('change', (e) => applyAgreementForRow(e.target.dataset.id));
  });

  document.querySelectorAll('.rowCheck').forEach((cb) => {
    cb.addEventListener('change', (e) => {
      const id = e.target.dataset.id;
      const p = proposals.find((x) => String(x.companyId) === String(id));
      const writableProps = { ...p.proposed };
      if (e.target.checked) state.selected.set(id, writableProps);
      else state.selected.delete(id);
      updateSelectionSummary();
    });
  });

  const unmatchedEl = document.getElementById('unmatchedRows');
  unmatchedEl.innerHTML = '';
  for (const c of unmatchedClients) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(c.name)}</td>
      <td>${c.active_devices}</td>
      <td>${escapeHtml(c.country || '')}</td>
      <td>${c.is_direct_channel ? 'Directo (Netipbox)' : escapeHtml(c.partner_group || '')}</td>
      <td><button class="ghost createBtn" data-name="${escapeHtml(c.name)}" data-country="${escapeHtml(c.country || '')}">Crear en HubSpot</button></td>
    `;
    unmatchedEl.appendChild(tr);
  }
  document.querySelectorAll('.createBtn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm(`¿Crear la company "${btn.dataset.name}" en HubSpot como Cliente Final (país: ${btn.dataset.country || 'sin dato'})?`)) return;
      btn.disabled = true;
      btn.textContent = 'Creando…';
      const res = await fetch('/api/create-company', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ properties: { name: btn.dataset.name, tipo_de_empresa: 'Cliente Final', country: btn.dataset.country || undefined } }),
      });
      const out = await res.json();
      btn.textContent = out.ok ? 'Creada ✓' : 'Error';
    });
  });
}

function updateSelectionSummary() {
  document.getElementById('selectionSummary').textContent = `${state.selected.size} cambios seleccionados`;
  document.getElementById('applyBtn').disabled = state.selected.size === 0;
}

document.getElementById('refreshBtn').addEventListener('click', () => load(true));
document.getElementById('setupPropsBtn').addEventListener('click', async () => {
  if (!confirm('Esto crea (si no existen) 3 propiedades nuevas en HubSpot: acceso_comercial_newsletter, acuerdo_contacto_directo_firmado y fecha_firma_acuerdo_directo. No toca ningún dato de ninguna company. ¿Confirmas?')) return;
  const btn = document.getElementById('setupPropsBtn');
  btn.disabled = true;
  btn.textContent = 'Creando…';
  const res = await fetch('/api/setup-properties', { method: 'POST' });
  const out = await res.json();
  btn.disabled = false;
  btn.textContent = '⚙ Crear propiedades en HubSpot';
  if (!out.ok) {
    alert(`Error: ${out.error}`);
    return;
  }
  alert(out.results.map((r) => `${r.name}: ${r.status}`).join('\n'));
  load(true);
});
['confidenceFilter', 'roleFilter', 'searchBox', 'onlyFlagged'].forEach((id) => {
  document.getElementById(id).addEventListener('input', () => { state.page = 0; render(); });
});
document.getElementById('pageSize').addEventListener('input', () => { state.page = 0; render(); });
document.getElementById('prevPage').addEventListener('click', () => { state.page -= 1; render(); });
document.getElementById('nextPage').addEventListener('click', () => { state.page += 1; render(); });
document.getElementById('selectAll').addEventListener('change', (e) => {
  document.querySelectorAll('.rowCheck:not([disabled])').forEach((cb) => {
    cb.checked = e.target.checked;
    cb.dispatchEvent(new Event('change'));
  });
});

document.getElementById('applyBtn').addEventListener('click', async () => {
  const updates = [...state.selected.entries()].map(([companyId, properties]) => ({ companyId, properties }));
  if (!confirm(`Esto va a escribir ${updates.length} cambios en HubSpot ahora mismo. ¿Confirmas?`)) return;
  document.getElementById('applyBtn').disabled = true;
  document.getElementById('applyBtn').textContent = 'Aplicando…';
  const res = await fetch('/api/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ updates }),
  });
  const out = await res.json();
  const failed = out.results.filter((r) => !r.ok);
  alert(failed.length ? `${out.results.length - failed.length} aplicados, ${failed.length} fallaron (ver consola)` : `${out.results.length} cambios aplicados correctamente`);
  if (failed.length) console.error(failed);
  state.selected.clear();
  document.getElementById('applyBtn').textContent = 'Verificar y aplicar a HubSpot';
  load(true);
});

load(false);
