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
      if (el) el.innerHTML = renderFundBreakTable(rows, data.fund_rows, data.fund_navs, filterRows, data.portfoliorf_offshore_fund);
    }
  }
  /* Re-alinha as tabelas auxiliares (alocação MM×Prev, break por fundo), que casam pelo TOPO
     da 1ª linha da tabela principal. Passou a ser necessário quando a tira "NET por grupo"
     subiu para CIMA da tabela (set/2026): ligar/desligar um filtro pode fazer um grupo sumir
     e a tira encolher de 2 linhas para 1 — o que desloca a tabela e desalinharia a auxiliar.
     Enquanto a tira ficava abaixo da tabela, nada acima dela mudava de altura. */
  requestAnimationFrame(() => _alignAuxTables(activeTraderTab));
}

/* ── Análise de Opções (na aba dedicada; blocos por objeto + vencimento) ── */

/* ── Dois predicados PARECIDOS e de propósito diferente — não fundir ──────────
   `_isDolUsdbrlOpt` responde "esta linha é do bloco DOL / USDBRL?" (AGRUPAMENTO: é o par
   que a tabela irmã Consolidado Dólar consolida). `_isBrlOpt` responde "é opção contra o
   BRL?" (SELEÇÃO default). EURBRL separa os dois: é BRL, mas não é dólar.
   `option_subtype === 'dol'` é opção de DOL **BMF** (o backend a separa do 'fx' genérico
   pelo nome começando em "DOL" — positions/router.py).
   ⚠️ `_isDolUsdbrlOpt` exige USD **e** BRL. Era só `includes('BRL')`, o que bastava
   enquanto o rótulo `option_undl` de um `Digital_EURBRL…` saía quebrado ("IGITAL") e não
   casava com nada; com o rótulo correto (set/2026) aquele teste jogaria a EURBRL no bloco
   do dólar. Mesmo aperto no `_dollarKind` (pos-dolar.js) e no `dollar_kind` (Python).
   ⚠️ `toUpperCase()` p/ casar com o `_dollarKind`, que classifica a tabela IRMÃ na MESMA
   aba e já normalizava — sem isso as duas discordariam de um `usdbrl` minúsculo. */
function _optUndlName(r) {
  return (r.option_undl || r.instrument_name || '').toUpperCase();
}
function _isDolUsdbrlOpt(r) {
  const undl = _optUndlName(r);
  return r.option_subtype === 'dol' || (r.option_subtype === 'fx' && undl.includes('USD') && undl.includes('BRL'));
}
function _isBrlOpt(r) {
  const undl = _optUndlName(r);
  return r.option_subtype === 'dol' || (r.option_subtype === 'fx' && undl.includes('BRL'));
}

/* Preço de REFERÊNCIA do resultado de uma linha de opção.
   É a mesma base que o breakdown de PnL do backend (positions/pricing/pnl.py) usa:
     • `r.price` = marcação de D-1 (JRS) → base do ESTOQUE;
     • sem D-1 (opção ABERTA HOJE — não tem linha no JRS, ver `optMaturity`) → o preço
       MÉDIO das boletas do dia, que é a base de COMPRA/VENDA.
   ⚠️ Quando o dia teve as DUAS pontas, o médio exibido é ponderado pela quantidade
   (`bq`/`sq` chegam do backend como MAGNITUDES, nunca negativas — `avg_*_price` só é
   preenchido `where(qty > 0)`). É resumo de EXIBIÇÃO: a conta continua separando compra de
   venda (o `pnlFor` não usa este número), por isso as duas pontas vão no title da célula. */
