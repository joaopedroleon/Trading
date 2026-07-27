/* ── PnL tab — render from unified positions endpoint ────────────────────── */
/* Depende de positions.js: posDataByTab, getSections, sortRows,
   fmtDate, fmtQty, fmtPrice, fmtPL, GROUP_ORDER                            */

let pnlData   = null;
const pnlRowMap     = {};
const hiddenPnlRows = {};  // tabId → Set<rowKey>
const _pnlRendered  = new Set();  // tabIds com PnL já renderizado (DOM presente)
let activePnlTabId  = null;

const SOURCE_LABELS = { bbg: 'BBG', boleta: 'Boleta', d1: 'D-1', manual: 'Marretado', marretado: 'Marretado' };

// HTML do resultado da última busca de PX_SETTLE D0 (persiste entre rerenders;
// limpo no "Atualizar" via resetPnlForTab). NÃO altera fallback/prioridade da tela.
let _pxSettleMsg = '';

/* ── Render PnL for a trader tab (uses data from posDataByTab) ───────────── */
function loadPnlForTab(tabId) {
  const data = posDataByTab[tabId];
  if (!data?.rows) return;
  if (tabId !== activeTraderTab) return;
  activePnlTabId = tabId;
  pnlData = data;
  buildPnlRowMap(data.rows);   // repoint do rowMap p/ edição (barato)
  // Só renderiza o DOM na 1ª vez; trocar de aba e voltar reusa o que já está montado
  // (preserva linhas de PnL ocultas e o estado colapsado do detalhe).
  if (!_pnlRendered.has(tabId)) {
    renderPnlSections(data, tabId);
    _pnlRendered.add(tabId);
  }
  _syncPnlRestoreBtn();
}

/* Limpa o estado de PnL de uma aba quando seus dados são recarregados (fetch novo). */
function resetPnlForTab(tabId) {
  delete hiddenPnlRows[tabId];
  _pnlRendered.delete(tabId);
  _pxSettleMsg = '';   // resultado da busca de settle é do run anterior → some no Atualizar
}

/* ── Buscar PX_SETTLE do dia (D0) para os ativos com preço BBG ─────────────── */
// SÓ para este botão: aplica o settle D0 como preço efetivo (via priceOverrides, a mesma
// marreta de sempre → top da prioridade), avisando os ativos cujo settle ainda não saiu.
// Não toca no fluxo normal (BBG live → boleta → D-1) das demais linhas.
function _pxSettleCandidates() {
  const rows = (pnlData && pnlData.rows) || [];
  // Alvo: instrumentos de BOLSA cujo ticker BBG é o PRÓPRIO instrument_reference — os que
  // "usamos preço da BBG como fonte". Identificado pelo sufixo do ticker (Comdty/Curncy/
  // Index): futuros DI/dólar/US/índice E opções SOBRE FUTURO (ex.: 'IMBWN6P4 7420 PUT' →
  // ref 'IMBWN6P4 7420 Index'; ouro 'GC..C .. Comdty').
  // IMPORTANTE: NÃO filtra por price_live_source — o botão serve justamente para quando a
  // BBG está sem spread agora (preço caiu no fallback boleta/D-1) mas o SETTLE do dia já saiu.
  // Exclui: FX fwd, SWAP (curva), ações cash/crédito/CDS (Equity/Corp/sem sufixo), e opções
  // de ticker especial DOL/FX/US-equity/IBOV/digital (resolvidas à parte no /reference).
  return rows.filter(r => {
    const ref = r.instrument_reference || '';
    if (!ref || r.is_fx || ref.startsWith('SWAP')) return false;
    if (!/ (Comdty|Curncy|Index)$/.test(ref)) return false;
    if (r.is_option) {
      const sub = r.option_subtype;
      if (sub === 'dol' || sub === 'fx' || sub === 'us_equity' || sub === 'digital') return false;
      if ((r.instrument_name || '').toUpperCase().startsWith('IBOV')) return false;
    }
    return true;
  });
}

