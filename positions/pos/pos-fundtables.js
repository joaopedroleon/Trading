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

/* Casa uma linha do livro de MM com a linha espelho de outro grupo (MM Prev · sleeve de
   RF). Non-SWAP: chave exata. SWAP consolidado: base+área+estratégia, com janela de 30
   dias na data representativa (o espelho pode ter menos legs e deslocá-la). */
function makeMirrorLookup(mirrorRows) {
  const byKey      = {};
  const swapGroups = {};
  for (const r of (mirrorRows ?? [])) {
    if (r.swap_detail != null) {
      const gk = `${r.instrument_reference}||${r.area}||${r.subarea}||${r.strategy}`;
      (swapGroups[gk] ??= []).push({ date: r.maturity ? new Date(r.maturity) : null, row: r });
    } else {
      byKey[`${r.instrument_reference}||${r.area}||${r.subarea}||${r.strategy}||${r.maturity ?? ''}`] = r;
    }
  }
  return function (mm) {
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
    return byKey[`${mm.instrument_reference}||${mm.area}||${mm.subarea}||${mm.strategy}||${mm.maturity ?? ''}`] ?? null;
  };
}

function fmtPct(v) {
  return v == null ? '—' : (v * 100).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%';
}

/* ── Bloco "Somente MM Prev" — DESLIGADO por trader (set/2026) ─────────────
   O bloco lista as posições que SÓ o grupo Prev tem (sem par no MM). Pedido da mesa:
   na aba do EMota elas não interessam ao check de enquadramento (ex.: a opção de
   EWZ US Equity, que é do Prev e não do livro dele) e poluem a tabela auxiliar.
   ⚠️ É DESLIGAMENTO TEMPORÁRIO e só de EXIBIÇÃO: nada muda no casamento MM×Prev
   (o `matchedPrev` continua varrendo todas as linhas) nem no backend.
   Para religar, tire o trader do Set — ou esvazie-o para voltar a valer em todas as abas. */
const HIDE_SO_PREV_TRADERS = new Set(['EMota']);

