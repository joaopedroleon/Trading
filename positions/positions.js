/* ── API base URL ─────────────────────────────────────────────────────────── */
const API_BASE = location.protocol === 'file:' ? 'http://localhost:8083' : '';

/* ── Trader tab config ───────────────────────────────────────────────────── */
const TRADER_TABS = [
  { id: 'emota',       trader: 'EMota',      filters: ['no_hedge_cambial','no_fx_small'], useGroups: true  },
  { id: 'ecotrim',     trader: 'ECotrim',    filters: ['no_hedge_cambial','no_fx_small'], useGroups: true  },
  { id: 'portfoliorf', trader: 'PortfolioRF',filters: ['no_cash'],                         useGroups: false },
  { id: 'other',       trader: 'PAlves',     filters: ['no_hedge_cambial'],               useGroups: false },
];

/* ── State ───────────────────────────────────────────────────────────────── */
let positionsData = null;       // active tab data (kept for pnl.js compat)
let detailVisible = false;
let activeTraderTab = 'emota';
const posDataByTab = {};   // tabId → positionsData
const hiddenRows   = {};              // tabId → Set<rowKey>
const swapOpeningOverrides = new Map(); // rowKey → number (override abertura SWAP)
const swapTradedOverrides  = new Map(); // rowKey → number (override trades SWAP)
const plOverrides          = new Map(); // rowKey → number (override manual #PL, fração — só posição)
const wdoUcAggregated      = new Set(); // tabIds com agregação WDO+UC ativa

// ── FONTE ÚNICA de marreta de preço/delta, por INSTRUMENTO (instKey), não por aba/trader.
//    Mesmo ticker → mesmo valor em todas as abas. Live vem do backend (price_live/option_delta).
const priceOverrides = new Map();  // instKey → preço manual (marreta)
const deltaOverrides = new Map();  // instKey → delta manual (marreta)
const _dirtyTabs     = new Set();  // abas carregadas que precisam re-render após uma marreta

/* ── Check Dólar Exposure (aba por fundo) ────────────────────────────────── */
const DOLAR_TAB_ID        = 'dolar';
let   dolarOptTickers     = {};         // optKey → ticker BBG (cache do backend; cadastro de DOL)

/* ── Hidden rows helpers ─────────────────────────────────────────────────── */
function rowKey(r) {
  return [r.group, r.trader, r.instrument_reference, r.area, r.subarea, r.strategy, r.maturity].join('||');
}

/* ── Fonte única de preço/delta efetivos (por instrumento) ───────────────── */
// Identidade do instrumento p/ marreta — independe de trader/aba (mesmo ticker → mesma marreta).
function instKey(r) {
  return (r.instrument_reference || r.instrument_name || '') + '||' + (r.maturity || '');
}
// CALL → +1, PUT → -1, senão null. Procura em QUALQUER parte do nome (não só no
// fim): há opções cadastradas com CALL/PUT no meio do nome.
function _optTypeSign(name) {
  const n = (name || '').toUpperCase();
  if (n.includes('CALL')) return 1;
  if (n.includes('PUT'))  return -1;
  return null;
}
// Preço efetivo: marreta manual → price_pnl (= BBG live → boleta → D-1, resolvido no backend).
function effectivePrice(r) {
  const k = instKey(r);
  if (priceOverrides.has(k)) return priceOverrides.get(k);
  return r.price_live != null ? r.price_live : r.price_pnl;
}
// Origem do preço p/ exibição/cor.
function priceSrc(r) {
  return priceOverrides.has(instKey(r)) ? 'manual' : (r.price_live_source || null);
}
// Delta efetivo de opção: marreta → option_delta (backend; live p/ DOL via ticker). Normaliza CALL/PUT.
function effectiveDelta(r) {
  const k = instKey(r);
  let d = deltaOverrides.has(k) ? deltaOverrides.get(k) : r.option_delta;
  if (d == null) return null;
  const sign = _optTypeSign(r.instrument_name);
  return sign != null ? sign * Math.abs(d) : d;
}
// Após marretar: re-renderiza a aba ativa e marca as demais carregadas p/ re-render ao abrir (sem refetch).
function _markTabsDirtyAndRerender() {
  for (const tab of TRADER_TABS) if (posDataByTab[tab.id] && tab.id !== activeTraderTab) _dirtyTabs.add(tab.id);
  if (dolarConsolData && Object.keys(dolarConsolData).length) _dirtyTabs.add(DOLAR_CONSOL_TAB_ID);
  if (posDataByTab[DOLAR_TAB_ID]) _dirtyTabs.add(DOLAR_TAB_ID);
  _dirtyTabs.delete(activeTraderTab);
  rerenderActive();
}
// Re-render da aba ativa conforme o tipo (sem refetch; preserva estado de colapso/ocultas).
function rerenderActive() {
  if (activeTraderTab === DOLAR_CONSOL_TAB_ID) { renderDolarConsol(dolarConsolTrader); }
  else if (activeTraderTab === DOLAR_TAB_ID)   { if (posDataByTab[DOLAR_TAB_ID]) renderDolarTable(posDataByTab[DOLAR_TAB_ID]); }
  else if (activeTraderTab === ROLAGEM_TAB_ID) { if (posDataByTab[ROLAGEM_TAB_ID]) renderRolagem(); }
  else { rerenderTables(); if (typeof rerenderPnlValues === 'function') rerenderPnlValues(); }
}

function _hiddenForTab(tabId) {
  if (!hiddenRows[tabId]) hiddenRows[tabId] = new Set();
  return hiddenRows[tabId];
}

function hideRow(key) {
  _hiddenForTab(activeTraderTab).add(key);
  rerenderTables(key);   // só re-renderiza o tbody da seção da linha ocultada
  renderRestoreBtn();
}

function restoreHidden() {
  delete hiddenRows[activeTraderTab];
  rerenderTables();
  renderRestoreBtn();
}

function renderRestoreBtn() {
  const btn = document.getElementById('restoreBtn');
  if (!btn) return;
  const count = _hiddenForTab(activeTraderTab).size;
  if (count > 0) {
    btn.textContent = `↩ Restaurar ocultas (${count})`;
    btn.style.display = '';
  } else {
    btn.style.display = 'none';
  }
}

/* ── Group order ─────────────────────────────────────────────────────────── */
const GROUP_ORDER = ['MM', 'MM Prev'];

/* ── Allocation targets ──────────────────────────────────────────────────── */
const ALLOC_TARGETS = { EMota: 0.80, ECotrim: 0.60, PAbinader: 0.30, LAguiar: 0.30 };
const ALLOC_TOL     = 0.02;

/* ── Filters ─────────────────────────────────────────────────────────────── */
const FILTERS = [
  {
    id:    'no_hedge_cambial',
    label: 'Excluir Hedge Cambial',
    fn:    r => r.subarea !== 'Hedge_Cambial',
  },
  {
    id:    'no_fx_small',
    label: 'Excluir FX < 200k',
    // exclui somente posições FX pequenas SEM atividade no dia
    fn:    r => !(r.is_fx && Math.abs(r.final_qty ?? 0) < 200_000 && (r.gross_traded_qty ?? 0) < 200_000),
  },
  {
    id:    'no_cash',
    label: 'Excluir Cash',
    fn:    r => r.subarea !== 'Cash',
  },
];
const activeFilters = new Set(FILTERS.map(f => f.id)); // todos ativos por default

function applyFilters(rows) {
  const active = FILTERS.filter(f => activeFilters.has(f.id));
  return rows.filter(r => active.every(f => f.fn(r)));
}

function toggleFilter(id) {
  activeFilters.has(id) ? activeFilters.delete(id) : activeFilters.add(id);
  const on = activeFilters.has(id);
  // Atualiza só os chips desse filtro (classe + marca) — não reconstrói a barra,
  // então os chips WDO+UC e blacklist sobrevivem (resolve os gotchas #1/#2).
  document.querySelectorAll(`.filter-chip[data-fid="${id}"]`).forEach(chip => {
    chip.classList.toggle('on', on);
    chip.classList.toggle('off', !on);
    const mark = chip.querySelector('.chip-mark');
    if (mark) mark.textContent = on ? '✕' : '+';
  });
  if (posDataByTab[activeTraderTab]) rerenderTables();
}

function renderFilterBars() {
  for (const tab of TRADER_TABS) {
    const el = document.getElementById(`filterBar-${tab.id}`);
    if (!el) continue;
    el.innerHTML = FILTERS
      .filter(f => tab.filters.includes(f.id))
      .map(f => {
        const on = activeFilters.has(f.id);
        return `<span class="filter-chip ${on ? 'on' : 'off'}" data-fid="${f.id}" onclick="toggleFilter('${f.id}')">
          <span class="chip-mark">${on ? '✕' : '+'}</span> ${f.label}
        </span>`;
      }).join('');
    renderWdoUcToggle(tab.id);  // restaura chip WDO+UC após sobrescrever innerHTML
  }
}

/* ── Blacklist ───────────────────────────────────────────────────────────── */
function renderBlacklist(list) {
  const chip = list && list.length
    ? `<span class="filter-chip on" style="cursor:default" title="${list.join('\n')}">🚫 ${list.length} ocultos</span>`
    : '';
  for (const tab of TRADER_TABS) {
    const el = document.getElementById(`filterBar-${tab.id}`);
    if (!el) continue;
    const existing = el.querySelector('.blacklist-chip');
    if (existing) existing.remove();
    if (chip) el.insertAdjacentHTML('beforeend', `<span class="blacklist-chip">${chip}</span>`);
  }
}

/* ── WDO + UC aggregation ────────────────────────────────────────────────── */
const _isWdoBmf = r => { const ref = (r.instrument_reference || '').toUpperCase(); return ref.endsWith('CURNCY') && ref.startsWith('WDO'); };
const _isUcBmf  = r => { const ref = (r.instrument_reference || '').toUpperCase(); return ref.endsWith('CURNCY') && ref.startsWith('UC'); };

function applyWdoUcAggregation(rows) {
  // Coleta todos os UCs (pode ter mais de um contrato)
  const ucRows = rows.filter(r => _isUcBmf(r));
  if (!ucRows.length) return rows;
  if (!rows.some(r => _isWdoBmf(r))) return rows;

  const ucSet = new Set(ucRows); // para remoção por identidade

  return rows.map(r => {
    if (ucSet.has(r)) return null; // remove todo UC

    if (!_isWdoBmf(r)) return r;  // outras linhas inalteradas

    // Para cada WDO (pode existir em MM e em MM Prev), soma contribuição de
    // todos os UCs do mesmo trader
    const matching = ucRows.filter(uc => uc.trader === r.trader && uc.group === r.group);
    if (!matching.length) return r;

    const wdo = { ...r };
    for (const uc of matching) {
      const mult = (r.calc_factor && uc.calc_factor)
        ? Math.round(uc.calc_factor / r.calc_factor) : 5;
      wdo.opening_qty      = (wdo.opening_qty      || 0) + (uc.opening_qty      || 0) * mult;
      wdo.buy_qty          = (wdo.buy_qty          || 0) + (uc.buy_qty          || 0) * mult;
      wdo.sell_qty         = (wdo.sell_qty         || 0) + (uc.sell_qty         || 0) * mult;
      wdo.traded_qty       = (wdo.traded_qty       || 0) + (uc.traded_qty       || 0) * mult;
      wdo.gross_traded_qty = (wdo.gross_traded_qty || 0) + (uc.gross_traded_qty || 0) * mult;
      wdo.final_qty        = (wdo.final_qty        || 0) + (uc.final_qty        || 0) * mult;
      // Exposição/PnL em USD são ADITIVOS e SEM mult: uc.pl já é a exposição cheia do
      // UC (FUT_VAL_PT=50 do próprio UC). Sem isto, o #PL ficava o do WDO bruto.
      for (const f of ['pl', 'usd_dv01', 'estoque_usd', 'compra_usd', 'venda_usd', 'total_usd', 'result_bps']) {
        if (uc[f] != null) wdo[f] = (wdo[f] || 0) + uc[f];
      }
    }
    wdo._wdoUcSynthetic = true;
    return wdo;
  }).filter(r => r !== null);
}

function toggleWdoUcAggregation(tabId) {
  wdoUcAggregated.has(tabId) ? wdoUcAggregated.delete(tabId) : wdoUcAggregated.add(tabId);
  const data = posDataByTab[tabId];
  if (data) renderSectionsForTab(tabId, data.rows);
  renderWdoUcToggle(tabId);
}

function renderWdoUcToggle(tabId) {
  const el = document.getElementById(`filterBar-${tabId}`);
  if (!el) return;
  const existing = el.querySelector(`#wdoUcChip-${tabId}`);
  if (existing) existing.remove();

  const rows = posDataByTab[tabId]?.rows ?? [];
  if (!rows.some(_isWdoBmf) || !rows.some(_isUcBmf)) return;

  const on = wdoUcAggregated.has(tabId);
  const chip = document.createElement('span');
  chip.id        = `wdoUcChip-${tabId}`;
  chip.className = `filter-chip ${on ? 'on' : 'off'}`;
  chip.style.cssText = on ? 'color:#f0c040;border-color:#f0c040;background:rgba(240,192,64,0.12)' : '';
  chip.title     = on ? 'Posição agregada — não é a posição real. Clique para reverter.' : 'Concentrar WDO e UC em uma única linha WDO equivalente (1 UC = 5 WDO)';
  chip.textContent = on ? '⚡ WDO+UC Agregado ✕' : '⚡ Agregar WDO+UC';
  chip.onclick   = () => toggleWdoUcAggregation(tabId);
  el.appendChild(chip);
}

/* ── Formatters ──────────────────────────────────────────────────────────── */
const fmtDate = iso => {
  if (!iso) return '—';
  if (!/^\d{4}-/.test(iso)) return iso;  // vértice (ex: "3M", "2Y") → exibe direto
  return iso.slice(0, 10).split('-').reverse().join('/');
};

const fmtQty = v =>
  v == null ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

const fmtPrice = v =>
  v == null ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fmtPricePct = v =>
  v == null ? '—' : (v * 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%';

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
    return `${base} <span style="color:#f0c040;font-size:11px" title="NAV indisponível para ${fmtDate(openingDate)} — usando ${fmtDate(navDate)}">⚠ ${fmtDate(navDate)}</span>`;
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
    <th class="col-copy" title="Copiar referência"></th>
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
function swapStartEdit(td, field, key, currentVal) {
  const map = field === 'opening' ? swapOpeningOverrides : swapTradedOverrides;
  const input = document.createElement('input');
  input.type = 'text';
  input.style.cssText = 'width:90px;font:inherit;text-align:right;background:var(--bg);border:1px solid var(--accent);color:var(--text)';
  input.value = currentVal != null
    ? currentVal.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
    : '';
  td.innerHTML = '';
  td.appendChild(input);
  input.focus();
  input.select();
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  input.blur();
    if (e.key === 'Escape') { map.delete(key); rerenderTables(); }
  });
  input.addEventListener('blur', () => swapApplyEdit(input, field, key));
  input.addEventListener('click', e => e.stopPropagation());
}

function swapApplyEdit(input, field, key) {
  const map = field === 'opening' ? swapOpeningOverrides : swapTradedOverrides;
  const val = parseFloat(String(input.value).replace(/\./g, '').replace(',', '.'));
  if (!isNaN(val)) map.set(key, val);
  else map.delete(key);
  rerenderTables();
}

/* ── #PL manual override ─────────────────────────────────────────────────── */
function posPlStartEdit(td) {
  if (td.querySelector('input')) return;
  const key = td.dataset.rowkey;
  const cur = plOverrides.has(key) ? (plOverrides.get(key) * 100) : '';
  const input = document.createElement('input');
  input.type = 'text';
  input.style.cssText = 'width:5em;font:inherit;text-align:right;background:var(--bg);border:1px solid var(--accent);color:var(--text)';
  input.value = cur !== '' ? String(cur).replace('.', ',') : '';
  td.innerHTML = '';
  td.appendChild(input);
  input.focus();
  input.select();
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  input.blur();
    if (e.key === 'Escape') { plOverrides.delete(key); rerenderTables(); }
  });
  input.addEventListener('blur',  () => posPlApplyEdit(input, key));
  input.addEventListener('click', e => e.stopPropagation());
}

function posPlApplyEdit(input, key) {
  const val = parseFloat(String(input.value).replace(/\./g, '').replace(',', '.'));
  if (!isNaN(val)) plOverrides.set(key, val / 100);
  else plOverrides.delete(key);
  rerenderTables();
}

function posPriceStartEdit(td) {
  if (td.querySelector('input')) return;
  const ik    = td.dataset.instkey;            // preço é por INSTRUMENTO (compartilhado entre abas)
  const key   = td.dataset.rowkey;             // #PL é por posição (trader)
  const isFx  = td.dataset.isfx === '1';
  const cur   = priceOverrides.has(ik) ? priceOverrides.get(ik) : null;
  const input = document.createElement('input');
  input.type  = 'text';
  input.style.cssText = 'width:6em;font:inherit;text-align:right;background:var(--bg);border:1px solid var(--accent);color:var(--text)';
  input.value = cur !== null ? String(isFx ? cur * 100 : cur).replace('.', ',') : '';
  td.innerHTML = '';
  td.appendChild(input);
  input.focus();
  input.select();
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  input.blur();
    if (e.key === 'Escape') {
      priceOverrides.delete(ik);
      plOverrides.delete(key);
      _markTabsDirtyAndRerender();
    }
  });
  input.addEventListener('blur',  () => posPriceApplyEdit(input, td));
  input.addEventListener('click', e => e.stopPropagation());
}

function posPriceApplyEdit(input, td) {
  const ik   = td.dataset.instkey;
  const key  = td.dataset.rowkey;
  const isFx = td.dataset.isfx === '1';
  const raw  = parseFloat(String(input.value).replace(/\./g, '').replace(',', '.'));
  if (isNaN(raw)) {
    priceOverrides.delete(ik);
    plOverrides.delete(key);
  } else {
    const price = isFx ? raw / 100 : raw;
    priceOverrides.set(ik, price);
    // Recalcula pl para instrumentos cuja exposição deriva do preço (pl_type='pct', não opção)
    const cf  = parseFloat(td.dataset.cf);
    const nav = parseFloat(td.dataset.nav);
    const fq  = parseFloat(td.dataset.fq);
    const plt = td.dataset.plt;
    const isOpt = td.dataset.isopt === '1';
    if (plt === 'pct' && !isOpt && !isNaN(cf) && !isNaN(nav) && nav !== 0 && !isNaN(fq))
      plOverrides.set(key, fq * cf * price / nav);
    else
      plOverrides.delete(key);
  }
  _markTabsDirtyAndRerender();
}