async function fetchPxSettleD0(btn) {
  const cands = _pxSettleCandidates();
  if (!cands.length) {
    _pxSettleMsg = `<span data-html2canvas-ignore="true" style="font-size:11px;color:var(--text-muted)">Nenhum ativo com preço BBG nesta aba.</span>`;
    rerenderPnlSummary();
    return;
  }
  const tickers = [...new Set(cands.map(r => r.instrument_reference))];
  const refDate = document.getElementById('refDate').value;
  const oldTxt  = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Buscando…';
  try {
    const params = new URLSearchParams();
    if (refDate) params.set('ref_date', refDate);
    params.set('tickers', tickers.join(','));
    const resp = await fetch(`${API_BASE}/api/positions/px-settle?${params}`);
    const data = await resp.json();
    if (!resp.ok || data.error) {
      _pxSettleMsg = `<span data-html2canvas-ignore="true" style="font-size:11px;color:var(--red)">⚠ ${data.error || 'Erro ao buscar settle.'}</span>`;
      rerenderPnlSummary();
      return;
    }
    const settle  = data.settle  || {};
    const missing = data.missing || [];
    for (const r of cands) {
      const px = settle[r.instrument_reference];
      if (px != null) priceOverrides.set(instKey(r), px);   // vira o preço efetivo (live) no PnL
    }
    const appliedN = tickers.filter(t => settle[t] != null).length;
    const parts = [`✓ settle D0 (${fmtDate(data.ref_date)}) aplicado: ${appliedN} ativo(s)`];
    if (missing.length) parts.push(`<span style="color:var(--yellow)">⚠ settle do dia ainda não saiu: ${missing.map(t => t.replace(/\s+(Comdty|Curncy|Index|Equity)$/i, '')).join(', ')}</span>`);
    _pxSettleMsg = `<span data-html2canvas-ignore="true" style="font-size:11px;color:${missing.length ? 'var(--text-muted)' : 'var(--green)'}">${parts.join(' · ')}</span>`;
    if (typeof _markTabsDirtyAndRerender === 'function') _markTabsDirtyAndRerender();
    else rerenderPnlSummary();
  } catch (e) {
    _pxSettleMsg = `<span data-html2canvas-ignore="true" style="font-size:11px;color:var(--red)">⚠ Erro de conexão: ${e.message}</span>`;
    rerenderPnlSummary();
  } finally {
    btn.disabled = false;
    btn.textContent = oldTxt;
  }
}

/* ── Formatters específicos do PnL ───────────────────────────────────────── */
// fmtUSD ≡ fmtMoney (positions.js, carregado antes) — alias p/ evitar duplicação.
const fmtUSD = fmtMoney;

const fmtBps = v => {
  if (v == null) return '<span style="color:var(--text-muted)">—</span>';
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  if (v > 0) return `<span style="color:var(--green)">+${s}</span>`;
  if (v < 0) return `<span style="color:var(--red)">(${s})</span>`;
  return `<span style="color:var(--text-muted)">—</span>`;
};

const fmtQtySummary = v => {
  if (v == null || v === 0) return '<span style="color:var(--text-muted)">—</span>';
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  return v < 0 ? `(${s})` : s;
};

/* ── Ocultar linhas no resumo ────────────────────────────────────────────── */
function _hiddenPnlForTab(tabId) {
  if (!hiddenPnlRows[tabId]) hiddenPnlRows[tabId] = new Set();
  return hiddenPnlRows[tabId];
}

function _syncPnlRestoreBtn() {
  const btn = document.getElementById('restorePnlBtn');
  if (!btn) return;
  const count = _hiddenPnlForTab(activePnlTabId).size;
  if (count > 0) {
    btn.textContent = `↩ Restaurar PnL ocultas (${count})`;
    btn.style.display = '';
  } else {
    btn.style.display = 'none';
  }
}

function hidePnlRow(key) {
  _hiddenPnlForTab(activePnlTabId).add(key);
  rerenderPnlSummary();
  _syncPnlRestoreBtn();
}

function restorePnlRows() {
  delete hiddenPnlRows[activePnlTabId];
  rerenderPnlSummary();
  _syncPnlRestoreBtn();
}

/* ── Copiar resumo como imagem (sem colunas de preço) ────────────────────── */
function copySummaryTable(btn) {
  const src = btn.closest('.card')?.querySelector('.section-copy-target') ?? btn.closest('.card');
  const clone = src.cloneNode(true);
  // remove as últimas 2 colunas (Preço Médio + Price Live) de cada linha
  for (const row of clone.querySelectorAll('.pnl-summary-table tr')) {
    while (row.children.length > 6) row.removeChild(row.lastElementChild);
  }
  clone.style.cssText = 'position:fixed;top:-9999px;left:-9999px;background:var(--bg-card)';
  document.body.appendChild(clone);
  copyElementAsImage(clone, btn).finally(() => document.body.removeChild(clone));
}