function renderAllocTable(allRows, trader, filterFn = applyFilters) {
  const target   = ALLOC_TARGETS[trader] ?? null;
  // Linha simulada fica FORA do check de alocação MM×MM Prev: ela não tem par no Prev por
  // definição (não existe no Oracle) e apareceria como "0% alocado", um alerta falso.
  const mmRows   = filterFn(sortRows(allRows.filter(r => r.group === 'MM' && r.trader === trader && !r.is_simulated)));
  const visRows  = mmRows.filter(r => !_hiddenForTab(activeTraderTab).has(rowKey(r)));
  const prevRows = allRows.filter(r => r.group === 'MM Prev' && r.trader === trader);

  /* ── Sleeve de RF (out/2026) — 3 colunas à direita, no mesmo espelho do Prev ──────
     O trader boleta ~4% do ticket TAMBÉM no veículo do RF. As colunas só nascem quando
     a aba de fato tem linha de sleeve: num trader que não espelha nada no RF elas
     seriam três colunas de travessão. */
  const rfCfg    = rfSleeveCfg(activeTraderTab);
  const rfGroup  = rfCfg?.group ?? RF_SLEEVE_GROUP_FALLBACK;
  const rfRows   = allRows.filter(r => r.group === rfGroup && r.trader === trader);
  const showRf   = !!rfRows.length;
  const lookupRf = showRf ? makeMirrorLookup(rfRows) : null;
  const NCOL     = showRf ? 9 : 6;

  // Non-SWAPs: chave exata. SWAPs consolidados: agrupa por base+área+estratégia e
  // usa a mesma janela de 30 dias do _consolidate_swaps para correlacionar clusters —
  // o cluster espelhado pode ter menos legs, deslocando a data representativa, mas
  // enquanto a diferença for ≤30 dias é considerado o mesmo grupo.
  // ⚠️ Virou FÁBRICA (out/2026) porque o mesmo casamento serve agora a dois espelhos do
  // livro de MM: o MM Prev (30%) e o sleeve de RF (4%). Duas cópias da regra de SWAP
  // divergiriam na primeira correção.
  const lookupPrev = makeMirrorLookup(prevRows);

  // Posições que SÓ o MM Prev tem (sem correlato no MM): hoje somem desta tabela
  // (que itera o MM). Casamos contra TODAS as linhas MM — não só as visíveis — pra
  // não tratar uma linha MM oculta/filtrada como "sem MM"; depois aplicamos os chips
  // de filtro às órfãs. Renderizadas abaixo, alinhadas com a coluna do Prev.
  // ⚠️ Trader em `HIDE_SO_PREV_TRADERS` não recebe o bloco (ver o topo do arquivo).
  const matchedPrev = new Set();
  for (const mm of allRows.filter(r => r.group === 'MM' && r.trader === trader)) {
    const p = lookupPrev(mm);
    if (p) matchedPrev.add(p);
  }
  const orphanRows = HIDE_SO_PREV_TRADERS.has(trader)
    ? []
    : sortRows(filterFn(prevRows.filter(p => !matchedPrev.has(p))));

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

    // Total dos veículos do livro. ⚠️ Com o sleeve de RF na aba ele entra aqui também —
    // senão a coluna diria "total" somando dois dos três veículos, e o número não bateria
    // com a mesma coluna da tabela de câmbio (pos-fxlegs.js), que soma os três.
    const rfFinal   = showRf ? (lookupRf(mm)?.final_qty ?? 0) : 0;
    const total     = (mmFinal) + (prevFinal ?? 0) + rfFinal;
    const totalCell = `<td class="num">${fmtFinalQty(total)}</td>`;

    return `<tr class="${rowClass} ${areaClass} ${tradedClass}">
      <td>${mm.instrument_name ?? '—'}${shortMark}</td>
      ${prevQtyCell}
      ${tradedCell}
      ${totalCell}
      ${dealCell}
      ${finalCell}
      ${showRf ? rfAllocCells(mmFinal, lookupRf(mm) ? rfFinal : null, rfCfg,
          mm.pl_type === 'pct' ? mm.pl : null,
          lookupRf(mm)?.pl_type === 'pct' ? lookupRf(mm)?.pl : null) : ''}
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
      ${showRf ? '<td class="num" style="color:var(--text-muted)">—</td>'.repeat(3) : ''}
    </tr>`;
  }).join('');
  const orphanSection = orphanRows.length
    ? `<tr class="area-divider"><td colspan="${NCOL}" style="font-weight:600;color:var(--text-muted)">Somente MM Prev</td></tr>${orphanTr}`
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
    footTr = `<tr><td colspan="${NCOL}" style="white-space:normal;font-size:11px;color:${color}">${note}</td></tr>`;
  }

  // Rodapé do sleeve: o 2º check NO AGREGADO — o alvo fixo contra o que os NAVs de hoje
  // pedem para a exposição dar 1/10. É esta linha que acusa quando os 4% envelheceram.
  const rfFootTr = showRf ? `<tr><td colspan="${NCOL}" style="white-space:normal;font-size:11px;color:var(--text-muted)">${rfTargetNote(rfCfg)}</td></tr>` : '';

  return `<table class="data-table alloc-table" style="white-space:nowrap;width:auto">
    <thead><tr>
      <th>Instrumento</th>
      <th>Abert. MM Prev</th>
      <th>Qtd Operada</th>
      <th>${showRf ? 'Total MM+Prev+RF' : 'Total MM+Prev'}</th>
      <th>Check Boleta</th>
      <th>% Alloc Final</th>
      ${showRf ? rfAllocHeadCells(rfCfg) : ''}
    </tr></thead>
    <tbody>${rows}${orphanSection}${footTr}${rfFootTr}</tbody>
  </table>`;
}

/* ── Sleeve de RF: as 3 células do check, usadas pelas DUAS abas ──────────────────────
   `mmQty`/`rfQty` são a quantidade FINAL de cada lado. A conta mora em `rfAllocEval`
   (pos-helpers.js); aqui é só apresentação. */
