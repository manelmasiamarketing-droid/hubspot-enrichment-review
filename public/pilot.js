function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let candidates = [];

function renderContactRow(c) {
  const name = [c.firstname, c.lastname].filter(Boolean).join(' ') || '(sin nombre)';
  const status = c.alreadyCreated
    ? `<span class="badge done">✓ Ya creado (A: ${escapeHtml(c.contactIdInA)})</span>`
    : '<span class="badge pending">Pendiente</span>';
  return `<tr>
    <td>${escapeHtml(name)}</td>
    <td>${escapeHtml(c.email || '')}</td>
    <td>${escapeHtml(c.contactIdInB)}</td>
    <td>${status}</td>
  </tr>`;
}

function renderCompany(company, index) {
  const status = company.alreadyCreated
    ? `<span class="badge done">✓ Ya creado (A: ${escapeHtml(company.companyIdInA)})</span>`
    : '<span class="badge pending">Pendiente</span>';
  const contactRows = company.contacts.map(renderContactRow).join('');
  const disableCheckbox = company.alreadyCreated ? 'disabled' : '';
  const dup = company.possibleDuplicateCompany;
  const warning = (dup && !company.alreadyCreated) ? `<div class="note" style="background:#fef2f2;border-color:#fecaca;color:#b91c1c;margin:0 16px 12px;">
      ⚠️ Posible duplicado: uno o más contactos ya pertenecen a <strong>${escapeHtml(dup.name || `company ${dup.id}`)}</strong> (id A: ${escapeHtml(dup.id)}) en la cuenta A.
      Antes de crear "${escapeHtml(company.companyName)}" como empresa nueva, revisa si es el mismo cliente real.
    </div>` : '';
  const createBtn = (dup && !company.alreadyCreated)
    ? `<button class="danger link-existing-btn" data-index="${index}">Vincular a "${escapeHtml(dup.name || dup.id)}" (recomendado)</button>
       <button class="secondary create-one-btn" data-index="${index}">Crear de todas formas</button>`
    : `<button class="secondary create-one-btn" data-index="${index}" ${company.alreadyCreated ? 'disabled' : ''}>Crear esta company</button>`;
  return `<div class="company-card" data-index="${index}">
    <div class="company-head">
      <input type="checkbox" class="row-check" data-index="${index}" ${disableCheckbox} ${company.alreadyCreated ? '' : 'checked'} />
      <div class="company-name">${escapeHtml(company.companyName)} <span style="color:var(--text-dim); font-weight:400;">(B: ${escapeHtml(company.companyIdInB)})</span></div>
      ${status}
      ${createBtn}
    </div>
    ${warning}
    <table>
      <thead><tr><th>Contacto</th><th>Email</th><th>ID contacto (B)</th><th>Estado</th></tr></thead>
      <tbody>${contactRows}</tbody>
    </table>
  </div>`;
}

function render() {
  document.getElementById('content').innerHTML = candidates.map(renderCompany).join('');
  document.querySelectorAll('.create-one-btn').forEach((btn) => {
    btn.addEventListener('click', () => createOne(Number(btn.dataset.index)));
  });
  document.querySelectorAll('.link-existing-btn').forEach((btn) => {
    btn.addEventListener('click', () => linkToExisting(Number(btn.dataset.index)));
  });
}

async function loadCandidates() {
  const status = document.getElementById('status');
  const content = document.getElementById('content');
  status.textContent = 'Cargando estado desde HubSpot (cuenta A)…';
  content.innerHTML = '';
  try {
    const res = await fetch('/api/pilot/candidates');
    const body = await res.json();
    if (!res.ok || body.error) {
      content.innerHTML = `<div class="error">${escapeHtml(body.error || `Error ${res.status}`)}</div>`;
      status.textContent = '';
      return;
    }
    candidates = body.candidates;
    render();
    status.textContent = '';
  } catch (e) {
    content.innerHTML = `<div class="error">Error de conexión: ${escapeHtml(e.message)}</div>`;
    status.textContent = '';
  }
}

async function createCompanyPayload(company) {
  const res = await fetch('/api/pilot/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      companyIdInB: company.companyIdInB,
      companyName: company.companyName,
      contacts: company.contacts.map((c) => ({
        contactIdInB: c.contactIdInB, email: c.email, firstname: c.firstname, lastname: c.lastname,
      })),
    }),
  });
  return res.json();
}