/* ── Cor condicional por fonte do price_live ─────────────────────────────── */
function priceLiveStyle(source) {
  switch (source) {
    case 'bbg':       return 'color:var(--green)';
    case 'd1':        return 'color:var(--red)';
    case 'boleta':    return 'color:var(--yellow)';
    case 'manual':    return 'color:var(--accent);font-style:italic';
    case 'marretado': return 'color:var(--accent);font-style:italic';
    default:          return '';
  }
}

function pnlBodyId(group, trader) {
  return `pnl_body_${group}_${trader}`.replace(/[^a-zA-Z0-9]/g, '_');
}

function _pnlTabFilterRows(rows) {
  if (!activePnlTabId) return rows;
  const tab = (typeof TRADER_TABS !== 'undefined') && TRADER_TABS.find(t => t.id === activePnlTabId);
  if (!tab?.filters?.length) return rows;
  const tabFs = FILTERS.filter(f => tab.filters.includes(f.id) && activeFilters.has(f.id));
  return rows.filter(r => tabFs.every(f => f.fn(r)));
}

/* ── PnL row helpers ─────────────────────────────────────────────────────── */
// Mesma chave da tabela de posições (positions.js:rowKey) — delega para não driftar.
function pnlRowKey(r) {
  return rowKey(r);
}

function buildPnlRowMap(rows) {
  for (const k in pnlRowMap) delete pnlRowMap[k];
  for (const r of rows) pnlRowMap[pnlRowKey(r)] = r;
}

// Abertura EFETIVA (DV01) de um SWAP live p/ o PnL: aplica as marretas via swapEffQty
// (abertura/operada/dv01). Fora de swap ou sem o helper → null (usa o backend).
function _swapEff(r) {
  if (r.swap_trade_usd == null || typeof swapEffQty !== 'function') return null;
  return swapEffQty(r);
}

// PnL derivado (PURO — não muta a row) a partir do preço efetivo (marreta → live → boleta → D-1).
// Sem marreta e com preço == price_pnl, reproduz exatamente o breakdown que o backend mandou.
function pnlFor(r) {
  const cf = r.calc_factor, nav = r.nav;
  // SWAP da tela LIVE (consolidado): total = ESTOQUE por TAXA (DV01×Δtaxa) + resultado das
  // BOLETAS (preço médio × marcação, já em USD no backend, campo swap_trade_usd). O estoque
  // escala pela marreta de DV01 (corrige o Oracle); as boletas NÃO escalam. Discrimina pelo
  // swap_trade_usd != null — o swap do SNAPSHOT não seta esse campo e cai no genérico abaixo.
  if (r.swap_trade_usd != null) {
    if (cf == null || nav == null) {   // sem curva (ex. ZAR) → total pronto do backend
      return { estoque: r.estoque_usd, compra: r.compra_usd, venda: r.venda_usd,
               total: r.total_usd, bps: r.result_bps };
    }
    const sp1 = effectivePrice(r);              // taxa live (ou marreta de taxa)
    const sp0 = r.price != null ? r.price : null;   // taxa D-1
    const eff = _swapEff(r);                    // abertura EFETIVA (marreta de abertura/dv01)
    const oq = eff ? eff.opening : (r.opening_qty ?? 0);   // estoque = DV01_abertura × Δtaxa
    const est = (sp0 != null && sp1 != null) ? oq * cf * (sp1 - sp0) : 0;
    const tot = est + (r.swap_trade_usd || 0);
    return { estoque: est, compra: r.compra_usd, venda: r.venda_usd, total: tot,
             bps: tot / nav * 10_000 };
  }
  const p1 = effectivePrice(r);
  if (cf == null || nav == null || p1 == null) {
    return { estoque: r.estoque_usd, compra: r.compra_usd, venda: r.venda_usd,
             total: r.total_usd, bps: r.result_bps };
  }
  const p0 = r.price != null ? r.price : null;
  const ab = r.avg_buy_price  != null ? r.avg_buy_price  : null;
  const av = r.avg_sell_price != null ? r.avg_sell_price : null;
  const oq = r.opening_qty ?? 0, bq = r.buy_qty ?? 0, sq = r.sell_qty ?? 0;
  const est  = p0 != null ? oq * cf * (p1 - p0) : 0;
  const comp = ab != null ? bq * cf * (p1 - ab) : 0;
  const vend = av != null ? sq * cf * (av - p1) : 0;
  const tot  = est + comp + vend;
  return { estoque: est, compra: comp, venda: vend, total: tot, bps: tot / nav * 10_000 };
}