function rfAllocCells(mmQty, rfQty, cfg, plMm, plRf) {
  const muted = v => `<td class="num" style="color:var(--text-muted)">${v}</td>`;
  const e     = rfAllocEval(mmQty, rfQty, cfg);
  const qtyTd = `<td class="num">${rfQty != null && rfQty !== 0 ? fmtFinalQty(rfQty) : '<span style="color:var(--text-muted)">—</span>'}</td>`;

  let allocTd = muted('—');
  if (e.allocPct != null && e.allocTarget != null) {
    const dpp = (e.allocPct - e.allocTarget) * 100;
    const tip = `${fmtPct(e.allocPct)} contra o alvo de ${fmtPct(e.allocTarget)} `
      + `(${dpp >= 0 ? '+' : ''}${dpp.toLocaleString('en-US', {maximumFractionDigits: 2})}pp).\n`
      + `Verde dentro de ±${(RF_ALLOC_REL_TOL * 100).toFixed(0)}% do alvo, amarelo até o dobro, vermelho além — `
      + `faixa RELATIVA, porque ±2pp num alvo de 4% aceitaria de 2% a 6%.`;
    allocTd = `<td class="num ${rfAllocClass(e.allocPct, e.allocTarget)}" title="${_rfEsc(tip)}">${fmtPct(e.allocPct)}</td>`;
  } else if (e.allocPct == null) {
    allocTd = `<td class="num" style="color:var(--text-muted)" title="${_rfEsc('Sem posição no MM para comparar.')}">—</td>`;
  }

  let expTd = muted('—');
  if (e.expRatio != null && e.expTarget != null) {
    /* ⭐ Os DOIS números por extenso, que é como a mesa enuncia a regra ("1% no RF é 10% no
       MM"). O #PL do lado do RF vem da própria linha (o backend já o calculou contra o NAV
       do fundo que detém o veículo); o do MM vem da linha de MM quando ela está na tela e,
       quando não está (aba do PortfolioRF), é DERIVADO — exato, porque preço e tamanho de
       contrato são os mesmos: pl_MM = pl_RF × (q_MM/q_RF) × (NAV_RF/NAV_MM). */
    const plMmEff = (plMm != null) ? plMm
      : (plRf != null && rfQty ? plRf * (mmQty / rfQty) / e.navRatio : null);
    const detalhe = (plRf != null && plMmEff != null)
      ? `\n\nNesta linha: RF ${(plRf * 100).toFixed(2)}% do NAV do RF · `
        + `MM ${(plMmEff * 100).toFixed(2)}% do NAV do MM`
        + (plMm != null ? '' : ' (derivado da linha do RF)') + '.'
      : '';
    const tip = `A exposição desta linha no RF é ${fmtPct(e.expRatio)} da exposição dela no MM `
      + `(cada uma em % do NAV do seu fundo). Alvo: ${fmtPct(e.expTarget)}.${detalhe}\n\n`
      + `Preço e tamanho de contrato cancelam (é o mesmo instrumento dos dois lados), então `
      + `isto é a razão de quantidade × NAV_MM/NAV_RF = `
      + `${fmtPct(e.allocPct)} × ${e.navRatio.toLocaleString('en-US', {maximumFractionDigits: 3})}.`;
    expTd = `<td class="num ${rfAllocClass(e.expRatio, e.expTarget)}" title="${_rfEsc(tip)}">${fmtPct(e.expRatio)}</td>`;
  } else if (e.allocPct != null) {
    expTd = `<td class="num" style="color:var(--text-muted)" title="${_rfEsc('Falta o NAV de um dos dois lados — a razão de exposição não é afirmada.')}">—</td>`;
  }
  return qtyTd + allocTd + expTd;
}