/* ── Allocation check helpers ────────────────────────────────────────────── */
function allocCheckId(trader) {
  return `alloc_${trader}`.replace(/[^a-zA-Z0-9]/g, '_');
}

function allocClass(delta) {
  if (delta == null) return '';
  const abs = Math.abs(delta);
  if (abs <= ALLOC_TOL)     return 'alloc-ok';
  if (abs <= 2 * ALLOC_TOL) return 'alloc-warn';
  return 'alloc-bad';
}

function fmtPct(v) {
  return v == null ? '—' : (v * 100).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%';
}

function renderAllocTable(allRows, trader, filterFn = applyFilters) {
  const target   = ALLOC_TARGETS[trader] ?? null;
  const mmRows   = filterFn(sortRows(allRows.filter(r => r.group === 'MM' && r.trader === trader)));
  const visRows  = mmRows.filter(r => !_hiddenForTab(activeTraderTab).has(rowKey(r)));
  const prevRows = allRows.filter(r => r.group === 'MM Prev' && r.trader === trader);

  // Non-SWAPs: chave exata. SWAPs consolidados: agrupa por base+área+estratégia e
  // usa a mesma janela de 30 dias do _consolidate_swaps para correlacionar clusters —
  // o cluster MM Prev pode ter menos legs, deslocando a data representativa, mas
  // enquanto a diferença for ≤30 dias é considerado o mesmo grupo.
  const prevMap    = {};
  const swapGroups = {};
  for (const r of prevRows) {
    if (r.swap_detail != null) {
      const gk = `${r.instrument_reference}||${r.area}||${r.subarea}||${r.strategy}`;
      (swapGroups[gk] ??= []).push({ date: r.maturity ? new Date(r.maturity) : null, row: r });
    } else {
      prevMap[`${r.instrument_reference}||${r.area}||${r.subarea}||${r.strategy}||${r.maturity ?? ''}`] = r;
    }
  }

  function lookupPrev(mm) {
    if (mm.swap_detail != null) {
      const gk         = `${mm.instrument_reference}||${mm.area}||${mm.subarea}||${mm.strategy}`;
      const candidates = swapGroups[gk];
      if (!candidates?.length) return null;
      if (candidates.length === 1) return candidates[0].row;
      const mmDate = mm.maturity ? new Date(mm.maturity) : null;
      if (!mmDate) return candidates[0].row;
      return candidates.find(c =>
        (c.row.maturity && c.row.maturity === mm.maturity) ||
        (c.date && mmDate && Math.abs(c.date - mmDate) / 86400000 <= 30)
      )?.row ?? candidates[0]?.row ?? null;
    }
    return prevMap[`${mm.instrument_reference}||${mm.area}||${mm.subarea}||${mm.strategy}||${mm.maturity ?? ''}`] ?? null;
  }

  // Posições que SÓ o MM Prev tem (sem correlato no MM): hoje somem desta tabela
  // (que itera o MM). Casamos contra TODAS as linhas MM — não só as visíveis — pra
  // não tratar uma linha MM oculta/filtrada como "sem MM"; depois aplicamos os chips
  // de filtro às órfãs. Renderizadas abaixo, alinhadas com a coluna do Prev.
  const matchedPrev = new Set();
  for (const mm of allRows.filter(r => r.group === 'MM' && r.trader === trader)) {
    const p = lookupPrev(mm);
    if (p) matchedPrev.add(p);
  }
  const orphanRows = sortRows(filterFn(prevRows.filter(p => !matchedPrev.has(p))));

  if (!visRows.length && !orphanRows.length) return '';

  let prevArea    = null;
  let prevSubarea = null;
  let subareaIdx  = -1;

  const rows = visRows.map((mm, i) => {
    const newArea    = mm.area    !== prevArea;
    const newSubarea = mm.subarea !== prevSubarea;
    if (newSubarea) subareaIdx++;
    const rowClass  = subareaIdx % 2 === 0 ? 'group-odd' : 'group-even';
    const areaClass = newArea && i > 0 ? 'area-divider' : '';
    const tradedClass = (mm.gross_traded_qty ?? 0) > 0 ? 'traded' : '';
    prevArea    = mm.area;
    prevSubarea = mm.subarea;

    const prev = lookupPrev(mm);

    // Abert. MM Prev
    const prevQty = prev?.opening_qty ?? null;
    const prevQtyCell = `<td class="num">${prevQty != null ? fmtFinalQty(prevQty) : '<span style="color:var(--text-muted)">—</span>'}</td>`;

    // Qtd Operada MM Prev
    const prevTraded = prev?.traded_qty ?? null;
    const tradedCell = `<td class="num">${prevTraded != null ? fmtTradedQty(prevTraded) : '<span style="color:var(--text-muted)">—</span>'}</td>`;

    // Check Boleta
    let dealCell = '<td class="num" style="color:var(--text-muted)">—</td>';
    if ((mm.gross_traded_qty ?? 0) > 0) {
      if ((mm.traded_qty ?? 0) === 0) {
        // daytrade: verificar compra e venda separadamente
        const bq = mm.buy_qty  ?? 0;
        const sq = mm.sell_qty ?? 0;
        const buyPct  = bq > 0 ? (prev?.buy_qty  ?? 0) / bq : null;
        const sellPct = sq > 0 ? (prev?.sell_qty ?? 0) / sq : null;
        if (buyPct === null && sellPct === null) {
          dealCell = '<td class="num" style="color:var(--text-muted)">0 líq.</td>';
        } else {
          const buyDelta  = target != null && buyPct  != null ? buyPct  - target : null;
          const sellDelta = target != null && sellPct != null ? sellPct - target : null;
          const bStr = buyPct  != null ? `<span class="${allocClass(buyDelta)}" title="Compra">C:${fmtPct(buyPct)}</span>`  : '';
          const sStr = sellPct != null ? `<span class="${allocClass(sellDelta)}" title="Venda">V:${fmtPct(sellPct)}</span>` : '';
          dealCell = `<td class="num">${[bStr, sStr].filter(Boolean).join(' / ')}</td>`;
        }
      } else {
        const dealPct   = (prev?.traded_qty ?? 0) / mm.traded_qty;
        const dealDelta = target != null ? dealPct - target : null;
        dealCell = `<td class="num ${allocClass(dealDelta)}">${fmtPct(dealPct)}</td>`;
      }
    }

    // % Alloc Final
    const mmFinal   = mm.final_qty ?? 0;
    const prevFinal = prev?.final_qty ?? null;
    const finalPct  = mmFinal !== 0 && prevFinal != null ? prevFinal / mmFinal : null;
    const finalCls  = allocClass(finalPct != null && target != null ? finalPct - target : null);
    const finalCell = `<td class="num ${finalCls}">${fmtPct(finalPct)}</td>`;

    // Total MM + MM Prev
    const total     = (mmFinal) + (prevFinal ?? 0);
    const totalCell = `<td class="num">${fmtFinalQty(total)}</td>`;

    return `<tr class="${rowClass} ${areaClass} ${tradedClass}">
      <td>${mm.instrument_name ?? '—'}</td>
      ${prevQtyCell}
      ${tradedCell}
      ${totalCell}
      ${dealCell}
      ${finalCell}
    </tr>`;
  }).join('');

  // Linhas só-Prev (sem MM): Total MM+Prev = só o Prev; Check/Alloc não se aplicam (—).
  const muted = '<span style="color:var(--text-muted)">—</span>';
  const orphanTr = orphanRows.map((p, i) => {
    const stripe = i % 2 === 0 ? 'group-odd' : 'group-even';
    return `<tr class="${stripe}">
      <td>${p.instrument_name ?? '—'}</td>
      <td class="num">${p.opening_qty != null ? fmtFinalQty(p.opening_qty) : muted}</td>
      <td class="num">${p.traded_qty  != null ? fmtTradedQty(p.traded_qty)  : muted}</td>
      <td class="num">${fmtFinalQty(p.final_qty ?? 0)}</td>
      <td class="num" style="color:var(--text-muted)">—</td>
      <td class="num" style="color:var(--text-muted)">—</td>
    </tr>`;
  }).join('');
  const orphanSection = orphanRows.length
    ? `<tr class="area-divider"><td colspan="6" style="font-weight:600;color:var(--text-muted)">Somente MM Prev</td></tr>${orphanTr}`
    : '';

  return `<table class="data-table alloc-table" style="white-space:nowrap;width:auto">
    <thead><tr>
      <th>Instrumento</th>
      <th>Abert. MM Prev</th>
      <th>Qtd Operada</th>
      <th>Total MM+Prev</th>
      <th>Check Boleta</th>
      <th>% Alloc Final</th>
    </tr></thead>
    <tbody>${rows}${orphanSection}</tbody>
  </table>`;
}

/* ── Fund breakdown table (portfoliorf) ─────────────────────────────────── */
function renderFundBreakTable(mainRows, fundRows, fundNavs, filterFn) {
  if (!fundRows?.length || !fundNavs) return '';

  const fundLabels = Object.keys(fundNavs).sort();
  const shortLabel = fl => fl.replace('JGP RF Ativa ', '').replace('-A', '');

  // Index fund rows by key -> {fund_label -> row}
  const fundIndex = {};
  for (const fr of fundRows) {
    const k = `${fr.instrument_reference}||${fr.area}||${fr.subarea}||${fr.strategy}||${fr.maturity ?? ''}`;
    (fundIndex[k] ??= {})[fr.fund_label] = fr;
  }

  const visRows = filterFn(mainRows.filter(r => !_hiddenForTab(activeTraderTab).has(rowKey(r))));

  let prevArea    = null;
  let prevSubarea = null;
  let subareaIdx  = -1;

  const rows = visRows.map((r, i) => {
    const newArea    = r.area    !== prevArea;
    const newSubarea = r.subarea !== prevSubarea;
    if (newSubarea) subareaIdx++;
    const rowClass  = subareaIdx % 2 === 0 ? 'group-odd' : 'group-even';
    const areaClass = newArea && i > 0 ? 'area-divider' : '';
    prevArea    = r.area;
    prevSubarea = r.subarea;

    const k           = `${r.instrument_reference}||${r.area}||${r.subarea}||${r.strategy}||${r.maturity ?? ''}`;
    const byFund      = fundIndex[k] ?? {};
    const totalQty    = r.final_qty || 0;
    const totalNavSum = fundLabels.reduce((s, fl) => s + (fundNavs[fl] ?? 0), 0);
    const groupPl     = r.pl;
    const ratioByFund = {};
    const fundPlArr   = [];

    const cells = fundLabels.map(fl => {
      const fr       = byFund[fl];
      const fund_qty = fr?.final_qty ?? 0;
      const navF     = fundNavs[fl];
      const pct      = totalQty !== 0 ? fund_qty / totalQty : null;
      ratioByFund[fl] = navF && totalNavSum ? (navF / totalNavSum) : null;

      let fundPl = null;
      if (!r.is_offshore && groupPl != null && totalQty !== 0 && navF && totalNavSum) {
        fundPl = groupPl * (fund_qty / totalQty) * (totalNavSum / navF);
      }
      fundPlArr.push(fundPl);

      const qtyCell = `<td class="num">${fund_qty !== 0 ? fmtFinalQty(fund_qty) : '<span style="color:var(--text-muted)">—</span>'}</td>`;
      const pctCell = `<td class="num">${pct != null ? fmtPct(pct) : '<span style="color:var(--text-muted)">—</span>'}</td>`;
      const plCell  = `<td class="num">${fundPl != null ? fmtPL(fundPl, r.pl_type) : '<span style="color:var(--text-muted)">—</span>'}</td>`;
      return qtyCell + pctCell + plCell;
    }).join('');

    // Check Qtd: % qty de cada fundo vs % NAV esperada
    let checkCell = '<td></td>';
    if (r.is_offshore) {
      checkCell = '<td style="color:var(--text-muted);text-align:center;font-size:11px">offshore</td>';
    } else {
      const checks = fundLabels.map(fl => {
        const fr       = byFund[fl];
        const fund_qty = fr?.final_qty ?? 0;
        const pctQty   = totalQty !== 0 ? fund_qty / totalQty : null;
        const pctNav   = ratioByFund[fl];
        return pctQty != null && pctNav != null ? Math.abs(pctQty - pctNav) : null;
      });
      const valid  = checks.filter(c => c != null);
      const maxDev = valid.length === fundLabels.length ? Math.max(...valid) : null;
      const cls    = allocClass(maxDev);
      const label  = maxDev == null ? '—' : maxDev < 0.01 ? '✓' : `±${(maxDev * 100).toLocaleString('en-US', {maximumFractionDigits:1})}pp`;
      checkCell = `<td class="${cls}" style="text-align:center">${label}</td>`;
    }

    // Check #PL: #PL individual de cada fundo vs #PL do grupo
    let checkPlCell = '<td></td>';
    if (r.is_offshore) {
      checkPlCell = '<td style="color:var(--text-muted);text-align:center;font-size:11px">offshore</td>';
    } else if (groupPl != null && fundPlArr.every(p => p != null)) {
      const devs   = fundPlArr.map(fp => Math.abs(fp - groupPl));
      const maxDev = Math.max(...devs);
      let plCheckContent;
      if (maxDev < 0.01) {
        plCheckContent = '<span style="color:var(--green)">✓</span>';
      } else {
        const cls = allocClass(maxDev);
        const lbl = `±${(maxDev * 100).toLocaleString('en-US', {maximumFractionDigits:2})}pp`;
        plCheckContent = `<span class="${cls}">${lbl}</span>`;
      }
      checkPlCell = `<td style="text-align:center">${plCheckContent}</td>`;
    } else {
      checkPlCell = '<td style="color:var(--text-muted);text-align:center">—</td>';
    }

    return `<tr class="${rowClass} ${areaClass}">
      <td>${r.instrument_name ?? '—'}</td>
      ${cells}
      ${checkCell}
      ${checkPlCell}
    </tr>`;
  }).join('');

  const headers = fundLabels.map(fl => {
    const navF   = fundNavs[fl];
    const navStr = navF != null
      ? `<br><small style="font-weight:normal;font-size:10px">${fmtNav(navF)}</small>`
      : '';
    return `<th colspan="3">${shortLabel(fl)}${navStr}</th>`;
  }).join('');
  const subHeaders = fundLabels.map(() => '<th>Qty</th><th>% Qtd</th><th>#PL</th>').join('');

  return `<table class="data-table alloc-table" style="white-space:nowrap;width:auto">
    <thead>
      <tr><th rowspan="2">Instrumento</th>${headers}<th rowspan="2">Check Qtd</th><th rowspan="2">Check #PL</th></tr>
      <tr>${subHeaders}</tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

/* ── Aux table alignment (must run while tab is visible) ─────────────────── */
function _alignAuxTables(tabId) {
  const data = posDataByTab[tabId];
  if (!data?.rows) return;
  const allRows      = data.rows;
  const hasFundBreak = tabId === 'portfoliorf' && !!(data.fund_rows?.length);
  // Separa LEITURAS de layout das ESCRITAS para evitar layout thrashing (reflow por iteração).
  const writes = [];
  for (const s of getSections(allRows)) {
    if (s.group === 'MM' && allRows.some(r => r.group === 'MM Prev' && r.trader === s.trader)) {
      const safeT      = s.trader.replace(/[^a-zA-Z0-9]/g, '_');
      const spacerEl   = document.getElementById(`alloc_spacer_${safeT}`);
      const outerEl    = document.getElementById(`alloc_outer_${safeT}`);
      const posFirst   = document.getElementById(sectionBodyId(s))?.rows[0];
      const allocThead = document.querySelector(`#${allocCheckId(s.trader)} thead`);
      if (spacerEl && outerEl && posFirst && allocThead) {
        const h = Math.max(0, posFirst.getBoundingClientRect().top
                              - outerEl.getBoundingClientRect().top - allocThead.offsetHeight);
        writes.push([spacerEl, h]);
      }
    }
    if (hasFundBreak && s.group === 'Todos') {
      const spacerEl = document.getElementById('fund_break_spacer_portfoliorf');
      const outerEl  = document.getElementById('fund_break_outer_portfoliorf');
      const posFirst = document.getElementById(sectionBodyId(s))?.rows[0];
      const fThead   = document.querySelector('#fund_break_portfoliorf thead');
      if (spacerEl && outerEl && posFirst && fThead) {
        const h = Math.max(0, posFirst.getBoundingClientRect().top
                              - outerEl.getBoundingClientRect().top - fThead.offsetHeight);
        writes.push([spacerEl, h]);
      }
    }
  }
  for (const [el, h] of writes) el.style.height = h + 'px';
}

/* ── Tab switching ───────────────────────────────────────────────────────── */
function showTraderTab(tabId) {
  activeTraderTab = tabId;
  for (const tab of TRADER_TABS) {
    const el  = document.getElementById(`tab-${tab.id}`);
    const btn = document.getElementById(`tab-btn-${tab.id}`);
    if (el)  el.style.display  = tab.id === tabId ? '' : 'none';
    if (btn) btn.classList.toggle('active', tab.id === tabId);
  }
  // esconde as abas que não fazem parte de TRADER_TABS (dólar e consolidado dólar)
  const dolarEl = document.getElementById('tab-dolar');
  if (dolarEl) dolarEl.style.display = 'none';
  document.getElementById('tab-btn-dolar')?.classList.remove('active');
  const consolEl = document.getElementById('tab-dolarconsol');
  if (consolEl) consolEl.style.display = 'none';
  document.getElementById('tab-btn-dolarconsol')?.classList.remove('active');
  _hideRolagemTab();
  if (!posDataByTab[tabId]) {
    loadPositionsForTab(tabId);
  } else {
    // aba já carregada — re-alinha e aplica marretas pendentes (dirty) a partir do cache, sem refetch
    requestAnimationFrame(() => _alignAuxTables(tabId));
    const wasDirty = _dirtyTabs.delete(tabId);
    if (wasDirty) { renderSectionsForTab(tabId, posDataByTab[tabId].rows); renderWdoUcToggle(tabId); }
    if (typeof loadPnlForTab === 'function') {
      loadPnlForTab(tabId);
      if (wasDirty && typeof rerenderPnlValues === 'function') rerenderPnlValues();
    }
  }
  renderRestoreBtn();
  if (typeof _syncPnlRestoreBtn === 'function') _syncPnlRestoreBtn();
}

