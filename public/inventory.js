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

const SIGNAL_LABELS = { emails: 'Email', deals: 'Deal (creado)', tasks: 'Tarea' };
const SIGNAL_ORDER = ['emails', 'deals', 'tasks'];

const TAB_LABELS = { all: 'Todo', 12: 'Últimos 12 meses', 6: 'Últimos 6 meses', 3: 'Últimos 3 meses' };

const state = {
  cache: {}, // "monthsKey|activityMonths" -> last successful response body
  current: '6',
  activityMonths: '12',
};

function cacheKey(monthsKey, activityMonths) {
  return `${monthsKey}|${activityMonths}`;
}

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

function fmtSignalValue(v) {
  return v === 'error' ? '<span style="color:#b91c1c;">error</span>' : (v ?? '—');
}

// Small side-by-side strip of every (ventana, actividad) combo already
// fetched this session, so switching tabs builds up a running comparison
// instead of only ever showing one at a time -- the actual point of having
// tabs (Manel, 09/09/2026: "para ver que vale la pena").
function renderComparisonStrip() {
  const keys = Object.keys(state.cache);
  if (keys.length < 2) return '';
  const rows = keys
    .sort((ka, kb) => {
      const [a] = ka.split('|');
      const [b] = kb.split('|');
      if (a === b) return ka.localeCompare(kb);
      return a === 'all' ? -1 : b === 'all' ? 1 : Number(b) - Number(a);
    })
    .map((k) => {
      const [monthsKey, activityMonths] = k.split('|');
      const body = state.cache[k];
      const cc = body.companiesComparison;
      const companiesB = cc.totalInAccountB;
      const dup = cc.clearDuplicates;
      const netNew = cc.netNewOrAmbiguous;
      const deals = body.accountB.objectCounts.deals;
      const isCurrent = monthsKey === state.current && activityMonths === state.activityMonths;
      const signalCells = SIGNAL_ORDER.map((key) => {
        const sig = cc.signals && cc.signals[key];
        if (!sig) return '<td>—</td>';
        const err = sig.error ? 'error' : null;
        return `<td>${fmtSignalValue(err || sig.duplicatesWithRealActivity)}/${dup} · ${fmtSignalValue(err || sig.netNewWithRealActivity)}/${netNew}</td>`;
      }).join('');
      return `<tr class="${isCurrent ? 'current' : ''}">
        <td>${TAB_LABELS[monthsKey]}</td>
        <td>${companiesB}</td>
        <td>${dup}</td>
        <td>${netNew}</td>
        <td>${typeof deals === 'object' ? '—' : deals}</td>
        ${signalCells}
        <td style="color:#9ca3af;">(${activityMonths}m)</td>
      </tr>`;
    }).join('');
  const signalHeaders = SIGNAL_ORDER.map((key) => `<th>${SIGNAL_LABELS[key]} (dup/net-new)</th>`).join('');
  return `<h2>Comparativa de ventanas ya cargadas</h2>
    <table>
      <thead><tr><th>Ventana</th><th>Companies (B)</th><th>Duplicados claros</th><th>Net-new/ambiguos</th><th>Deals (B)</th>${signalHeaders}<th>Ventana actividad</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function activityBadge(v) {
  if (v === 'error') return '<span style="color:#b91c1c; font-size:11.5px;">error</span>';
  if (v === true) return '<span class="badge new">Sí</span>';
  return '<span style="color:#9ca3af; font-size:11.5px;">—</span>';
}

function renderComparisonTable(title, rows, kind) {
  if (!rows.length) return `<h2>${title}</h2><p style="color:#9ca3af;font-size:13px;">Ninguna</p>`;
  const signalHeaders = kind === 'new' || kind === 'dup'
    ? SIGNAL_ORDER.map((key) => `<th>${SIGNAL_LABELS[key]}</th>`).join('')
    : '';
  const body = rows.map((r) => {
    const signalCells = SIGNAL_ORDER.map((key) => `<td>${activityBadge(r.recentActivity ? r.recentActivity[key] : undefined)}</td>`).join('');
    if (kind === 'dup') {
      return `<tr>
        <td>${escapeHtml(r.nameInB)}</td>
        <td>${escapeHtml(r.matchedNameInA)}</td>
        <td>${(r.score * 100).toFixed(0)}%</td>
        <td><span class="badge dup">Duplicado claro</span></td>
        ${signalCells}
      </tr>`;
    }
    return `<tr>
      <td>${escapeHtml(r.nameInB)}</td>
      <td>${r.ambiguous ? escapeHtml(r.possibleMatchInA || '') : '<span style="color:#9ca3af;">—</span>'}</td>
      <td>${r.ambiguous ? `${(r.score * 100).toFixed(0)}%` : ''}</td>
      <td>${r.ambiguous ? '<span class="badge ambig">Ambiguo — revisar</span>' : '<span class="badge new">Net-new</span>'}</td>
      ${signalCells}
    </tr>`;
  }).join('');
  return `<h2>${title} (${rows.length})</h2>
    <table>
      <thead><tr><th>Nombre en cuenta B</th><th>Posible match en cuenta A</th><th>Confianza</th><th>Estado</th>${signalHeaders}</tr></thead>
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

  for (const key of SIGNAL_ORDER) {
    const sig = companiesComparison.signals && companiesComparison.signals[key];
    if (!sig) continue;
    if (sig.error) {
      html += `<div class="error">No se pudo comprobar la señal "${SIGNAL_LABELS[key]}": ${escapeHtml(sig.error)}</div>`;
      continue;
    }
    const dupRate = companiesComparison.clearDuplicates > 0
      ? Math.round((sig.duplicatesWithRealActivity / companiesComparison.clearDuplicates) * 100)
      : null;
    const mechanismLooksBlind = companiesComparison.clearDuplicates > 0 && sig.duplicatesWithRealActivity === 0;
    html += `<div class="note">
      <strong>Señal "${SIGNAL_LABELS[key]}" vía contacto (control de fiabilidad):</strong> de los ${companiesComparison.clearDuplicates} duplicados claros
      (cuentas YA sabidas reales), <strong>${sig.duplicatesWithRealActivity}</strong>${dupRate !== null ? ` (${dupRate}%)` : ''}
      tienen algún contacto asociado con un ${SIGNAL_LABELS[key].toLowerCase()} real en los últimos ${sig.activityMonths} meses
      (Company → Contacto → ${SIGNAL_LABELS[key]}, ya que esta cuenta no asocia nada directamente a la Company).
      ${mechanismLooksBlind
        ? ` <strong style="color:#b91c1c;">0% incluso en cuentas activas conocidas — revisar antes de confiar en esta señal.</strong>`
        : ` Señal fiable — de las net-new/ambiguas, <strong>${sig.netNewWithRealActivity}</strong> muestran esta misma actividad real.`}
    </div>`;
  }

  html += renderComparisonTable('Duplicados claros', companiesComparison.duplicates, 'dup');
  html += renderComparisonTable('Net-new / ambiguos', companiesComparison.netNew, 'new');
  content.innerHTML = html;
}