function _optResultRef(r) {
  if (r.price != null) return { px: r.price, kind: 'd1' };
  const ab = r.avg_buy_price  != null ? r.avg_buy_price  : null;
  const av = r.avg_sell_price != null ? r.avg_sell_price : null;
  const bq = Math.abs(r.buy_qty  || 0);
  const sq = Math.abs(r.sell_qty || 0);
  if (ab != null && av != null && (bq + sq) > 0)
    return { px: (ab * bq + av * sq) / (bq + sq), kind: 'medio', ab, av };
  if (ab != null) return { px: ab, kind: 'medio', ab, av: null };
  if (av != null) return { px: av, kind: 'medio', ab: null, av };
  return { px: null, kind: null };
}

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
    /* RESULTADO: não se recalcula aqui. `pnlFor` (pnl.js) é a MESMA função que a aba de PnL
       do trader usa — estoque (D-1) + compra + venda, a partir do preço EFETIVO, ou seja a
       marreta ★ desta tela também move o resultado, como já move prêmio e exposições.
       Guarda de `typeof`: o `pnl.js` carrega DEPOIS dos módulos `pos/*` (ver positions.html);
       em runtime já está lá, mas um consumidor que carregue só os `pos/*` degrada p/ "—" em
       vez de estourar a tabela inteira. */
    const ref = _optResultRef(r);
    const pf  = (typeof pnlFor === 'function') ? pnlFor(r) : null;
    const res = pf && isFinite(pf.total) ? pf.total : null;
    const bps = pf && isFinite(pf.bps)   ? pf.bps   : null;
    return { price, delta, src, premium, dPct, dUsd, nPct, nUsd, edited, ref, res, bps };
  };

  // agrupar por ativo objeto + vencimento, com exceções:
  //  • DOL e USDBRL no mesmo bloco
  //  • ações do mesmo ativo objeto no mesmo bloco (ignora vencimento)
  const groups = new Map();
  for (const r of opts) {
    const sub  = r.option_subtype;
    let undl   = r.option_undl || r.instrument_name || '—';
    // Vencimento EFETIVO (JRS, ou lido do nome quando o JRS não traz — ver `optMaturity`):
    // sem isso a opção aberta hoje caía num bloco "sem vencimento" separado do resto da
    // mesma série, e o Total do bloco não era o da série.
    const om   = optMaturity(r);
    let mat    = om.iso || '';
    let matDrv = om.derived;
    if (_isDolUsdbrlOpt(r)) undl = 'DOL / USDBRL';
    if (sub === 'us_equity') { mat = ''; matDrv = false; }   // ações: mesmo objeto junto, mesmo com vencimentos diferentes
    const gkey = `${undl}||${mat}`;
    if (!groups.has(gkey)) groups.set(gkey, { undl, mat, matDrv: false, rows: [] });
    groups.get(gkey).rows.push(r);
    if (matDrv) groups.get(gkey).matDrv = true;
  }
  const sorted = [...groups.values()].sort((a, b) =>
    a.undl.localeCompare(b.undl, 'en-US', { sensitivity: 'base' }) ||
    String(a.mat).localeCompare(String(b.mat)));

  /* Seleção default (só na 1ª vez que a linha aparece): marcada se AINDA TEM POSIÇÃO
     **e não for opção contra o BRL** (`_isBrlOpt`) — DOL BMF, USDBRL e também EURBRL.
     Começou em ago/2026 com DOL/USDBRL, que já têm tabela própria logo acima nesta mesma
     aba (Consolidado Dólar); em set/2026 a mesa estendeu a QUALQUER opção de BRL, então o
     critério deixou de ser "já aparece na tabela irmã" e passou a ser a MOEDA — por isso
     um predicado próprio, e não o `_isDolUsdbrlOpt` do agrupamento.
     Continua sendo só o DEFAULT: o checkbox por linha manda, e "Só com posição" traz as de
     BRL de volta em um clique. */
  for (const r of opts) {
    const k = rowKey(r);
    if (!optPrintSel.has(k)) {
      optPrintSel.set(k, Number(r.final_qty || 0) !== 0 && !_isBrlOpt(r));
    }
  }
  const isSel = r => optPrintSel.get(rowKey(r)) !== false;
  const nSel  = opts.filter(isSel).length;

  const NCOL = 15;   // checkbox + instrumento + 3 qtds + bid/mid/ask + delta + prêmio + 2 exps + 3 result
  // Cabeçalho em DUAS linhas, no padrão `um-table` do US Monitor: a 1ª agrupa as colunas
  // por natureza, a 2ª nomeia cada uma. Não é só estética — pôr BID · MID · ASK sob um
  // grupo "Preço (BBG)" mostra de relance que o mid está ENTRE os dois, que é a coisa
  // que a tabela precisa afirmar. As colunas soltas usam rowspan=2.
  const head = `<thead>
    <tr>
      <th rowspan="2" class="center col-sel" style="width:26px"
          title="Linhas marcadas entram no ⎘ Copiar (o Total da tela soma o bloco inteiro)"><input type="checkbox"
          ${nSel === opts.length ? 'checked' : ''} onclick="optSelAll(this.checked)" style="cursor:pointer"></th>
      <th rowspan="2" class="left">Instrumento</th>
      <th colspan="3" class="center sep">Quantidade</th>
      <th colspan="3" class="center sep"
          title="BID e ASK são de tela (PX_BID/PX_ASK) e só existem em opção LISTADA. Só o MID entra nas contas.">Preço (BBG)</th>
      <th rowspan="2" class="sep">Delta</th>
      <th colspan="3" class="center sep">Exposição</th>
      <th colspan="3" class="center sep"
          title="Mesmo cálculo da aba de PnL do trader: estoque (D-1) + compra + venda, sobre o preço MID desta tabela.">Resultado</th>
    </tr>
    <tr>
      <th class="sep">Abertura</th>
      <th>Operada</th>
      <th>Final</th>
      <th class="sep" title="BID de tela (PX_BID) — só opção LISTADA. Referência: NÃO entra em nenhuma conta.">BID</th>
      <th title="Preço usado em TODAS as contas derivadas (prêmio e exposições). Passe o mouse na célula p/ ver o campo BBG.">MID ◂</th>
      <th title="ASK de tela (PX_ASK) — só opção LISTADA. Referência: NÃO entra em nenhuma conta.">ASK</th>
      <th class="sep">Prêmio USD</th>
      <th>Nominal</th>
      <th>Delta</th>
      <th class="sep" title="Base do resultado: a marcação de D-1 (JRS). Sem D-1 (opção aberta HOJE), o preço MÉDIO das boletas do dia.">D-1 / Médio</th>
      <th title="Resultado em USD = estoque (D-1 → MID) + compra + venda. Mesma conta da aba de PnL.">USD</th>
      <th title="Resultado sobre o NAV do trader, em bps.">bps</th>
    </tr>
  </thead>`;

  const body = sorted.map((g, gi) => {
    /* DOIS totais por bloco, e os dois vão para o DOM:
       • `t*` = TODAS as linhas do bloco — é o que a TELA mostra. O checkbox é filtro de
         IMPRESSÃO, então desmarcar não pode apagar o total (era o sintoma: bloco todo
         desmarcado somava 0 e o `fmtMoney`/`fmtExp` pintam 0 como "—", ou seja, a linha
         de Total aparecia vazia). Pedido da mesa, ago/2026 — inverte a regra anterior.
       • `s*` = só as linhas MARCADAS — fica numa <tr> escondida por CSS (`.tot-print`) que
         o `copyOptAnalysisImage` troca no lugar da outra, para a IMAGEM fechar com as
         linhas que ela de fato mostra. Calcular aqui evita re-render no clique do Copiar. */
    let tPrem = 0, tDUsd = 0, tDPct = 0, tNUsd = 0, tNPct = 0, tRes = 0, tBps = 0;
    let sPrem = 0, sDUsd = 0, sDPct = 0, sNUsd = 0, sNPct = 0, sRes = 0, sBps = 0;
    const rowsHtml = sortRows(g.rows).map(r => {
      const m   = metric(r);
      const sel = isSel(r);
      if (m.premium != null) { tPrem += m.premium; if (sel) sPrem += m.premium; }
      if (m.dUsd != null)    { tDUsd += m.dUsd;    if (sel) sDUsd += m.dUsd; }
      if (m.dPct != null)    { tDPct += m.dPct;    if (sel) sDPct += m.dPct; }
      if (m.nUsd != null)    { tNUsd += m.nUsd;    if (sel) sNUsd += m.nUsd; }
      if (m.nPct != null)    { tNPct += m.nPct;    if (sel) sNPct += m.nPct; }
      /* bps somado LINHA A LINHA (e não total/NAV): cada linha já vem dividida pelo SEU nav,
         e na aba PortfolioRF o nav difere entre linha onshore e offshore — é a mesma regra
         que as colunas de exposição em %NAV logo acima já seguem. */
      if (m.res != null)     { tRes  += m.res;     if (sel) sRes  += m.res; }
      if (m.bps != null)     { tBps  += m.bps;     if (sel) sBps  += m.bps; }
      const isFx     = r.option_subtype === 'fx';
      const safeIk   = instKey(r).replace(/"/g, '&quot;');
      const safeRk   = rowKey(r).replace(/"/g, '&quot;');
      const priceFmt = isFx ? fmtPricePct(m.price) : fmtOptPx(m.price);
      const deltaFmt = m.delta != null
        ? m.delta.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 }) : '—';
      const star     = m.edited ? '<span style="color:var(--accent);font-size:10px">★ </span>' : '';
      // origem do preço (igual ao PnL): BBG → boleta → D-1 → manual
      const srcMap   = { bbg: ['BBG', 'var(--green)'], boleta: ['Boleta', 'var(--yellow)'], d1: ['D-1', 'var(--red)'], manual: ['Manual', 'var(--accent)'] };
      const [srcLbl, srcColor] = srcMap[m.src] || ['—', ''];
      const priceStyle = `cursor:pointer;${srcColor ? `color:${srcColor}` : ''}`;
      // Hover do preço: QUAL campo da BBG (com overrides) produziu este número.
      const priceTip = m.src === 'manual'
        ? 'Marreta manual (★) — sobrepõe o preço da BBG · clique para editar'
        : `Fonte: ${srcLbl} — ${priceSrcLabel(m.src, r.price_live_kind)} · clique para editar`;
      // ⚠️ A coluna se chama "(mid)", mas a cadeia do backend cai p/ PX_LAST quando a BBG não
      // tem mid two-sided (ilíquido/OTM/pré-abertura) — e aí a conta NÃO saiu de um mid. Marca
      // essas linhas com * em vez de deixar o rótulo da coluna mentir em silêncio.
      const notMid = m.src !== 'manual' && r.price_live_kind === 'last';
      const midMark = notMid
        ? '<span style="color:var(--yellow)" title="sem mid two-sided na BBG — este número é o PX_LAST">*</span>'
        : '';
      const deltaTip = deltaOverrides.has(instKey(r))
        ? 'Marreta manual (★) — sobrepõe o delta da BBG · clique para editar'
        : `Delta: ${deltaSrcLabel(r.option_delta_field)} · clique para editar`;
      // BID/ASK: só opção listada (ações, ETFs e futuros). FX e DOL BMF ficam com traço.
      const isListed = r.option_subtype === 'futures' || r.option_subtype === 'us_equity';
      const sideFmt  = v => (!isListed ? '<span style="color:var(--text-muted)">—</span>'
                            : v == null ? '<span style="color:var(--text-muted)">n/d</span>'
                            : fmtOptPx(v));
      const sideTip  = !isListed
        ? 'Opção de FX / DOL BMF: preço vem do FXOPT_PRICE (sem bid/ask two-sided de tela)'
        : 'Referência de mercado — não entra em nenhuma conta desta tabela';
      // Base do resultado. Sem realce de cor: quem é médio (em vez de D-1) se diz no title
      // — pedido da mesa, ago/2026. A coluna fica nas cores normais da tabela.
      const pxFmt   = v => (isFx ? fmtPricePct(v) : fmtOptPx(v));
      const refFmt  = m.ref.px == null
        ? '<span style="color:var(--text-muted)">—</span>' : pxFmt(m.ref.px);
      const refTip  = m.ref.kind === 'd1'
        ? 'Marcação de D-1 (JRS) — base do resultado de ESTOQUE'
        : m.ref.kind === 'medio'
          ? 'Sem marcação de D-1 (posição ABERTA HOJE): preço médio das boletas do dia'
            + (m.ref.ab != null ? ` · C ${pxFmt(m.ref.ab)}` : '')
            + (m.ref.av != null ? ` · V ${pxFmt(m.ref.av)}` : '')
            + (m.ref.ab != null && m.ref.av != null
               ? ' (o exibido é a média ponderada pela quantidade; a conta separa as duas pontas)' : '')
          : 'Sem D-1 e sem boleta — não há base de resultado para esta linha';
      return `<tr data-optrow="${safeRk}" data-optsel="${sel ? 1 : 0}" data-optgrp="${gi}">
        <td class="sel col-sel"><input type="checkbox" ${sel ? 'checked' : ''}
            onclick="optSelRow('${safeRk.replace(/'/g, "\\'")}', this.checked)" style="cursor:pointer"></td>
        <td class="lbl">${star}${r.instrument_name ?? '—'}</td>
        <td class="sep">${fmtFinalQty(r.opening_qty)}</td>
        <td>${fmtTradedQty(r.traded_qty)}</td>
        <td>${fmtFinalQty(r.final_qty)}</td>
        <td class="sep" title="${sideTip}">${sideFmt(r.price_bid)}</td>
        <td class="val" style="${priceStyle}" title="${priceTip}" data-instkey="${safeIk}" data-kind="price" data-isfx="${isFx ? 1 : 0}" onclick="optEditStart(this)">${priceFmt}${midMark}</td>
        <td title="${sideTip}">${sideFmt(r.price_ask)}</td>
        <td class="sep" style="cursor:pointer" title="${deltaTip}" data-instkey="${safeIk}" data-kind="delta" onclick="optEditStart(this)">${deltaFmt}</td>
        <td class="sep">${fmtMoney(m.premium)}</td>
        <td>${fmtExp(m.nUsd, m.nPct)}</td>
        <td>${fmtExp(m.dUsd, m.dPct)}</td>
        <td class="sep" title="${refTip}">${refFmt}</td>
        <td>${fmtMoney(m.res)}</td>
        <td>${fmtBps(m.bps)}</td>
      </tr>`;
    }).join('');
    // Subgrupo = faixa clara DENTRO do corpo (padrão `um-table`). O respiro entre blocos
    // vem do padding-top da própria faixa — não há mais linha vazia de 18px.
    const matLbl = g.mat ? ` — ${fmtDate(g.mat)}${g.matDrv ? '~' : ''}` : '';
    const matTip = g.matDrv
      ? ' title="Vencimento (~) lido do NOME do instrumento — o JRS não trouxe maturity para ao menos uma linha deste bloco."' : '';
    const header = `<tr class="grp" data-optgrp="${gi}"><td colspan="${NCOL}"${matTip}>${g.undl}${matLbl}</td></tr>`;
    const totalRow = (prem, nUsd, nPct, dUsd, dPct, res, bps, cls, kind) => `<tr class="tot${cls}" data-optgrp="${gi}" data-tot="${kind}">
        <td class="sel col-sel"></td>
        <td class="lbl">Total</td>
        <td class="sep"></td><td></td><td></td>
        <td class="sep"></td><td></td><td></td>
        <td class="sep"></td>
        <td class="sep">${fmtMoney(prem)}</td>
        <td>${fmtExp(nUsd, nPct)}</td>
        <td>${fmtExp(dUsd, dPct)}</td>
        <td class="sep"></td>
        <td>${fmtMoney(res)}</td>
        <td>${fmtBps(bps)}</td>
      </tr>`;
    const total = totalRow(tPrem, tNUsd, tNPct, tDUsd, tDPct, tRes, tBps, '', 'all')
                + totalRow(sPrem, sNUsd, sNPct, sDUsd, sDPct, sRes, sBps, ' tot-print', 'sel');
    return header + rowsHtml + total;
  }).join('');

  container.innerHTML = `<div class="card">
    <div class="section-title" style="padding:8px 0 10px 0;display:flex;align-items:center;gap:16px">
      <span>Análise de Opções <span style="font-weight:400;color:var(--text-muted);font-size:13px">— ${dolarConsolTrader} (MM)</span></span>
      <span data-html2canvas-ignore="true" style="font-weight:400;color:var(--text-muted);font-size:12px">${nSel}/${opts.length} linhas marcadas</span>
      <button class="btn btn-secondary" data-html2canvas-ignore="true" style="padding:3px 12px;font-size:12px;margin-left:auto" onclick="optSelAll(true)">Marcar todas</button>
      <button class="btn btn-secondary" data-html2canvas-ignore="true" style="padding:3px 12px;font-size:12px" title="Marca toda linha com posição final ≠ 0 — INCLUSIVE as opções contra o BRL (DOL BMF, USDBRL, EURBRL), que o default deixa desmarcadas." onclick="optSelWithPosition()">Só com posição</button>
      <button class="btn btn-secondary" data-html2canvas-ignore="true" style="padding:3px 12px;font-size:12px" onclick="copyOptAnalysisImage(this)">⎘ Copiar</button>
    </div>
    <!-- max-width:100% e o que faz o wrap de rolagem funcionar: .section-copy-target e
         width:fit-content (positions.html), logo sem teto ele cresce ate a tabela (1.338px)
         e o overflow-x:auto de dentro nunca chega a apertar nada. Com o teto, o alvo para na
         largura do card e a tabela rola DENTRO dele - e a nota de rodape (width:0;
         min-width:100%) volta a quebrar na largura visivel em vez de na da tabela.
         Inline, e nao no CSS: .section-copy-target veste outros 3 blocos da tela. -->
    <div class="section-copy-target" style="max-width:100%">
      <p class="csub jgp-tbl-note" style="margin:0 0 8px;font-size:11.5px;color:var(--text-muted);line-height:1.5">
        Um subgrupo por <b>ativo objeto + vencimento</b>, com Total próprio. Toda conta derivada
        (Prêmio, as duas exposições e o <b>Resultado</b>) sai do <b>MID</b> — BID e ASK ficam ao
        lado só como referência de mercado, e por isso o MID aparece entre os dois.
      </p>
      <!-- Rolagem lateral DENTRO do card, nunca da pagina: com o bloco Resultado a tabela
           passa de 1.100 p/ ~1.340px e, abaixo de ~1.370px de viewport, o document inteiro
           comecava a rolar de lado (medido: doc 1386 x win 1366). Mesmo padrao do detalhe da
           aba de PnL (overflow-x:auto no wrap). O copyOptAnalysisImage NEUTRALIZA este
           wrap na captura - senao a imagem sairia cortada na largura visivel. -->
      <div class="opt-tbl-scroll" style="overflow-x:auto">
        <table class="jgp-tbl" id="optAnalysisTable">
          ${head}
          <tbody>${body}</tbody>
        </table>
      </div>
      <div class="opt-calc-note jgp-tbl-note" style="margin-top:8px;font-size:11.5px;color:var(--text-muted);line-height:1.5">
        BID/ASK (<code>PX_BID</code>/<code>PX_ASK</code>) existem apenas para opções
        <b>listadas</b> (ações, ETFs e futuros) e <b>não entram em nenhuma conta</b>; opções de FX
        e de DOL BMF marcam pelo <code>FXOPT_PRICE</code> e ficam com traço. Passe o mouse sobre o
        preço ou o delta para ver o campo exato da Bloomberg (e os overrides) que gerou o número.
        <b style="color:var(--yellow)">*</b> = a BBG não tinha mid two-sided nesse instante e o
        preço usado foi o <code>PX_LAST</code>.
        O bloco <b>Resultado</b> é o mesmo cálculo da aba de PnL do trader — estoque
        (<i>abertura × (MID − D-1)</i>) + compra + venda — e por isso responde à marreta ★ de
        preço. A coluna <b>D-1 / Médio</b> mostra a base contra a qual o resultado é medido:
        a <b>marcação de D-1</b> do JRS, ou, quando a linha <b>nasceu hoje</b> e não tem D-1, o
        <b>preço médio das boletas do dia</b> — qual dos dois é, e as duas pontas quando houve
        compra e venda, ficam no <i>hover</i> da célula. Na tela o <b>Total</b> soma <b>todas</b> as linhas
        do bloco; o checkbox escolhe apenas o que entra no <b>⎘ Copiar</b> (e lá o Total é
        recalculado sobre as marcadas, para a imagem fechar). Por default vêm marcadas só as que
        <b>ainda têm posição</b> e <b>não são opções contra o BRL</b> (DOL BMF, USDBRL e
        EURBRL — as de dólar ficam na tabela <i>Consolidado Dólar</i>, acima). Use
        <b>Só com posição</b> para incluí-las, ou o checkbox da linha.
      </div>
    </div>
  </div>`;
}