// Re-render dos valores do PnL (resumo + tbodies já montados) SEM refetch e SEM perder
// estado (colapso do detalhe / linhas ocultas). Usado após uma marreta de preço.
function rerenderPnlValues() {
  if (!pnlData) return;
  rerenderPnlSummary();
  const tabRows = _pnlTabFilterRows(pnlData.rows);
  for (const s of getSections(tabRows)) {
    if (!_isPnlGroup(s.group)) continue;
    const bodyId = pnlBodyId(s.group, s.trader);
    if (!document.getElementById(bodyId)) continue;
    const rows = sortRows(   // tabRows já filtrado por _pnlTabFilterRows (ver renderPnlSections)
      tabRows.filter(r => r.group === s.group && r.trader === s.trader)
    );
    renderPnlTable(rows, bodyId);
  }
}

const _isPnlGroup = g => g === 'MM' || g === 'Todos';

function rerenderPnlSection(inputEl) {
  const tbodyId = inputEl.closest('tbody').id;
  const tabRows = _pnlTabFilterRows(pnlData.rows);
  for (const s of getSections(tabRows)) {
    if (!_isPnlGroup(s.group)) continue;
    const bodyId = pnlBodyId(s.group, s.trader);
    if (bodyId === tbodyId) {
      // tabRows já vem filtrado por _pnlTabFilterRows (mesmos filtros da tabela de
      // Posição). NÃO reaplicar applyFilters (filtros globais) — isso derrubava Cash
      // do PnL em abas cujo tab.filters não inclui no_cash.
      const rows = sortRows(
        tabRows.filter(r => r.group === s.group && r.trader === s.trader)
      );
      renderPnlTable(rows, tbodyId);
      return;
    }
  }
}

function rerenderPnlSummary() {
  const mmRows    = _pnlTabFilterRows(pnlData.rows).filter(r => _isPnlGroup(r.group));
  const container = document.getElementById(`pnlContainer-${activePnlTabId}`);
  if (!container) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = renderPnlSummary(mmRows);
  container.replaceChild(tmp.firstElementChild, container.firstElementChild);
}

/* ── Edição inline de price_live ─────────────────────────────────────────── */
function pnlStartEdit(cell) {
  if (cell.querySelector('input')) return;  // já em edição
  const key = cell.dataset.key;
  const r   = pnlRowMap[key];
  if (!r) return;
  // FX options: preço guardado como decimal (0.0051); mostra como porcentagem (0.51)
  const isFx    = r.option_subtype === 'fx';
  const ep      = effectivePrice(r);
  const current = ep != null ? (isFx ? ep * 100 : ep) : '';
  cell.innerHTML = `<input type="number" step="any" value="${current}"
    style="width:80px;background:var(--bg);color:var(--text);border:1px solid var(--accent);padding:2px 4px;font-size:inherit;text-align:right">`;
  const input = cell.querySelector('input');
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input._cancelled = true; input.blur(); }
  });
  input.addEventListener('blur', () => {
    if (input._cancelled) { rerenderPnlSection(input); return; }
    pnlApplyEdit(input, key);
  });
  input.addEventListener('click', e => e.stopPropagation());
  input.focus();
  input.select();
}

function pnlApplyEdit(input, key) {
  const val = parseFloat(String(input.value).replace(',', '.'));
  if (isNaN(val)) { rerenderPnlSection(input); return; }
  const r = pnlRowMap[key];
  if (!r) return;
  // marreta de preço é GLOBAL por instrumento → grava no priceOverrides e propaga p/ todas as abas
  priceOverrides.set(instKey(r), r.option_subtype === 'fx' ? val / 100 : val);
  if (typeof _markTabsDirtyAndRerender === 'function') _markTabsDirtyAndRerender();
  else { rerenderPnlSection(input); rerenderPnlSummary(); }
}