async function load(monthsKey, activityMonths) {
  state.current = monthsKey;
  state.activityMonths = activityMonths;
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.months === monthsKey);
  });
  document.querySelectorAll('.activity-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.activityMonths === activityMonths);
  });

  const key = cacheKey(monthsKey, activityMonths);
  if (state.cache[key]) {
    renderBody(state.cache[key]);
    return;
  }

  const status = document.getElementById('status');
  const content = document.getElementById('content');
  document.querySelectorAll('.tab-btn, .activity-btn').forEach((btn) => { btn.disabled = true; });
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
    const res = await fetch(`/api/inventory?months=${encodeURIComponent(monthsKey)}&activityMonths=${encodeURIComponent(activityMonths)}`);
    const body = await res.json();
    clearInterval(pollId);
    document.querySelectorAll('.tab-btn, .activity-btn').forEach((btn) => { btn.disabled = false; });
    status.textContent = '';

    if (!res.ok || body.error) {
      content.innerHTML = `<div class="error">${escapeHtml(body.error || `Error ${res.status}`)}</div>`;
      return;
    }

    state.cache[key] = body;
    renderBody(body);
  } catch (e) {
    clearInterval(pollId);
    document.querySelectorAll('.tab-btn, .activity-btn').forEach((btn) => { btn.disabled = false; });
    status.textContent = '';
    content.innerHTML = `<div class="error">Error de conexión: ${escapeHtml(e.message)}</div>`;
  }
}

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => load(btn.dataset.months, state.activityMonths));
});
document.querySelectorAll('.activity-btn').forEach((btn) => {
  btn.addEventListener('click', () => load(state.current, btn.dataset.activityMonths));
});
