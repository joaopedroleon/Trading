const fmtDate = iso => {
  if (!iso) return '—';
  if (!/^\d{4}-/.test(iso)) return iso;  // vértice (ex: "3M", "2Y") → exibe direto
  return iso.slice(0, 10).split('-').reverse().join('/');
};

// ISO com hora (ex.: '2026-07-15T18:45:03') → 'DD/MM HH:MM'
const fmtDateTime = iso => {
  if (!iso) return '';
  const s = String(iso);
  const [y, m, d] = s.slice(0, 10).split('-');
  const hm = s.slice(11, 16);
  return `${d}/${m}${hm ? ' ' + hm : ''}`;
};

const fmtQty = v =>
  v == null ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

const fmtPrice = v =>
  v == null ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fmtPricePct = v =>
  v == null ? '—' : (v * 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%';

// Preço de OPÇÃO na Análise de Opções (mid + BID/ASK): 2 casas de piso, até 4 quando precisa.
// ⚠️ Não é firula: com 2 casas fixas um prêmio de EWZ com bid 0,19 e ask 0,22 mostrava mid
// "0,21" — e o mid É 0,205. A tabela afirma que TODA conta derivada sai do mid; um mid que
// não bate com o meio do próprio bid/ask exibido desmente a afirmação na cara do leitor.
// Preço "grande" (24,6 de opção de futuro) segue lendo 24,60, sem cauda de zeros.
const fmtOptPx = v =>
  v == null ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });

function fmtDv01(v) {
  if (v == null) return '—';
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  if (v < 0) return `<span style="color:var(--red)">(${s})</span>`;
  if (v === 0) return `<span style="color:var(--text-muted)">—</span>`;
  return s;
}

function fmtNav(v, navDate, openingDate) {
  if (v == null) return '';
  const base = `NAV: USD ${v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  if (navDate && openingDate && navDate !== openingDate)
    return `${base} <span style="color:var(--yellow);font-size:11px" title="NAV indisponível para ${fmtDate(openingDate)} — usando ${fmtDate(navDate)}">⚠ ${fmtDate(navDate)}</span>`;
  return base;
}

function fmtPL(v, type, noGreen = false) {
  if (v == null) return '<span style="color:var(--text-muted)">—</span>';
  const abs = Math.abs(v);
  let s;
  if (type === 'pct') {
    s = (abs * 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%';
  } else {
    s = abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  if (v > 0) return noGreen ? `<span>+${s}</span>` : `<span style="color:var(--green)">+${s}</span>`;
  if (v < 0) return `<span style="color:var(--red)">(${s})</span>`;
  return `<span style="color:var(--text-muted)">—</span>`;
}


function fmtTradedQty(v) {
  if (v == null || v === 0) return '<span style="color:var(--text-muted)">—</span>';
  const s = fmtQty(Math.abs(v));
  return v < 0 ? `<span style="color:var(--red)">(${s})</span>` : s;
}

function fmtFinalQty(v) {
  if (v == null) return '—';
  const s = fmtQty(Math.abs(v));
  if (v < 0) return `<span style="color:var(--red)">(${s})</span>`;
  if (v === 0) return `<span style="color:var(--text-muted)">—</span>`;
  return s;
}

/* Valor financeiro em USD (verde +, vermelho entre parênteses), 0 casas */
function fmtMoney(v) {
  if (v == null || !isFinite(v)) return '<span style="color:var(--text-muted)">—</span>';
  const s = Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (v > 0) return `<span style="color:var(--green)">+${s}</span>`;
  if (v < 0) return `<span style="color:var(--red)">(${s})</span>`;
  return '<span style="color:var(--text-muted)">—</span>';
}

/* Exposição: financeiro em USD + % do NAV entre parênteses, numa célula só */
function fmtExp(usd, pct) {
  if ((usd == null || !isFinite(usd)) && (pct == null || !isFinite(pct)))
    return '<span style="color:var(--text-muted)">—</span>';
  const money = fmtMoney(usd);
  if (pct == null || !isFinite(pct)) return money;
  const p = (pct * 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%';
  return `${money} <span style="color:var(--text-muted)">(${p})</span>`;
}

function bbgTooltip(bbgData) {
  if (!bbgData) return '';
  return Object.entries(bbgData)
    .map(([k, v]) => `${k}: ${v ?? '—'}`)
    .join('\n');
}

/* ── Sort ────────────────────────────────────────────────────────────────── */
function sortRows(rows) {
  return [...rows].sort((a, b) => {
    const cmp = (x, y, desc = false) => {
      const r = (x ?? '').toString().localeCompare((y ?? '').toString(), 'en-US', { sensitivity: 'base' });
      return desc ? -r : r;
    };
    // Linhas SIMULADAS (pos-simular.js) sempre no FIM, qualquer que seja a área: são
    // acréscimo do usuário, não podem se intercalar na leitura da posição real.
    const sim = (a.is_simulated ? 1 : 0) - (b.is_simulated ? 1 : 0);
    if (sim) return sim;
    return cmp(a.area,            b.area,            true)  // área: Z→A
        || cmp(a.subarea,         b.subarea)                 // sub-área: A→Z
        || cmp(a.strategy,        b.strategy)                // estratégia: A→Z
        || cmp(a.instrument_name, b.instrument_name);        // instrumento: A→Z
  });
}

/* ── Toggle detail cols ──────────────────────────────────────────────────── */
function toggleDetail() {
  detailVisible = !detailVisible;
  document.querySelectorAll('.col-detail').forEach(el => {
    el.style.display = detailVisible ? '' : 'none';
  });
  document.getElementById('toggleBtn').textContent = detailVisible
    ? '▲ Ocultar detalhes'
    : '▼ Área / Sub-área / Estratégia';
}

/* ── Section helpers ─────────────────────────────────────────────────────── */
function getSections(rows) {
  const map = new Map();
  for (const r of rows) {
    const key = `${r.group}||${r.trader}`;
    if (!map.has(key)) map.set(key, { group: r.group, trader: r.trader });
  }
  return [...map.values()].sort((a, b) => {
    const gi = x => { const i = GROUP_ORDER.indexOf(x.group); return i >= 0 ? i : 99; };
    return (gi(a) - gi(b)) || a.trader.localeCompare(b.trader);
  });
}

function sectionBodyId(s) {
  return `body_${s.group}_${s.trader}`.replace(/[^a-zA-Z0-9]/g, '_');
}

function thead() {
  const d = detailVisible ? '' : 'style="display:none"';
  return `<thead><tr>
    <th class="col-copy" title="Excluir linha"></th>
    <th class="col-detail" ${d}>Área</th>
    <th class="col-detail" ${d}>Sub-área</th>
    <th class="col-detail" ${d}>Estratégia</th>
    <th class="col-detail" ${d}>Preço D-1</th>
    <th class="col-final">Instrumento</th>
    <th>Vencto</th>
    <th class="col-pnl">Qtd Abertura</th>
    <th>Qtd Operada</th>
    <th class="col-right">Qtd Final</th>
    <th>Price Live</th>
    <th>USD DV01</th>
    <th class="col-final">#PL</th>
  </tr></thead>`;
}

/* ── SWAP manual override ────────────────────────────────────────────────── */