/* ── Edição inline de price_live no resumo ───────────────────────────────── */
function pnlStartSummaryEdit(cell) {
  if (cell.querySelector('input')) return;
  const rowKeys = JSON.parse(cell.dataset.rowkeys);
  const firstR  = pnlRowMap[rowKeys[0]];
  if (!firstR) return;
  const isFxS   = firstR.option_subtype === 'fx';
  const epS     = effectivePrice(firstR);
  const current = epS != null ? (isFxS ? epS * 100 : epS) : '';
  cell.innerHTML = `<input type="number" step="any" value="${current}"
    style="width:80px;background:var(--bg);color:var(--text);border:1px solid var(--accent);padding:2px 4px;font-size:inherit;text-align:right">`;
  const input = cell.querySelector('input');
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input._cancelled = true; input.blur(); }
  });
  input.addEventListener('blur', () => {
    if (input._cancelled) { rerenderPnlSummary(); return; }
    pnlApplySummaryEdit(input, rowKeys);
  });
  input.addEventListener('click', e => e.stopPropagation());
  input.focus();
  input.select();
}

function pnlApplySummaryEdit(input, rowKeys) {
  const val = parseFloat(String(input.value).replace(',', '.'));
  if (isNaN(val)) { rerenderPnlSummary(); return; }
  // marreta GLOBAL por instrumento: aplica a todas as linhas do grupo (todas as maturidades do mesmo par)
  for (const key of rowKeys) {
    const r = pnlRowMap[key];
    if (r) priceOverrides.set(instKey(r), r.option_subtype === 'fx' ? val / 100 : val);
  }
  if (typeof _markTabsDirtyAndRerender === 'function') _markTabsDirtyAndRerender();
  else rerenderPnlValues();
}

