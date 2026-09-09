const OBJECT_LABELS = {
  companies: 'Companies',
  contacts: 'Contactos',
  deals: 'Deals',
  notes: 'Notas',
  tasks: 'Tareas',
  emails: 'Emails',
  calls: 'Llamadas',
  meetings: 'Reuniones',
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatProgress(p) {
  if (!p || p.stage === 'idle') return '';
  const pct = p.total ? ` (${Math.round((p.done / p.total) * 100)}%)` : '';
  return `${p.stage}${pct}`;
}

function renderCards(objectCounts, totalCompaniesA) {
  const cards = Object.keys(OBJECT_LABELS).map((key) => {
    const val = objectCounts[key];
    const isErr = val && typeof val === 'object' && val.error;
    return `<div class="card">
      <div class="value ${isErr ? 'err' : ''}">${isErr ? 'Error' : (val ?? '—')}</div>
      <div class="label">${OBJECT_LABELS[key]} (cuenta B)${isErr ? `<br/><span style="font-size:11px;">${escapeHtml(val.error)}</span>` : ''}</div>
    </div>`;
  }).join('');
  return `<div class="cards">${cards}
    <div class="card"><div class="value">${totalCompaniesA}</div><div class="label">Companies (cuenta A — nsign)</div></div>
  </div>`;
}

function renderComparisonTable(title, rows, kind) {
  if (!rows.length) return `<h2>${title}</h2><p style="color:#9ca3af;font-size:13px;">Ninguna</p>`;
  const body = rows.map((r) => {
    if (kind === 'dup') {
      return `<tr>
        <td>${escapeHtml(r.nameInB)}</td>
        <td>${escapeHtml(r.matchedNameInA)}</td>
        <td>${(r.score * 100).toFixed(0)}%</td>
        <td><span class="badge dup">Duplicado claro</span></td>
      </tr>`;
    }
    return `<tr>
      <td>${escapeHtml(r.nameInB)}</td>
      <td>${r.ambiguous ? escapeHtml(r.possibleMatchInA || '') : '<span style="color:#9ca3af;">—</span>'}</td>
      <td>${r.ambiguous ? `${(r.score * 100).toFixed(0)}%` : ''}</td>
      <td>${r.ambiguous ? '<span class="badge ambig">Ambiguo — revisar</span>' : '<span class="badge new">Net-new</span>'}</td>
    </tr>`;
  }).join('');
  return `<h2>${title} (${rows.length})</h2>
    <table>
      <thead><tr><th>Nombre en cuenta B</th><th>Posible match en cuenta A</th><th>Confianza</th><th>Estado</th></tr></thead>
      <tbody>${body}</tbody>
    </table>`;
}

async function load() {
  const status = document.getElementById('status');
  const content = document.getElementById('content');
  const btn = document.getElementById('loadBtn');
  btn.disabled = true;
  status.textContent = 'Cargando…';
  content.innerHTML = '';

  const pollId = setInterval(async () => {
    try {
      const p = await (await fetch('/api/inventory/progress')).json();
      const text = formatProgress(p);
      if (text) status.textContent = text;
    } catch (e) { /* cosmetic only */ }
  }, 700);

  try {
    const res = await fetch('/api/inventory');
    const body = await res.json();
    clearInterval(pollId);
    btn.disabled = false;
    status.textContent = '';

    if (!res.ok || body.error) {
      content.innerHTML = `<div class="error">${escapeHtml(body.error || `Error ${res.status}`)}</div>`;
      return;
    }

    const { accountB, accountA, companiesComparison, filter } = body;
    let html = '';
    if (filter) {
      html += `<div class="note">Filtro aplicado: ${escapeHtml(filter.description)} (desde ${escapeHtml(filter.sinceDate)}).</div>`;
    }
    html += renderCards(accountB.objectCounts, accountA.totalCompanies);
    html += `<div class="note">
      De ${companiesComparison.totalInAccountB} companies en la cuenta B (actualizadas en los últimos 6 meses):
      <strong>${companiesComparison.clearDuplicates}</strong> parecen duplicados claros de una company ya existente en nsign,
      <strong>${companiesComparison.netNewOrAmbiguous}</strong> son net-new o ambiguas (revisar a mano antes de decidir nada).
    </div>`;
    html += renderComparisonTable('Duplicados claros', companiesComparison.duplicates, 'dup');
    html += renderComparisonTable('Net-new / ambiguos', companiesComparison.netNew, 'new');
    content.innerHTML = html;
  } catch (e) {
    clearInterval(pollId);
    btn.disabled = false;
    status.textContent = '';
    content.innerHTML = `<div class="error">Error de conexión: ${escapeHtml(e.message)}</div>`;
  }
}

document.getElementById('loadBtn').addEventListener('click', load);
