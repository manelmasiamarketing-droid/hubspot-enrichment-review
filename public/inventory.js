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

const TAB_LABELS = { all: 'Todo', 12: 'Últimos 12 meses', 6: 'Últimos 6 meses', 3: 'Últimos 3 meses' };

const state = {
  cache: {}, // monthsKey -> last successful response body
  current: '6',
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

// Small side-by-side strip of every window already fetched this session, so
// switching tabs builds up a running comparison instead of only ever showing
// one window at a time -- this is the actual point of having tabs (Manel,
// 09/09/2026: "para ver que vale la pena").
function renderComparisonStrip() {
  const keys = Object.keys(state.cache);
  if (keys.length < 2) return '';
  const rows = keys
    .sort((a, b) => (a === 'all' ? -1 : b === 'all' ? 1 : Number(b) - Number(a)))
    .map((k) => {
      const body = state.cache[k];
      const companiesB = body.companiesComparison.totalInAccountB;
      const dup = body.companiesComparison.clearDuplicates;
      const netNew = body.companiesComparison.netNewOrAmbiguous;
      const deals = body.accountB.objectCounts.deals;
      const realActivity = body.companiesComparison.emailActivityError
        ? 'error'
        : body.companiesComparison.netNewWithRealActivity;
      return `<tr class="${k === state.current ? 'current' : ''}">
        <td>${TAB_LABELS[k]}</td>
        <td>${companiesB}</td>
        <td>${dup}</td>
        <td>${netNew}</td>
        <td>${typeof deals === 'object' ? '—' : deals}</td>
        <td>${realActivity === 'error' ? '<span style="color:#b91c1c;">error</span>' : realActivity}</td>
      </tr>`;
    }).join('');
  return `<h2>Comparativa de ventanas ya cargadas</h2>
    <table>
      <thead><tr><th>Ventana</th><th>Companies (B)</th><th>Duplicados claros</th><th>Net-new/ambiguos</th><th>Deals (B)</th><th>Net-new con email real (12m)</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function activityBadge(recentEmailActivity) {
  if (recentEmailActivity === 'error') return '<span style="color:#b91c1c; font-size:11.5px;">error</span>';
  if (recentEmailActivity === true) return '<span class="badge new">Email reciente</span>';
  return '<span style="color:#9ca3af; font-size:11.5px;">sin actividad</span>';
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
      <td>${activityBadge(r.recentEmailActivity)}</td>
    </tr>`;
  }).join('');
  const extraHeader = kind === 'new' ? '<th>Actividad real (email, 12m)</th>' : '';
  return `<h2>${title} (${rows.length})</h2>
    <table>
      <thead><tr><th>Nombre en cuenta B</th><th>Posible match en cuenta A</th><th>Confianza</th><th>Estado</th>${extraHeader}</tr></thead>
      <tbody>${body}</tbody>
    </table>`;
}

function renderBody(body) {
  const content = document.getElementById('content');
  const { accountB, accountA, companiesComparison, filter } = body;
  let html = renderComparisonStrip();
  if (filter) {
    html += `<div class="note">Filtro aplicado: ${escapeHtml(filter.description)}${filter.sinceDate ? ` (desde ${escapeHtml(filter.sinceDate)})` : ''}.</div>`;
  }
  html += renderCards(accountB.objectCounts, accountA.totalCompanies);
  html += `<div class="note">
    De ${companiesComparison.totalInAccountB} companies en la cuenta B (${TAB_LABELS[state.current].toLowerCase()}):
    <strong>${companiesComparison.clearDuplicates}</strong> parecen duplicados claros de una company ya existente en nsign,
    <strong>${companiesComparison.netNewOrAmbiguous}</strong> son net-new o ambiguas (revisar a mano antes de decidir nada).
  </div>`;
  if (companiesComparison.emailActivityError) {
    html += `<div class="error">No se pudo comprobar la actividad real por email: ${escapeHtml(companiesComparison.emailActivityError)}</div>`;
  } else {
    html += `<div class="note">
      De esas net-new/ambiguas, <strong>${companiesComparison.netNewWithRealActivity}</strong> tienen al menos un email real
      en los últimos ${companiesComparison.emailActivityMonths} meses — una señal más fiable que la fecha de última
      modificación de la company/deal, que en esta cuenta parece tocarse en bloque por algo automático. El resto no
      muestra actividad de email reciente.
    </div>`;
  }
  html += renderComparisonTable('Duplicados claros', companiesComparison.duplicates, 'dup');
  html += renderComparisonTable('Net-new / ambiguos', companiesComparison.netNew, 'new');
  content.innerHTML = html;
}

async function loadTab(monthsKey) {
  state.current = monthsKey;
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.months === monthsKey);
  });

  if (state.cache[monthsKey]) {
    renderBody(state.cache[monthsKey]);
    return;
  }

  const status = document.getElementById('status');
  const content = document.getElementById('content');
  document.querySelectorAll('.tab-btn').forEach((btn) => { btn.disabled = true; });
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
    const res = await fetch(`/api/inventory?months=${encodeURIComponent(monthsKey)}`);
    const body = await res.json();
    clearInterval(pollId);
    document.querySelectorAll('.tab-btn').forEach((btn) => { btn.disabled = false; });
    status.textContent = '';

    if (!res.ok || body.error) {
      content.innerHTML = `<div class="error">${escapeHtml(body.error || `Error ${res.status}`)}</div>`;
      return;
    }

    state.cache[monthsKey] = body;
    renderBody(body);
  } catch (e) {
    clearInterval(pollId);
    document.querySelectorAll('.tab-btn').forEach((btn) => { btn.disabled = false; });
    status.textContent = '';
    content.innerHTML = `<div class="error">Error de conexión: ${escapeHtml(e.message)}</div>`;
  }
}

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => loadTab(btn.dataset.months));
});