/* ── Tabela de resumo (pivot por sub-área) ───────────────────────────────── */
function renderPnlSummary(rows) {
  // agrupa por (subarea, instrument_name, maturity) somando financeiros
  const map = new Map();
  for (const r of rows) {
    const key = `${r.subarea ?? ''}||${r.instrument_name ?? ''}||${r.maturity ?? ''}`;
    if (!map.has(key)) {
      map.set(key, { subarea: r.subarea, instrument_name: r.instrument_name,
                     opening_qty: 0, buy_qty: 0, sell_qty: 0,
                     buy_price_sum: 0, sell_price_sum: 0,
                     final_qty: 0, total_usd: 0, result_bps: 0,
                     eff_price: effectivePrice(r), price_src: priceSrc(r),
                     option_subtype: r.option_subtype ?? null,
                     swap_detail: r.swap_detail ?? null,
                     rowKeys: [], summaryKey: key });
    }
    const e   = map.get(key);
    const pf  = pnlFor(r);
    const eff = _swapEff(r);   // swap: abertura/final EFETIVAS (marretas); null p/ o resto
    e.opening_qty    += eff ? eff.opening : (r.opening_qty ?? 0);
    e.buy_qty        += r.buy_qty     ?? 0;
    e.sell_qty       += r.sell_qty    ?? 0;
    e.buy_price_sum  += (r.buy_qty  ?? 0) * (r.avg_buy_price  ?? 0);
    e.sell_price_sum += (r.sell_qty ?? 0) * (r.avg_sell_price ?? 0);
    e.final_qty  += eff ? eff.final : (r.final_qty ?? 0);
    e.total_usd  += pf.total ?? 0;
    e.result_bps += pf.bps   ?? 0;
    e.rowKeys.push(pnlRowKey(r));
  }

  // agrupa por subarea, excluindo linhas ocultas
  const subareas = new Map();
  for (const e of map.values()) {
    if (_hiddenPnlForTab(activePnlTabId).has(e.summaryKey)) continue;
    const sa = e.subarea ?? '—';
    if (!subareas.has(sa)) subareas.set(sa, []);
    subareas.get(sa).push(e);
  }

  let tbody = '';
  let grandUsd = 0, grandBps = 0;

  for (const [sa, entries] of subareas) {
    let subUsd = 0, subBps = 0;
    for (const e of entries) { subUsd += e.total_usd ?? 0; subBps += e.result_bps ?? 0; }
    grandUsd += subUsd;
    grandBps += subBps;

    // linha da sub-área já traz o subtotal inline
    tbody += `<tr style="font-weight:600;background:var(--border);border-top:2px solid var(--border)">
      <td style="padding:5px 8px">${sa}</td>
      <td></td><td></td>
      <td></td>
      <td class="num">${fmtUSD(subUsd)}</td>
      <td class="num">${fmtBps(subBps)}</td>
      <td></td>
      <td class="col-pnl"></td>
    </tr>`;
    for (const e of entries) {
      const srcLabel   = SOURCE_LABELS[e.price_src] || '—';
      const priceColor = priceLiveStyle(e.price_src);
      const rowKeysJson = JSON.stringify(e.rowKeys).replace(/"/g, '&quot;');
      const sk          = e.summaryKey.replace(/'/g, "\\'");
      const swapAttr    = e.swap_detail
        ? ` data-swaps="${e.swap_detail.map(s => `${s.name}: ${fmtQty(s.qty)}`).join('\n').replace(/"/g, '&quot;')}"`
        : '';
      const tradedQty   = e.buy_qty - e.sell_qty;
      const totalTraded = e.buy_qty + e.sell_qty;
      let avgPriceCell;
      if (totalTraded === 0) {
        avgPriceCell = '<span style="color:var(--text-muted)">—</span>';
      } else if (tradedQty === 0) {
        const abp  = e.buy_qty  > 0 ? e.buy_price_sum  / e.buy_qty  : null;
        const asp  = e.sell_qty > 0 ? e.sell_price_sum / e.sell_qty : null;
        const bStr = abp != null ? (e.option_subtype === 'fx' ? fmtPricePct(abp) : fmtPrice(abp)) : '—';
        const sStr = asp != null ? (e.option_subtype === 'fx' ? fmtPricePct(asp) : fmtPrice(asp)) : '—';
        avgPriceCell = `${bStr}&nbsp;/&nbsp;${sStr}`;
      } else {
        // posição líquida: custo líquido = (notional compra − notional venda) / qtd líquida
        const avgPrice = (e.buy_price_sum - e.sell_price_sum) / tradedQty;
        avgPriceCell = e.option_subtype === 'fx' ? fmtPricePct(avgPrice) : fmtPrice(avgPrice);
      }
      tbody += `<tr onclick="hidePnlRow('${sk}')" title="Clique para ocultar" style="cursor:pointer">
        <td style="padding-left:16px"${swapAttr}>${e.instrument_name ?? '—'}</td>
        <td class="num">${fmtQtySummary(e.opening_qty)}</td>
        <td class="num">${fmtQtySummary(tradedQty)}</td>
        <td class="num">${fmtQtySummary(e.final_qty)}</td>
        <td class="num">${fmtUSD(e.total_usd)}</td>
        <td class="num" style="font-weight:600">${fmtBps(e.result_bps)}</td>
        <td class="num">${avgPriceCell}</td>
        <td class="col-pnl num" data-rowkeys="${rowKeysJson}"
            title="Fonte: ${srcLabel}"
            onclick="event.stopPropagation();pnlStartSummaryEdit(this)"
            style="cursor:pointer;${priceColor}"
        >${e.option_subtype === 'fx' ? fmtPricePct(e.eff_price) : fmtPrice(e.eff_price)}</td>
      </tr>`;
    }
  }

  tbody += `<tr style="font-weight:700;background:var(--border);border-top:2px solid var(--border)">
    <td>Total Geral</td>
    <td></td><td></td>
    <td></td>
    <td class="num">${fmtUSD(grandUsd)}</td>
    <td class="num">${fmtBps(grandBps)}</td>
    <td></td>
    <td class="col-pnl"></td>
  </tr>`;

  // build header: unique traders with NAV, same style as positions
  const traders     = pnlData?.traders || {};
  const navDate     = pnlData?.nav_date;
  const openingDate = pnlData?.opening_date;
  const uniqueTraders = [...new Set(rows.map(r => r.trader).filter(Boolean))].sort();
  const traderBadges = uniqueTraders.map(t => {
    const nav = traders[t];
    let navStr = '';
    if (nav != null) {
      const base = `NAV: USD ${nav.toLocaleString('en-US', {maximumFractionDigits:0})}`;
      const warn = (navDate && openingDate && navDate !== openingDate)
        ? ` <span style="color:var(--yellow);font-size:11px" title="NAV indisponível para ${openingDate} — usando ${navDate}">⚠ ${navDate}</span>`
        : '';
      navStr = `<span style="font-weight:400;color:var(--text-muted);font-size:12px">${base}${warn}</span>`;
    }
    return `<span style="font-weight:400;color:var(--text-muted);font-size:13px">— ${t}</span> ${navStr}`;
  }).join('<span style="color:var(--border);margin:0 8px">|</span>');

  const _hpCount = _hiddenPnlForTab(activePnlTabId).size;
  const restoreBtn = _hpCount > 0
    ? `<button class="btn" data-html2canvas-ignore="true" style="background:var(--red);color:#fff;padding:2px 10px;font-size:12px" onclick="restorePnlRows()">↩ Restaurar (${_hpCount})</button>`
    : '';

  return `<div class="card">
    <div class="section-copy-target" style="background:var(--bg-card)">
      <div class="section-title" style="padding:8px 0 10px 0;display:flex;align-items:baseline;gap:12px;flex-wrap:wrap">
        <span>MM ${traderBadges}</span>
        ${restoreBtn}
        <button class="btn btn-secondary" data-html2canvas-ignore="true" style="padding:2px 10px;font-size:12px" title="Busca o PX_SETTLE do dia (D0) na BBG p/ os ativos com preço BBG e aplica como preço efetivo; avisa os que ainda não saíram." onclick="fetchPxSettleD0(this)">⤓ Buscar Settle D0</button>
        ${_pxSettleMsg}
        <button class="btn btn-secondary" data-html2canvas-ignore="true" style="padding:2px 10px;font-size:12px;margin-left:auto" onclick="copySummaryTable(this)">⎘ Copiar</button>
      </div>
      <table class="data-table pnl-summary-table" style="white-space:nowrap;width:auto">
        <thead><tr>
          <th>Ativo</th>
          <th class="num">Qtd Abertura</th>
          <th class="num">Qtd Operada</th>
          <th class="num">Qtd Final</th>
          <th class="num">Resultado USD</th>
          <th class="num">Result Bps</th>
          <th class="num">Preço Médio</th>
          <th class="col-pnl num">Price Live</th>
        </tr></thead>
        <tbody>${tbody}</tbody>
      </table>
    </div>
  </div>`;
}

/* ── Thead ───────────────────────────────────────────────────────────────── */
function pnlThead() {
  const d = detailVisible ? '' : 'style="display:none"';
  return `<thead><tr>
    <th class="col-detail" ${d}>Área</th>
    <th class="col-detail" ${d}>Sub-área</th>
    <th class="col-detail" ${d}>Estratégia</th>
    <th>Instrumento</th>
    <th>Vencto</th>
    <th class="num">Qtd Abertura</th>
    <th class="num">Preço D-1</th>
    <th class="num">Price Live</th>
    <th class="num">C Qtd</th>
    <th class="num">Preço Médio C</th>
    <th class="num">V Qtd</th>
    <th class="num">Preço Médio V</th>
    <th class="col-pnl num">Estoque USD</th>
    <th class="col-pnl num">Compra USD</th>
    <th class="col-pnl num">Venda USD</th>
    <th class="col-pnl num">Total USD</th>
    <th class="col-pnl num">Result Bps</th>
  </tr></thead>`;
}

/* ── Render sections ─────────────────────────────────────────────────────── */
function renderPnlSections(data, tabId) {
  const tabRows   = _pnlTabFilterRows(data.rows);
  const sections  = getSections(tabRows).filter(s => _isPnlGroup(s.group));
  const traders   = data.traders || {};
  const container = document.getElementById(`pnlContainer-${tabId}`);

  const mmRows = tabRows.filter(r => _isPnlGroup(r.group));   // tabRows já filtrado (ver rerenderPnlValues)

  container.style.display       = 'inline-flex';
  container.style.flexDirection = 'column';
  container.innerHTML = renderPnlSummary(mmRows) + sections.map(s => {
    const nav    = traders[s.trader];
    const navStr = nav
      ? `<span style="font-weight:400;color:var(--text-muted);font-size:12px">NAV: USD ${nav.toLocaleString('en-US', {maximumFractionDigits:0})}</span>`
      : '';
    const bodyId = pnlBodyId(s.group, s.trader);
    const wrapId = `${bodyId}_wrap`;
    return `
    <div class="card">
      <div style="cursor:pointer;user-select:none" onclick="(function(btn,wrap){
        var open=wrap.style.display!=='none';
        wrap.style.display=open?'none':'';
        btn.textContent=open?'▶':'▼';
      })(this.querySelector('.pnlDetailArrow'),document.getElementById('${wrapId}'))">
        <div class="section-title" style="padding:0 0 10px 0;display:flex;align-items:baseline;gap:16px">
          <span>${s.group} <span style="font-weight:400;color:var(--text-muted);font-size:13px">— ${s.trader}</span> <span style="font-weight:400;color:var(--text-muted);font-size:12px">(detalhe)</span></span>
          ${navStr}
          <span class="pnlDetailArrow" style="margin-left:auto;font-size:13px;color:var(--text-muted)">▶</span>
        </div>
      </div>
      <div id="${wrapId}" style="display:none;overflow-x:auto">
        <table class="data-table" style="white-space:nowrap;width:auto">
          ${pnlThead()}
          <tbody id="${bodyId}"></tbody>
        </table>
      </div>
    </div>`;
  }).join('');

  for (const s of sections) {
    const bodyId = pnlBodyId(s.group, s.trader);
    const rows   = sortRows(
      tabRows.filter(r => r.group === s.group && r.trader === s.trader)
    );
    renderPnlTable(rows, bodyId);
  }
}

/* ── Render tbody ────────────────────────────────────────────────────────── */
function renderPnlTable(rows, tbodyId) {
  const body = document.getElementById(tbodyId);
  if (!body) return;

  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="17" class="no-data">Nenhuma posição encontrada.</td></tr>';
    return;
  }

  const d = detailVisible ? '' : 'style="display:none"';
  let prevArea    = null;
  let prevSubarea = null;
  let subareaIdx  = -1;

  body.innerHTML = rows.map((r, i) => {
    const newArea    = r.area    !== prevArea;
    const newSubarea = r.subarea !== prevSubarea;
    if (newSubarea) subareaIdx++;
    const rowClass  = subareaIdx % 2 === 0 ? 'group-odd' : 'group-even';
    const areaClass = newArea && i > 0 ? 'area-divider' : '';
    prevArea    = r.area;
    prevSubarea = r.subarea;

    const swapAttr = r.swap_detail
      ? ` data-swaps="${r.swap_detail.map(s => `${s.name}: ${fmtQty(s.qty)}`).join('\n').replace(/"/g, '&quot;')}"`
      : '';
    const pf  = pnlFor(r);
    const ep  = effectivePrice(r);
    const src = priceSrc(r);
    const eff = _swapEff(r);                     // swap: abertura EFETIVA (marreta) p/ a qtd
    const oq  = eff ? eff.opening : (r.opening_qty ?? 0);
    const bq  = r.buy_qty  ?? 0;
    const sq  = r.sell_qty ?? 0;
    return `<tr class="${rowClass} ${areaClass}">
      <td class="col-detail" ${d}>${r.area     ?? '—'}</td>
      <td class="col-detail" ${d}>${r.subarea  ?? '—'}</td>
      <td class="col-detail" ${d}>${r.strategy ?? '—'}</td>
      <td${swapAttr}>${r.instrument_name ?? '—'}</td>
      <td>${fmtDate(r.maturity)}</td>
      <td class="num">${fmtQty(oq)}</td>
      <td class="num">${r.option_subtype === 'fx' ? fmtPricePct(r.price) : fmtPrice(r.price)}</td>
      <td class="num" data-key="${pnlRowKey(r).replace(/"/g, '&quot;')}"
          title="Fonte: ${SOURCE_LABELS[src] || '—'}"
          onclick="pnlStartEdit(this)"
          style="cursor:pointer;${priceLiveStyle(src)}"
      >${r.option_subtype === 'fx' ? fmtPricePct(ep) : fmtPrice(ep)}</td>
      <td class="num">${bq ? fmtQty(bq)  : '<span style="color:var(--text-muted)">—</span>'}</td>
      <td class="num">${r.avg_buy_price  != null ? (r.option_subtype === 'fx' ? fmtPricePct(r.avg_buy_price)  : fmtPrice(r.avg_buy_price))  : '<span style="color:var(--text-muted)">—</span>'}</td>
      <td class="num">${sq ? fmtQty(sq) : '<span style="color:var(--text-muted)">—</span>'}</td>
      <td class="num">${r.avg_sell_price != null ? (r.option_subtype === 'fx' ? fmtPricePct(r.avg_sell_price) : fmtPrice(r.avg_sell_price)) : '<span style="color:var(--text-muted)">—</span>'}</td>
      <td class="col-pnl num">${fmtUSD(pf.estoque)}</td>
      <td class="col-pnl num">${fmtUSD(pf.compra)}</td>
      <td class="col-pnl num">${fmtUSD(pf.venda)}</td>
      <td class="col-pnl num">${fmtUSD(pf.total)}</td>
      <td class="col-pnl num">${fmtBps(pf.bps)}</td>
    </tr>`;
  }).join('');
}