function reloadActiveTab() {
  // "Atualizar" sempre busca preços/deltas ao vivo → limpa as marretas (fonte única, global).
  priceOverrides.clear();
  deltaOverrides.clear();
  if (activeTraderTab === DOLAR_TAB_ID) {
    delete posDataByTab[DOLAR_TAB_ID];
    loadDolarExposure();
    return;
  }
  if (activeTraderTab === DOLAR_CONSOL_TAB_ID) {
    delete dolarConsolData[dolarConsolTrader];
    loadDolarConsol(dolarConsolTrader, { fresh: true });
    return;
  }
  if (activeTraderTab === ROLAGEM_TAB_ID) {
    delete posDataByTab[ROLAGEM_TAB_ID];
    loadRolagem();
    return;
  }
  // limpa o cache de TODAS as abas de trader: evita servir dados de uma data
  // anterior ao trocar de aba após mudar a "Data ref" + Atualizar.
  for (const tab of TRADER_TABS) {
    delete posDataByTab[tab.id];
    delete hiddenRows[tab.id];
    if (typeof resetPnlForTab === 'function') resetPnlForTab(tab.id);
  }
  // também invalida as abas de dólar (Análise de Opções e Check Dólar Exposure):
  // senão, ao abri-las após Atualizar, serviriam dados em cache de uma data anterior.
  for (const t of Object.keys(dolarConsolData)) delete dolarConsolData[t];
  delete posDataByTab[DOLAR_TAB_ID];
  delete posDataByTab[ROLAGEM_TAB_ID];
  swapOpeningOverrides.clear();
  swapTradedOverrides.clear();
  plOverrides.clear();
  loadPositionsForTab(activeTraderTab, { fresh: true });   // botão "Atualizar" → preços ao vivo
}

function changeOtherTrader(trader) {
  TRADER_TABS[3].trader = trader;
  const label = document.getElementById('otherTraderLabel');
  if (label) label.textContent = trader;
  delete posDataByTab['other'];
  if (activeTraderTab === 'other') loadPositionsForTab('other');
}

/* ── Load positions for a tab ────────────────────────────────────────────── */
// opts.background: carga silenciosa (prefetch) — não mexe na UI global (status/botão).
// opts.fresh: ignora o cache de preços Bloomberg no backend (botão "Atualizar").
async function loadPositionsForTab(tabId, opts = {}) {
  const { background = false, fresh = false } = opts;
  const tab      = TRADER_TABS.find(t => t.id === tabId);
  const refDate  = document.getElementById('refDate').value;
  const status   = document.getElementById('refStatus');
  const srcLabel = document.getElementById('srcLabel');
  const btn      = document.getElementById('btnLoad');
  const container = document.getElementById(`posContainer-${tabId}`);

  if (!background) {
    status.textContent = 'Buscando dados...';
    status.style.color = 'var(--text-muted)';
    btn.disabled = true;
    container.innerHTML = '<div class="card"><span class="loading">Carregando...</span></div>';
    const pnlCont = document.getElementById(`pnlContainer-${tabId}`);
    if (pnlCont) pnlCont.innerHTML = '<div class="card"><span class="loading">Carregando...</span></div>';
  }

  try {
    const params = new URLSearchParams({ trader: tab.trader });
    if (refDate) params.set('ref_date', refDate);
    const forceOpening = document.getElementById('forceOpening').value;
    if (forceOpening) params.set('force_opening', forceOpening);
    if (!tab.useGroups) params.set('use_groups', 'false');
    if (fresh) params.set('fresh', 'true');
    const data = await (await fetch(`${API_BASE}/api/positions/reference?${params}`)).json();

    if (data.error) {
      if (!background) {
        status.textContent = 'Erro: ' + data.error;
        status.style.color = 'var(--red)';
        container.innerHTML = `<div class="card no-data">${data.error}</div>`;
      }
      return;
    }

    posDataByTab[tabId] = data;
    if (tabId === activeTraderTab) {
      positionsData = data;
      status.textContent = '';
      srcLabel.textContent =
        `Abertura: ${fmtDate(data.opening_date)}  |  Boletas: ${fmtDate(data.ref_date)}`;
    }

    delete hiddenRows[tabId];
    if (tabId === activeTraderTab) renderRestoreBtn();
    renderBlacklist(data.blacklist);
    renderSectionsForTab(tabId, data.rows);
    renderWdoUcToggle(tabId);

    if (typeof resetPnlForTab === 'function') resetPnlForTab(tabId);  // dados novos → re-render do PnL
    if (typeof loadPnlForTab === 'function') loadPnlForTab(tabId);

    // após a aba ativa carregar, prefetch silencioso das demais (troca de aba instantânea)
    if (!background && tabId === activeTraderTab) setTimeout(prefetchOtherTabs, 300);

  } catch (e) {
    if (!background) {
      status.textContent = 'Erro ao conectar: ' + e.message;
      status.style.color = 'var(--red)';
    }
  } finally {
    if (!background) btn.disabled = false;
  }
}

/* Prefetch silencioso das demais abas de trader (após a ativa carregar) para
   troca de aba instantânea. Sequencial p/ não saturar o backend; usa o cache. */
async function prefetchOtherTabs() {
  for (const tab of TRADER_TABS) {
    if (tab.id === activeTraderTab) continue;
    if (posDataByTab[tab.id]) continue;
    try { await loadPositionsForTab(tab.id, { background: true }); }
    catch { /* prefetch é best-effort */ }
  }
}

function renderSectionsForTab(tabId, allRows) {
  const tab        = TRADER_TABS.find(t => t.id === tabId);
  const tabFilters = FILTERS.filter(f => (tab?.filters ?? []).includes(f.id) && activeFilters.has(f.id));
  const filterRows = rows => rows.filter(r => tabFilters.every(f => f.fn(r)));
  const data       = posDataByTab[tabId];
  const displayRows = wdoUcAggregated.has(tabId) ? applyWdoUcAggregation(allRows) : allRows;
  const sections   = getSections(displayRows);
  const container  = document.getElementById(`posContainer-${tabId}`);
  const navMap     = data?.traders ?? {};

  const hasFundBreak  = tabId === 'portfoliorf' && !!(data?.fund_rows?.length);
  const navDate       = data?.nav_date;
  const pnlNavDate    = data?.portfoliorf_nav_date ?? navDate;
  const openingDate   = data?.opening_date;

  container.style.display       = 'inline-flex';
  container.style.flexDirection = 'column';
  container.innerHTML = sections.map((s, _i) => {
    const nav      = navMap[s.trader];
    const effDate  = tabId === 'portfoliorf' ? pnlNavDate : navDate;
    const navStr   = fmtNav(nav, effDate, openingDate);
    const isMmPrev = s.group === 'MM Prev';
    const hasAlloc = s.group === 'MM' && displayRows.some(r => r.group === 'MM Prev' && r.trader === s.trader);
    const titleId  = hasAlloc ? `id="sec_title_${s.trader.replace(/[^a-zA-Z0-9]/g,'_')}_MM"` : '';
    const bodyWrapId = `mmPrev_wrap_${s.trader.replace(/[^a-zA-Z0-9]/g,'_')}`;
    const hasFund  = hasFundBreak && s.group === 'Todos';

    if (isMmPrev) {
      return `
      <div class="card">
        <div style="cursor:pointer;user-select:none" onclick="(function(btn,wrap){
          var open=wrap.style.display!=='none';
          wrap.style.display=open?'none':'';
          btn.textContent=open?'▶':'▼';
        })(this.querySelector('.mmPrevArrow'),document.getElementById('${bodyWrapId}'))">
          <div class="section-title" style="padding:8px 0 8px 0;display:flex;align-items:baseline;gap:16px">
            <span>MM Prev <span style="font-weight:400;color:var(--text-muted);font-size:13px">— ${s.trader}</span></span>
            ${navStr ? `<span style="font-weight:400;color:var(--text-muted);font-size:12px">${navStr}</span>` : ''}
            <span class="mmPrevArrow" style="margin-left:auto;font-size:13px;color:var(--text-muted)">▶</span>
          </div>
        </div>
        <div id="${bodyWrapId}" style="display:none">
          <table class="data-table" style="white-space:nowrap;width:auto">
            ${thead()}
            <tbody id="${sectionBodyId(s)}"></tbody>
          </table>
        </div>
      </div>`;
    }

    return `
    <div class="card">
      <div style="display:flex;gap:40px;align-items:flex-start">
        <div class="section-copy-target">
          <div class="section-title" ${titleId} style="padding:8px 0 10px 0;display:flex;align-items:baseline;gap:16px">
            <span>${s.group} <span style="font-weight:400;color:var(--text-muted);font-size:13px">— ${s.trader}</span></span>
            ${navStr ? `<span style="font-weight:400;color:var(--text-muted);font-size:12px">${navStr}</span>` : ''}
            <button class="btn btn-secondary" data-html2canvas-ignore="true" style="margin-left:auto;padding:2px 10px;font-size:12px" onclick="copyCardImage(this)">⎘ Copiar</button>
          </div>
          <table class="data-table" style="white-space:nowrap;width:auto">
            ${thead()}
            <tbody id="${sectionBodyId(s)}"></tbody>
          </table>
        </div>
        ${hasAlloc ? `<div id="alloc_outer_${s.trader.replace(/[^a-zA-Z0-9]/g,'_')}" data-html2canvas-ignore="true">
          <div id="alloc_spacer_${s.trader.replace(/[^a-zA-Z0-9]/g,'_')}"></div>
          <div id="${allocCheckId(s.trader)}"></div>
        </div>` : ''}
        ${hasFund ? `<div id="fund_break_outer_portfoliorf" data-html2canvas-ignore="true">
          <div id="fund_break_spacer_portfoliorf"></div>
          <div id="fund_break_portfoliorf"></div>
        </div>` : ''}
      </div>
    </div>`;
  }).join('');

  for (const s of sections) {
    const rows = filterRows(sortRows(
      displayRows.filter(r => r.group === s.group && r.trader === s.trader)
    ));
    renderTable(rows, sectionBodyId(s));
    if (s.group === 'MM' && displayRows.some(r => r.group === 'MM Prev' && r.trader === s.trader)) {
      const el = document.getElementById(allocCheckId(s.trader));
      if (el) el.innerHTML = renderAllocTable(displayRows, s.trader, filterRows);
    }
    if (hasFundBreak && s.group === 'Todos') {
      const el = document.getElementById('fund_break_portfoliorf');
      if (el) el.innerHTML = renderFundBreakTable(
        filterRows(sortRows(displayRows.filter(r => r.group === s.group && r.trader === s.trader))),
        data.fund_rows, data.fund_navs, filterRows
      );
    }
  }

  // defer alignment: if tab is hidden (background load), getBoundingClientRect returns 0
  if (tabId === activeTraderTab) requestAnimationFrame(() => _alignAuxTables(tabId));
}

/* ── Re-render tables in place (filter toggle / row hide) ────────────────── */
// onlyKey (opcional): rowKey da linha afetada → só re-renderiza o tbody da seção dela.
// Linhas de outras seções (group/trader) não mudam ao ocultar uma linha, então
// pular o rebuild do innerHTML delas é seguro. Alloc/fund-break/opções têm
// dependência cross-section e são sempre atualizados (são tabelas pequenas).
function rerenderTables(onlyKey) {
  const data = posDataByTab[activeTraderTab];
  if (!data?.rows) return;
  const onlySection = onlyKey ? onlyKey.split('||') : null;  // [group, trader, ...]
  const tab        = TRADER_TABS.find(t => t.id === activeTraderTab);
  const tabFilters = FILTERS.filter(f => (tab?.filters ?? []).includes(f.id) && activeFilters.has(f.id));
  const filterRows = rows => rows.filter(r => tabFilters.every(f => f.fn(r)));
  const hasFundBreak = activeTraderTab === 'portfoliorf' && !!(data?.fund_rows?.length);
  const displayRows  = wdoUcAggregated.has(activeTraderTab)
    ? applyWdoUcAggregation(data.rows) : data.rows;
  for (const s of getSections(displayRows)) {
    const isTarget = !onlySection || (s.group === onlySection[0] && s.trader === onlySection[1]);
    const rows = filterRows(sortRows(
      displayRows.filter(r => r.group === s.group && r.trader === s.trader)
    ));
    if (isTarget) renderTable(rows, sectionBodyId(s));
    if (s.group === 'MM' && displayRows.some(r => r.group === 'MM Prev' && r.trader === s.trader)) {
      const el = document.getElementById(allocCheckId(s.trader));
      if (el) el.innerHTML = renderAllocTable(displayRows, s.trader, filterRows);
    }
    if (hasFundBreak && s.group === 'Todos') {
      const el = document.getElementById('fund_break_portfoliorf');
      if (el) el.innerHTML = renderFundBreakTable(rows, data.fund_rows, data.fund_navs, filterRows);
    }
  }
}

/* ── Análise de Opções (na aba dedicada; blocos por objeto + vencimento) ── */
// Lê os dados já carregados da aba (dolarConsolData[trader]) — independente das abas de trader.
function renderOptionsAnalysis() {
  const container = document.getElementById('optAnalysisContainer');
  if (!container) return;

  const data = dolarConsolData[dolarConsolTrader];
  // só book MM (exclui MM Prev)
  const opts = (data?.rows ?? []).filter(r => r.is_option && r.group !== 'MM Prev');
  if (!opts.length) { container.innerHTML = '<div class="card no-data">Nenhuma opção (MM) para este trader.</div>'; return; }

  // métricas por linha — fonte única: effectivePrice/effectiveDelta (marreta por instrumento → live → fallback)
  const metric = r => {
    const ik    = instKey(r);
    const price = effectivePrice(r);
    const src   = priceSrc(r);
    const delta = effectiveDelta(r);
    const nav   = r.nav;
    const premium = (r.final_qty != null && price != null && r.calc_factor != null)
                    ? r.final_qty * price * r.calc_factor : null;
    const nPct = r.option_nominal_exp;                                   // nominal independe do delta
    const nUsd = (nPct != null && nav) ? nPct * nav : null;
    const dPct = (nPct != null && delta != null) ? nPct * delta : null;  // exp. delta = nominal × delta
    const dUsd = (dPct != null && nav) ? dPct * nav : null;
    const edited = priceOverrides.has(ik) || deltaOverrides.has(ik);
    return { price, delta, src, premium, dPct, dUsd, nPct, nUsd, edited };
  };

  // agrupar por ativo objeto + vencimento, com exceções:
  //  • DOL e USDBRL no mesmo bloco
  //  • ações do mesmo ativo objeto no mesmo bloco (ignora vencimento)
  const groups = new Map();
  for (const r of opts) {
    const sub  = r.option_subtype;
    let undl   = r.option_undl || r.instrument_name || '—';
    let mat    = r.maturity || '';
    if (sub === 'dol' || (sub === 'fx' && undl.includes('BRL'))) undl = 'DOL / USDBRL';
    if (sub === 'us_equity') mat = '';   // ações: mesmo objeto junto, mesmo com vencimentos diferentes
    const gkey = `${undl}||${mat}`;
    if (!groups.has(gkey)) groups.set(gkey, { undl, mat, rows: [] });
    groups.get(gkey).rows.push(r);
  }
  const sorted = [...groups.values()].sort((a, b) =>
    a.undl.localeCompare(b.undl, 'en-US', { sensitivity: 'base' }) ||
    String(a.mat).localeCompare(String(b.mat)));

  const head = `<thead><tr>
    <th class="col-final">Instrumento</th>
    <th class="col-pnl num">Qtd Abertura</th>
    <th class="num">Qtd Operada</th>
    <th class="col-right num">Qtd Final</th>
    <th class="num">Preço Live</th>
    <th class="num">Delta</th>
    <th class="col-pnl num">Prêmio USD</th>
    <th class="num">Exp. Nominal</th>
    <th class="col-final num">Exp. Delta</th>
  </tr></thead>`;

  const body = sorted.map(g => {
    let tPrem = 0, tDUsd = 0, tDPct = 0, tNUsd = 0, tNPct = 0;
    const rowsHtml = sortRows(g.rows).map(r => {
      const m = metric(r);
      if (m.premium != null) tPrem += m.premium;
      if (m.dUsd != null)    tDUsd += m.dUsd;
      if (m.dPct != null)    tDPct += m.dPct;
      if (m.nUsd != null)    tNUsd += m.nUsd;
      if (m.nPct != null)    tNPct += m.nPct;
      const isFx     = r.option_subtype === 'fx';
      const safeIk   = instKey(r).replace(/"/g, '&quot;');
      const priceFmt = isFx ? fmtPricePct(m.price) : fmtPrice(m.price);
      const deltaFmt = m.delta != null
        ? m.delta.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 }) : '—';
      const star     = m.edited ? '<span style="color:var(--accent);font-size:10px">★ </span>' : '';
      // origem do preço (igual ao PnL): BBG → boleta → D-1 → manual
      const srcMap   = { bbg: ['BBG', 'var(--green)'], boleta: ['Boleta', '#e8a020'], d1: ['D-1', 'var(--red)'], manual: ['Manual', 'var(--accent)'] };
      const [srcLbl, srcColor] = srcMap[m.src] || ['—', ''];
      const priceStyle = `cursor:pointer;${srcColor ? `color:${srcColor}` : ''}`;
      return `<tr>
        <td class="col-final">${star}${r.instrument_name ?? '—'}</td>
        <td class="col-pnl num">${fmtFinalQty(r.opening_qty)}</td>
        <td class="num">${fmtTradedQty(r.traded_qty)}</td>
        <td class="col-right num">${fmtFinalQty(r.final_qty)}</td>
        <td class="num" style="${priceStyle}" title="Fonte: ${srcLbl} · clique para editar" data-instkey="${safeIk}" data-kind="price" data-isfx="${isFx ? 1 : 0}" onclick="optEditStart(this)">${priceFmt}</td>
        <td class="num" style="cursor:pointer" title="Clique para editar delta" data-instkey="${safeIk}" data-kind="delta" onclick="optEditStart(this)">${deltaFmt}</td>
        <td class="col-pnl num">${fmtMoney(m.premium)}</td>
        <td class="num">${fmtExp(m.nUsd, m.nPct)}</td>
        <td class="col-final num">${fmtExp(m.dUsd, m.dPct)}</td>
      </tr>`;
    }).join('');
    const spacer = `<tr><td colspan="9" style="height:18px;padding:0;border:none;background:transparent"></td></tr>`;
    const header = `<tr><td colspan="9" style="font-weight:600;color:var(--text-dim);background:var(--bg-row-alt);padding:7px 10px">${g.undl}${g.mat ? ` — ${fmtDate(g.mat)}` : ''}</td></tr>`;
    const total = `<tr style="font-weight:700">
        <td class="col-final">Total</td>
        <td class="col-pnl num"></td><td class="num"></td><td class="col-right num"></td><td class="num"></td><td class="num"></td>
        <td class="col-pnl num">${fmtMoney(tPrem)}</td>
        <td class="num">${fmtExp(tNUsd, tNPct)}</td>
        <td class="col-final num">${fmtExp(tDUsd, tDPct)}</td>
      </tr>`;
    return spacer + header + rowsHtml + total;
  }).join('');

  container.innerHTML = `<div class="card">
    <div class="section-title" style="padding:8px 0 10px 0;display:flex;align-items:center;gap:16px">
      <span>Análise de Opções <span style="font-weight:400;color:var(--text-muted);font-size:13px">— ${dolarConsolTrader} (MM)</span></span>
      <button class="btn btn-secondary" data-html2canvas-ignore="true" style="padding:3px 12px;font-size:12px;margin-left:auto" onclick="copyCardImage(this)">⎘ Copiar</button>
    </div>
    <div class="section-copy-target">
      <table class="data-table" style="white-space:nowrap;width:auto">
        ${head}
        <tbody>${body}</tbody>
      </table>
    </div>
  </div>`;
}