async function createOne(index) {
  const company = candidates[index];
  const dup = company.possibleDuplicateCompany;
  const dupWarning = dup ? `\n\n⚠️ AVISO: contactos de esta empresa ya pertenecen a "${dup.name || dup.id}" en cuenta A -- esto puede ser un duplicado. Confirmas que quieres crear una empresa NUEVA de todas formas?` : '';
  if (!confirm(`¿Crear "${company.companyName}" (+ ${company.contacts.length} contacto/s) en la cuenta A de HubSpot?\n\nEsto ESCRIBE en HubSpot. Si ya existe (mismo id_origen_cuenta_b), no se duplicará.${dupWarning}`)) {
    return;
  }
  const status = document.getElementById('status');
  status.textContent = `Creando ${company.companyName}…`;
  const result = await createCompanyPayload(company);
  status.textContent = '';
  if (!result.ok) {
    alert(`Error creando ${company.companyName}: ${result.error}`);
    return;
  }
  await loadCandidates();
}

async function linkToExisting(index) {
  const company = candidates[index];
  const dup = company.possibleDuplicateCompany;
  if (!confirm(`¿Vincular los contactos de "${company.companyName}" a la company existente "${dup.name || dup.id}" (id A: ${dup.id}) en vez de crear una nueva?\n\nEsto ESCRIBE en HubSpot (asocia contactos + rellena id_origen_cuenta_b si esa company aún no tiene uno).`)) {
    return;
  }
  const status = document.getElementById('status');
  status.textContent = `Vinculando ${company.companyName} a ${dup.name || dup.id}…`;
  const res = await fetch('/api/pilot/link-to-existing-company', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      companyIdInB: company.companyIdInB,
      existingCompanyIdInA: dup.id,
      contacts: company.contacts.map((c) => ({
        contactIdInB: c.contactIdInB, email: c.email, firstname: c.firstname, lastname: c.lastname,
      })),
    }),
  });
  const result = await res.json();
  status.textContent = '';
  if (!result.ok) {
    alert(`Error vinculando ${company.companyName}: ${result.error}`);
    return;
  }
  await loadCandidates();
}

async function createSelected() {
  const checked = [...document.querySelectorAll('.row-check:checked')].map((el) => Number(el.dataset.index));
  const toCreate = checked.map((i) => candidates[i]).filter((c) => !c.alreadyCreated);
  if (toCreate.length === 0) {
    alert('No hay nada seleccionado pendiente de crear.');
    return;
  }
  if (!confirm(`¿Crear ${toCreate.length} companies (+ sus contactos activos) en la cuenta A de HubSpot?\n\nEsto ESCRIBE en HubSpot, una por una. Las que ya existan no se duplicarán.`)) {
    return;
  }
  const status = document.getElementById('status');
  const btn = document.getElementById('createSelectedBtn');
  btn.disabled = true;
  for (let i = 0; i < toCreate.length; i += 1) {
    const company = toCreate[i];
    status.textContent = `Creando ${i + 1}/${toCreate.length}: ${company.companyName}…`;
    const result = await createCompanyPayload(company);
    if (!result.ok) {
      alert(`Error creando ${company.companyName}: ${result.error}\n\nSe detiene aquí -- lo ya creado queda hecho, lo pendiente sigue pendiente.`);
      break;
    }
  }
  status.textContent = '';
  btn.disabled = false;
  await loadCandidates();
}

document.getElementById('reloadBtn').addEventListener('click', loadCandidates);
document.getElementById('createSelectedBtn').addEventListener('click', createSelected);
document.getElementById('setupBtn').addEventListener('click', async () => {
  if (!confirm('¿Crear las 2 propiedades de correspondencia (id_origen_cuenta_b en Company, id_contacto_origen_cuenta_b en Contact) en HubSpot (cuenta A)?\n\nEsto solo crea definiciones de propiedad, no toca ningún registro. Es idempotente -- si ya existen, no hace nada.')) {
    return;
  }
  const status = document.getElementById('status');
  status.textContent = 'Creando propiedades…';
  const res = await fetch('/api/pilot/setup-crosswalk-properties', { method: 'POST' });
  const body = await res.json();
  status.textContent = '';
  if (!body.ok) {
    alert(`Error: ${body.error}`);
    return;
  }
  alert(body.results.map((r) => `${r.objectType}.${r.name}: ${r.status}`).join('\n'));
});

loadCandidates();