function rfAllocHeadCells(cfg) {
  const t  = cfg?.alloc_target, x = cfg?.exposure_ratio;
  const fn = (cfg?.fund ?? '').replace(/^JGP /, '');
  return `<th title="${_rfEsc('Quantidade FINAL (abertura + boletas de hoje) no veículo do RF: ' + fn + '.')}">Qtd RF</th>`
    + `<th title="${_rfEsc('Quantidade no RF ÷ quantidade no MM, contra o alvo FIXO que a mesa boleta'
        + (t != null ? ' (' + fmtPct(t) + ')' : '') + '. É o check da BOLETA.')}">% Aloc RF${t != null ? ' · alvo ' + fmtPct(t) : ''}</th>`
    + `<th title="${_rfEsc('Exposição da linha no RF (em % do NAV do RF) ÷ exposição dela no MM (em % do NAV do MM). '
        + 'É o check da REGRA' + (x != null ? ': o RF carrega ' + fmtPct(x) + ' do que o MM carrega' : '') + '.')}">Exp. RF ÷ MM${x != null ? ' · alvo ' + fmtPct(x) : ''}</th>`;
}

/* ── DERIVA DO ALVO — o 2º check no agregado ──────────────────────────────────────────
   ⭐ **É este o número que diz se a proporção fixa precisa ser trocada**, e por quanto
   (pedido da mesa: "se o NAV do Abinader ou do RF mudarem significativamente, o check deve
   apontar para quanto deve ir essa nova proporção").

   O alvo COMBINADO (`alloc_target`, 4,4%) contra o alvo que os NAVs de HOJE pedem para a
   exposição dar exatamente 1/10 (`navTarget = exposure_ratio × NAV_RF / NAV_MM`). Eles
   coincidem no dia em que foram combinados e vão se afastando conforme um dos dois NAVs
   anda — captação, resgate, resultado.
   ⛔ A tela PROPÕE o número novo; quem troca o `RF_SLEEVE_ALLOC_TARGET` é a mesa. Atualizar
   sozinho calaria exatamente este aviso. */
function _rfDrift(cfg) {
  const e   = rfAllocEval(null, null, cfg);
  const tol = cfg?.drift_tol ?? 0.05;
  if (e.navTarget == null || e.allocTarget == null) return { e, tol, rel: null, nivel: 'semnav' };
  const rel = e.allocTarget / e.navTarget - 1;   // COM sinal: + = boletando demais
  const a   = Math.abs(rel);
  return { e, tol, rel, nivel: a <= tol ? 'ok' : a <= 2 * tol ? 'atencao' : 'trocar' };
}

/* Painel do sleeve, no topo da aba. ⚠️ Sai MESMO SEM LINHA BOLETADA: ele é sobre os NAVs, e
   é justamente antes da 1ª boleta (ou num dia parado) que a mesa pergunta se a proporção
   ainda vale. */