/* ── Análise de Opções: edição inline de preço / delta ───────────────────── */
function optEditStart(td) {
  if (td.querySelector('input')) return;
  const kind = td.dataset.kind;
  const isFx = td.dataset.isfx === '1';
  const key  = td.dataset.instkey;
  const map  = kind === 'delta' ? deltaOverrides : priceOverrides;
  const cur  = map.has(key) ? map.get(key) : null;
  const input = document.createElement('input');
  input.type = 'text';
  input.style.cssText = 'width:6em;font:inherit;text-align:right;background:var(--bg);border:1px solid var(--accent);color:var(--text)';
  const shown = cur !== null ? (kind === 'price' && isFx ? cur * 100 : cur) : '';
  input.value = shown === '' ? '' : String(shown).replace('.', ',');
  td.innerHTML = '';
  td.appendChild(input);
  input.focus();
  input.select();
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  input.blur();
    if (e.key === 'Escape') { map.delete(key); _markTabsDirtyAndRerender(); }
  });
  input.addEventListener('blur',  () => optEditApply(input, td));
  input.addEventListener('click', e => e.stopPropagation());
}

function optEditApply(input, td) {
  const kind = td.dataset.kind;
  const isFx = td.dataset.isfx === '1';
  const key  = td.dataset.instkey;
  const map  = kind === 'delta' ? deltaOverrides : priceOverrides;
  const raw  = parseFloat(String(input.value).replace(/\./g, '').replace(',', '.'));
  if (isNaN(raw)) map.delete(key);
  else            map.set(key, kind === 'price' && isFx ? raw / 100 : raw);
  _markTabsDirtyAndRerender();
}

