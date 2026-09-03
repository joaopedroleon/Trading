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
  // Linha simulada fica FORA do check de alocação MM×MM Prev: ela não tem par no Prev por
  // definição (não existe no Oracle) e apareceria como "0% alocado", um alerta falso.
  const mmRows   = filterFn(sortRows(allRows.filter(r => r.group === 'MM' && r.trader === trader && !r.is_simulated)));
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

  // Short de bolsa BR ONSHORE (BRL): o Sulamérica não entra → target proporcional ao NAV do
  // resto do grupo. Risco Brasil comprado lá fora (EWZ, ADR, XP) não conta — ver isBrEquity.
  const shortFactor  = prevShortBrEquityFactor();
  let   usedReduced  = false;   // alguma linha usou o target reduzido
  let   missingFactor = false;  // linha de short de bolsa BR sem o NAV do grupo (target cheio)

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

    // Target da linha: reduzido quando é short de bolsa BR (Sulamérica fora do trade)
    const isShortBr = target != null && isBrEquityShort(mm);
    if (isShortBr && shortFactor == null) missingFactor = true;
    const rowTarget = isShortBr && shortFactor != null ? target * shortFactor : target;
    if (isShortBr && shortFactor != null) usedReduced = true;
    const shortMark = isShortBr
      ? ` <span class="alloc-short-br" title="Short de bolsa BR onshore — Sulamérica não entra. Target ${
          shortFactor != null ? fmtPct(rowTarget) : fmtPct(target) + ' (NAV do grupo Prev indisponível)'}">↓</span>`
      : '';

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
          const buyDelta  = rowTarget != null && buyPct  != null ? buyPct  - rowTarget : null;
          const sellDelta = rowTarget != null && sellPct != null ? sellPct - rowTarget : null;
          const bStr = buyPct  != null ? `<span class="${allocClass(buyDelta)}" title="Compra">C:${fmtPct(buyPct)}</span>`  : '';
          const sStr = sellPct != null ? `<span class="${allocClass(sellDelta)}" title="Venda">V:${fmtPct(sellPct)}</span>` : '';
          dealCell = `<td class="num">${[bStr, sStr].filter(Boolean).join(' / ')}</td>`;
        }
      } else {
        const dealPct   = (prev?.traded_qty ?? 0) / mm.traded_qty;
        const dealDelta = rowTarget != null ? dealPct - rowTarget : null;
        dealCell = `<td class="num ${allocClass(dealDelta)}">${fmtPct(dealPct)}</td>`;
      }
    }

    // % Alloc Final
    const mmFinal   = mm.final_qty ?? 0;
    const prevFinal = prev?.final_qty ?? null;
    const finalPct  = mmFinal !== 0 && prevFinal != null ? prevFinal / mmFinal : null;
    const finalCls  = allocClass(finalPct != null && rowTarget != null ? finalPct - rowTarget : null);
    const finalCell = `<td class="num ${finalCls}">${fmtPct(finalPct)}</td>`;

    // Total MM + MM Prev
    const total     = (mmFinal) + (prevFinal ?? 0);
    const totalCell = `<td class="num">${fmtFinalQty(total)}</td>`;

    return `<tr class="${rowClass} ${areaClass} ${tradedClass}">
      <td>${mm.instrument_name ?? '—'}${shortMark}</td>
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

  // Nota de rodapé: qual target valeu para as linhas marcadas com ↓ (e aviso se faltou o NAV).
  let footTr = '';
  if (usedReduced || missingFactor) {
    const blocked = (posDataByTab[activeTraderTab]?.prev_no_br_equity_short_funds ?? [])
      .map(fl => fl.replace(/-A$/, '')).join(', ') || 'Sulamérica';
    const note = usedReduced
      ? `↓ short de bolsa BR onshore: target ${fmtPct(target * shortFactor)} (= ${fmtPct(target)} × ${
          fmtPct(shortFactor)}) — ${blocked} não pode ficar vendido em bolsa BR e fica fora do trade. `
        + `Posição de risco Brasil negociada fora (EWZ, ADR) não entra na regra.`
      : `↓ short de bolsa BR onshore: target deveria ser reduzido (${blocked} fica fora), mas o NAV do grupo Prev `
        + `não veio — check usando o target cheio de ${fmtPct(target)}.`;
    const color = usedReduced ? 'var(--text-muted)' : 'var(--red)';
    footTr = `<tr><td colspan="6" style="white-space:normal;font-size:11px;color:${color}">${note}</td></tr>`;
  }

  return `<table class="data-table alloc-table" style="white-space:nowrap;width:auto">
    <thead><tr>
      <th>Instrumento</th>
      <th>Abert. MM Prev</th>
      <th>Qtd Operada</th>
      <th>Total MM+Prev</th>
      <th>Check Boleta</th>
      <th>% Alloc Final</th>
    </tr></thead>
    <tbody>${rows}${orphanSection}${footTr}</tbody>
  </table>`;
}

/* ── Fund breakdown table (portfoliorf) ─────────────────────────────────── */
function renderFundBreakTable(mainRows, fundRows, fundNavs, filterFn, offshoreFund) {
  if (!fundRows?.length || !fundNavs) return '';

  const fundLabels = Object.keys(fundNavs).sort();
  const shortLabel = fl => fl.replace('JGP RF Ativa ', '').replace('-A', '');
  // Fundo que recebe 100% do dólar (backend: `portfoliorf_offshore_fund`). Sem ele —
  // payload antigo / snapshot estático — o check cai no comportamento anterior.
  const offFund  = (offshoreFund && fundNavs[offshoreFund] != null) ? offshoreFund : null;
  let   usedOffOnly = false;

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
    // Linha cuja alocação vai 100% para o fundo offshore por desenho (hoje: dólar).
    // O sleeve offshore (`is_offshore`) segue no ramo próprio, sem check.
    const offOnly     = !!r.alloc_offshore_only && !r.is_offshore && !!offFund;
    if (offOnly) usedOffOnly = true;
    // NAV contra o qual o backend calculou o #PL desta linha (`r.nav`): o consolidado nas
    // linhas rateadas, o NAV do fundo offshore nas de dólar. Usar `totalNavSum` fixo
    // reescalaria o #PL por fundo da linha de dólar (29,5/25,1 ≈ +17%).
    const refNav      = r.nav ?? totalNavSum;

    const cells = fundLabels.map(fl => {
      const fr       = byFund[fl];
      const fund_qty = fr?.final_qty ?? 0;
      const navF     = fundNavs[fl];
      const pct      = totalQty !== 0 ? fund_qty / totalQty : null;
      ratioByFund[fl] = navF && totalNavSum ? (navF / totalNavSum) : null;

      let fundPl = null;
      if (!r.is_offshore && groupPl != null && totalQty !== 0 && navF && refNav) {
        fundPl = groupPl * (fund_qty / totalQty) * (refNav / navF);
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
    } else if (offOnly) {
      // Alvo 100% no fundo offshore — NÃO é desligar o check, é trocar o alvo: qtd que
      // vaze para o outro fundo continua sendo acusada.
      const offQty = byFund[offFund]?.final_qty ?? 0;
      const pctOff = totalQty !== 0 ? offQty / totalQty : null;
      const dev    = pctOff != null ? Math.abs(pctOff - 1) : null;
      const lbl    = dev == null ? '—' : dev < 0.01 ? '✓' : `±${(dev * 100).toLocaleString('en-US', {maximumFractionDigits:1})}pp`;
      checkCell = `<td class="${allocClass(dev)}" style="text-align:center" title="Dólar — alvo 100% em ${
        shortLabel(offFund)}, não o rateio por NAV">${lbl}</td>`;
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
    } else if (offOnly) {
      // Só o fundo offshore entra: os demais não carregam a posição por desenho, então
      // compará-los com o #PL do grupo acusaria a ausência esperada.
      const fpOff  = fundPlArr[fundLabels.indexOf(offFund)];
      const devPl  = (groupPl != null && fpOff != null) ? Math.abs(fpOff - groupPl) : null;
      const lblPl  = devPl == null
        ? '<span style="color:var(--text-muted)">—</span>'
        : devPl < 0.01
          ? '<span style="color:var(--green)">✓</span>'
          : `<span class="${allocClass(devPl)}">±${(devPl * 100).toLocaleString('en-US', {maximumFractionDigits:2})}pp</span>`;
      checkPlCell = `<td style="text-align:center" title="Dólar — #PL conferido só em ${
        shortLabel(offFund)}">${lblPl}</td>`;
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

    const offMark = offOnly
      ? ` <span class="alloc-off-only" title="Dólar — alocação 100% em ${shortLabel(offFund)}. `
        + `Alvo do check e denominador do #PL são o NAV desse fundo, não o consolidado.">US$</span>`
      : '';

    return `<tr class="${rowClass} ${areaClass}">
      <td>${r.instrument_name ?? '—'}${offMark}</td>
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

  // Rodapé: diz por que aquelas linhas não seguem o rateio por NAV (a tela não pode
  // trocar o alvo do check em silêncio).
  const footTr = usedOffOnly
    ? `<tr><td colspan="${1 + 3 * fundLabels.length + 2}" style="white-space:normal;font-size:11px;color:var(--text-muted)">`
      + `US$ dólar (WDO/UC, opção DOL/USDBRL, spot-fwd USD/BRL): alocação vai 100% para `
      + `${shortLabel(offFund)} — o check usa esse alvo, não o rateio por NAV, e a exposição `
      + `(#PL) da tabela principal é calculada sobre o NAV desse fundo.</td></tr>`
    : '';

  return `<table class="data-table alloc-table" style="white-space:nowrap;width:auto">
    <thead>
      <tr><th rowspan="2">Instrumento</th>${headers}<th rowspan="2">Check Qtd</th><th rowspan="2">Check #PL</th></tr>
      <tr>${subHeaders}</tr>
    </thead>
    <tbody>${rows}${footTr}</tbody>
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