function renderRfTargetBanner(cfg) {
  if (!cfg) return '';
  const { e, tol, rel, nivel } = _rfDrift(cfg);
  const usd = v => v == null ? '—'
    : 'USD ' + Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 });
  const tr    = cfg.traders?.[0] ?? 'trader';
  const navMm = cfg.mm_nav?.[tr];

  const COR = { semnav: 'var(--yellow)', ok: 'var(--green)',
                atencao: 'var(--yellow)', trocar: 'var(--red)' }[nivel];

  let veredito, detalhe;
  if (nivel === 'semnav') {
    veredito = '⚠ sem os dois NAVs — não dá para conferir';
    detalhe  = `Falta ${cfg.nav == null ? 'o NAV do ' + (cfg.nav_fund ?? 'RF') : 'o NAV de MM do ' + tr}`
             + ' nesta data. O alvo da boleta segue valendo, mas hoje ele não está sendo conferido.';
  } else {
    const dpp  = (e.allocTarget - e.navTarget) * 100;
    const sinal = rel > 0 ? 'ACIMA' : 'abaixo';
    veredito = nivel === 'ok'
      ? `✓ em dia — os NAVs de hoje pedem ${fmtPct(e.navTarget)}`
      : nivel === 'atencao'
        ? `⚠ começando a divergir — os NAVs de hoje pedem ${fmtPct(e.navTarget)}`
        : `⚠ ATUALIZAR PARA ${fmtPct(e.navTarget)}`;
    /* O desvio só é enunciado quando EXISTE: num dia em dia a frase "está 0pp abaixo disso
       (-0%)" é ruído, e pior, treina a mesa a não ler a linha. */
    const temDesvio = Math.abs(dpp) >= 0.01;
    detalhe = `Para o RF carregar <b>${fmtPct(e.expTarget)}</b> da exposição do ${tr} `
      + `(cada uma em % do NAV do seu fundo), a boleta precisa sair em `
      + `<b>${fmtPct(e.navTarget)}</b> do ticket de MM.`
      + (temDesvio
          ? ` O alvo combinado está ${Math.abs(dpp).toLocaleString('en-US', {maximumFractionDigits: 2})}pp `
            + `${sinal} disso (${rel > 0 ? '+' : '−'}${Math.abs(rel * 100).toLocaleString('en-US', {maximumFractionDigits: 1})}%).`
          : ' É onde ele está.')
      + (nivel === 'trocar'
          ? ` <b>Trocar com a mesa</b> — e, combinado, <code>RF_SLEEVE_ALLOC_TARGET</code> em `
            + `<code>positions/funds.py</code> para <code>${e.navTarget.toFixed(4)}</code>.`
          : '');
  }

  const navLinha = `NAV do RF <b>${usd(cfg.nav)}</b> `
    + `<span style="color:var(--text-muted)">(${(cfg.nav_fund ?? '—').replace(/^JGP /, '')}`
    + `${cfg.nav_date ? ' · ' + fmtDate(cfg.nav_date) : ''}${cfg.nav_source ? ' · ' + cfg.nav_source : ''})</span>`
    + ` &nbsp;·&nbsp; NAV de MM do ${tr} <b>${usd(navMm)}</b>`
    + (cfg.nav && navMm
        ? ` &nbsp;·&nbsp; <span style="color:var(--text-muted)" title="${_rfEsc(
            'É esta razão que manda no alvo: alvo = ' + fmtPct(e.expTarget) + ' ÷ (NAV_MM/NAV_RF). '
            + 'A razão que sustenta o alvo combinado é ' + (e.expTarget / e.allocTarget).toFixed(3) + '.')
          }">razão ${(navMm / cfg.nav).toLocaleString('en-US', {maximumFractionDigits: 3})} `
          + `(sustenta o alvo combinado: ${(e.expTarget / e.allocTarget).toLocaleString('en-US', {maximumFractionDigits: 3})})</span>`
        : '');

  const semLinha = !cfg.n_rows
    ? ` <span style="color:var(--text-muted);font-weight:400;font-size:11px" title="${_rfEsc(
        'Nenhuma posição do ' + tr + ' no ' + (cfg.fund ?? 'veículo') + ' nesta data. O painel acima é '
        + 'sobre os NAVs e vale assim mesmo; as tabelas de check só aparecem quando houver linha.')
      }">· sem linha boletada hoje</span>`
    : '';

  return `<div class="card" style="border-left:3px solid ${COR};flex:0 0 auto">
    <div style="font-size:12px;line-height:1.7">
      <b>Sleeve de RF — alvo da boleta ${fmtPct(e.allocTarget)}</b>
      <span style="color:${COR};font-weight:600">&nbsp;&nbsp;${veredito}</span>${semLinha}
      <div style="color:var(--text-primary);margin-top:2px">${detalhe}</div>
      <div style="margin-top:2px">${navLinha}</div>
    </div>
  </div>`;
}

/* Resumo de UMA linha para o rodapé das tabelas de check — o recado longo mora no painel. */
function rfTargetNote(cfg) {
  const { e, nivel } = _rfDrift(cfg);
  if (nivel === 'semnav') {
    return `<span style="color:var(--yellow)">Alvo da boleta `
         + `${e.allocTarget != null ? fmtPct(e.allocTarget) : '—'} — sem os dois NAVs, não conferido hoje.</span>`;
  }
  const cor = { ok: 'var(--text-muted)', atencao: 'var(--yellow)', trocar: 'var(--red)' }[nivel];
  const fim = nivel === 'ok' ? 'os dois dizem a mesma coisa.'
            : `<b>os ${fmtPct(e.allocTarget)} deixaram de ser ${fmtPct(e.expTarget)} de exposição `
              + `— ver o painel no topo da aba.</b>`;
  return `<span style="color:${cor}">Alvo da boleta <b>${fmtPct(e.allocTarget)}</b> · `
       + `pelos NAVs de hoje <b>${fmtPct(e.navTarget)}</b> — ${fim}</span>`;
}