/* ── Render single tbody ─────────────────────────────────────────────────── */
function renderTable(rows, tbodyId) {
  const body = document.getElementById(tbodyId);
  if (!body) return;

  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="${body.closest('table')?.querySelector('thead tr')?.childElementCount ?? 12}" class="no-data">Nenhuma posição encontrada.</td></tr>`;
    return;
  }

  const d = detailVisible ? '' : 'style="display:none"';

  // filtrar linhas ocultas manualmente (não afeta contagem de área)
  const visibleRows = rows.filter(r => !_hiddenForTab(activeTraderTab).has(rowKey(r)));

  let prevArea    = null;
  let prevSubarea = null;
  let subareaIdx  = -1;

  body.innerHTML = visibleRows.map((r, i) => {
    const newArea    = r.area    !== prevArea;
    const newSubarea = r.subarea !== prevSubarea;
    if (newSubarea) subareaIdx++;

    const rowClass  = subareaIdx % 2 === 0 ? 'group-odd' : 'group-even';
    const areaClass = newArea && i > 0 ? 'area-divider' : '';
    const tradedClass = (r.gross_traded_qty ?? 0) > 0 ? 'traded' : '';
    const key = rowKey(r).replace(/'/g, "\\'");

    prevArea    = r.area;
    prevSubarea = r.subarea;

    const tip = bbgTooltip(r.bbg_data);
    const tipAttr = tip ? ` data-bbg="${tip.replace(/"/g, '&quot;')}"` : '';
    const swapAttr = r.swap_detail
      ? ` data-swaps="${r.swap_detail.map(s => `${s.name}: ${fmtQty(s.qty)}`).join('\n').replace(/"/g, '&quot;')}"`
      : '';

    // valores efetivos: SWAPs consolidados E linhas normais podem ter override manual
    // de abertura/operada (mapas swap*Overrides, keyed por rowKey). Quantidade marretada
    // → recalcula Qtd Final e escala #PL/DV01 (lineares na qtd). Aba PnL não é afetada.
    const isSwap     = r.swap_detail != null;
    const rKeyFull   = rowKey(r);
    const nav        = r.nav ?? (posDataByTab[activeTraderTab] ?? positionsData)?.traders?.[r.trader];
    const hasOpenOvr = swapOpeningOverrides.has(rKeyFull);
    const hasTrdOvr  = swapTradedOverrides.has(rKeyFull);
    const qtyOvr     = hasOpenOvr || hasTrdOvr;
    const effOpening = hasOpenOvr ? swapOpeningOverrides.get(rKeyFull) : r.opening_qty;
    const effTraded  = hasTrdOvr  ? swapTradedOverrides.get(rKeyFull)  : r.traded_qty;
    const effFinal   = (qtyOvr || isSwap) ? (effOpening ?? 0) + (effTraded ?? 0) : r.final_qty;

    let effDv01, effPl, effPlType;
    if (isSwap) {                        // SWAP: a "qtd" É o DV01 (comportamento atual)
      effDv01   = effFinal || null;
      effPl     = (effDv01 != null && nav) ? effDv01 * 10_000 / nav : r.pl;
      effPlType = effDv01 != null ? 'nominal' : r.pl_type;
    } else if (qtyOvr && r.final_qty) {  // linha normal marretada: escala linear pela nova qtd
      const ratio = effFinal / r.final_qty;
      effDv01   = r.usd_dv01 != null ? r.usd_dv01 * ratio : null;
      effPl     = r.pl       != null ? r.pl       * ratio : r.pl;
      effPlType = r.pl_type;
    } else {                             // sem override (ou final_qty=0): valores do backend
      effDv01   = r.usd_dv01;
      effPl     = r.pl;
      effPlType = r.pl_type;
    }
    const isOvr      = qtyOvr;           // ★ no nome para qualquer override de quantidade

    const safeKey    = rKeyFull.replace(/"/g, '&quot;');
    const safeIk     = instKey(r).replace(/"/g, '&quot;');   // chave por instrumento (preço compartilhado)
    const openingCell = `<td class="col-pnl num" style="cursor:pointer" title="Clique para editar"
            data-swapkey="${safeKey}" data-opening="${effOpening ?? ''}"
            onclick="event.stopPropagation();swapStartEdit(this,'opening',this.dataset.swapkey,parseFloat(this.dataset.opening))">
           ${fmtFinalQty(effOpening)}</td>`;
    const tradedCell = `<td class="num" style="cursor:pointer" title="Clique para editar"
            data-swapkey="${safeKey}" data-traded="${effTraded ?? ''}"
            onclick="event.stopPropagation();swapStartEdit(this,'traded',this.dataset.swapkey,parseFloat(this.dataset.traded))">
           ${fmtTradedQty(effTraded)}</td>`;

    const refCopy = (r.instrument_reference ?? r.instrument_name ?? '').replace(/"/g, '&quot;');
    return `<tr class="${rowClass} ${areaClass} ${tradedClass}" style="cursor:pointer" title="Clique para ocultar" onclick="hideRow('${key}')">
      <td class="col-copy" data-ref="${refCopy}" title="Copiar referência do instrumento" onclick="event.stopPropagation();copyInstrumentRef(this)">⧉</td>
      <td class="col-detail" ${d}>${r.area     ?? '—'}</td>
      <td class="col-detail" ${d}>${r.subarea  ?? '—'}</td>
      <td class="col-detail" ${d}>${r.strategy ?? '—'}</td>
      <td class="col-detail num" ${d}>${r.option_subtype === 'fx' ? fmtPricePct(r.price) : fmtPrice(r.price)}</td>
      <td class="col-final"${swapAttr}>${(isOvr || plOverrides.has(rKeyFull) || priceOverrides.has(instKey(r)) || deltaOverrides.has(instKey(r))) ? '<span style="color:var(--accent);font-size:10px">★ </span>' : ''}${r.instrument_name ?? '—'}</td>
      <td>${fmtDate(r.maturity)}</td>
      ${openingCell}
      ${tradedCell}
      <td class="col-right num">${fmtFinalQty(effFinal)}</td>
      ${(() => {
        const isFxOpt       = r.option_subtype === 'fx';
        const dispPriceLive = effectivePrice(r);
        const priceStr      = isFxOpt ? fmtPricePct(dispPriceLive) : fmtPrice(dispPriceLive);
        return `<td class="num" style="cursor:pointer"${tipAttr}${!tip ? ' title="Clique para editar preço"' : ''}
          data-instkey="${safeIk}" data-rowkey="${safeKey}"
          data-cf="${r.calc_factor ?? ''}" data-nav="${r.nav ?? ''}"
          data-fq="${r.final_qty ?? ''}" data-plt="${r.pl_type ?? ''}"
          data-isfx="${isFxOpt ? 1 : 0}" data-isopt="${r.is_option ? 1 : 0}"
          onclick="event.stopPropagation();posPriceStartEdit(this)">
          ${priceStr}</td>`;
      })()}
      <td class="num"${tipAttr}>${fmtDv01(effDv01)}</td>
      ${(() => {
        const ov       = plOverrides.get(rKeyFull);
        const dispPl   = ov !== undefined ? ov    : effPl;
        const dispType = ov !== undefined ? 'pct' : effPlType;
        const delta    = r.option_delta;
        const plTip    = delta != null
          ? `Delta: ${delta} (clique para editar #PL)`
          : 'Clique para editar #PL';
        return `<td class="col-final num" data-rowkey="${safeKey}" onclick="event.stopPropagation();posPlStartEdit(this)" style="cursor:pointer" title="${plTip}">${fmtPL(dispPl, dispType)}</td>`;
      })()}
    </tr>`;
  }).join('');
}

/* ── Copiar a referência do instrumento (botão ⧉ no início de cada linha) ──── */
function _copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text).catch(() => _copyTextFallback(text));
  }
  _copyTextFallback(text);            // file:// / contexto não-seguro → execCommand
  return Promise.resolve();
}
function _copyTextFallback(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
  document.body.appendChild(ta);
  ta.focus(); ta.select();
  try { document.execCommand('copy'); } catch (_) { /* melhor esforço */ }
  document.body.removeChild(ta);
}
function copyInstrumentRef(td) {
  const ref = td?.dataset?.ref || '';
  if (!ref) return;
  _copyText(ref);
  const prev = td.textContent;       // feedback visual rápido
  td.textContent = '✓';
  td.style.color = 'var(--green)';
  setTimeout(() => { td.textContent = prev; td.style.color = ''; }, 900);
}


/* ── Copy element as image (WhatsApp-compatible) ─────────────────────────── */
// html2canvas é pesado e só serve ao botão "Copiar" → carrega sob demanda (1º clique).
let _h2cPromise = null;
function _ensureHtml2Canvas() {
  if (typeof html2canvas !== 'undefined') return Promise.resolve();
  if (_h2cPromise) return _h2cPromise;
  _h2cPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
  return _h2cPromise;
}

async function copyElementAsImage(el, btn) {
  if (!el) return;
  const origText = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    await _ensureHtml2Canvas();
    const canvas = await html2canvas(el, {
      scale: 2,
      useCORS: true,
      logging: false,
      backgroundColor: null,
    });
    canvas.toBlob(async blob => {
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        if (btn) {
          btn.textContent = '✓ Copiado';
          setTimeout(() => { btn.textContent = origText; btn.disabled = false; }, 1800);
        }
      } catch {
        if (btn) { btn.textContent = origText; btn.disabled = false; }
      }
    }, 'image/png');
  } catch {
    if (btn) { btn.textContent = origText; btn.disabled = false; }
  }
}

function copyCardImage(btn) {
  const card = btn.closest('.card');
  const target = card.querySelector('.section-copy-target') ?? card;
  copyElementAsImage(target, btn);
}

/* ── Calendar helpers ────────────────────────────────────────────────────── */
function _easter(y) {
  const a=y%19, b=Math.floor(y/100), c=y%100, d=Math.floor(b/4), e=b%4;
  const f=Math.floor((b+8)/25), g=Math.floor((b-f+1)/3);
  const h=(19*a+b-d-g+15)%30, i=Math.floor(c/4), k=c%4;
  const l=(32+2*e+2*i-h-k)%7, m=Math.floor((a+11*h+22*l)/451);
  const mo=Math.floor((h+l-7*m+114)/31), dy=((h+l-7*m+114)%31)+1;
  return new Date(y, mo-1, dy);
}
function _isHoliday(d) {
  const m=d.getMonth()+1, day=d.getDate();
  if (m===1  && day===1)  return true;
  if (m===12 && day===25) return true;
  const gf = _easter(d.getFullYear()); gf.setDate(gf.getDate()-2);
  return m===gf.getMonth()+1 && day===gf.getDate();
}
function lastBusinessDay(d) {
  const dt = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  while (dt.getDay()===0 || dt.getDay()===6 || _isHoliday(dt))
    dt.setDate(dt.getDate()-1);
  return dt.toISOString().slice(0,10);
}

/* ── Check Dólar Exposure ─────────────────────────────────────────────────── */
const _DOLAR_CATS = [
  { key: 'mini',   label: 'Mini Dólar (WDO)' },
  { key: 'cheio',  label: 'Dólar Cheio (UC)' },
  { key: 'option', label: 'Opções de DOL' },
];

// Chave do CACHE de ticker BBG da opção (compartilhada com o backend) = instrument_reference.
function _dolarOptKey(inst) { return inst.instrument_reference || inst.instrument_name || ''; }

// Delta efetivo, |delta| com sinal pelo tipo. Prioridade: marreta global → default do backend (já live p/ DOL).
// Independe do sinal cru da BBG (que reflete a direção da posição cadastrada). `instk` = instKey(inst).
function _effOptDelta(instk, defaultDelta, name) {
  const ov = deltaOverrides.get(instk);      // marreta global por instrumento (prioridade)
  let dl = ov != null ? ov : defaultDelta;   // defaultDelta = delta do backend (live DOL via ticker / DB)
  if (dl == null) return null;
  const sign = _optTypeSign(name);
  return sign != null ? sign * Math.abs(dl) : dl;
}

function _dolarInstExp(inst) {
  // futuros: exp já calculado pelo backend; opções: recomputa com delta efetivo
  if (inst.category === 'option') {
    const dl   = _effOptDelta(instKey(inst), inst.delta, inst.instrument_name);
    const ok   = dl != null && inst.px_last != null;
    const unit = ok ? dl * inst.mult * inst.px_last : null;
    return {
      delta:   dl,
      opening: ok ? inst.opening_qty * unit : null,
      trade:   ok ? inst.traded_qty  * unit : null,
      final:   ok ? inst.final_qty   * unit : null,
    };
  }
  return { delta: null, opening: inst.opening_exp, trade: inst.trade_exp, final: inst.final_exp };
}

function _fmtBrl(v) {
  if (v == null) return '<span style="color:var(--text-muted)">—</span>';
  const s = Math.abs(v).toLocaleString('pt-BR', { maximumFractionDigits: 0 });
  if (v < 0) return `<span style="color:var(--red)">(${s})</span>`;
  if (v === 0) return `<span style="color:var(--text-muted)">—</span>`;
  return s;
}

function _qtyTip(qty) {
  if (qty == null) return '';
  const n = Math.round(qty);
  return ` title="${n.toLocaleString('pt-BR')} contratos"`;
}

// Célula: BRL em cima, % do NAV embaixo; tooltip com qtd de contratos.
function _expCell(exp, nav, qty, lb = false) {
  const pct   = (exp != null && nav) ? fmtPct(exp / nav) : '—';
  const style = lb ? ' style="border-left:1px solid var(--border)"' : '';
  return `<td class="num"${style}${_qtyTip(qty)}>${_fmtBrl(exp)}<br><span style="font-size:11px;color:var(--text-muted)">${pct}</span></td>`;
}

// Célula só BRL (linha de total geral, onde % do NAV não faz sentido entre fundos).
function _brlCell(exp, lb = false) {
  return `<td class="num"${lb ? ' style="border-left:1px solid var(--border)"' : ''}>${_fmtBrl(exp)}</td>`;
}

// BRL sem coloração própria (para a célula destacada, onde a cor vem do limite).
function _brlPlain(v) {
  if (v == null) return '—';
  const s = Math.abs(Math.round(v)).toLocaleString('pt-BR');
  return v < 0 ? `(${s})` : s;
}

// Gradação de cor do limite de exposição a dólar (limite 20%).
//  < 15% verde · 15–17% amarelo · 17–19% laranja · 19–20% vermelho forte · > 20% estouro
function _dolarLimitStyle(pct) {
  if (pct == null) return 'color:var(--text-muted)';
  const a = Math.abs(pct);
  if (a < 0.15) return 'color:var(--green)';
  if (a < 0.17) return 'color:#f0c040';
  if (a < 0.19) return 'color:#e8853a';
  if (a <= 0.20) return 'color:#fff;background:var(--red);font-weight:700';
  return 'color:#fff;background:#8a0d0d;font-weight:700';
}

// Célula destacada Total/Final: a coluna mais relevante (exposição vs limite).
function _totalFinalCell(brl, pct) {
  const warn = (pct != null && Math.abs(pct) >= 0.19) ? ' ⚠' : '';
  const pctStr = pct != null ? fmtPct(pct) : '—';
  return `<td class="num" style="border-left:2px solid var(--border);border-right:2px solid var(--border);${_dolarLimitStyle(pct)}">
    <span style="font-size:11px;opacity:0.85">${_brlPlain(brl)}</span><br><span style="font-size:14px;font-weight:700">${pctStr}${warn}</span></td>`;
}

const _SEP_TD = 'border-left:3px double var(--border);padding-left:14px';

// Reenquadramento ao limite de 20%: quantos contratos faltam vender/comprar (estouro)
// ou cabem (folga) p/ chegar no limite. totF = exposição final; opsF = operações líquidas.
function _reframeCell(totF, opsF, nav, isSula, miniVal, fullVal) {
  if (nav == null || !miniVal || !fullVal)
    return `<td class="num" style="${_SEP_TD};color:var(--text-muted)">—</td>`;
  const limit = 0.20 * nav;
  const over  = Math.abs(totF) - limit;            // >0 estourou · <0 tem folga
  const nMini = Math.abs(over) / miniVal;
  const nFull = Math.abs(over) / fullVal;
  const fN = n => n.toLocaleString('pt-BR', { maximumFractionDigits: 1 });
  if (over > 0) {
    const refSign = isSula ? Math.sign(opsF) : Math.sign(totF);
    const action  = refSign >= 0 ? 'vender' : 'comprar';
    return `<td class="num" style="${_SEP_TD};color:var(--red);font-weight:600">
      ${action} ${fN(nFull)} cheio<br><span style="font-size:11px;font-weight:400">(ou ${fN(nMini)} mini) p/ reenquadrar</span></td>`;
  }
  return `<td class="num" style="${_SEP_TD};color:var(--green)">
    folga ${fN(nFull)} cheio<br><span style="font-size:11px;color:var(--text-muted)">(ou ${fN(nMini)} mini)</span></td>`;
}

function showDolarTab() {
  activeTraderTab = DOLAR_TAB_ID;
  for (const tab of TRADER_TABS) {
    const el = document.getElementById(`tab-${tab.id}`);
    if (el) el.style.display = 'none';
    document.getElementById(`tab-btn-${tab.id}`)?.classList.remove('active');
  }
  const dolarEl = document.getElementById('tab-dolar');
  if (dolarEl) dolarEl.style.display = '';
  document.getElementById('tab-btn-dolar')?.classList.add('active');
  const consolEl = document.getElementById('tab-dolarconsol');
  if (consolEl) consolEl.style.display = 'none';
  document.getElementById('tab-btn-dolarconsol')?.classList.remove('active');
  _hideRolagemTab();
  if (!posDataByTab[DOLAR_TAB_ID]) loadDolarExposure();
  else { _dirtyTabs.delete(DOLAR_TAB_ID); renderDolarTable(posDataByTab[DOLAR_TAB_ID]); }
}

/* ── Rolagem Dólar (posição do vencimento a rolar + geração de boletas) ───── */
// Carrega só ao abrir (sem prefetch/background). Sem Bloomberg: só JRS+JDS.
// Consolida WDO (mini) + UC (cheio) do vencimento-alvo por FUNDO e permite filtrar
// por fundo/trader/área/subárea/estratégia/ativo (múltipla escolha; vazio = tudo),
// tudo client-side sobre o cache. Depois gera as boletas de rolagem (real+gerencial).
const ROLAGEM_TAB_ID = 'rolagem';
const ROLAGEM_FILTER_DIMS = [
  { key: 'fund',     label: 'Fundo'      },
  { key: 'trader',   label: 'Trader'     },
  { key: 'area',     label: 'Área'       },
  { key: 'subarea',  label: 'Sub-área'   },
  { key: 'strategy', label: 'Estratégia' },
  { key: 'asset',    label: 'Ativo'      },
];
// Lista de brokers/counterparties (droplist das execuções e do counterparty gerencial).
const ROLAGEM_BROKERS = [
  'Ativa CTVC', 'Banco Bradesco S.A.', 'Banco BTG Pactual S.A.',
  'Banco Itau-Unibanco S.A.', 'Banco Santander Brasil', 'C6 CTVM', 'Convencao CVC',
  'Gerencial', 'Link CCTVM', 'Liquidez DTVM', 'Necton Investimentos', 'Renaissance',
  'Terra Inv DTVM', 'XP Investimentos CCTVM',
];
// Traders desmarcados por default (o resto começa marcado).
const ROLAGEM_TRADER_OFF = new Set(['AMuller', 'EquityHedge', 'FIA', 'CPLiquidos']);
let rolagemMonth = null;                       // 'YYYY-MM' escolhido; null = default (próximo mês)
const rolagemFilters = {};                     // dimKey → Set<valor> (vazio/ausente = tudo)
let rolagemBoletas = null;                     // último retorno do POST /boletas
let rolagemQtyEdit = {};                        // idx da boleta → quantidade ajustada manualmente
let _rolagemPanelMonth = null;                 // vencimento p/ o qual o painel de config foi montado
let _fundDropOpen = false;                     // dropdown de fundos aberto?
// Config de execução/colunas fixas (persiste entre renders). Cada ativo tem uma LISTA de
// execuções (qtd/preço/broker/base) que a ferramenta distribui pelas alocações.
const rolagemConfig = {
  deal_date: '', counterparty_gerencial: 'Gerencial', giveup: '', deal_type: '',
  value_date: '', fixing_date: '', fo_remark: '', bo_remark: '',
  obs_reserved: '', ignore_previous: '',
  mini:  { execs: [] },
  cheio: { execs: [] },
};

function _hideRolagemTab() {
  const el = document.getElementById('tab-rolagem');
  if (el) el.style.display = 'none';
  document.getElementById('tab-btn-rolagem')?.classList.remove('active');
}

function showRolagemTab() {
  activeTraderTab = ROLAGEM_TAB_ID;
  for (const tab of TRADER_TABS) {
    const el = document.getElementById(`tab-${tab.id}`);
    if (el) el.style.display = 'none';
    document.getElementById(`tab-btn-${tab.id}`)?.classList.remove('active');
  }
  document.getElementById('tab-dolar').style.display = 'none';
  document.getElementById('tab-btn-dolar')?.classList.remove('active');
  document.getElementById('tab-dolarconsol').style.display = 'none';
  document.getElementById('tab-btn-dolarconsol')?.classList.remove('active');
  const el = document.getElementById('tab-rolagem');
  if (el) el.style.display = '';
  document.getElementById('tab-btn-rolagem')?.classList.add('active');
  if (!posDataByTab[ROLAGEM_TAB_ID]) loadRolagem();
  else renderRolagem();
}

async function loadRolagem() {
  const refDate   = document.getElementById('refDate').value;
  const status    = document.getElementById('refStatus');
  const srcLabel  = document.getElementById('srcLabel');
  const btn       = document.getElementById('btnLoad');
  const container = document.getElementById('rolagemContainer');

  status.textContent = 'Buscando dados...';
  status.style.color = 'var(--text-muted)';
  btn.disabled = true;
  container.innerHTML = '<div class="card"><span class="loading">Carregando...</span></div>';

  try {
    const params = new URLSearchParams();
    if (refDate) params.set('ref_date', refDate);
    const forceOpening = document.getElementById('forceOpening').value;
    if (forceOpening) params.set('force_opening', forceOpening);
    if (rolagemMonth) params.set('target_month', rolagemMonth);
    const data = await (await fetch(`${API_BASE}/api/positions/rolagem-dolar?${params}`)).json();

    if (data.error) {
      status.textContent = 'Erro: ' + data.error;
      status.style.color = 'var(--red)';
      container.innerHTML = `<div class="card no-data">${data.error}</div>`;
      return;
    }

    posDataByTab[ROLAGEM_TAB_ID] = data;
    rolagemMonth = data.target_month;
    rolagemBoletas = null;               // nova base → prévia de boletas anterior fica obsoleta
    // Traders começam marcados por default, exceto os de ROLAGEM_TRADER_OFF; demais dims vazias (=tudo).
    rolagemFilters.trader = new Set(_rolagemDistinct(data.rows || [], 'trader').filter(t => !ROLAGEM_TRADER_OFF.has(t)));
    status.textContent = '';
    srcLabel.textContent =
      `Abertura: ${fmtDate(data.opening_date)}  |  Boletas: ${fmtDate(data.ref_date)}`;
    renderRolagem();
  } catch (e) {
    status.textContent = 'Erro ao conectar: ' + e.message;
    status.style.color = 'var(--red)';
  } finally {
    btn.disabled = false;
  }
}

function changeRolagemMonth(v) {
  rolagemMonth = v;
  delete posDataByTab[ROLAGEM_TAB_ID];
  loadRolagem();
}

// Detalhe (tabela por linha) recolhido por default — o foco é o resumo.
function toggleRolagemPos() {
  const c = document.getElementById('rolagemContainer');
  const h = document.getElementById('rolagemPosHeader');
  const hidden = c.style.display === 'none';
  c.style.display = hidden ? '' : 'none';
  if (h) h.textContent = `${hidden ? '▼' : '▶'} Posição de dólar do vencimento a rolar (detalhe)`;
}

/* ── Filtros de múltipla escolha (Set por dimensão; vazio = tudo) ─────────── */
function _rolagemSet(key) {
  if (!rolagemFilters[key]) rolagemFilters[key] = new Set();
  return rolagemFilters[key];
}
function toggleRolagemFilter(key, val) {
  const s = _rolagemSet(key);
  if (s.has(val)) s.delete(val); else s.add(val);
  rolagemBoletas = null;               // filtro mudou → prévia de boletas obsoleta
  renderRolagem();
}
function clearRolagemFilter(key) {
  rolagemFilters[key] = new Set();
  rolagemBoletas = null;
  renderRolagem();
}
function _rolagemDistinct(rows, key) {
  return [...new Set(rows.map(r => r[key]).filter(v => v != null && v !== ''))].sort();
}
// Aplica os filtros ativos (cada dimensão: Set vazio = passa tudo).
function _rolagemFilteredRows(data) {
  let rows = (data.rows || []).slice();
  for (const d of ROLAGEM_FILTER_DIMS) {
    const s = rolagemFilters[d.key];
    if (s && s.size) rows = rows.filter(r => s.has(r[d.key]));
  }
  return rows;
}

function toggleFundDropdown() {
  _fundDropOpen = !_fundDropOpen;
  const p = document.getElementById('rolagemFundPanel');
  if (p) p.style.display = _fundDropOpen ? '' : 'none';
}

// Dropdown de fundos (multi-select por checkbox; nenhum marcado = todos).
function _rolagemFundDropdown(allRows) {
  const sel = rolagemFilters.fund;
  const funds = _rolagemDistinct(allRows, 'fund');
  const nSel = sel ? sel.size : 0;
  const label = nSel ? `${nSel} fundo(s)` : 'Todos os fundos';
  const boxes = funds.map(v => {
    const on = sel && sel.has(v);
    const safe = String(v).replace(/'/g, "\\'");
    return `<label style="display:flex;gap:6px;align-items:center;font-size:12px;padding:2px 4px;white-space:nowrap;cursor:pointer">
        <input type="checkbox" ${on ? 'checked' : ''} onchange="toggleRolagemFilter('fund','${safe}')"> ${v}
      </label>`;
  }).join('');
  return `<div style="position:relative;display:inline-block">
      <button type="button" onclick="toggleFundDropdown()"
        style="padding:4px 12px;font-size:12px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:4px;cursor:pointer">
        Fundos: <b>${label}</b> ▾</button>
      <div id="rolagemFundPanel" style="display:${_fundDropOpen ? '' : 'none'};position:absolute;z-index:50;margin-top:4px;
        max-height:280px;overflow-y:auto;background:var(--bg-card);border:1px solid var(--border);border-radius:6px;padding:6px 8px;min-width:240px;box-shadow:0 4px 12px rgba(0,0,0,0.25)">
        <div style="display:flex;gap:8px;margin-bottom:4px">
          <span class="filter-chip off" onclick="clearRolagemFilter('fund')">Limpar (todos)</span>
        </div>
        ${boxes || '<span style="font-size:12px;color:var(--text-muted)">—</span>'}
      </div>
    </div>`;
}

function _rolagemRenderControls(data) {
  const allRows = data.rows || [];
  const months = (data.available_months || []).slice();
  if (!months.some(m => m.ym === data.target_month)) {
    months.push({ ym: data.target_month, label: data.target_label });
  }
  months.sort((a, b) => a.ym.localeCompare(b.ym));
  const monthOpts = months.map(m =>
    `<option value="${m.ym}" ${m.ym === rolagemMonth ? 'selected' : ''}>${m.label}</option>`).join('');

  // Trader: chips TODOS selecionados por default (sem "Todos"). Área/Sub-área/Estratégia/Ativo:
  // chips com "Todos" (vazio = tudo). Fundo: dropdown multi-select (acima).
  const chipDim = (d, withTodos) => {
    const sel = rolagemFilters[d.key];
    const allOn = !sel || sel.size === 0;
    const chips = _rolagemDistinct(allRows, d.key).map(v => {
      const on = sel && sel.has(v);
      const safe = String(v).replace(/'/g, "\\'");
      return `<span class="filter-chip ${on ? 'on' : 'off'}" onclick="toggleRolagemFilter('${d.key}','${safe}')">${v}</span>`;
    }).join('');
    const todos = withTodos
      ? `<span class="filter-chip ${allOn ? 'on' : 'off'}" onclick="clearRolagemFilter('${d.key}')">Todos</span>` : '';
    return `<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:2px 0">
        <span style="font-size:12px;color:var(--text-muted);font-weight:600;min-width:74px">${d.label}:</span>
        ${todos}${chips}
      </div>`;
  };

  document.getElementById('rolagemControls').innerHTML = `
    <div class="card" style="display:flex;flex-direction:column;gap:8px">
      <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
        <label style="font-size:13px;color:var(--text-muted)">Vencimento a rolar:
          <select onchange="changeRolagemMonth(this.value)"
            style="padding:5px 10px;font-size:13px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:4px">${monthOpts}</select>
        </label>
        <span style="font-size:12px;color:var(--text-muted);font-weight:600">Fundo:</span>
        ${_rolagemFundDropdown(allRows)}
        <span style="font-size:12px;color:var(--text-muted)">Contrato BBG: <b>${data.target_code}${(data.target_month || '').slice(2, 4)}</b> (mini WDO + cheio UC)</span>
      </div>
      ${chipDim(ROLAGEM_FILTER_DIMS[1], false)}
      ${chipDim(ROLAGEM_FILTER_DIMS[2], true)}
      ${chipDim(ROLAGEM_FILTER_DIMS[3], true)}
      ${chipDim(ROLAGEM_FILTER_DIMS[4], true)}
      ${chipDim(ROLAGEM_FILTER_DIMS[5], true)}
    </div>`;
}

/* ── Resumo: net por fundo (mini/cheio) — o que precisa rolar ─────────────── */
function _rolagemRenderSummary(rows) {
  const el = document.getElementById('rolagemSummary');
  if (!el) return;
  const byFund = new Map();   // fund → {mini, cheio}
  for (const r of rows) {
    let g = byFund.get(r.fund);
    if (!g) { g = { mini: 0, cheio: 0 }; byFund.set(r.fund, g); }
    g[r.asset] += r.final_qty;
  }
  const funds = [...byFund.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  // Execução por LADO: fundos com net>0 compram o spread; net<0 vendem. Fundos não netam
  // entre si, então a compra total = Σ net>0 e a venda total = Σ|net<0| (por ativo).
  let buyMini = 0, sellMini = 0, buyCheio = 0, sellCheio = 0;
  for (const [, g] of funds) {
    const m = Math.round(g.mini), c = Math.round(g.cheio);
    if (m > 0) buyMini += m; else sellMini += -m;
    if (c > 0) buyCheio += c; else sellCheio += -c;
  }
  const body = funds.map(([fund, g]) => `<tr>
      <td>${fund}</td>
      <td class="num">${fmtFinalQty(g.mini)}</td>
      <td class="num">${fmtFinalQty(g.cheio)}</td>
    </tr>`).join('');
  el.innerHTML = `
    <div class="card" style="overflow-x:auto">
      <table class="data-table" style="max-width:680px">
        <thead><tr>
          <th style="text-align:left">Fundo</th>
          <th class="num" title="Net de WDO (mini) por fundo">Net mini (ctr)</th>
          <th class="num" title="Net de UC (cheio) por fundo">Net cheio (ctr)</th>
        </tr></thead>
        <tbody>
          ${body || '<tr><td colspan="3" class="no-data">—</td></tr>'}
          <tr class="area-divider" style="font-weight:700">
            <td title="Contratos a COMPRAR no mercado = Σ dos net positivos por fundo">A executar — COMPRA</td>
            <td class="num"><span style="color:var(--green)">${buyMini ? '+' + fmtQty(buyMini) : '—'}</span></td>
            <td class="num"><span style="color:var(--green)">${buyCheio ? '+' + fmtQty(buyCheio) : '—'}</span></td>
          </tr>
          <tr style="font-weight:700">
            <td title="Contratos a VENDER no mercado = Σ dos |net| negativos por fundo">A executar — VENDA</td>
            <td class="num"><span style="color:var(--red)">${sellMini ? '(' + fmtQty(sellMini) + ')' : '—'}</span></td>
            <td class="num"><span style="color:var(--red)">${sellCheio ? '(' + fmtQty(sellCheio) + ')' : '—'}</span></td>
          </tr>
        </tbody>
      </table>
    </div>`;
}

function renderRolagem() {
  const data = posDataByTab[ROLAGEM_TAB_ID];
  if (!data) return;
  _rolagemRenderControls(data);

  const rows = _rolagemFilteredRows(data);
  _rolagemRenderSummary(rows);

  // ── Tabela principal: Fundo · Trader · Área · Sub-área · Estratégia · Instrument · Qtd
  const container = document.getElementById('rolagemContainer');
  const sorted = rows.slice().sort((a, b) =>
    (a.fund || '').localeCompare(b.fund || '') ||
    (a.area || '').localeCompare(b.area || '') ||
    (a.subarea || '').localeCompare(b.subarea || '') ||
    (a.strategy || '').localeCompare(b.strategy || '') ||
    (a.trader || '').localeCompare(b.trader || ''));

  if (!sorted.length) {
    container.innerHTML = '<div class="card no-data">Sem posição de dólar no vencimento selecionado (com os filtros atuais).</div>';
  } else {
    const body = sorted.map(r => `<tr>
        <td>${r.fund || '—'}</td>
        <td>${r.trader || '—'}</td>
        <td>${r.area || '—'}</td>
        <td>${r.subarea || '—'}</td>
        <td>${r.strategy || '—'}</td>
        <td>${r.instrument_reference || '—'} <span style="font-size:11px;color:var(--text-muted)">(${r.asset})</span></td>
        <td class="num col-final" style="font-weight:600">${fmtFinalQty(r.final_qty)}</td>
      </tr>`).join('');
    container.innerHTML = `
      <div class="card" style="overflow-x:auto">
        <table class="data-table">
          <thead><tr>
            <th style="text-align:left">Fundo</th>
            <th style="text-align:left">Trader</th>
            <th style="text-align:left">Área</th>
            <th style="text-align:left">Sub-área</th>
            <th style="text-align:left">Estratégia</th>
            <th style="text-align:left">Instrument reference</th>
            <th class="num col-final">Quantidade</th>
          </tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>`;
  }

  _rolagemRenderBoletaPanel(data);
}

/* ── Painel de boletas de rolagem (config + gerar + prévia + export) ──────── */
// Colunas do JDS que ficam SEMPRE vazias: escondidas na prévia, mas presentes no
// export (a contagem de colunas importa ao colar no Excel).
const ROLAGEM_EMPTY_COLS = new Set([
  'Giveup Counterparty', 'Deal Type', 'Value date', 'Fixing date',
  'FO Remark', 'BO Remark', '(OBS) Reserved', 'Ignore previous positions',
]);
function _fmtDDMMYYYY(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  return m ? `${m[3]}/${m[2]}/${m[1]}` : (iso || '');
}
function setRolagemCfg(path, val) {
  const parts = path.split('.');
  let o = rolagemConfig;
  while (parts.length > 1) o = o[parts.shift()];
  o[parts[0]] = val;
}

function _cfgInput(label, path, cur, ph = '') {
  const safe = String(cur ?? '').replace(/"/g, '&quot;');
  return `<label style="font-size:12px;color:var(--text-muted);display:flex;flex-direction:column;gap:2px">
      ${label}
      <input type="text" value="${safe}" placeholder="${ph}" oninput="setRolagemCfg('${path}', this.value)"
        style="padding:4px 8px;font-size:12px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:4px;min-width:120px">
    </label>`;
}

// <select> de broker (opções da lista ROLAGEM_BROKERS; sem linha vazia).
function _brokerOptions(cur) {
  return ROLAGEM_BROKERS.map(b => `<option ${b === cur ? 'selected' : ''}>${b}</option>`).join('');
}
function _cfgSelect(label, path, cur, options) {
  return `<label style="font-size:12px;color:var(--text-muted);display:flex;flex-direction:column;gap:2px">
      ${label}
      <select onchange="setRolagemCfg('${path}', this.value)"
        style="padding:4px 8px;font-size:12px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:4px;min-width:120px">${options}</select>
    </label>`;
}

// Ticker do ativo de rolagem (espelha o backend): mini→WD1, cheio→DR1, {front}{Yf}{back}{Yb}.
const _ROLL_FUT_CODES = 'FGHJKMNQUVXZ';
function _rollSpreadTicker(asset, ym) {
  const y = +ym.slice(0, 4), m = +ym.slice(5, 7);
  const bm = m === 12 ? 1 : m + 1, by = m === 12 ? y + 1 : y;
  const pfx = asset === 'mini' ? 'WD1' : 'DR1';
  return `${pfx}${_ROLL_FUT_CODES[m - 1]}${y % 10}${_ROLL_FUT_CODES[bm - 1]}${by % 10}`;
}

/* ── Execuções reais por ativo (lista editável; a tool distribui nas alocações) ─ */
function setExecCell(asset, i, field, val) {
  const e = rolagemConfig[asset].execs[i];
  if (e) e[field] = val;
}
function addExecRow(asset) {
  // broker default = 1º da lista (sem opção vazia no droplist)
  rolagemConfig[asset].execs.push({ qty: '', price: '', broker: ROLAGEM_BROKERS[0], base: '' });
  _renderExecRows(asset);
}
function removeExecRow(asset, i) {
  rolagemConfig[asset].execs.splice(i, 1);
  _renderExecRows(asset);
}
function _renderExecRows(asset) {
  const el = document.getElementById('rolagemExecs-' + asset);
  if (!el) return;
  const inSty = 'padding:3px 6px;font-size:12px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:4px';
  const rows = rolagemConfig[asset].execs.map((e, i) => `<tr>
      <td><input type="text" inputmode="numeric" value="${String(e.qty ?? '').replace(/"/g, '&quot;')}" placeholder="+compra / −venda"
        oninput="setExecCell('${asset}',${i},'qty',this.value)" style="${inSty};width:110px;text-align:right"></td>
      <td><input type="text" value="${String(e.price ?? '').replace(/"/g, '&quot;')}" placeholder="spread"
        oninput="setExecCell('${asset}',${i},'price',this.value)" style="${inSty};width:90px;text-align:right"></td>
      <td><select onchange="setExecCell('${asset}',${i},'broker',this.value)" style="${inSty};min-width:170px">${_brokerOptions(e.broker)}</select></td>
      <td><input type="text" value="${String(e.base ?? '').replace(/"/g, '&quot;')}" placeholder="preço-base"
        oninput="setExecCell('${asset}',${i},'base',this.value)" style="${inSty};width:100px;text-align:right"></td>
      <td><button class="btn" onclick="removeExecRow('${asset}',${i})" style="padding:2px 8px;font-size:12px;background:var(--red);color:#fff">✕</button></td>
    </tr>`).join('');
  el.innerHTML = `
    <table class="data-table" style="font-size:12px;width:auto">
      <thead><tr>
        <th class="num">Qtd (spread)</th><th class="num">Preço (spread)</th>
        <th style="text-align:left">Broker</th><th class="num">Base (Aux.)</th><th></th>
      </tr></thead>
      <tbody>${rows || '<tr><td colspan="5" style="color:var(--text-muted);font-size:12px">sem execuções — clique “+ execução”</td></tr>'}</tbody>
    </table>
    <button class="btn btn-secondary" onclick="addExecRow('${asset}')" style="margin-top:6px;padding:4px 12px;font-size:12px">+ execução</button>`;
}

function _rolagemRenderBoletaPanel(data) {
  const panel = document.getElementById('rolagemBoletaPanel');
  if (!panel) return;

  // (Re)monta a config só quando o vencimento muda (os tickers dependem dele);
  // os valores digitados persistem em rolagemConfig.
  if (_rolagemPanelMonth !== data.target_month) {
    _rolagemPanelMonth = data.target_month;
    if (!rolagemConfig.deal_date) rolagemConfig.deal_date = _fmtDDMMYYYY(data.ref_date || '');
    const assetBlock = (asset, label) => `
      <div style="border:1px solid var(--border);border-radius:6px;padding:8px 10px;display:flex;flex-direction:column;gap:6px;flex:1;min-width:340px">
        <div style="font-weight:600;font-size:12px">${label} — ativo <b>${_rollSpreadTicker(asset, data.target_month)}</b></div>
        <div id="rolagemExecs-${asset}"></div>
      </div>`;

    panel.innerHTML = `
      <div class="card" style="display:flex;flex-direction:column;gap:12px">
        <div style="font-size:12px;color:var(--text-muted)">
          Informe as execuções reais (várias, com qtd/preço/broker/base diferentes). A ferramenta
          distribui por lado (compra/venda) nas alocações e gera as boletas — reais (com broker) +
          gerenciais fictícias (netam zero por fundo, no preço/base médio das execuções).
        </div>
        <div style="display:flex;gap:12px;flex-wrap:wrap">
          ${assetBlock('mini', 'Mini (WDO)')}
          ${assetBlock('cheio', 'Cheio (UC)')}
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          ${_cfgInput('Deal Date (dd/mm/aaaa)', 'deal_date', rolagemConfig.deal_date)}
          ${_cfgSelect('Cpty gerencial', 'counterparty_gerencial', rolagemConfig.counterparty_gerencial, _brokerOptions(rolagemConfig.counterparty_gerencial))}
          <span style="font-size:11px;color:var(--text-muted);align-self:flex-end">As colunas Giveup/Deal Type/Value date/Fixing/Remarks/Ignore ficam vazias (só contam no paste).</span>
        </div>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <button class="btn" onclick="gerarBoletas()" style="padding:6px 18px;font-size:13px">Gerar boletas</button>
          <span style="font-size:12px;color:var(--text-muted)">As boletas refletem os filtros atuais.</span>
        </div>
        <div id="rolagemBoletaPreview"></div>
      </div>`;
    _renderExecRows('mini');
    _renderExecRows('cheio');
  }
  _renderBoletaPreview();
}

async function gerarBoletas() {
  const status = document.getElementById('refStatus');
  const filters = {};
  for (const d of ROLAGEM_FILTER_DIMS) {
    const s = rolagemFilters[d.key];
    if (s && s.size) filters[d.key] = [...s];
  }
  const payload = {
    ref_date: document.getElementById('refDate').value || undefined,
    force_opening: document.getElementById('forceOpening').value || undefined,
    target_month: rolagemMonth,
    filters,
    config: rolagemConfig,
  };
  status.textContent = 'Gerando boletas...';
  status.style.color = 'var(--text-muted)';
  try {
    const resp = await fetch(`${API_BASE}/api/positions/rolagem-dolar/boletas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    if (data.error) {
      status.textContent = 'Erro: ' + data.error;
      status.style.color = 'var(--red)';
      return;
    }
    rolagemBoletas = data;
    rolagemQtyEdit = {};                 // nova geração → limpa ajustes manuais
    status.textContent = '';
    _renderBoletaPreview();
  } catch (e) {
    status.textContent = 'Erro ao gerar boletas: ' + e.message;
    status.style.color = 'var(--red)';
  }
}

