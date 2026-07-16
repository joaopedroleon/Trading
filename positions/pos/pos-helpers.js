function rowKey(r) {
  return [r.group, r.trader, r.instrument_reference, r.area, r.subarea, r.strategy, r.maturity].join('||');
}

/* ── Fonte única de preço/delta efetivos (por instrumento) ───────────────── */
// Identidade do instrumento p/ marreta — independe de trader/aba (mesmo ticker → mesma marreta).
// Referências "família" (FX forwards p/ value date; SWAPs por tenor) repetem a MESMA ref em
// vencimentos diferentes → o maturity faz parte da identidade. Já um ticker único (ex.: futuro
// "ODF31 Comdty") identifica sozinho — e o JRS às vezes traz maturity inconsistente para ele
// (null p/ um trader, data p/ outro); incluir maturity aí quebraria a marreta compartilhada.
function instKey(r) {
  const ref = r.instrument_reference;
  if (!ref) return (r.instrument_name || '') + '||' + (r.maturity || '');
  const isFamily = r.is_fx || ref.startsWith('SWAP') || ref.includes('/');
  return isFamily ? ref + '||' + (r.maturity || '') : ref;
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
  // O PnL da aba usa os mesmos filtros da Posição → re-renderiza junto p/ não dessincronizar.
  if (typeof rerenderPnlValues === 'function') rerenderPnlValues();
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

// Banner GLOBAL de procedência da BBG: o Terminal fora faz o backend servir preços/
// exposição do último fetch bom (cache) — a POSIÇÃO e as DATAS seguem frescas (Oracle),
// mas os NÚMEROS DE MERCADO não são ao vivo. Deve ficar MUITO claro na tela principal.
// O estado é GLOBAL (o Terminal está fora p/ a página toda): guarda-se a última procedência
// vista em qualquer /reference e o banner lê dela, valendo em todas as abas (inclusive as de
// dólar, que usam outro endpoint). `bbg_source` ('live'|'cache') vem do /reference; ausente
// (payload antigo) → não altera o estado.
let _bbgSource = null;        // 'live' | 'cache' | null (desconhecido)
let _bbgCacheTime = null;

function noteBbgSource(data) {
  if (data && data.bbg_source) { _bbgSource = data.bbg_source; _bbgCacheTime = data.bbg_cache_time || null; }
  updateBbgBanner();
}

function updateBbgBanner() {
  const el = document.getElementById('bbgStaleBanner');
  if (!el) return;
  if (_bbgSource !== 'cache') { el.style.display = 'none'; el.textContent = ''; return; }
  const when = _bbgCacheTime ? fmtDateTime(_bbgCacheTime) : '';
  el.textContent = '⚠ DADOS BLOOMBERG NÃO ESTÃO AO VIVO — preços e exposição (#PL) são do último '
    + 'fechamento da BBG' + (when ? ` (${when})` : '') + '. Posição e datas estão atualizadas (Oracle). '
    + 'Clique em "Atualizar" com o Terminal aberto para valores ao vivo.';
  el.style.display = '';
}

/* ── Formatters ──────────────────────────────────────────────────────────── */