/* ── Análise de Opções: seleção de linhas p/ o Copiar e p/ os totais ─────── */
function optSelRow(rk, checked) { optPrintSel.set(rk, !!checked); renderOptionsAnalysis(); }

function _optAnalysisRows() {
  const data = dolarConsolData[dolarConsolTrader];
  return (data?.rows ?? []).filter(r => r.is_option && r.group !== 'MM Prev');
}
function optSelAll(checked) {
  for (const r of _optAnalysisRows()) optPrintSel.set(rowKey(r), !!checked);
  renderOptionsAnalysis();
}
function optSelWithPosition() {
  for (const r of _optAnalysisRows()) optPrintSel.set(rowKey(r), Number(r.final_qty || 0) !== 0);
  renderOptionsAnalysis();
}

// Copiar como imagem SÓ a TABELA, e nela só as linhas marcadas. Esconde as demais, a
// coluna de checkbox e os textos de apoio (`.jgp-tbl-note` — subtítulo e nota de BID/ASK)
// durante a captura, e restaura ao fim — inclusive se der erro.
// ⚠️ Os textos saem por `display:none`, não por `data-html2canvas-ignore`: o `ignore` pula
// o DESENHO mas mantém o espaço, então sobrariam duas faixas brancas na imagem.
// ⚠️ E TROCA a linha de Total: a da tela soma o bloco inteiro (o checkbox não mexe no que
// a tela mostra), a da imagem soma só as marcadas — senão a imagem levaria um Total que
// não fecha com as linhas que ela mostra. As duas já vêm prontas do `renderOptionsAnalysis`
// (`data-tot="all"` visível, `data-tot="sel"` escondida pelo CSS `.tot-print`).
async function copyOptAnalysisImage(btn) {
  const card   = btn.closest('.card');
  const target = card.querySelector('.section-copy-target') ?? card;
  // Bloco (ativo objeto + vencimento) sem NENHUMA linha marcada sai inteiro — senão a
  // imagem leva um cabeçalho de grupo seguido de um "Total" vazio, que só ocupa espaço.
  const liveGrp = new Set([...target.querySelectorAll('tr[data-optrow][data-optsel="1"]')]
                          .map(tr => tr.dataset.optgrp));
  const hidden = [...target.querySelectorAll('tr[data-optgrp]')]
                   .filter(tr => !liveGrp.has(tr.dataset.optgrp) || tr.dataset.optsel === '0');
  // Só nos blocos que sobrevivem: esconde o Total "todas" e revela o Total "marcadas".
  // ⚠️ `display:'table-row'` explícito — o `.tot-print` é `display:none` por CSS, e um
  // `''` aqui devolveria o elemento à regra que o esconde.
  const totAll = [...target.querySelectorAll('tr[data-tot="all"]')].filter(tr => liveGrp.has(tr.dataset.optgrp));
  const totSel = [...target.querySelectorAll('tr[data-tot="sel"]')].filter(tr => liveGrp.has(tr.dataset.optgrp));
  const sel    = [...target.querySelectorAll('.col-sel')];
  const notas  = [...target.querySelectorAll('.jgp-tbl-note')];
  /* ⚠️ O wrap de rolagem tem de sair na captura, e o ALVO junto: o html2canvas desenha a
     CAIXA do elemento, então um `overflow:visible` sozinho deixaria a tabela transbordar
     para fora do `.section-copy-target` e a imagem sairia cortada na largura da tela. */
  const wrap    = target.querySelector('.opt-tbl-scroll');
  const wrapCss = wrap ? wrap.getAttribute('style') : null;
  const tgtCss  = target.getAttribute('style');
  if (wrap) wrap.style.cssText = 'overflow:visible;width:max-content';
  target.style.maxWidth = 'none';
  target.style.width    = 'max-content';
  hidden.forEach(tr => { tr.style.display = 'none'; });
  totAll.forEach(tr => { tr.style.display = 'none'; });
  totSel.forEach(tr => { tr.style.display = 'table-row'; });
  sel.forEach(td => { td.style.display = 'none'; });
  notas.forEach(el => { el.style.display = 'none'; });
  try {
    await copyElementAsImage(target, btn);
  } finally {
    hidden.forEach(tr => { tr.style.display = ''; });
    totAll.forEach(tr => { tr.style.display = ''; });
    totSel.forEach(tr => { tr.style.display = ''; });
    sel.forEach(td => { td.style.display = ''; });
    notas.forEach(el => { el.style.display = ''; });
    if (wrap) { if (wrapCss === null) wrap.removeAttribute('style'); else wrap.setAttribute('style', wrapCss); }
    if (tgtCss === null) target.removeAttribute('style'); else target.setAttribute('style', tgtCss);
  }
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

/* ── Resumo "net por grupo de ativo" (tira abaixo da tabela de Posição) ──────────────
   Uma linha só, por SEÇÃO (group+trader), somando exatamente as linhas que a tabela acima
   está mostrando — filtros de aba, blacklist, linhas ocultas no ✕, agregação WDO+UC,
   linhas simuladas e marretas inclusive. O número somado é o `effectiveRowPl` (a MESMA
   função da célula #PL), não uma reconta a partir da row crua.

   ☠️ **`pct` e `nominal` NÃO se somam** — são unidades diferentes: `pct` é fração do NAV
   (exposição) e `nominal` é `DV01 × 10.000 / NAV`, ou seja quanto do PL move a cada 100bp.
   Por isso a soma é POR TIPO dentro do balde e o rótulo da unidade (`NAV` / `PL`) vai junto
   do número. Balde que tenha os dois mostra os dois, separados por `·` — nunca um número
   só. É por isso também que os baldes nascem homogêneos por natureza do risco.

   ⚠️ **O `net USDBRL` daqui pode NÃO bater com o TOTAL DÓLAR da aba Análise de Opções.**
   Lá o delta é o EFETIVO (`effectiveDelta`, aceita marreta na própria tabela); aqui é o
   delta do backend, porque é o que a coluna #PL usa. A tira está colada à tabela de
   Posição e tem de fechar com ELA — divergir da coluna que está 2px acima é pior.

   ── Duas ordens, de propósito ────────────────────────────────────────────────────────
   `match` é avaliado NA ORDEM DO ARRAY (1º que casa vence); a EXIBIÇÃO segue `sort`. As
   duas deixaram de ser a mesma lista quando a mesa pediu a tira na ordem em que a TABELA
   ordena — área Z→A no `sortRows`, ou seja **Rates → Equities → Currencies → Commodities**:
   o WDO de `Hedge_Cambial` mora na área Rates/Equities e PRECISA ser testado como moeda
   antes de cair em "Juros off", mas tem de APARECER no bloco de moedas, depois dos juros.

   ── Um balde pode virar VÁRIOS chips (`sub`) ─────────────────────────────────────────
   Moedas quebram por PAR (USDBRL, EURBRL, USDCLP…) e commodities pelo ATIVO (Gold…), a
   pedido da mesa: "moedas" num número só não diz nada quando há USDBRL, EURUSD e USDZAR na
   mesma linha, e "commodities" idem. Juros/bolsa continuam num chip cada.
   ⚠️ `_dollarKind` (pos-dolar.js) é a fonte única do recorte de dólar e já recolhe futuro
   cheio/mini, opção de DOL BMF, opção USDBRL e spot/fwd/NDF — o "tudo concentrado" pedido.
   ☠️ EURBRL NÃO entra no USDBRL: é opção contra o BRL mas não é dólar (ver o gotcha do
   `Digital_EURBRL` no `_dollarKind` e em classify.py). Vira o SEU chip, logo depois.

   ── Balde vazio não aparece ──────────────────────────────────────────────────────────
   Chip cujo net arredonda para zero em todas as unidades é OMITIDO (pedido da mesa: "só
   não mostra nada"). Exceção: se o balde tem linha sem #PL calculável, o chip fica — com
   o ⚠ — porque aí o zero não é "flat", é "não sei". */

/* Roots de commodity → nome. É LOOKUP, não heurística: o mesmo ativo tem de cair no mesmo
   chip vindo de futuro (`GCZ6`), de outro vencimento (`GCV6`) ou de opção (`GCWU26P1`), e
   nenhum dos três traz o nome no `instrument_name`. Casa por PREFIXO do ticker, do mais
   longo para o mais curto. Root desconhecido cai no próprio prefixo alfabético — rótulo
   feio, mas verdadeiro; o tooltip do chip lista os instrumentos somados, então dá para ver
   o que é e acrescentar aqui. Grãos usam root de 1 letra + espaço ("C 1 Comdty"). */
const _NET_COMMOD_ROOTS = [
  ['XGC', 'Gold'],  ['GC', 'Gold'],   ['SI', 'Silver'],      ['HG', 'Copper'],
  ['PL', 'Platinum'], ['PA', 'Palladium'],
  ['CL', 'WTI'],    ['CO', 'Brent'],  ['QS', 'Gasoil'],      ['HO', 'Heating Oil'],
  ['XB', 'Gasolina'], ['NG', 'Nat Gas'],
  ['KC', 'Coffee'], ['SB', 'Sugar'],  ['CT', 'Cotton'],      ['CC', 'Cocoa'],
  ['LC', 'Live Cattle'], ['LH', 'Lean Hogs'],
  ['SM', 'Soybean Meal'], ['BO', 'Soybean Oil'],
  ['LA', 'Aluminium'], ['LN', 'Nickel'], ['LX', 'Zinc'], ['LL', 'Lead'], ['LP', 'Copper (LME)'],
  ['S ', 'Soybeans'], ['C ', 'Corn'],  ['W ', 'Wheat'],
].sort((a, b) => b[0].length - a[0].length);

function _netCommodity(r) {
  const ref = (r.instrument_reference || r.instrument_name || '').toUpperCase();
  for (const [p, lbl] of _NET_COMMOD_ROOTS) if (ref.startsWith(p)) return lbl;
  const root = (ref.match(/^[A-Z]+/) || [''])[0];
  return root ? root.slice(0, 3) : 'Commodities';
}

/* Roots de FUTURO DE ÍNDICE → o índice. Só p/ ticker de yellow key `Index`/`Comdty`; ação e
   ETF à vista NUNCA chegam aqui (saem antes, pelo próprio ticker), então não há risco de um
   `ESS US Equity` virar "SPX". Como o de commodity, é lookup para estender — root fora dele
   mostra o próprio prefixo do ticker, e o `title` do chip lista o que foi somado. */
const _NET_EQ_ROOTS = [
  ['ES', 'SPX'], ['NQ', 'NDX'], ['RTY', 'RTY'], ['DM', 'DJIA'], ['YM', 'DJIA'],
  ['VG', 'SX5E'], ['GX', 'DAX'], ['Z ', 'UKX'], ['NK', 'NKY'], ['TP', 'TPX'], ['HI', 'HSI'],
].sort((a, b) => b[0].length - a[0].length);

/* Índice Bovespa na B3, pelo TICKER: `BZ…` é o futuro CHEIO ("BOVESPA INDEX FUT") e `XB…` o
   MINI ("MINI BOVESPA FUT"), e as opções sobre esses futuros herdam o mesmo root. Casa root +
   código de mês + ano (`BZV6`, `XBV6C 145000`) e SÓ na yellow key `Index`: `BZ US Equity` é a
   Sezzle (Nasdaq) e `XB Comdty` é a gasolina RBOB — nenhuma das duas pode virar IBOV. Existe
   porque o NOME sozinho não basta como única âncora: o mini chega como "MINI BOVESPA FUT", ou
   seja o token nem começa a string. */
const _NET_IBOV_REF_RE = /^(?:BZ|XB)[FGHJKMNQUVXZ]\d/;
const _netIsIbovRef = ref => {
  const up = (ref || '').trim().toUpperCase();
  return /\sINDEX$/.test(up) && _NET_IBOV_REF_RE.test(up);
};

/* Ativo objeto da linha de BOLSA (IBOV · EWZ · SPX · AMZN…). A ORDEM dos testes é o que evita
   rótulo inventado:
     1. IBOV pelo NOME **ou pelo TICKER** — futuro cheio, mini e opção de IBOV chegam por
        caminhos diferentes e os três têm de cair no mesmo chip. ☠️ O teste era
        `startsWith('BOVESPA')` e o mini se chama "MINI BOVESPA FUT  Oct26": não começava com
        nenhum dos dois tokens, caía até o passo 4, e como `XB` não está no `_NET_EQ_ROOTS`
        virava o chip **"XBV"** — o próprio prefixo do ticker (era o sintoma reportado pela
        mesa). Hoje `includes('BOVESPA')` + o root do ticker;
     2. `option_undl` — o backend JÁ resolve o objeto da opção (router.py: `SPX US`, `U-U`,
        `IBOV`, `EWZ US`); reimplementar aqui seria a 2ª cópia da regra. Fica o 1º token,
        porque o sufixo de praça (`US`, `CN`, `BZ`) não muda o ativo;
     3. ticker de AÇÃO/ETF à vista (`… Equity`) → o próprio root: `AGI US Equity` → AGI;
     4. ticker de ÍNDICE/FUTURO (`… Index`/`… Comdty`) → o lookup acima;
     5. o resto (perna de swap de ações, `032830KSSWAP_10_082726`) → a FAMÍLIA antes do 1º
        `_`, para as 4 pernas do mesmo swap somarem num chip só em vez de virarem 4. */
function _netEquityUndl(r) {
  const nm = (r.instrument_name || '').toUpperCase();
  if (nm.startsWith('IBOV') || nm.includes('BOVESPA')) return 'IBOV';
  if (_netIsIbovRef(r.instrument_reference)) return 'IBOV';
  const undl = (r.option_undl || '').trim();
  if (undl) return undl.split(/\s+/)[0].toUpperCase();
  const ref = (r.instrument_reference || '').trim();
  if (/\sEQUITY$/i.test(ref)) return ref.split(/\s+/)[0].toUpperCase();
  if (/\s(INDEX|COMDTY)$/i.test(ref)) {
    const up = ref.toUpperCase();
    for (const [p, lbl] of _NET_EQ_ROOTS) if (up.startsWith(p)) return lbl;
    const root = (up.match(/^[A-Z]+/) || [''])[0];
    if (root) return root.slice(0, 3);
  }
  const base = (ref || nm).split('_')[0].split(/\s+/)[0];
  return base ? base.toUpperCase() : 'Bolsa';
}

/* Código de PRAÇA de um ticker BBG (`LIGT3 BZ Equity` → BZ; `EWZ US` → US). É o 2º token, e
   ler a posição importa: um `\bBZ\b` solto casaria o `BZ US Equity` (Sezzle, Nasdaq) e o
   mandaria para a bolsa brasileira. */
const _netExch = t => ((t || '').trim().split(/\s+/)[1] || '').toUpperCase();

/* Renda variável BRASILEIRA — risco Brasil, INDEPENDENTE da praça em que o papel é listado.
   ⚠️ NÃO é o `isBrEquity` (pos-helpers.js) e os dois não se fundem: aquele responde "esta
   linha é short de bolsa BR ONSHORE?" para o check de alocação MM×Prev, e por isso exige
   instrumento em BRL e **exclui EWZ/ADR de propósito**. Aqui a pergunta é de EXPOSIÇÃO, e a
   mesa foi explícita: EWZ é RV BR. Mudar um pelo outro quebraria o target do Prev. */
const _NET_EQ_BR_UNDL = new Set(['IBOV', 'EWZ', 'EWZS', 'BOVA11']);
function _netEquityIsBr(r) {
  if (_NET_EQ_BR_UNDL.has(_netEquityUndl(r))) return true;
  if (_netExch(r.instrument_reference) === 'BZ' || _netExch(r.option_undl) === 'BZ') return true;
  return /bra[sz]il/i.test(r.subarea || '');
}

/* Chip da linha de bolsa. **RV BR quebra por ativo objeto** (EWZ, IBOV, o papel local);
   **RV Off NÃO quebra** — vai tudo num chip só, a pedido da mesa: offshore ali é uma cesta de
   nomes soltos (SPX, XOM, NVDA, AMZN, urânio…) que viraria uma tira de 10 chips sem que
   nenhum deles fosse a leitura que se quer de relance. */
function _netEquity(r) {
  return _netEquityIsBr(r) ? _netEquityUndl(r) : 'RV Off';
}
// RV Off por último dentro do bloco de bolsa; os nomes de RV BR vêm antes, em ordem alfabética.
const _netEquityRank = lbl => (lbl === 'RV Off' ? 1 : 0);

/* Par de moedas da linha, para o chip. Dólar-BRL (em qualquer forma) → 'USDBRL'; opção de
   FX → o `option_undl`, que o backend já resolve com o parser de par (classify.py,
   `fx_pair_from_name`) — não reimplementar aqui; à vista/forward → o nome sem a barra. */
function _netFxPair(r) {
  if (_dollarKind(r) != null) return 'USDBRL';
  const undl = (r.option_undl || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (undl.length === 6) return undl;
  const nm = (r.instrument_name || '').toUpperCase().split(/\s+/)[0];
  const m = nm.match(/^([A-Z]{3})\/([A-Z]{3})$/);
  if (m) return m[1] + m[2];
  return 'Moedas';
}

// USDBRL primeiro, EURBRL logo depois, o resto em ordem alfabética (pedido da mesa).
const _NET_PAIR_HEAD = ['USDBRL', 'EURBRL'];
function _netPairRank(p) {
  const i = _NET_PAIR_HEAD.indexOf(p);
  return i >= 0 ? i : _NET_PAIR_HEAD.length;
}

const POS_NET_GROUPS = [
  { id: 'fx', sort: 30, sub: _netFxPair, subRank: _netPairRank,
    tip: 'Moedas, por par. USDBRL concentra futuro cheio/mini, opção de DOL BMF, opção USDBRL e spot/fwd/NDF (recorte do _dollarKind); EURBRL é BRL mas não é dólar, e tem chip próprio.',
    match: r => _dollarKind(r) != null || r.is_fx || r.option_subtype === 'fx' || r.area === 'Currencies' },

  { id: 'di', sort: 10, sub: () => 'DI',
    tip: 'Sub-área Fixed Rates Brazil — o mesmo recorte que o regime de DV01 usa para o DI (positions/pricing/dv01.py).',
    match: r => r.subarea === 'Fixed Rates Brazil' },
  { id: 'jurosoff', sort: 11, sub: () => 'Juros off',
    tip: 'Resto da área Rates: juros de fora do Brasil (Fixed Rates G7 e demais sub-áreas).',
    match: r => r.area === 'Rates' && r.subarea !== 'Cash' },
  { id: 'caixa', sort: 12, sub: () => 'Caixa',
    tip: 'Sub-área Cash (LFT e afins). DV01 ~0 — fica fora do Juros off para não somar zero lá.',
    match: r => r.subarea === 'Cash' },

  { id: 'bolsa', sort: 20, sub: _netEquity, subRank: _netEquityRank,
    tip: 'Bolsa (área Equities). RV BR quebra por ativo objeto (EWZ, IBOV, papel local); RV Off vai tudo num chip só.',
    match: r => r.area === 'Equities' },

  { id: 'commod', sort: 40, sub: _netCommodity,
    tip: 'Commodities, por ativo (root do ticker BBG).',
    match: r => r.area === 'Commodities' },

  { id: 'outros', sort: 90, sub: () => 'Outros',
    tip: 'Não casou com nenhum balde acima — vale olhar a área/sub-área da linha.',
    match: () => true },
];

function posNetGroup(r) {
  return POS_NET_GROUPS.find(g => g.match(r)) || POS_NET_GROUPS[POS_NET_GROUPS.length - 1];
}

/* Acumula por (balde, sub), SEPARANDO por unidade (ver o ☠️ acima). Linha sem #PL
   calculável (sem NAV, sem preço, sem delta) não vira zero: vai para `missing` e o chip
   ganha um ⚠ que nomeia os instrumentos — um net que ignora linha calado é um net errado.
   `insts` guarda o que entrou em cada chip: é o tooltip que dispensa adivinhar de onde
   saiu o número (e o que confere o rótulo de uma commodity fora do lookup). */
function netByAssetGroup(rows) {
  const acc = new Map();
  for (const r of rows) {
    const g   = posNetGroup(r);
    const sub = g.sub(r);
    const k   = `${g.id}||${sub}`;
    if (!acc.has(k)) acc.set(k, { g, sub, pct: 0, nom: 0, nPct: 0, nNom: 0, missing: [], insts: [] });
    const a = acc.get(k);
    a.insts.push(r.instrument_name ?? '—');
    const { pl, type } = effectiveRowPl(r);
    if (pl == null || !isFinite(pl)) { a.missing.push(r.instrument_name ?? '—'); continue; }
    if      (type === 'pct')     { a.pct += pl; a.nPct++; }
    else if (type === 'nominal') { a.nom += pl; a.nNom++; }
    else                         { a.missing.push(r.instrument_name ?? '—'); }
  }
  return [...acc.values()].sort((x, y) =>
       (x.g.sort - y.g.sort)
    || ((x.g.subRank ? x.g.subRank(x.sub) : 0) - (y.g.subRank ? y.g.subRank(y.sub) : 0))
    || String(x.sub).localeCompare(String(y.sub)));
}

const _netEsc = t => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/* Igual ao `fmtPL`, com UMA diferença: zero imprime `0.00`, não `—`. No corpo da tabela o
   traço quer dizer "não há número"; num NET diria a mesma coisa e estaria errado. Só chega
   aqui o chip que sobreviveu ao corte de `_netFlat` — ou seja, um zero exibido é sempre um
   zero AO LADO de outro número, ou um balde com linha sem preço (o ⚠). */
function _netNum(v, type) {
  const abs = Math.abs(v);
  const s = type === 'pct'
    ? (abs * 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%'
    : abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (s.startsWith('0.00')) return `<span style="color:var(--text-muted)">${s}</span>`;
  if (v > 0) return `<span style="color:var(--green)">+${s}</span>`;
  return `<span style="color:var(--red)">(${s})</span>`;
}

// Chip "achatado": tudo que ele soma arredonda para 0.00 e não há linha sem #PL. Some da
// tira. O par de FED FUND (Oct26 −x / Nov26 +x) e o ouro parado são os casos do dia a dia.
const _netFlat = a =>
  !a.missing.length &&
  (!a.nPct || Math.abs(a.pct) < 0.00005) &&
  (!a.nNom || Math.abs(a.nom) < 0.005);

/* ⚠️ **O rótulo da unidade saiu da pílula** (set/2026, pedido da mesa) — hoje o chip mostra só
   `DI (1.80)` e `EWZ (2.90%)`, sem o `PL`/`NAV` ao lado. Quem separa as duas réguas passou a ser
   o **`%`**: `pct` sempre imprime com `%` (exposição, fração do NAV) e `nominal` nunca (DV01 ×
   10.000 / NAV, o quanto do PL move a cada 100bp) — ver o ☠️ das unidades no topo do bloco. A
   unidade continua ESCRITA no `title` do chip, que é onde ela pode ser lida por extenso sem
   competir com o número. Não é o mesmo que somar as duas: a soma segue separada por unidade, e
   um balde que tenha as duas mostra as duas, agora só com o `·` entre elas. */
function renderNetSummary(rows) {
  const chips = netByAssetGroup(rows).filter(a => !_netFlat(a)).map(a => {
    const parts = [], unid = [];
    if (a.nPct) { parts.push(_netNum(a.pct, 'pct'));     unid.push('% do NAV (exposição)'); }
    if (a.nNom) { parts.push(_netNum(a.nom, 'nominal')); unid.push('PL por 100bp (DV01 × 10.000 / NAV)'); }
    if (!parts.length) parts.push('<span style="color:var(--text-muted)">n/d</span>');
    const warn = a.missing.length
      ? ` <span class="net-warn" title="${_netEsc(
          `${a.missing.length} linha(s) sem #PL calculável — FORA desta soma:\n· ` +
          a.missing.join('\n· '))}">⚠</span>`
      : '';
    const tip = `${a.g.tip}\n\nUnidade: ${unid.join(' · ')}`
              + `\n\nSoma ${a.insts.length} linha(s):\n· ${a.insts.join('\n· ')}`;
    return `<span class="net-chip" title="${_netEsc(tip)}"><span class="net-chip-lbl">${a.sub}</span> ${parts.join(' <span class="net-sep">·</span> ')}${warn}</span>`;
  });
  if (!chips.length) return '';
  return `<span class="net-lbl" title="Soma da coluna #PL das linhas EXIBIDAS acima, por grupo de ativo, na mesma ordem de área da tabela (juros → bolsa → moedas → commodities). Com % = exposição sobre o NAV; sem % = PL por 100bp. Balde zerado não aparece.">Net</span>${chips.join('')}`;
}

/* ── Render single tbody ─────────────────────────────────────────────────────── */
function renderTable(rows, tbodyId) {
  const body = document.getElementById(tbodyId);
  if (!body) return;
  // Tira "net por grupo de ativo" desta seção. O id é o PAR do tbody (`body_…` → `netsum_…`,
  // mesmo sufixo — ver sectionBodyId/sectionNetId em pos-format.js). Ausente de propósito no
  // card de MM Prev e nos snapshots antigos → o `if (netEl)` deixa tudo como estava.
  const netEl = document.getElementById(tbodyId.replace(/^body_/, 'netsum_'));

  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="${body.closest('table')?.querySelector('thead tr')?.childElementCount ?? 12}" class="no-data">Nenhuma posição encontrada.</td></tr>`;
    if (netEl) netEl.innerHTML = '';   // senão a tira do render anterior fica mentindo
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
    // ⚠️ A conta mora em `effectiveRowValues` (pos-helpers.js) — e não mais aqui — porque o
    // resumo "net por grupo de ativo" logo abaixo desta tabela soma o MESMO #PL que a coluna
    // imprime (ver `renderNetSummary`). Cópia aqui e lá divergiria na 1ª marreta, calada.
    const rKeyFull   = rowKey(r);
    const eff        = effectiveRowValues(r);
    const isSwap     = eff.isSwap;
    const effOpening = eff.opening;
    const effTraded  = eff.traded;
    const effFinal   = eff.final;
    const effDv01    = eff.dv01;
    const isOvr      = eff.qtyOvr;       // ★ no nome para qualquer override de quantidade

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
    // Linha SIMULADA (pos-simular.js): o ✕ REMOVE a simulação em vez de só ocultar a linha,
    // e o nome ganha ⚡ (a coluna Área, que diria "SIMULAÇÃO", vem escondida por padrão).
    const simRef  = r.is_simulated ? (r.instrument_reference ?? '').replace(/'/g, "\\'") : null;
    const killCell = simRef
      ? `<td class="col-copy" title="Remover esta linha simulada" onclick="event.stopPropagation();removeSimRow('${simRef}')">✕</td>`
      : `<td class="col-copy" title="Excluir (ocultar) esta linha" onclick="event.stopPropagation();hideRow('${key}')">✕</td>`;
    const simMark = r.is_simulated
      ? `<span style="color:var(--yellow)" title="${
           ['Linha SIMULADA — não está na carteira', ...(r.sim_avisos ?? []).map(a => '⚠ ' + a)]
             .join('\n').replace(/"/g, '&quot;')}">⚡ </span>`
      : '';
    return `<tr class="${rowClass} ${areaClass} ${tradedClass}" data-ref="${refCopy}" style="cursor:pointer" title="Clique para copiar a referência" onclick="copyRowRef(this)">
      ${killCell}
      <td class="col-detail" ${d}>${r.area     ?? '—'}</td>
      <td class="col-detail" ${d}>${r.subarea  ?? '—'}</td>
      <td class="col-detail" ${d}>${r.strategy ?? '—'}</td>
      <td class="col-detail num" ${d}>${r.option_subtype === 'fx' ? fmtPricePct(r.price) : fmtPrice(r.price)}</td>
      <td class="col-final"${swapAttr}>${(isOvr || plOverrides.has(rKeyFull) || priceOverrides.has(instKey(r)) || deltaOverrides.has(instKey(r))) ? '<span style="color:var(--accent);font-size:10px">★ </span>' : ''}${simMark}${r.instrument_name ?? '—'}</td>
      <!-- fmtOptMaturity, e nao fmtDate(r.maturity): a coluna tem de mostrar a MESMA data que
           ORDENA a linha (sortMaturityKey). Sem isso as opcoes abertas hoje, que chegam sem
           maturity do JRS, ficavam com um traco no meio do bloco, ordenadas por um criterio
           invisivel. O que foi derivado do nome sai marcado com ~ e com title proprio. -->
      <td>${fmtOptMaturity(r)}</td>
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
        // `effectiveRowPl` (pos-helpers.js) é a fonte única do número desta célula — o mesmo
        // que o resumo "net por grupo de ativo" soma abaixo da tabela.
        const { pl: dispPl, type: dispType } = effectiveRowPl(r, eff);
        const delta    = r.option_delta;
        const plTip    = delta != null
          ? `Delta: ${delta} (clique para editar #PL)`
          : 'Clique para editar #PL';
        return `<td class="col-final num" data-rowkey="${safeKey}" onclick="event.stopPropagation();posPlStartEdit(this)" style="cursor:pointer" title="${plTip}">${fmtPL(dispPl, dispType)}</td>`;
      })()}
    </tr>`;
  }).join('');

  if (netEl) netEl.innerHTML = renderNetSummary(visibleRows);
}

/* ── Copiar a referência do instrumento (clique na LINHA) ──────────────────── */