function _renderBoletaPreview() {
  const el = document.getElementById('rolagemBoletaPreview');
  if (!el) return;
  const b = rolagemBoletas;
  if (!b || !b.boletas) {
    el.innerHTML = '<div style="font-size:12px;color:var(--text-muted)">Configure e clique <b>Gerar boletas</b> — a prévia (real + gerencial) aparece aqui.</div>';
    return;
  }
  if (!b.boletas.length) {
    el.innerHTML = '<div class="no-data">Nenhuma boleta gerada (sem posição no filtro atual).</div>';
    return;
  }

  const nReal = b.boletas.filter(x => x._kind === 'real').length;
  const nGer  = b.boletas.length - nReal;

  // ── "Casar" execuções × posição a rolar (usa qtd EFETIVA = com ajustes manuais) ──
  // Por (fundo, ativo): Σ boletas deve = net a rolar. Se você editou uma qtd ou a execução
  // não bateu, aqui acusa a diferença (ajuste manualmente as Quantity até casar).
  const netMap = {};   // 'fund||asset' → net a rolar
  for (const r of (b.reconciliation || [])) netMap[`${r.fund}||${r.asset}`] = r.net;
  const sumMap = {};   // 'fund||asset' → Σ qtd efetiva
  b.boletas.forEach((bo, i) => {
    const k = `${bo._fund}||${bo._asset}`;
    sumMap[k] = (sumMap[k] || 0) + _effBoletaQty(i);
  });
  const mism = Object.keys(netMap).map(k => {
    const net = Math.round(netMap[k] || 0), sum = Math.round(sumMap[k] || 0);
    return { k, net, sum, diff: sum - net };
  }).filter(m => m.diff !== 0);
  const matchMsg = mism.length
    ? `<span style="color:var(--red);font-weight:600">⚠ ${mism.length} fundo(s)/ativo com boletas ≠ posição a rolar — ajuste as Quantity</span>`
    : `<span style="color:var(--green);font-weight:600">✓ boletas casam com a posição a rolar</span>`;
  const mismTable = mism.length ? `
    <div style="margin-bottom:8px">
      <table class="data-table" style="font-size:12px;width:auto">
        <thead><tr><th style="text-align:left">Fundo</th><th style="text-align:left">Ativo</th>
          <th class="num">A rolar (net)</th><th class="num">Σ boletas</th><th class="num">Dif.</th></tr></thead>
        <tbody>${mism.map(m => {
          const [fund, asset] = m.k.split('||');
          return `<tr><td>${fund}</td><td>${asset}</td><td class="num">${fmtFinalQty(m.net)}</td>
            <td class="num">${fmtFinalQty(m.sum)}</td><td class="num" style="color:var(--red)">${fmtFinalQty(m.diff)}</td></tr>`;
        }).join('')}</tbody>
      </table>
    </div>` : '';

  // Cobertura das EXECUÇÕES por ativo/lado (informativo; base nas execuções informadas)
  const execRows = (b.exec_reconciliation || []).map(e => {
    const diff = e.short ? `<span style="color:var(--red)">faltam ${fmtQty(e.short)}</span>`
      : (e.leftover ? `<span style="color:#f0c040">sobram ${fmtQty(e.leftover)}</span>`
      : `<span style="color:var(--green)">ok</span>`);
    return `<tr><td>${e.asset}</td><td>${e.side}</td><td class="num">${fmtQty(e.demand)}</td>
        <td class="num">${fmtQty(e.executed)}</td><td>${diff}</td></tr>`;
  }).join('');
  const execTable = execRows ? `
    <div style="margin-bottom:8px">
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:2px">Cobertura das execuções (demanda × executado)</div>
      <table class="data-table" style="font-size:12px;width:auto">
        <thead><tr><th style="text-align:left">Ativo</th><th style="text-align:left">Lado</th>
          <th class="num">Demanda</th><th class="num">Executado</th><th style="text-align:left">Cobertura</th></tr></thead>
        <tbody>${execRows}</tbody>
      </table>
    </div>` : '';

  // Prévia mostra só as colunas relevantes (esconde as sempre-vazias); o export leva todas.
  const viewCols = b.columns.filter(c => !ROLAGEM_EMPTY_COLS.has(c));
  const head = viewCols.map(c => `<th style="text-align:left;white-space:nowrap">${c}</th>`).join('');
  const inSty = 'padding:2px 4px;font-size:11px;background:var(--bg);color:inherit;border:1px solid var(--border);border-radius:3px;width:74px;text-align:right';
  const rows = b.boletas.map((bo, i) => {
    const color = bo._uncovered ? 'color:var(--red)' : (bo._kind === 'real' ? '' : 'color:var(--text-muted)');
    const cells = viewCols.map(c => {
      if (c === 'Quantity') {
        return `<td class="num" style="${color}"><input type="text" inputmode="numeric" value="${_effBoletaQty(i)}"
          onchange="setBoletaQty(${i}, this.value)" style="${inSty}"></td>`;
      }
      const v = bo[c];
      const cls = (c === 'Price' || c === 'Auxiliary number') ? 'num' : '';
      return `<td class="${cls}" style="${color};white-space:nowrap">${v == null ? '' : v}</td>`;
    }).join('');
    return `<tr>${cells}</tr>`;
  }).join('');

  el.innerHTML = `
    ${mismTable}
    ${execTable}
    <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
      <button class="btn btn-secondary" onclick="copyBoletasTSV()" style="padding:5px 14px;font-size:12px">Copiar (TSV)</button>
      <button class="btn btn-secondary" onclick="downloadBoletasCSV()" style="padding:5px 14px;font-size:12px">Baixar CSV</button>
      <span style="font-size:12px;color:var(--text-muted)">${b.boletas.length} boletas — ${nReal} reais · ${nGer} gerenciais &nbsp;·&nbsp; ${matchMsg}</span>
    </div>
    <div style="overflow-x:auto;max-height:420px;overflow-y:auto;border:1px solid var(--border);border-radius:6px">
      <table class="data-table" style="font-size:11px">
        <thead><tr>${head}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// Quantidade efetiva de uma boleta (com ajuste manual, se houver).
function _effBoletaQty(i) {
  return (i in rolagemQtyEdit) ? rolagemQtyEdit[i] : rolagemBoletas.boletas[i].Quantity;
}
function setBoletaQty(i, val) {
  const n = parseInt(val, 10);
  if (Number.isFinite(n)) rolagemQtyEdit[i] = n;
  else delete rolagemQtyEdit[i];
  _renderBoletaPreview();
}

// Linhas do export, só com as colunas JDS na ordem (usa a qtd EFETIVA). includeHeader
// controla o cabeçalho. Colunas sempre-vazias entram como '' (contam no paste).
function _boletasMatrix(includeHeader) {
  const cols = rolagemBoletas.columns;
  const lines = includeHeader ? [cols.slice()] : [];
  rolagemBoletas.boletas.forEach((bo, i) => {
    lines.push(cols.map(c => {
      if (c === 'Quantity') return _effBoletaQty(i);
      return bo[c] == null ? '' : bo[c];
    }));
  });
  return { cols, lines };
}

function copyBoletasTSV() {
  if (!rolagemBoletas || !rolagemBoletas.boletas?.length) return;
  const { lines } = _boletasMatrix(false);   // sem cabeçalho (cola direto na planilha do JDS)
  const tsv = lines.map(row => row.join('\t')).join('\n');
  const status = document.getElementById('refStatus');
  navigator.clipboard.writeText(tsv).then(() => {
    if (status) { status.textContent = 'Boletas copiadas (TSV)'; status.style.color = 'var(--text-muted)'; }
  }).catch(e => {
    if (status) { status.textContent = 'Erro ao copiar: ' + e.message; status.style.color = 'var(--red)'; }
  });
}

function downloadBoletasCSV() {
  if (!rolagemBoletas || !rolagemBoletas.boletas?.length) return;
  const { lines } = _boletasMatrix(true);   // CSV (arquivo) mantém o cabeçalho
  const csv = lines.map(row => row.map(v => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `rolagem_dolar_boletas_${rolagemBoletas.target_month || ''}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

/* ── Consolidado Dólar (por trader) ──────────────────────────────────────── */
const DOLAR_CONSOL_TAB_ID = 'dolarconsol';
const UC_FACE_USD = 50_000;   // face do contrato de dólar cheio (UC)
const DOLAR_CONSOL_TRADERS = ['EMota', 'ECotrim', 'PortfolioRF', 'PAlves', 'AJakurski', 'GBranquinho', 'LAguiar', 'PAbinader'];
const dolarConsolData = {};   // trader → API response (cache próprio, não conflita com posDataByTab)
let dolarConsolTrader = 'ECotrim';
/* nº de contratos equivalentes (1 casa, verde +, vermelho entre parênteses) */
function fmtUc(v) {
  if (v == null || !isFinite(v)) return '<span style="color:var(--text-muted)">—</span>';
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  if (v > 0) return `<span style="color:var(--green)">+${s}</span>`;
  if (v < 0) return `<span style="color:var(--red)">(${s})</span>`;
  return '<span style="color:var(--text-muted)">—</span>';
}

// Classifica a row como instrumento de dólar; null se não é.
function _dollarKind(r) {
  const ref = (r.instrument_reference || '').toUpperCase();
  const isCurncy = ref.endsWith('CURNCY');
  if (isCurncy && ref.startsWith('UC'))  return 'uc';    // dólar cheio (futuro)
  if (isCurncy && ref.startsWith('WDO')) return 'wdo';   // mini dólar (futuro)
  if (r.is_option && r.option_subtype === 'dol') return 'dolopt';
  if (r.is_option && r.option_subtype === 'fx' && (r.option_undl || '').toUpperCase().includes('BRL')) return 'fxopt';
  if (r.is_fx) {
    const nm = (r.instrument_name || '').toUpperCase().replace(/\s/g, '');
    if (nm.includes('USD') && nm.includes('BRL')) return 'fxfwd';
  }
  return null;
}

const _DOLLAR_KIND_LABEL = {
  uc: 'Futuro cheio (UC)', wdo: 'Futuro mini (WDO)',
  dolopt: 'Opção DOL', fxopt: 'Opção USDBRL', fxfwd: 'Spot/Fwd USD/BRL',
};

function showDolarConsolTab() {
  activeTraderTab = DOLAR_CONSOL_TAB_ID;
  for (const tab of TRADER_TABS) {
    const el = document.getElementById(`tab-${tab.id}`);
    if (el) el.style.display = 'none';
    document.getElementById(`tab-btn-${tab.id}`)?.classList.remove('active');
  }
  const dolarEl = document.getElementById('tab-dolar');
  if (dolarEl) dolarEl.style.display = 'none';
  document.getElementById('tab-btn-dolar')?.classList.remove('active');
  const consolEl = document.getElementById('tab-dolarconsol');
  if (consolEl) consolEl.style.display = '';
  document.getElementById('tab-btn-dolarconsol')?.classList.add('active');
  _hideRolagemTab();

  // popula o seletor de trader uma vez
  const sel = document.getElementById('dolarConsolTraderSelect');
  if (sel && !sel.options.length) {
    sel.innerHTML = DOLAR_CONSOL_TRADERS.map(t => `<option value="${t}">${t}</option>`).join('');
    sel.value = dolarConsolTrader;
  }
  if (dolarConsolData[dolarConsolTrader]) { _dirtyTabs.delete(DOLAR_CONSOL_TAB_ID); renderDolarConsol(dolarConsolTrader); }
  else loadDolarConsol(dolarConsolTrader);
}

function selectDolarConsolTrader(trader) {
  dolarConsolTrader = trader;
  if (dolarConsolData[trader]) renderDolarConsol(trader);
  else loadDolarConsol(trader);
}

async function loadDolarConsol(trader, opts = {}) {
  const { fresh = false } = opts;
  const refDate   = document.getElementById('refDate').value;
  const status    = document.getElementById('refStatus');
  const btn       = document.getElementById('btnLoad');
  const container = document.getElementById('dolarConsolContainer');
  status.textContent = 'Buscando dados...';
  status.style.color = 'var(--text-muted)';
  btn.disabled = true;
  container.innerHTML = '<div class="card"><span class="loading">Carregando...</span></div>';
  try {
    const params = new URLSearchParams({ trader });
    if (refDate) params.set('ref_date', refDate);
    const forceOpening = document.getElementById('forceOpening').value;
    if (forceOpening) params.set('force_opening', forceOpening);
    if (fresh) params.set('fresh', 'true');
    // Só EMota/ECotrim usam grupos MM/MM Prev; demais traders trazem tudo ('Todos').
    if (trader !== 'EMota' && trader !== 'ECotrim') params.set('use_groups', 'false');
    const data = await (await fetch(`${API_BASE}/api/positions/reference?${params}`)).json();
    if (data.error) {
      status.textContent = 'Erro: ' + data.error;
      status.style.color = 'var(--red)';
      container.innerHTML = `<div class="card no-data">${data.error}</div>`;
      return;
    }
    dolarConsolData[trader] = data;
    status.textContent = '';
    document.getElementById('srcLabel').textContent =
      `Abertura: ${fmtDate(data.opening_date)}  |  Boletas: ${fmtDate(data.ref_date)}`;
    // carrega o mapa de tickers cadastrados (compartilhado com a aba Check Dólar Exposure)
    try { dolarOptTickers = await (await fetch(`${API_BASE}/api/positions/dolar-opt-tickers`)).json() || {}; }
    catch { /* mantém o que tiver */ }
    if (dolarConsolTrader === trader) {
      // delta/preço live já vêm do backend (option_delta/price_live, inclusive DOL via ticker)
      renderDolarConsol(trader);
    }
  } catch (e) {
    status.textContent = 'Erro ao conectar: ' + e.message;
    status.style.color = 'var(--red)';
  } finally {
    btn.disabled = false;
  }
}

function renderDolarConsol(trader) {
  const container = document.getElementById('dolarConsolContainer');
  if (!container) return;
  const data = dolarConsolData[trader];
  const navTrader = data?.traders?.[trader];

  // MM apenas; exclui Hedge_Cambial (igual ao filtro padrão da aba de posições); só dólar
  const rows = (data?.rows ?? [])
    .filter(r => r.group !== 'MM Prev' && r.subarea !== 'Hedge_Cambial')
    .map(r => ({ r, kind: _dollarKind(r) }))
    .filter(x => x.kind);

  if (!rows.length) {
    container.innerHTML = `<div class="card no-data">Nenhuma posição de dólar (UC/WDO, opção DOL/USDBRL, USD/BRL) para ${trader} no book MM.</div>`;
    return;
  }

  // métrica por linha (respeita delta manual e delta/preço live via ticker BBG p/ DOL)
  const metric = ({ r, kind }) => {
    const ref   = r.instrument_reference || '';
    const nav   = r.nav ?? navTrader;
    const isOpt = !!r.is_option;
    // delta efetivo: override manual → live BBG (ticker) → backend.
    // Normaliza pelo TIPO (CALL = +|δ|, PUT = −|δ|): o sinal cru da BBG reflete a
    // direção da posição cadastrada, e a direção já vem da qtd → evita inverter 2×.
    const ik = instKey(r);
    // delta: marreta → backend (live p/ DOL via ticker) → normalizado CALL/PUT (helper único)
    const delta = isOpt ? effectiveDelta(r) : 1;
    // preço efetivo (mesma fonte única das outras abas); sempre positivo.
    let price = effectivePrice(r);
    if (price != null) price = Math.abs(price);
    // exposição NOMINAL em USD (delta-independente)
    let nominalUsd;
    if (kind === 'dolopt')     nominalUsd = (r.final_qty != null) ? r.final_qty * UC_FACE_USD : null;          // face US$50k/contrato
    else if (kind === 'fxopt') nominalUsd = (r.option_nominal_exp != null && nav) ? r.option_nominal_exp * nav : null;
    else                       nominalUsd = (r.pl != null && nav) ? r.pl * nav : null;                          // futuros/FX (delta=1)
    const expUsd = isOpt ? (nominalUsd != null && delta != null ? nominalUsd * delta : null) : nominalUsd;
    const expPct = (expUsd != null && nav) ? expUsd / nav : null;
    // UC-equivalente: futuros por contagem de contrato (razão fixa); opção DOL = qtd×delta;
    // USDBRL/spot = nocional ÷ face.
    let ucEq;
    if (kind === 'uc')          ucEq = r.final_qty != null ? r.final_qty : null;          // dólar cheio 1:1
    else if (kind === 'wdo')    ucEq = r.final_qty != null ? r.final_qty / 5 : null;      // mini ÷ 5
    else if (kind === 'dolopt') ucEq = (r.final_qty != null && delta != null) ? r.final_qty * delta : null;
    else                        ucEq = expUsd != null ? expUsd / UC_FACE_USD : null;       // fxopt, fxfwd
    const premium = (isOpt && r.final_qty != null && price != null && r.calc_factor != null)
                    ? r.final_qty * price * r.calc_factor : null;
    return { ref, ik, nav, isOpt, kind, delta, price, expUsd, expPct, ucEq, premium };
  };

  const optRows = rows.filter(x => x.kind === 'dolopt' || x.kind === 'fxopt');
  const futRows = rows.filter(x => x.kind === 'uc' || x.kind === 'wdo' || x.kind === 'fxfwd');

  // cabeçalho em UMA linha (azul escuro); % NAV + UC-equiv delimitados pelas bordas do bloco
  const head = `<thead><tr>
    <th class="col-final">Instrumento</th>
    <th>Tipo</th>
    <th>Vencto</th>
    <th class="col-right num">Qtd Final</th>
    <th class="num">Delta</th>
    <th>Ticker BBG (DOL)</th>
    <th class="num">Preço Live</th>
    <th class="col-pnl num">Prêmio USD</th>
    <th class="num">% NAV</th>
    <th class="num">UC-equiv</th>
  </tr></thead>`;

  let gPrem = 0, gUsd = 0, gPct = 0, gUc = 0;

  const deltaCell = (m) => {
    if (!m.isOpt) return `<td class="num" style="color:var(--text-muted)">1.00</td>`;
    const ek = m.ik.replace(/'/g, "\\'");
    const hasOv = deltaOverrides.has(m.ik);
    const bord = hasOv ? 'var(--green)' : 'var(--border)';
    const val = m.delta != null ? Number(m.delta.toFixed(4)) : '';
    return `<td class="num"><input type="number" step="0.01" value="${val}"
      style="width:64px;text-align:right;background:var(--bg);color:var(--text);border:1px solid ${bord};border-radius:4px;padding:2px 4px"
      onchange="consolSetDelta('${ek}', this.value)"></td>`;
  };
  const tickerCell = (r, kind) => {
    if (kind !== 'dolopt') return `<td style="color:var(--text-muted)">—</td>`;
    const ek = (r.instrument_reference || '').replace(/'/g, "\\'");
    const tk = (dolarOptTickers[r.instrument_reference] || '').replace(/"/g, '&quot;');
    return `<td><input type="text" value="${tk}" placeholder="ticker BBG"
      style="width:150px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:2px 6px"
      onchange="consolSetTicker('${ek}', this.value)"></td>`;
  };

  const renderBlock = (title, blockRows) => {
    if (!blockRows.length) return '';
    let sUsd = 0, sPct = 0, sUc = 0, sPrem = 0;
    const trs = sortRows(blockRows.map(x => x.r)).map(r => {
      const x = blockRows.find(b => b.r === r);
      const m = metric(x);
      if (m.expUsd != null) { sUsd += m.expUsd; gUsd += m.expUsd; }
      if (m.expPct != null) { sPct += m.expPct; gPct += m.expPct; }
      if (m.ucEq   != null) { sUc  += m.ucEq;   gUc  += m.ucEq; }
      if (m.premium!= null) { sPrem+= m.premium; gPrem+= m.premium; }
      const priceFmt = (m.kind === 'fxopt') ? fmtPricePct(m.price) : fmtPrice(m.price);
      return `<tr>
        <td class="col-final">${r.instrument_name ?? '—'}</td>
        <td style="color:var(--text-muted);font-size:11px">${_DOLLAR_KIND_LABEL[x.kind]}</td>
        <td>${fmtDate(r.maturity)}</td>
        <td class="col-right num">${fmtFinalQty(r.final_qty)}</td>
        ${deltaCell(m)}
        ${tickerCell(r, x.kind)}
        <td class="num">${priceFmt}</td>
        <td class="col-pnl num">${fmtMoney(m.premium)}</td>
        <td class="num">${fmtPL(m.expPct, 'pct')}</td>
        <td class="num dc-uc">${fmtUc(m.ucEq)}</td>
      </tr>`;
    }).join('');
    const sub = `<tr class="dc-sub">
      <td colspan="7">Subtotal · ${title}</td>
      <td class="col-pnl num">${fmtMoney(sPrem)}</td>
      <td class="num">${fmtPL(sPct, 'pct')}</td>
      <td class="num dc-uc">${fmtUc(sUc)}</td>
    </tr>`;
    const header = `<tr class="dc-block"><td colspan="10">${title}</td></tr>`;
    return header + trs + sub;
  };

  // linha espaçadora transparente (respiro entre blocos e antes do total, sem desenhar linha)
  const spacer = `<tr><td colspan="10" style="height:14px;padding:0;border:none;background:transparent"></td></tr>`;
  const body = [
    renderBlock('Opções (DOL / USDBRL)', optRows),
    renderBlock('Futuros e Spot (UC / WDO / USD/BRL)', futRows),
  ].filter(Boolean).join(spacer);

  const grand = `<tr class="dc-total">
    <td colspan="7">TOTAL DÓLAR — ${trader}</td>
    <td class="col-pnl num">${fmtMoney(gPrem)}</td>
    <td class="num">${fmtPL(gPct, 'pct')}</td>
    <td class="num dc-uc">${fmtUc(gUc)}</td>
  </tr>`;

  const navStr = navTrader ? `NAV: USD ${navTrader.toLocaleString('en-US',{maximumFractionDigits:0})}` : '';
  const netLabel = gUc >= 0 ? 'comprado' : 'vendido';
  const netColor = gUc >= 0 ? 'var(--green)' : 'var(--red)';
  container.innerHTML = `<div class="card">
    <div class="section-title" style="padding:8px 0 10px 0;display:flex;align-items:center;gap:16px;flex-wrap:wrap">
      <span>Consolidado Dólar <span style="font-weight:400;color:var(--text-muted);font-size:13px">— ${trader} (MM)</span></span>
      ${navStr ? `<span style="font-weight:400;color:var(--text-muted);font-size:12px">${navStr}</span>` : ''}
      <button class="btn btn-secondary" data-html2canvas-ignore="true" style="padding:3px 12px;font-size:12px;margin-left:auto" onclick="copyCardImage(this)">⎘ Copiar</button>
    </div>
    <div style="font-size:14px;margin-bottom:10px;padding:8px 12px;background:var(--bg-row-alt);border-left:3px solid var(--border);border-radius:4px">
      Posição líquida em dólar: <b style="color:${netColor};font-size:16px">${fmtUc(gUc)}</b> contratos equiv. de dólar cheio (UC) — <b>${netLabel}</b>
      <span style="color:var(--text-muted);font-size:11px">(face US$ ${UC_FACE_USD.toLocaleString('en-US')} · exposição ${fmtMoney(gUsd)})</span>
    </div>
    <div class="section-copy-target">
      <table class="data-table dc-table" style="white-space:nowrap;width:auto">
        ${head}
        <tbody>${body}${spacer}${grand}</tbody>
      </table>
    </div>
  </div>`;

  renderOptionsAnalysis();   // segunda tabela (todas as opções MM) logo abaixo, mesmos dados
}

/* edição manual de delta (marreta global por instrumento) */
function consolSetDelta(ik, value) {
  const v = parseFloat(value);
  if (value === '' || isNaN(v)) deltaOverrides.delete(ik);
  else deltaOverrides.set(ik, v);
  _markTabsDirtyAndRerender();
}

/* salva o ticker BBG da opção de DOL (cache compartilhado); não re-renderiza p/ não perder o foco */
async function consolSetTicker(ref, ticker) {
  ticker = (ticker || '').trim();
  if (ticker) dolarOptTickers[ref] = ticker;
  else delete dolarOptTickers[ref];
  const status = document.getElementById('refStatus');
  try {
    await fetch(`${API_BASE}/api/positions/dolar-opt-tickers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [ref]: ticker }),
    });
    if (status) { status.textContent = 'Ticker salvo'; status.style.color = 'var(--text-muted)'; }
  } catch (e) {
    if (status) { status.textContent = 'Erro ao salvar ticker: ' + e.message; status.style.color = 'var(--red)'; }
  }
}

async function loadDolarExposure() {
  const refDate   = document.getElementById('refDate').value;
  const status    = document.getElementById('refStatus');
  const srcLabel  = document.getElementById('srcLabel');
  const btn       = document.getElementById('btnLoad');
  const container = document.getElementById('dolarContainer');

  status.textContent = 'Buscando dados...';
  status.style.color = 'var(--text-muted)';
  btn.disabled = true;
  container.innerHTML = '<div class="card"><span class="loading">Carregando...</span></div>';

  try {
    const params = new URLSearchParams();
    if (refDate) params.set('ref_date', refDate);
    const forceOpening = document.getElementById('forceOpening').value;
    if (forceOpening) params.set('force_opening', forceOpening);
    const data = await (await fetch(`${API_BASE}/api/positions/dolar-exposure?${params}`)).json();

    if (data.error) {
      status.textContent = 'Erro: ' + data.error;
      status.style.color = 'var(--red)';
      container.innerHTML = `<div class="card no-data">${data.error}</div>`;
      return;
    }

    posDataByTab[DOLAR_TAB_ID] = data;
    status.textContent = '';
    srcLabel.textContent =
      `Abertura: ${fmtDate(data.opening_date)}  |  Boletas: ${fmtDate(data.ref_date)}`;
    try { dolarOptTickers = await (await fetch(`${API_BASE}/api/positions/dolar-opt-tickers`)).json() || {}; }
    catch { dolarOptTickers = {}; }
    // delta live das opções de DOL já vem do backend (option via ticker cadastrado)
    renderDolarTable(data);
  } catch (e) {
    status.textContent = 'Erro ao conectar: ' + e.message;
    status.style.color = 'var(--red)';
  } finally {
    btn.disabled = false;
  }
}

function renderDolarTable(data) {
  const container = document.getElementById('dolarContainer');
  if (!container) return;

  const navDateStr = data.nav_date ? fmtDate(data.nav_date) : '—';
  const usdbrlStr  = data.usdbrl != null
    ? data.usdbrl.toLocaleString('pt-BR', { minimumFractionDigits: 4, maximumFractionDigits: 4 }) : '—';
  const navMismatch = data.nav_date && data.opening_date && data.nav_date !== data.opening_date;
  const navInfo = `<span style="font-weight:400;color:${navMismatch ? '#f0c040' : 'var(--text-muted)'};font-size:12px">
    ${navMismatch ? '⚠ ' : ''}NAV: ${navDateStr} &nbsp;·&nbsp; USDBRL (interno): ${usdbrlStr}</span>`;

  // Valor BRL de 1 contrato (mini=10, cheio=50) × preço do dólar (UCA PX_LAST)
  const miniVal = data.uca_px ? 10 * data.uca_px : null;
  const fullVal = data.uca_px ? 50 * data.uca_px : null;

  // ── Tabela única: 1 linha por fundo ──────────────────────────────────────
  // *.e = exposição BRL; *.q = qtd de contratos (para tooltip)
  const gz = () => ({ eo:0, et:0, ef:0, qo:0, qt:0, qf:0 });
  const grandTotal = { mini: gz(), cheio: gz(), option: gz(), fimie: 0, to:0, tt:0, tf:0, nav:0 };

  // NET (default): operações somam com sinal e netam contra o FIM IE.
  // GROSS (Sulamerica): |operações líquidas| + |FIM IE| — nunca netam.
  const _effExp = (opsNet, fimie, isSula) =>
    isSula ? Math.abs(opsNet) + Math.abs(fimie || 0) : opsNet + (fimie || 0);

  const bodyRows = data.funds.map(fund => {
    const nav = fund.nav;
    const isSula = /sulamerica/i.test(fund.fund_label);
    const sums = {};
    for (const c of _DOLAR_CATS) sums[c.key] = gz();
    for (const inst of fund.instruments) {
      const e = _dolarInstExp(inst);
      const s = sums[inst.category]; if (!s) continue;
      s.eo += e.opening || 0; s.et += e.trade || 0; s.ef += e.final || 0;
      s.qo += inst.opening_qty || 0; s.qt += inst.traded_qty || 0; s.qf += inst.final_qty || 0;
    }
    const fimie = fund.fim_ie_exp;

    // operações líquidas (mini+cheio+opções), com sinal
    const opsO = sums.mini.eo + sums.cheio.eo + sums.option.eo;
    const opsT = sums.mini.et + sums.cheio.et + sums.option.et;
    const opsF = sums.mini.ef + sums.cheio.ef + sums.option.ef;
    // FIM IE é posição estática: entra na abertura e na final, não nos trades
    const totO = _effExp(opsO, fimie, isSula);
    const totT = isSula ? Math.abs(opsT) : opsT;
    const totF = _effExp(opsF, fimie, isSula);

    for (const k of ['mini','cheio','option']) {
      grandTotal[k].eo += sums[k].eo; grandTotal[k].et += sums[k].et; grandTotal[k].ef += sums[k].ef;
      grandTotal[k].qo += sums[k].qo; grandTotal[k].qt += sums[k].qt; grandTotal[k].qf += sums[k].qf;
    }
    grandTotal.fimie += fimie || 0;
    grandTotal.to += totO; grandTotal.tt += totT; grandTotal.tf += totF;
    grandTotal.nav += nav || 0;

    const navStr = nav != null
      ? `BRL ${nav.toLocaleString('pt-BR', { maximumFractionDigits: 0 })}`
      : '<span style="color:var(--red)">—</span>';
    const regimeTag = `<span style="font-size:10px;color:var(--text-muted)">${isSula ? 'GROSS' : 'NET'}</span>`;

    const fimieCell = `<td class="num" style="border-left:1px solid var(--border)" title="Rateio proporcional do FIM IE">${_fmtBrl(fimie)}<br><span style="font-size:11px;color:var(--text-muted)">${(fimie != null && nav) ? fmtPct(fimie / nav) : '—'}</span></td>`;

    return `<tr>
      <td>${fund.fund_label} ${regimeTag}</td>
      <td class="num">${navStr}</td>
      ${_expCell(sums.mini.eo, nav, sums.mini.qo, true)}${_expCell(sums.mini.et, nav, sums.mini.qt)}${_expCell(sums.mini.ef, nav, sums.mini.qf)}
      ${_expCell(sums.cheio.eo, nav, sums.cheio.qo, true)}${_expCell(sums.cheio.et, nav, sums.cheio.qt)}${_expCell(sums.cheio.ef, nav, sums.cheio.qf)}
      ${_expCell(sums.option.eo, nav, sums.option.qo, true)}${_expCell(sums.option.et, nav, sums.option.qt)}${_expCell(sums.option.ef, nav, sums.option.qf)}
      ${fimieCell}
      ${_expCell(totO, nav, null, true)}${_expCell(totT, nav, null)}${_totalFinalCell(totF, nav ? totF / nav : null)}
      ${_reframeCell(totF, opsF, nav, isSula, miniVal, fullVal)}
    </tr>`;
  }).join('');

  const gnav = grandTotal.nav || null;
  const totalRow = `<tr class="area-divider" style="font-weight:600">
    <td>Total (BRL)</td>
    <td class="num">${gnav ? 'BRL ' + gnav.toLocaleString('pt-BR', { maximumFractionDigits: 0 }) : '—'}</td>
    ${_expCell(grandTotal.mini.eo, gnav, grandTotal.mini.qo, true)}${_expCell(grandTotal.mini.et, gnav, grandTotal.mini.qt)}${_expCell(grandTotal.mini.ef, gnav, grandTotal.mini.qf)}
    ${_expCell(grandTotal.cheio.eo, gnav, grandTotal.cheio.qo, true)}${_expCell(grandTotal.cheio.et, gnav, grandTotal.cheio.qt)}${_expCell(grandTotal.cheio.ef, gnav, grandTotal.cheio.qf)}
    ${_expCell(grandTotal.option.eo, gnav, grandTotal.option.qo, true)}${_expCell(grandTotal.option.et, gnav, grandTotal.option.qt)}${_expCell(grandTotal.option.ef, gnav, grandTotal.option.qf)}
    ${_expCell(grandTotal.fimie, gnav, null, true)}
    ${_expCell(grandTotal.to, gnav, null, true)}${_expCell(grandTotal.tt, gnav, null)}<td class="num" style="border-left:2px solid var(--border);border-right:2px solid var(--border)">${_brlPlain(grandTotal.tf)}<br><span style="font-size:12px">${gnav ? fmtPct(grandTotal.tf / gnav) : '—'}</span></td>
    <td class="num" style="${_SEP_TD};color:var(--text-muted)">—</td>
  </tr>`;

  const grp = lbl => `<th colspan="3" class="num" style="border-left:1px solid var(--border);text-align:center">${lbl}</th>`;
  const sub = lb => `<th class="num"${lb ? ' style="border-left:1px solid var(--border)"' : ''}>Abert.</th><th class="num">Trades</th><th class="num">Final</th>`;
  const subTotal = `<th class="num" style="border-left:2px solid var(--border)">Abert.</th><th class="num">Trades</th><th class="num" style="border-left:2px solid var(--border);border-right:2px solid var(--border)">Final</th>`;

  const legend = `<div style="margin-top:8px;font-size:11px;color:var(--text-muted)">
    Limite 20%. <b>NET</b> (geral): operações de dólar netam contra o FIM IE. <b>GROSS</b> (Sulamerica): |operações| + |FIM IE|.
    &nbsp;Cor: <span style="color:var(--green)">&lt;15%</span> ·
    <span style="color:#f0c040">15–17%</span> ·
    <span style="color:#e8853a">17–19%</span> ·
    <span style="color:#fff;background:var(--red);padding:0 4px">19–20%</span> ·
    <span style="color:#fff;background:#8a0d0d;padding:0 4px">&gt;20%</span></div>`;

  const mainTable = `
    <div class="card">
      <div class="section-title" style="padding:8px 0 10px 0;display:flex;align-items:baseline;gap:16px">
        <span>Exposição por fundo (BRL)</span>${navInfo}
      </div>
      <table class="data-table" style="white-space:nowrap;width:auto">
        <thead>
          <tr>
            <th rowspan="2">Fundo</th>
            <th rowspan="2" class="num">NAV</th>
            ${grp('Mini Dólar (WDO)')}${grp('Dólar Cheio (UC)')}${grp('Opções DOL')}
            <th rowspan="2" class="num" style="border-left:1px solid var(--border)">FIM IE</th>
            <th colspan="3" class="num" style="border-left:2px solid var(--border);border-right:2px solid var(--border);text-align:center">Total vs NAV — limite 20%</th>
            <th rowspan="2" class="num" style="${_SEP_TD};text-align:center">Reenquadramento<br><span style="font-weight:400;font-size:10px">(contratos p/ o limite)</span></th>
          </tr>
          <tr>${sub(true)}${sub(true)}${sub(true)}${subTotal}</tr>
        </thead>
        <tbody>${bodyRows}${totalRow}</tbody>
      </table>
      ${legend}
    </div>`;

  // ── Resumo de opções de DOL: delta editável (global, afeta todos os fundos) ─
  const optMap = new Map();   // key → { name, key, delta, px_last, mult, o, t, f }
  for (const fund of data.funds) {
    for (const inst of fund.instruments) {
      if (inst.category !== 'option') continue;
      const key = _dolarOptKey(inst);
      let agg = optMap.get(key);
      if (!agg) {
        agg = { name: inst.instrument_name || inst.instrument_reference, key,
                instrument_reference: inst.instrument_reference, instrument_name: inst.instrument_name,
                maturity: inst.maturity,
                delta: inst.delta, px_last: inst.px_last, mult: inst.mult, o:0, t:0, f:0, donos:{} };
        optMap.set(key, agg);
      }
      agg.o += inst.opening_qty || 0; agg.t += inst.traded_qty || 0; agg.f += inst.final_qty || 0;
      for (const td of inst.traders || []) {   // soma o final por trader entre os fundos
        agg.donos[td.trader] = (agg.donos[td.trader] || 0) + (td.final_qty || 0);
      }
    }
  }

  let optSumO = 0, optSumT = 0, optSumF = 0, optSumExp = 0, optAnyExp = false;
  const optRows = [...optMap.values()].map(a => {
    const ik  = instKey(a);
    const dl  = _effOptDelta(ik, a.delta, a.name);   // delta usado (normalizado por tipo)
    const ok  = dl != null && a.px_last != null;
    const exp = ok ? a.f * dl * a.mult * a.px_last : null;
    const ov  = deltaOverrides.has(ik);
    const sign = _optTypeSign(a.name);
    const defNorm = a.delta != null ? (sign != null ? sign * Math.abs(a.delta) : a.delta) : null;
    const kind = sign === 1 ? 'CALL' : sign === -1 ? 'PUT' : '';
    optSumO += a.o; optSumT += a.t; optSumF += a.f;
    if (exp != null) { optSumExp += exp; optAnyExp = true; }
    const ek  = a.key.replace(/'/g, "\\'");          // chave do ticker (instrument_reference)
    const ekd = ik.replace(/'/g, "\\'");             // chave da marreta de delta (instKey)
    const tk  = dolarOptTickers[a.key] || '';
    return `<tr>
      <td>${a.name} ${kind ? `<span style="font-size:10px;color:var(--text-muted)">${kind}</span>` : ''}</td>
      <td class="num">${fmtFinalQty(a.o)}</td>
      <td class="num">${fmtTradedQty(a.t)}</td>
      <td class="num">${fmtFinalQty(a.f)}</td>
      <td style="font-size:11px;color:var(--text-muted)">${_dolarDonos(a.donos) || '—'}</td>
      <td><input type="text" value="${tk.replace(/"/g, '&quot;')}" placeholder="ticker BBG"
        style="width:140px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:2px 6px"
        onchange="dolarSetTicker('${ek}', this.value)"></td>
      <td class="num">${defNorm != null ? defNorm.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}) : '—'}</td>
      <td class="num"><input type="number" step="0.01" value="${dl != null ? Number(dl.toFixed(4)) : ''}"
        style="width:64px;text-align:right;background:var(--bg);color:var(--text);border:1px solid ${ov ? 'var(--green)' : 'var(--border)'};border-radius:4px;padding:2px 4px"
        onchange="dolarSetDelta('${ekd}', this.value)"></td>
      <td class="num">${_fmtBrl(exp)}</td>
    </tr>`;
  }).join('');

  const optTotalRow = `<tr class="area-divider" style="font-weight:600">
    <td>Total</td>
    <td class="num">${fmtFinalQty(optSumO)}</td>
    <td class="num">${fmtTradedQty(optSumT)}</td>
    <td class="num">${fmtFinalQty(optSumF)}</td>
    <td></td><td></td><td class="num">—</td><td class="num">—</td>
    <td class="num">${optAnyExp ? _fmtBrl(optSumExp) : '<span style="color:var(--text-muted)">—</span>'}</td>
  </tr>`;

  const optTable = optMap.size ? `
    <div class="card">
      <div class="section-title" style="padding:8px 0 10px 0">
        <span>Opções de DOL — delta (altera todos os fundos)</span>
      </div>
      <table class="data-table" style="white-space:nowrap;width:auto">
        <thead><tr>
          <th>Opção</th><th class="num">Abertura</th><th class="num">Trades</th><th class="num">Final</th>
          <th>Donos</th><th>Ticker BBG</th><th class="num">Delta default</th><th class="num">Delta usado</th><th class="num">Exp. final (BRL)</th>
        </tr></thead>
        <tbody>${optRows}${optTotalRow}</tbody>
      </table>
    </div>` : '';

  container.innerHTML = mainTable + optTable + _renderFimIeTable(data);
}

// Gradação de cor para o limite de 100% do FIM IE.
function _fimLimitStyle(pct) {
  if (pct == null) return 'color:var(--text-muted)';
  const a = Math.abs(pct);
  if (a < 0.75) return 'color:var(--green)';
  if (a < 0.90) return 'color:#f0c040';
  if (a < 1.00) return 'color:#e8853a';
  if (a <= 1.01) return 'color:#fff;background:var(--red);font-weight:700';
  return 'color:#fff;background:#8a0d0d;font-weight:700';
}

const _CAT_LABEL = { mini: 'Mini (WDO)', cheio: 'Cheio (UC)', option: 'Opção DOL' };

// Coluna "Donos": final por trader (não-zero), maior |qtd| primeiro. Aceita lista
// [{trader, final_qty}] (FIM IE) ou objeto {trader: final} (agregado de opções).
function _dolarDonos(traders) {
  if (!traders) return '';
  const arr = Array.isArray(traders)
    ? traders.map(t => [t.trader, t.final_qty])
    : Object.entries(traders);
  return arr.filter(([, q]) => Math.round(q) !== 0)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .map(([t, q]) => `${t} ${fmtFinalQty(q)}`)
    .join('  /  ');
}

// Check do veículo JGP FIM IE-A: posição de dólar por área-subárea-estratégia (limite 100% do NAV).
function _renderFimIeTable(data) {
  const positions = data.fim_ie_positions || [];
  const nav = data.fim_ie_nav;
  if (!positions.length && nav == null) return '';

  // consolida por subárea (ordena por subárea → instrumento)
  const rows = [...positions].sort((a, b) =>
    (a.subarea || '').localeCompare(b.subarea || '') ||
    (a.instrument_name || '').localeCompare(b.instrument_name || ''));

  let totExp = 0, anyExp = false;
  let lastGrp = null;
  let bodyHtml = '';
  let grpExp = 0;

  const flushGroup = () => {
    if (lastGrp !== null) {
      bodyHtml += `<tr style="font-weight:600;background:rgba(128,128,128,0.06)">
        <td colspan="7" style="text-align:right">Subtotal ${lastGrp}</td>
        <td class="num">${_fmtBrl(grpExp)}</td>
        <td class="num">${nav ? fmtPct(grpExp / nav) : '—'}</td>
      </tr>`;
    }
  };

  for (const p of rows) {
    const grp = p.subarea || '(sem subárea)';
    if (grp !== lastGrp) { flushGroup(); lastGrp = grp; grpExp = 0;
      bodyHtml += `<tr class="area-divider"><td colspan="9" style="font-weight:600;color:var(--text-muted)">${grp}</td></tr>`;
    }
    const e = _dolarInstExp(p);                 // mesma conta dos fundos (delta normalizado p/ opções)
    const ef = e.final;
    if (ef != null) { totExp += ef; anyExp = true; grpExp += ef; }
    const dlStr = p.category === 'option'
      ? (e.delta != null ? e.delta.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}) : '—') : '';
    bodyHtml += `<tr>
      <td style="padding-left:18px">${p.instrument_name || p.instrument_reference}</td>
      <td>${_CAT_LABEL[p.category] || p.category}</td>
      <td class="num" title="${Math.round(p.opening_qty).toLocaleString('pt-BR')} contratos">${fmtFinalQty(p.opening_qty)}</td>
      <td class="num">${fmtTradedQty(p.traded_qty)}</td>
      <td class="num" style="font-weight:600" title="${Math.round(p.final_qty).toLocaleString('pt-BR')} contratos">${fmtFinalQty(p.final_qty)}</td>
      <td style="font-size:11px;color:var(--text-muted)">${_dolarDonos(p.traders) || '—'}</td>
      <td class="num">${dlStr}</td>
      <td class="num">${_fmtBrl(ef)}</td>
      <td class="num">${nav ? fmtPct(ef / nav) : '—'}</td>
    </tr>`;
  }
  flushGroup();

  const pctTot = nav ? totExp / nav : null;
  const navStr = nav != null ? `BRL ${nav.toLocaleString('pt-BR', { maximumFractionDigits: 0 })}` : '—';
  const totalRow = `<tr class="area-divider" style="font-weight:700">
    <td colspan="7" style="text-align:right">TOTAL dólar vs NAV (limite 100%)</td>
    <td class="num">${anyExp ? _fmtBrl(totExp) : '—'}</td>
    <td class="num" style="${_fimLimitStyle(pctTot)};font-size:14px">${pctTot != null ? fmtPct(pctTot) + (Math.abs(pctTot) >= 0.95 ? ' ⚠' : '') : '—'}</td>
  </tr>`;

  const emptyMsg = positions.length ? '' :
    `<tr><td colspan="9" class="no-data" style="color:var(--text-muted)">Sem posição de dólar no FIM IE</td></tr>`;

  return `
    <div class="card">
      <div class="section-title" style="padding:8px 0 10px 0;display:flex;align-items:baseline;gap:16px">
        <span>Check JGP FIM IE — dólar por estratégia</span>
        <span style="font-weight:400;color:var(--text-muted);font-size:12px">NAV: ${navStr} · limite 100%</span>
      </div>
      <table class="data-table" style="white-space:nowrap;width:auto">
        <thead><tr>
          <th>Estratégia / Instrumento</th><th>Tipo</th>
          <th class="num">Abert. (qtd)</th><th class="num">Trades (qtd)</th><th class="num">Final (qtd)</th>
          <th>Donos</th><th class="num">Delta</th><th class="num">Exp. (BRL)</th><th class="num">% NAV</th>
        </tr></thead>
        <tbody>${bodyHtml}${emptyMsg}${totalRow}</tbody>
      </table>
    </div>`;
}

function dolarSetDelta(ik, value) {
  const v = parseFloat(value);
  if (value === '' || isNaN(v)) deltaOverrides.delete(ik);
  else deltaOverrides.set(ik, v);
  _markTabsDirtyAndRerender();
}

// Salva/atualiza o ticker BBG da opção no cache do backend (não re-renderiza p/ não perder o foco).
async function dolarSetTicker(optKey, ticker) {
  ticker = (ticker || '').trim();
  if (ticker) dolarOptTickers[optKey] = ticker;
  else delete dolarOptTickers[optKey];
  const status = document.getElementById('refStatus');
  try {
    await fetch(`${API_BASE}/api/positions/dolar-opt-tickers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [optKey]: ticker }),
    });
    if (status) { status.textContent = 'Ticker salvo'; status.style.color = 'var(--text-muted)'; }
  } catch (e) {
    if (status) { status.textContent = 'Erro ao salvar ticker: ' + e.message; status.style.color = 'var(--red)'; }
  }
}

/* ── Init ────────────────────────────────────────────────────────────────── */
const _today = new Date();
document.getElementById('refDate').value = lastBusinessDay(
  new Date(_today.getFullYear(), _today.getMonth(), _today.getDate())
);
renderFilterBars();
showTraderTab('emota');
