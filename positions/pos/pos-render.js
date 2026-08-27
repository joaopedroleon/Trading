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
}

/* ── Análise de Opções (na aba dedicada; blocos por objeto + vencimento) ── */

/* Esta linha cai no bloco "DOL / USDBRL"?
   FONTE ÚNICA do predicado: era escrito inline no agrupamento, e a seleção default passou a
   precisar do MESMO critério (ago/2026 — DOL/USDBRL nasce desmarcado). Duas cópias da regra
   deixariam a linha cair num bloco e ser marcada por outro critério, em silêncio.
   `option_subtype === 'dol'` é opção de DOL **BMF** (o backend a separa do 'fx' genérico pelo
   nome começando em "DOL" — positions/router.py); `'fx'` com BRL no objeto é a USDBRL. Uma
   opção de FX que não seja contra o BRL (EURUSD, p.ex.) NÃO entra aqui, e continua marcada.
   ⚠️ `toUpperCase()` p/ casar com o `_dollarKind` do pos-dolar.js, que classifica a tabela
   IRMÃ (Consolidado Dólar) na MESMA aba e já normalizava. Sem isso as duas discordariam de um
   `usdbrl` minúsculo. Não muda nada no dado de hoje (a BBG devolve `USDBRL`). */
function _isDolUsdbrlOpt(r) {
  const sub  = r.option_subtype;
  const undl = (r.option_undl || r.instrument_name || '').toUpperCase();
  return sub === 'dol' || (sub === 'fx' && undl.includes('BRL'));
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
    return { price, delta, src, premium, dPct, dUsd, nPct, nUsd, edited };
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
     **e não for DOL BMF / USDBRL**. Essas duas já têm tabela própria logo acima nesta mesma
     aba (Consolidado Dólar, que é onde a mesa lê a posição de dólar), então repeti-las no
     Total e na imagem copiada da Análise de Opções era ruído — pedido da mesa, ago/2026.
     Continua sendo só o DEFAULT: o checkbox por linha manda, e "Só com posição" traz as de
     dólar de volta em um clique. */
  for (const r of opts) {
    const k = rowKey(r);
    if (!optPrintSel.has(k)) {
      optPrintSel.set(k, Number(r.final_qty || 0) !== 0 && !_isDolUsdbrlOpt(r));
    }
  }
  const isSel = r => optPrintSel.get(rowKey(r)) !== false;
  const nSel  = opts.filter(isSel).length;

  const NCOL = 12;   // checkbox + instrumento + 3 qtds + bid/mid/ask + delta + prêmio + 2 exps
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
    let tPrem = 0, tDUsd = 0, tDPct = 0, tNUsd = 0, tNPct = 0;
    let sPrem = 0, sDUsd = 0, sDPct = 0, sNUsd = 0, sNPct = 0;
    const rowsHtml = sortRows(g.rows).map(r => {
      const m   = metric(r);
      const sel = isSel(r);
      if (m.premium != null) { tPrem += m.premium; if (sel) sPrem += m.premium; }
      if (m.dUsd != null)    { tDUsd += m.dUsd;    if (sel) sDUsd += m.dUsd; }
      if (m.dPct != null)    { tDPct += m.dPct;    if (sel) sDPct += m.dPct; }
      if (m.nUsd != null)    { tNUsd += m.nUsd;    if (sel) sNUsd += m.nUsd; }
      if (m.nPct != null)    { tNPct += m.nPct;    if (sel) sNPct += m.nPct; }
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
      </tr>`;
    }).join('');
    // Subgrupo = faixa clara DENTRO do corpo (padrão `um-table`). O respiro entre blocos
    // vem do padding-top da própria faixa — não há mais linha vazia de 18px.
    const matLbl = g.mat ? ` — ${fmtDate(g.mat)}${g.matDrv ? '~' : ''}` : '';
    const matTip = g.matDrv
      ? ' title="Vencimento (~) lido do NOME do instrumento — o JRS não trouxe maturity para ao menos uma linha deste bloco."' : '';
    const header = `<tr class="grp" data-optgrp="${gi}"><td colspan="${NCOL}"${matTip}>${g.undl}${matLbl}</td></tr>`;
    const totalRow = (prem, nUsd, nPct, dUsd, dPct, cls, kind) => `<tr class="tot${cls}" data-optgrp="${gi}" data-tot="${kind}">
        <td class="sel col-sel"></td>
        <td class="lbl">Total</td>
        <td class="sep"></td><td></td><td></td>
        <td class="sep"></td><td></td><td></td>
        <td class="sep"></td>
        <td class="sep">${fmtMoney(prem)}</td>
        <td>${fmtExp(nUsd, nPct)}</td>
        <td>${fmtExp(dUsd, dPct)}</td>
      </tr>`;
    const total = totalRow(tPrem, tNUsd, tNPct, tDUsd, tDPct, '', 'all')
                + totalRow(sPrem, sNUsd, sNPct, sDUsd, sDPct, ' tot-print', 'sel');
    return header + rowsHtml + total;
  }).join('');

  container.innerHTML = `<div class="card">
    <div class="section-title" style="padding:8px 0 10px 0;display:flex;align-items:center;gap:16px">
      <span>Análise de Opções <span style="font-weight:400;color:var(--text-muted);font-size:13px">— ${dolarConsolTrader} (MM)</span></span>
      <span data-html2canvas-ignore="true" style="font-weight:400;color:var(--text-muted);font-size:12px">${nSel}/${opts.length} linhas marcadas</span>
      <button class="btn btn-secondary" data-html2canvas-ignore="true" style="padding:3px 12px;font-size:12px;margin-left:auto" onclick="optSelAll(true)">Marcar todas</button>
      <button class="btn btn-secondary" data-html2canvas-ignore="true" style="padding:3px 12px;font-size:12px" title="Marca toda linha com posição final ≠ 0 — INCLUSIVE DOL BMF / USDBRL, que o default deixa desmarcadas (elas já têm a tabela Consolidado Dólar acima)." onclick="optSelWithPosition()">Só com posição</button>
      <button class="btn btn-secondary" data-html2canvas-ignore="true" style="padding:3px 12px;font-size:12px" onclick="copyOptAnalysisImage(this)">⎘ Copiar</button>
    </div>
    <div class="section-copy-target">
      <p class="csub jgp-tbl-note" style="margin:0 0 8px;font-size:11.5px;color:var(--text-muted);line-height:1.5">
        Um subgrupo por <b>ativo objeto + vencimento</b>, com Total próprio. Toda conta derivada
        (Prêmio e as duas exposições) sai do <b>MID</b> — BID e ASK ficam ao lado só como
        referência de mercado, e por isso o MID aparece entre os dois.
      </p>
      <table class="jgp-tbl" id="optAnalysisTable">
        ${head}
        <tbody>${body}</tbody>
      </table>
      <div class="opt-calc-note jgp-tbl-note" style="margin-top:8px;font-size:11.5px;color:var(--text-muted);line-height:1.5">
        BID/ASK (<code>PX_BID</code>/<code>PX_ASK</code>) existem apenas para opções
        <b>listadas</b> (ações, ETFs e futuros) e <b>não entram em nenhuma conta</b>; opções de FX
        e de DOL BMF marcam pelo <code>FXOPT_PRICE</code> e ficam com traço. Passe o mouse sobre o
        preço ou o delta para ver o campo exato da Bloomberg (e os overrides) que gerou o número.
        <b style="color:var(--yellow)">*</b> = a BBG não tinha mid two-sided nesse instante e o
        preço usado foi o <code>PX_LAST</code>. Na tela o <b>Total</b> soma <b>todas</b> as linhas
        do bloco; o checkbox escolhe apenas o que entra no <b>⎘ Copiar</b> (e lá o Total é
        recalculado sobre as marcadas, para a imagem fechar). Por default vêm marcadas só as que
        <b>ainda têm posição</b> e <b>não são de DOL BMF / USDBRL</b> (essas ficam na tabela
        <i>Consolidado Dólar</i>, acima). Use <b>Só com posição</b> para incluí-las, ou o
        checkbox da linha.
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