const _rfEsc = t => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/* ── Card do sleeve na aba do PortfolioRF ─────────────────────────────────────────────
   Lá as linhas de MM do outro trader NÃO estão na tela (a aba é do PortfolioRF), então o
   lado do MM vem do backend em `rf_sleeve.mm_rows` — só quantidades, que é tudo de que os
   dois checks precisam. A tabela itera as linhas do SLEEVE (é o que a aba mostra), não as
   do MM: o que interessa aqui é "o que chegou no RF está na proporção?". */
function renderRfSleeveCheck(rfRows, cfg, filterFn) {
  if (!cfg || !rfRows?.length) return '';
  const lookupMm = makeMirrorLookup(cfg.mm_rows ?? []);
  const visRows  = filterFn(sortRows(rfRows.filter(r => !_hiddenForTab(activeTraderTab).has(rowKey(r)))));
  if (!visRows.length) return '';

  let prevArea = null, prevSubarea = null, subareaIdx = -1;
  const body = visRows.map((r, i) => {
    const newArea    = r.area    !== prevArea;
    const newSubarea = r.subarea !== prevSubarea;
    if (newSubarea) subareaIdx++;
    const rowClass  = subareaIdx % 2 === 0 ? 'group-odd' : 'group-even';
    const areaClass = newArea && i > 0 ? 'area-divider' : '';
    prevArea = r.area; prevSubarea = r.subarea;
    const mm = lookupMm(r);
    return `<tr class="${rowClass} ${areaClass}">
      <td class="num">${mm?.final_qty != null ? fmtFinalQty(mm.final_qty) : '<span style="color:var(--text-muted)">—</span>'}</td>
      ${rfAllocCells(mm?.final_qty ?? null, effectiveRowValues(r).final ?? r.final_qty ?? 0, cfg,
          null, r.pl_type === 'pct' ? r.pl : null)}
    </tr>`;
  }).join('');

  const semMm = visRows.filter(r => !lookupMm(r)).length;
  const avisoMm = semMm
    ? `<tr><td colspan="4" style="white-space:normal;font-size:11px;color:var(--yellow)">`
      + `⚠ ${semMm} linha(s) do sleeve sem posição correspondente no book de MM de `
      + `${(cfg.traders ?? []).join(', ')} — o check não é afirmado nelas (pode ser perna que `
      + `só existe no RF, ou casamento por instrumento que não fechou).</td></tr>`
    : '';

  return `<table class="data-table alloc-table" style="white-space:nowrap;width:auto">
    <thead><tr>
      <th title="${_rfEsc('Quantidade FINAL do mesmo instrumento no book de MM do trader do sleeve. '
        + 'Não está na tabela ao lado (a aba é do PortfolioRF) — vem do backend só para este check.')}">Qtd MM</th>
      ${rfAllocHeadCells(cfg)}
    </tr></thead>
    <tbody>${body}${avisoMm}
      <tr><td colspan="4" style="white-space:normal;font-size:11px;color:var(--text-muted)">${rfTargetNote(cfg)}</td></tr>
    </tbody>
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
    if (s.group === (data.rf_sleeve?.group ?? RF_SLEEVE_GROUP_FALLBACK) && data.rf_sleeve?.mm_rows?.length) {
      const spacerEl = document.getElementById(`rf_check_spacer_${tabId}`);
      const outerEl  = document.getElementById(`rf_check_outer_${tabId}`);
      const posFirst = document.getElementById(sectionBodyId(s))?.rows[0];
      const rThead   = document.querySelector(`#rf_check_${tabId} thead`);
      if (spacerEl && outerEl && posFirst && rThead) {
        const h = Math.max(0, posFirst.getBoundingClientRect().top
                              - outerEl.getBoundingClientRect().top - rThead.offsetHeight);
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
