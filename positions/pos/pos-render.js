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
      const srcMap   = { bbg: ['BBG', 'var(--green)'], boleta: ['Boleta', 'var(--yellow)'], d1: ['D-1', 'var(--red)'], manual: ['Manual', 'var(--accent)'] };
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
    const hasDv01Ovr = isSwap && swapDv01Overrides.has(rKeyFull);
    const qtyOvr     = hasOpenOvr || hasTrdOvr || hasDv01Ovr;
    const effOpening = hasOpenOvr ? swapOpeningOverrides.get(rKeyFull) : r.opening_qty;
    const effTraded  = hasTrdOvr  ? swapTradedOverrides.get(rKeyFull)  : r.traded_qty;
    const effFinal   = hasDv01Ovr ? swapDv01Overrides.get(rKeyFull)                  // marreta de DV01 domina
                     : (qtyOvr || isSwap) ? (effOpening ?? 0) + (effTraded ?? 0)
                     : r.final_qty;

    let effDv01, effPl, effPlType;
    if (isSwap) {                        // SWAP: a "qtd" É o DV01 — marreta direta (swapDv01Overrides) OU
      effDv01   = effFinal || null;      //   abertura+operada; effFinal já reflete a marreta de DV01
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
    return `<tr class="${rowClass} ${areaClass} ${tradedClass}" data-ref="${refCopy}" style="cursor:pointer" title="Clique para copiar a referência" onclick="copyRowRef(this)">
      <td class="col-copy" title="Excluir (ocultar) esta linha" onclick="event.stopPropagation();hideRow('${key}')">✕</td>
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
      ${isSwap
        ? `<td class="num" style="cursor:pointer" title="Clique para marretar o DV01 (o #PL segue)"${tipAttr}
             data-swapkey="${safeKey}" data-dv01="${effDv01 ?? ''}"
             onclick="event.stopPropagation();swapStartEdit(this,'dv01',this.dataset.swapkey,parseFloat(this.dataset.dv01))">${fmtDv01(effDv01)}</td>`
        : `<td class="num"${tipAttr}>${fmtDv01(effDv01)}</td>`}
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

/* ── Copiar a referência do instrumento (clique na LINHA) ──────────────────── */
