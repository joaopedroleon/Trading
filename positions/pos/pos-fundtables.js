function allocCheckId(trader) {
  return `alloc_${trader}`.replace(/[^a-zA-Z0-9]/g, '_');
}

/* ── Célula de CHECK — UM formato para toda a tela (08/10/2026, pedido da mesa) ───────
   Os checks de alocação eram percentual em `class="num"`, só com a cor do texto; os do
   sleeve de RF já tinham nascido com fundo tingido e glifo maior. A mesa pediu o mesmo
   padrão em todos — EMota, ECotrim, PAbinader —, então o veredito passa por aqui.
   `v`: número (fração) OU string já pronta (o caso compra/venda do daytrade).
   `delta`: desvio contra o alvo, que escolhe a faixa de cor. `null` ⇒ não afirmado: a
   célula fica MUDA, sem fundo — pintar o que não foi conferido é pior que não pintar.
   ⚠️ O estilo mora em `.check-cell` (positions-v2.css), junto com o da coluna do sleeve —
   uma folha só para os dois, senão o "mesmo padrão" dura até a próxima mexida. */
/* Célula de check VAZIA — "não há o que conferir aqui". Centralizada como as que têm
   veredito: o traço alinhado à direita, no meio de uma coluna de blocos centrados, lia como
   se fosse outra coisa (pedido da mesa, 08/10/2026). Sem fundo, de propósito — ela não é um
   veredito. */
function _checkVazio(txt, tip) {
  const t = tip ? ` title="${_escHtml(tip)}"` : '';
  return `<td class="num" style="text-align:right;color:var(--text-muted)"${t}>${txt ?? '—'}</td>`;
}

function _checkCell(v, delta, tip) {
  const txt = (typeof v === 'string') ? v : fmtPct(_semZeroNegativo(v));
  const cls = allocClass(delta);
  const t   = tip ? ` title="${_escHtml(tip)}"` : '';
  return cls ? `<td class="check-cell ${cls}"${t}>${txt}</td>` : _checkVazio(txt, tip);
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
/* Identidade de uma linha para o casamento entre espelhos.
   ☠️ **CÂMBIO não casa por `instrument_reference`.** No pipeline o ref de uma linha de FX só
   sobrevive quando ela tem abertura no JRS; numa linha que é só boleta ele vira o próprio par.
   Então a MESMA posição tem ref diferente conforme o fundo tenha ou não abertura, e o
   casamento falha calado. A identidade de FX é **par normalizado + data de liquidação** — a
   mesma que o backend usa no `_FX_JOIN_KEYS`. (O `maturity` de FX já vem como `YYYY-MM-DD`
   nos dois lados; fora de FX vem ISO com hora, igual nos dois.) */
function _mirrorKey(r) {
  return r.is_fx
    ? `FX||${r.instrument_name}||${r.area}||${r.subarea}||${r.strategy}||${r.maturity ?? ''}`
    : `${r.instrument_reference}||${r.area}||${r.subarea}||${r.strategy}||${r.maturity ?? ''}`;
}

function makeMirrorLookup(mirrorRows) {
  const byKey      = {};
  const swapGroups = {};
  for (const r of (mirrorRows ?? [])) {
    if (r.swap_detail != null) {
      const gk = `${r.instrument_reference}||${r.area}||${r.subarea}||${r.strategy}`;
      (swapGroups[gk] ??= []).push({ date: r.maturity ? new Date(r.maturity) : null, row: r });
    } else {
      byKey[_mirrorKey(r)] = r;
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
    return byKey[_mirrorKey(mm)] ?? null;
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

/* ── Check MM×Prev do DÓLAR: futuro e NDF contam JUNTOS (out/2026) ───────────────────
   ☠️ **O mesmo dólar é montado com instrumentos diferentes em cada veículo.** Medido no
   livro do ECotrim em 08/10/2026: o MM carrega os −18,62 % todo em **mini dólar**, e o Prev
   divide os −11,12 % entre **mini dólar (−5,58 %) e um NDF de USD/BRL (−5,54 %)**. Linha a
   linha o check fazia −900 ÷ −3.000 = **30 %** e acusava o Prev em metade do alvo de 60 %;
   somando futuro + NDF dá **59,7 %**, que é o certo.

   ⛔ **ESCOPO FECHADO, por decisão da mesa (08/10/2026): só `USDBRL`, e só FUTURO + NDF.**
   - **Só o BRL** porque é ali que a mesa troca um pelo outro — "é uma característica só do
     BRL". Nas outras moedas (`USDMXN`, `USDCLP`) cada veículo usa o mesmo instrumento e a
     linha já fecha: aferido, EMota dá 70,0 % nas duas pela linha. Somá-las ali não
     consertaria nada e esconderia descasamento real.
   - **Opção fica de FORA e segue linha a linha** (`is_option`): o nocional dela é nocional ×
     delta, outra régua. Aferido no EMota: com a opção dentro, o balde dava 71,0 %; com ela
     fora, futuro+NDF dá **69,6 %** e a `CUSDBRL_5.00_261030` fecha sozinha em **70,0 %** —
     dois números certos, cada um na sua unidade.
   - **DI e bolsa nunca entram**: a maturidade e o nome não são substituíveis, e somá-los
     esconderia um descasamento de verdade.

   ⚠️ **Nada disso vira rótulo na tela** (pedido da mesa): a célula mostra o **%**, como
   sempre; quem quiser a composição abre o hover. O nome do mecanismo não é informação para
   quem está conferindo alocação.

   ⚠️ A soma usa as linhas que a ABA MOSTRA (ver o ☠️ em `renderAllocTable`): o
   `no_hedge_cambial` é corte de ESCOPO, não de exibição, e incluí-lo invertia o veredito.
   ⚠️ Reusa `netByAssetGroup`/`posNetGroup` (pos-render.js) — a MESMA máquina da tira NET,
   que já decompõe cross em pares contra o dólar e já sabe somar futuro com termo. */

// O único par em que a mesa troca futuro por NDF. Uma linha para alargar, se mudar.
const _ALLOC_BUCKET_SUB = 'USDBRL';
// Elegível ao balde: câmbio LINEAR. Opção sai (outra régua — ver o ⛔ acima).
const _allocBucketEligible = r => !r.is_option;

/* Nocional em USD de UMA unidade da linha (um contrato de mini dólar; 1 USD no NDF),
   tirado do próprio `#PL`: `pl × NAV ÷ qtd final`. É o que permite somar a boleta de um
   futuro com a de um termo — as quantidades estão em unidades diferentes.
   ⚠️ Devolve null quando a posição final é zero (abriu e zerou no dia): ali não há de onde
   tirar o fator, e inventar um seria pior que não afirmar o check. */
function _usdPorUnidade(r) {
  const pl  = (typeof effectiveRowPl === 'function' ? effectiveRowPl(r).pl : r.pl);
  const fq  = (typeof effectiveRowValues === 'function' ? effectiveRowValues(r).final : r.final_qty);
  if (pl == null || !isFinite(pl) || r.pl_type !== 'pct' || !r.nav || !fq) return null;
  return (pl * r.nav) / fq;
}

function _allocBuckets(mmRows, prevRows) {
  const idx = new Map();
  const put = (lado, arr) => {
    for (const a of netByAssetGroup(arr)) {
      const k = `${a.g.id}||${a.sub}`;
      if (!idx.has(k)) idx.set(k, { id: a.g.id, sub: a.sub, mm: null, prev: null,
                                    mmRaw: [], prevRaw: [] });
      idx.get(k)[lado] = a;
    }
    // Linhas cruas do par, p/ a conta da boleta (que precisa do nocional por unidade).
    for (const r of arr) {
      const g = posNetGroup(r);
      if (g.id !== 'fx') continue;
      for (const l of (g.legs ? g.legs(r) : [{ sub: g.sub(r) }])) {
        const k = `fx||${l.sub}`;
        if (idx.has(k)) idx.get(k)[lado === 'mm' ? 'mmRaw' : 'prevRaw'].push(r);
      }
    }
  };
  put('mm', (mmRows || []).filter(_allocBucketEligible));
  put('prev', (prevRows || []).filter(_allocBucketEligible));
  return idx;
}

/* Veredito do balde para UMA linha, ou null quando a linha não é de câmbio (aí vale a
   linha). Cross cai em dois baldes — devolve o de PIOR desvio, que é o que tem de aparecer. */
function _bucketCheck(mm, buckets, target) {
  if (typeof posNetGroup !== 'function') return null;
  if (!_allocBucketEligible(mm)) return null;          // opção: linha a linha
  const g = posNetGroup(mm);
  if (g.id !== 'fx') return null;
  const subs = (g.legs ? g.legs(mm) : [{ sub: g.sub(mm) }])
    .map(l => l.sub).filter(x => x === _ALLOC_BUCKET_SUB);   // só o dólar/real
  let pior = null;
  for (const sub of [...new Set(subs)]) {
    const b = buckets.get(`fx||${sub}`);
    if (!b) continue;
    const a = b.mm, c = b.prev;
    const usaPct = Math.abs(a?.pct ?? 0) > 1e-9 || Math.abs(c?.pct ?? 0) > 1e-9;
    const A = usaPct ? (a?.pct ?? 0) : (a?.nom ?? 0);
    const B = usaPct ? (c?.pct ?? 0) : (c?.nom ?? 0);
    if (!A) continue;
    const pct = B / A;
    /* Boleta do dia SOMADA na mesma unidade (USD), pelo nocional por unidade de cada linha.
       `null` em qualquer parcela ⇒ não afirma: melhor um traço que um número meio certo. */
    const somaOperada = (arr) => {
      let tot = 0, ok = true;
      for (const r of (arr || [])) {
        const t = (typeof effectiveRowValues === 'function' ? effectiveRowValues(r).traded : r.traded_qty) || 0;
        if (!t) continue;
        const u = _usdPorUnidade(r);
        if (u == null) { ok = false; break; }
        tot += t * u;
      }
      return ok ? tot : null;
    };
    const opMm = somaOperada(b.mmRaw), opPv = somaOperada(b.prevRaw);
    const cand = {
      sub, pct,
      mmTxt: `${(A * 100).toFixed(2)}%`, prevTxt: `${(B * 100).toFixed(2)}%`,
      opMm, opPv,
      opPct: (opMm != null && opPv != null && Math.abs(opMm) > 1e-9) ? opPv / opMm : null,
      // ⚠️ ORDENADOS: o `insts` sai na ordem das linhas, que difere entre os dois lados —
      // comparar sem ordenar marcava como "instrumentos diferentes" um conjunto em que os
      // dois veículos usam exatamente os mesmos três (foi o caso do livro do EMota).
      mmInsts: [...new Set(a?.insts ?? [])].sort(),
      prevInsts: [...new Set(c?.insts ?? [])].sort(),
    };
    if (!pior || (target != null && Math.abs(pct - target) > Math.abs(pior.pct - target))) pior = cand;
  }
  return pior;
}

/* A célula de "% Alloc Final" quando o veredito vem do balde. */
function _bucketCell(bk, target) {
  const cls = allocClass(target != null ? bk.pct - target : null);
  const tip = `DÓLAR — futuro e NDF contam JUNTOS: a mesma exposição é montada com `
    + `instrumentos diferentes em cada veículo.\n\n`
    + `  MM    ${bk.mmTxt.padStart(8)} : ${bk.mmInsts.join(' · ') || '—'}\n`
    + `  Prev  ${bk.prevTxt.padStart(8)} : ${bk.prevInsts.join(' · ') || '—'}\n\n`
    + `  Prev ÷ MM = ${fmtPct(bk.pct)}` + (target != null ? `  ·  alvo ${fmtPct(target)}` : '')
    + `\n\nSó ${bk.sub}, e só futuro + NDF. Opção, DI, bolsa e as demais moedas seguem linha `
    + `a linha — ali o instrumento, o vértice e o nome não são substituíveis. `
    + `Soma as linhas que a aba mostra — os filtros dela valem: Hedge Cambial é hedge de caixa, não posição do trader, e não tem contraparte no Prev.`;
  return _checkCell(bk.pct, target != null ? bk.pct - target : null, tip);
}

function renderAllocTable(allRows, trader, filterFn = applyFilters) {
  const target   = ALLOC_TARGETS[trader] ?? null;
  // Linha simulada fica FORA do check de alocação MM×MM Prev: ela não tem par no Prev por
  // definição (não existe no Oracle) e apareceria como "0% alocado", um alerta falso.
  const mmRows   = filterFn(sortRows(allRows.filter(r => r.group === 'MM' && r.trader === trader && !r.is_simulated)));
  const visRows  = mmRows.filter(r => !_hiddenForTab(currentRenderTab()).has(rowKey(r)));
  const prevRows = allRows.filter(r => r.group === 'MM Prev' && r.trader === trader);

  /* ── Sleeve de RF (out/2026) — a coluna `Check RF`, no mesmo espelho do Prev ──────
     O trader boleta uma fração do ticket TAMBÉM no veículo do RF — a fração é derivada
     dos NAVs do dia (`funds.rf_sleeve_alloc_target`), não é constante. */
  /* Baldes de ativo p/ o check do DÓLAR (ver `_allocBuckets`).
     ☠️ **Com os MESMOS filtros da aba, não com o livro cru.** A 1ª versão somava tudo, com o
     argumento de que "um filtro de exibição não pode mudar o veredito" — e estava errada: o
     `no_hedge_cambial` não é exibição, é ESCOPO. O Hedge Cambial é o hedge de caixa da
     tesouraria, não posição direcional do trader, e **não tem contraparte no Prev por
     desenho**. Medido no EMota em 08/10/2026: as 4 linhas de mini dólar de Hedge_Cambial
     (−4, +16, −13, +7) inflavam o lado do MM e puxavam o check de **74,1 % para 70,3 %** —
     transformavam um desvio real de 4pp contra o alvo de 70 % num verde. Erro na direção
     pior. Com o filtro, `% Alloc Final` e `Check Boleta` dão o mesmo **74,1 %**, que é o que
     a mesa lê na tabela ao lado (ali a abertura é zero: operada = final).
     ⚠️ O ✕ de linha (esconder à mão) continua FORA do corte — é ação de exibição do usuário,
     e esconder uma linha não pode mudar a proporção alocada da carteira. */
  const buckets  = _allocBuckets(
    filterFn(allRows.filter(r => r.group === 'MM' && r.trader === trader && !r.is_simulated)),
    filterFn(prevRows));

  const rfGroup  = rfGroupIdFor(posDataByTab[currentRenderTab()]);
  const rfCfg    = rfSleeveCfg(currentRenderTab());
  const rfRows   = allRows.filter(r => r.group === rfGroup && r.trader === trader);
  /* ☠️ **A coluna existe quando o trader ESPELHA, não quando há linha no sleeve.** Era
     `!!rfRows.length`, e no dia em que a mesa tirou todas as operações do RF a coluna inteira
     SUMIU — justamente quando ela tinha mais a dizer: "não há nada no RF" é o veredito, não a
     ausência dele. E em bolsa/commodity o vazio é o ✓ que confirma a regra do veículo. */
  const showRf   = !!(rfCfg?.traders ?? []).includes(trader);
  const lookupRf = showRf ? makeMirrorLookup(rfRows) : null;
  const NCOL     = showRf ? 7 : 6;

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
  let   missingFactor = false;  // linha de short de bolsa BR sem o NAV do grupo (target cheio)
  // Nome dos fundos que ficam fora do trade — usado no tooltip de CADA linha marcada
  // (antes só existia dentro do bloco da nota de rodapé, que deixou de existir).
  const blocked0 = (posDataByTab[currentRenderTab()]?.prev_no_br_equity_short_funds ?? [])
    .map(fl => fl.replace(/-A$/, '')).join(', ') || 'Sulamérica';

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
    // Daytrade de bolsa BR que fecha zerado: direção indeterminável — ver
    // `isBrEquityDaytradeFlat`. Aqui o alvo vira FAIXA, não ponto.
    const isAmbBr = target != null && !isShortBr && shortFactor != null
                    && isBrEquityDaytradeFlat(mm);
    if (isShortBr && shortFactor == null) missingFactor = true;
    const rowTarget = isShortBr && shortFactor != null ? target * shortFactor : target;
    // Faixa aceita [reduzido, cheio] só no caso ambíguo; `null` = alvo é ponto.
    const banda = isAmbBr ? [target * shortFactor, target] : null;

    /* Desvio contra o alvo. Com `banda`, o que vale é a distância à BORDA mais próxima
       (zero dentro dela) — é o que faz a faixa ser aceita sem afrouxar o resto da
       coluna, que continua medindo contra um ponto. */
    const dAlvo = (pct) => {
      if (pct == null || rowTarget == null) return null;
      if (!banda) return pct - rowTarget;
      const [lo, hi] = banda;
      return pct < lo ? pct - lo : (pct > hi ? pct - hi : 0);
    };

    const _notaCurta = blocked0 + ' não pode ficar vendido em bolsa BR e fica fora do trade, '
      + 'então a boleta do Prev sai proporcionalmente menor.\n\n'
      + 'Alvo cheio ' + fmtPct(target) + '  ×  fator '
      + (shortFactor != null ? fmtPct(shortFactor) : '—')
      + ' (NAV do grupo ex-bloqueados ÷ NAV do grupo)\n'
      + 'Alvo desta linha: ' + (shortFactor != null ? fmtPct(target * shortFactor) : '—')
      + '\n\nPosição de risco Brasil negociada FORA (EWZ, ADR, XP, MELI) não entra na '
      + 'regra — a restrição é de bolsa ONSHORE.';

    const shortMark = isShortBr
      ? ` <span class="alloc-short-br" title="${_escHtml('SHORT DE BOLSA BR ONSHORE — alvo reduzido.\n\n'
          + (shortFactor != null ? _notaCurta
             : 'NAV do grupo Prev indisponível: o check está usando o alvo CHEIO de '
               + fmtPct(target) + ', que é mais exigente do que deveria.'))}">↓</span>`
      : isAmbBr
      ? ` <span class="alloc-short-br" title="${_escHtml('DAYTRADE DE BOLSA BR QUE FECHOU ZERADO — '
          + 'direção indeterminável.\n\nComprou-e-vendeu e vendeu-e-recomprou produzem os MESMOS '
          + 'campos no payload (quantidade e preço médio de cada lado, sem ordem nem horário), '
          + 'então não dá para saber se houve short.\n\nPor isso esta linha aceita a FAIXA entre '
          + 'o alvo reduzido (' + fmtPct(target * shortFactor) + ', se foi short) e o alvo cheio ('
          + fmtPct(target) + ', se foi long). Fora dela continua acusando.\n\n' + _notaCurta)}">↕</span>`
      : '';

    /* ☠️ Declarado AQUI, antes do primeiro uso: o `Check Boleta` (logo abaixo) consulta o
       balde, e `const` numa arrow de `.map` tem temporal dead zone — com a declaração lá
       embaixo, no bloco do "% Alloc Final", a tabela inteira estourava com "Cannot access
       'bk' before initialization" e a auxiliar saía VAZIA, sem erro visível na tela. */
    const bk = _bucketCheck(mm, buckets, rowTarget);

    // Abert. MM Prev
    const prevQty = prev?.opening_qty ?? null;
    const prevQtyCell = `<td class="num">${prevQty != null ? fmtFinalQty(prevQty, qtyDec(mm)) : '<span style="color:var(--text-muted)">—</span>'}</td>`;

    // Qtd Operada MM Prev
    const prevTraded = prev?.traded_qty ?? null;
    const tradedCell = `<td class="num">${prevTraded != null ? fmtTradedQty(prevTraded, qtyDec(mm)) : '<span style="color:var(--text-muted)">—</span>'}</td>`;

    // Check Boleta
    let dealCell = _checkVazio('—', 'Sem boleta nesta linha hoje.');
    if ((mm.gross_traded_qty ?? 0) > 0) {
      if ((mm.traded_qty ?? 0) === 0) {
        // daytrade: verificar compra e venda separadamente
        const bq = mm.buy_qty  ?? 0;
        const sq = mm.sell_qty ?? 0;
        const buyPct  = bq > 0 ? (prev?.buy_qty  ?? 0) / bq : null;
        const sellPct = sq > 0 ? (prev?.sell_qty ?? 0) / sq : null;
        if (buyPct === null && sellPct === null) {
          dealCell = _checkVazio('0 líq.', 'Compra e venda se anularam no dia.');
        } else {
          const buyDelta  = dAlvo(buyPct);
          const sellDelta = dAlvo(sellPct);
          const bStr = buyPct  != null ? `C:${fmtPct(buyPct)}`  : '';
          const sStr = sellPct != null ? `V:${fmtPct(sellPct)}` : '';
          /* ⚠️ Daytrade traz DOIS números numa célula só. Com o fundo tingido, a cor é da
             célula inteira — então vale o PIOR dos dois lados: uma compra certa não pode
             pintar de verde uma venda fora do alvo. */
          const pior = [buyDelta, sellDelta].filter(x => x != null)
            .reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0);
          dealCell = _checkCell([bStr, sStr].filter(Boolean).join(' / '),
                                (buyDelta == null && sellDelta == null) ? null : pior);
        }
      } else {
        const dealPct   = (prev?.traded_qty ?? 0) / mm.traded_qty;
        const dealDelta = dAlvo(dealPct);
        /* ⚠️ No dólar a boleta do Prev pode sair em OUTRO instrumento (mini dólar no MM, NDF
           no Prev) — comparar instrumento com instrumento acusaria um desvio que não existe.
           Aqui as duas também contam juntas, convertidas a USD pelo nocional por unidade.
           Sem o fator (linha que abriu e zerou no dia), volta ao % da própria linha. */
        // ⚠️ PASSA pelo `_checkCell` como todos os outros: este ramo nascera com um `<td>`
        // próprio e era o único check da tela sem o fundo tingido — a mesa pegou no print.
        dealCell = (bk && bk.opPct != null)
          ? _checkCell(bk.opPct, dAlvo(bk.opPct),
              'DÓLAR — boleta do dia com futuro e NDF JUNTOS, em USD:\n'
              + '  MM   ' + fmtMoneyTxt(bk.opMm) + '\n  Prev ' + fmtMoneyTxt(bk.opPv) + '\n'
              + '  Prev ÷ MM = ' + fmtPct(bk.opPct)
              + (rowTarget != null ? '  ·  alvo ' + fmtPct(rowTarget) : ''))
          : _checkCell(dealPct, dealDelta);
      }
    }

    // % Alloc Final — em CÂMBIO vem do BALDE (ver `_bucketCheck`); no resto, da linha.
    const mmFinal   = mm.final_qty ?? 0;
    const prevFinal = prev?.final_qty ?? null;
    const finalPct  = mmFinal !== 0 && prevFinal != null ? prevFinal / mmFinal : null;
    const finalCls  = allocClass(dAlvo(finalPct));
    const finalCell = bk
      ? _bucketCell(bk, rowTarget)
      : _checkCell(finalPct, dAlvo(finalPct));

    // Total dos veículos do livro. ⚠️ Com o sleeve de RF na aba ele entra aqui também —
    // senão a coluna diria "total" somando dois dos três veículos, e o número não bateria
    // com a mesma coluna da tabela de câmbio (pos-fxlegs.js), que soma os três.
    const rfFinal   = showRf ? (lookupRf(mm)?.final_qty ?? 0) : 0;
    const total     = (mmFinal) + (prevFinal ?? 0) + rfFinal;
    const totalCell = `<td class="num">${fmtFinalQty(total, qtyDec(mm))}</td>`;

    return `<tr class="${rowClass} ${areaClass} ${tradedClass}">
      <td>${mm.instrument_name ?? '—'}${shortMark}</td>
      ${prevQtyCell}
      ${tradedCell}
      ${totalCell}
      ${dealCell}
      ${finalCell}
      ${showRf ? rfCheckCell(rfCfg, { mmQty: mmFinal, rfQty: lookupRf(mm) ? rfFinal : null,
                                      row: lookupRf(mm) ?? mm }) : ''}
    </tr>`;
  }).join('');

  // Linhas só-Prev (sem MM): Total MM+Prev = só o Prev; Check/Alloc não se aplicam (—).
  const muted = '<span style="color:var(--text-muted)">—</span>';
  const orphanTr = orphanRows.map((p, i) => {
    const stripe = i % 2 === 0 ? 'group-odd' : 'group-even';
    /* ⭐ Órfã de CÂMBIO não é posição sem alocação: ela É parte do balde (o NDF do Prev que
       cobre o mini dólar do MM). Mostrar "—" aqui faria parecer que ela não foi conferida. */
    const bkO = _bucketCheck(p, buckets, target);
    return `<tr class="${stripe}">
      <td>${p.instrument_name ?? '—'}</td>
      <td class="num">${p.opening_qty != null ? fmtFinalQty(p.opening_qty, qtyDec(p)) : muted}</td>
      <td class="num">${p.traded_qty  != null ? fmtTradedQty(p.traded_qty, qtyDec(p))  : muted}</td>
      <td class="num">${fmtFinalQty(p.final_qty ?? 0, qtyDec(p))}</td>
      ${_checkVazio('—', 'Linha sem par no MM — check de boleta não se aplica.')}
      ${bkO ? _bucketCell(bkO, target) : _checkVazio()}
      ${showRf ? _checkVazio() : ''}
    </tr>`;
  }).join('');
  const orphanSection = orphanRows.length
    ? `<tr class="area-divider"><td colspan="${NCOL}" style="font-weight:600;color:var(--text-muted)">Somente MM Prev</td></tr>${orphanTr}`
    : '';

  /* Rodapé do short de bolsa BR.
     ⚠️ O caso NORMAL (alvo reduzido aplicado) deixou de ter nota fixa — pedido da mesa em
     13/10/2026: era um parágrafo de duas linhas ocupando a largura da tabela todo dia em
     que houvesse short de Ibov, para explicar uma regra que a mesa já conhece. O texto
     inteiro passou para o `title` do marcador ↓ / ↕ da linha, que é onde a dúvida nasce.
     ⛔ O caso de FALHA continua FIXO e vermelho: ali o número exibido está medindo contra
     o alvo errado, e isso não pode depender de alguém passar o mouse. */
  let footTr = '';
  if (missingFactor) {
    const note = `↓ short de bolsa BR onshore: o target deveria ser reduzido (${blocked0} fica fora), `
      + `mas o NAV do grupo Prev não veio — check usando o target cheio de ${fmtPct(target)}.`;
    footTr = `<tr><td class="aux-foot" colspan="${NCOL}" style="font-size:11px;color:var(--red)"><div>${note}</div></td></tr>`;
  }

  // Rodapé do sleeve: o 2º check NO AGREGADO — o alvo fixo contra o que os NAVs de hoje
  // pedem para a exposição dar 1/10. É esta linha que acusa quando os 4% envelheceram.
  const rfFootTr = showRf ? `<tr><td class="aux-foot" colspan="${NCOL}" style="font-size:11px;color:var(--text-muted)"><div>${rfTargetNote(rfCfg)}</div></td></tr>` : '';

  return `<table class="data-table alloc-table" style="white-space:nowrap;width:auto">
    <thead><tr>
      <!-- ⚠️ Cabeçalhos longos em DUAS LINHAS (br), e não por estética: numa tabela
           width:auto a coluna nasce do MAIOR conteúdo dela, e aqui o maior conteúdo era o
           rótulo. "Total MM+Prev+RF" sozinho pedia 145px para números de 3 dígitos.
           O br quebra mesmo com o white-space:nowrap da tabela — e o espaçador de
           alinhamento da auxiliar mede thead.offsetHeight ao vivo, então um cabeçalho mais
           alto continua casando linha a linha com a tabela da esquerda.
           (Sem crase neste comentário: ele vive dentro de um template literal.) -->
      <th>Instrumento</th>
      <th>Abert.<br>MM Prev</th>
      <th>Qtd<br>Operada</th>
      <th>${showRf ? 'Total<br>MM+Prev+RF' : 'Total<br>MM+Prev'}</th>
      <th>Check<br>Boleta</th>
      <th>% Alloc<br>Final</th>
      ${showRf ? rfCheckHead(rfCfg, false, true) : ''}
    </tr></thead>
    <tbody>${rows}${orphanSection}${footTr}${rfFootTr}</tbody>
  </table>`;
}

/* ── Sleeve de RF: UMA coluna de check, com o detalhe no tooltip ─────────────────────
   A mesa pediu uma coluna só (08/10/2026): três (`Qtd RF · % Aloc · Exp.`) enchiam a
   auxiliar de números que só valem para metade das linhas. Aqui sai o VEREDITO; a conta,
   os dois lados e o motivo de não ser afirmado vão no `title`.

   A régua MUDA com o instrumento, e isso é decisão da mesa, não detalhe:
     • **câmbio linear** (spot · NDF · forward) → o veredito vem do agregado **por MOEDA**
       (`ccy_check`), porque o mesmo euro é montado com pares diferentes em cada livro;
     • **opção e o resto** → linha a linha, pela **quantidade**, contra o alvo da boleta. */
function rfCheckCell(cfg, { mmQty, rfQty, row } = {}) {
  const muted = (txt, tip) =>
    `<td class="num" style="color:var(--text-muted);text-align:right" title="${_escHtml(tip)}">${txt}</td>`;
  const alvoExp = cfg?.exposure_ratio;

  /* ⭐ **Ativo que NÃO pode ir para o RF: zero lá é o CERTO, e o check diz OK** (pedido da
     mesa, 08/10/2026). O veículo carrega só os books de juros e moedas — numa linha de bolsa
     ou de commodity, o RF estar zerado é a regra sendo cumprida, não desvio de alocação.
     Antes isto saía `⚠ 0.0%` em VERMELHO (0 ÷ qtd do MM contra o alvo de 4,4 %), ou seja, a
     tela acusava justamente o comportamento correto — e com duas linhas permanentemente
     vermelhas a coluna perde o sentido.
     ⛔ O vermelho fica reservado para o inverso: ativo fora do escopo COM posição no RF. Aí
     é violação de regra do veículo, e a faixa do topo da aba já nomeia a linha. */
  const areasOk = cfg?.areas_ok;
  if (row && Array.isArray(areasOk) && areasOk.length
      && !areasOk.includes((row.area ?? '').trim())) {
    const temRf = Math.abs(rfQty ?? 0) > 0;
    const books = areasOk.map(a => ({ Rates: 'juros', Currencies: 'moedas',
                                      Equities: 'bolsa', Commodities: 'commodities' }[a] ?? a)).join(' e ');
    return temRf
      ? `<td class="check-cell alloc-bad" title="${_escHtml(
          `⛔ FORA DO ESCOPO: o veículo de RF carrega só os books de ${books}, e esta linha é de `
          + `${row.area ?? '—'} — mas tem ${fmtFinalQtyTxt(rfQty)} lá. Ver a faixa no topo da aba.`)}">⛔</td>`
      : `<td class="check-cell alloc-ok" title="${_escHtml(
          `✓ Correto: ${row.area ?? 'este ativo'} não vai para o RF (o veículo carrega só os books `
          + `de ${books}), então zero aqui é o esperado — não é desvio de alocação.`)}">✓</td>`;
  }

  // ── câmbio linear: veredito das MOEDAS do par ────────────────────────────────────
  // ⚠️ Só vale o veredito por moeda quando EXISTE agregado — sem linha no sleeve ele não é
  // montado, e aí a régua volta a ser a quantidade da linha (que dirá "nada no RF").
  if (row?.is_fx && cfg?.ccy_check?.linhas?.length) {
    const c = cfg?.ccy_check;
    /* ☠️ **Moeda sem spot CONTAMINA moeda que tem** (27/10/2026). O
       `ccy_exposure_usd` pula a LINHA inteira quando falta o spot da base — e pular um
       cross some com as DUAS pernas. Medido na aba do PortfolioRF: sem o spot do EUR, o
       `EUR/MXN` do MM saiu do agregado e o MXN do MM foi de −2,82 MM para −8,82 MM USD,
       com esta coluna marcando 3,4 % (vermelho) numa linha cuja quantidade estava certa.
       Ou seja: o nome que falta no `sem_spot` não é o da moeda afetada, e por isso o
       guard é do AGREGADO INTEIRO, não das pernas deste par. Vermelho errado é pior que
       veredito nenhum. */
    if (c?.sem_spot?.length) {
      return muted('—', 'Câmbio linear: o check é por MOEDA, no agregado — e hoje ele está '
        + `incompleto.\n\nSem spot de: ${c.sem_spot.join(', ')}. Cada linha sem spot é pulada `
        + 'inteira, e um CROSS pulado tira as duas pernas dele da conta — inclusive de uma '
        + 'moeda que tem spot. O agregado não é afirmado enquanto faltar spot.\n\n'
        + 'Ver a tabela "Exposição por moeda" no topo da aba.');
    }
    const pair = String(row.instrument_name ?? '').toUpperCase();
    const [base, quote] = pair.split('/').map(x => (x || '').trim());
    const legs = (c?.linhas ?? []).filter(l => l.ccy === base || l.ccy === quote);
    const mat  = legs.filter(l => l.ratio != null);
    if (!mat.length) {
      return muted('—', `Câmbio linear: o check é por MOEDA, no agregado.\n\n`
        + `${base}/${quote} não tem exposição material no MM para servir de denominador `
        + `(piso de US$ ${Number(c?.min_usd ?? 200000).toLocaleString('en-US')}).\n\n`
        + 'Ver a tabela "Exposição por moeda" no topo da aba.');
    }
    const pior = mat.reduce((a, b) =>
      Math.abs(b.ratio / alvoExp - 1) > Math.abs(a.ratio / alvoExp - 1) ? b : a);
    const cls  = rfAllocClass(pior.ratio, alvoExp);
    const det  = legs.map(l => l.ratio != null
      ? `  ${l.ccy}: RF ${fmtPct(l.rf_pct)} do NAV do RF ÷ MM ${fmtPct(l.mm_pct)} do NAV do MM = ${fmtPct(l.ratio)}`
      : `  ${l.ccy}: sem exposição material no MM — não afirmado`).join('\n');
    const tip = `CÂMBIO LINEAR — o check é por MOEDA, não por instrumento: o mesmo ${base} é `
      + `montado com pares diferentes em cada livro.\n\nAlvo: ${fmtPct(alvoExp)}.\n${det}\n\n`
      + 'Tabela completa no topo da aba ("Exposição por moeda").';
    return `<td class="check-cell ${cls}" title="${_escHtml(tip)}">${
      cls === 'alloc-ok' ? '✓' : '⚠ ' + fmtPct(_semZeroNegativo(pior.ratio))}</td>`;
  }

  // ── o resto (opção incluída): linha a linha, pela QUANTIDADE ─────────────────────
  const e = rfAllocEval(mmQty, rfQty, cfg);
  /* ⚠️ **O alvo é derivado dos dois NAVs** (03/11/2026) — sem um deles não existe alvo a
     afirmar, e medir contra o número de outro dia seria pior do que não medir. */
  if (e.allocTarget == null) {
    return muted('—', 'Alvo não afirmado hoje: ele é derivado dos NAVs ('
      + fmtPct(cfg?.exposure_ratio) + ' da exposição do MM ⇒ NAV do '
      + rfSleeveFundLabel(cfg) + ' ÷ NAV de MM do ' + (cfg?.traders?.[0] ?? 'trader')
      + '), e falta um dos dois nesta data.');
  }
  if (e.allocPct == null) {
    return muted('—', 'Sem posição no book de MM do trader para comparar — o check não é '
      + 'afirmado. Pode ser perna que só existe no RF, ou casamento por instrumento que não fechou.');
  }
  /* ⚠️ **Piso de materialidade.** Sem ele, cada resíduo de rolagem do livro de câmbio (um
     USD/JPY de 25 mil num NAV de 74 MM) viraria uma linha vermelha por não ter contraparte
     no RF — e uma coluna com dez vermelhos imateriais não é lida. Mesmo corte do agregado
     por moeda (`_RF_CCY_MIN_USD`, US$ 200 mil), medido sobre a exposição da linha no MM. */
  const minUsd = cfg?.min_usd ?? 200000;
  const expUsd = (row && row.pl != null && row.pl_type === 'pct' && row.nav)
    ? Math.abs(row.pl * row.nav) : null;
  if (!Math.abs(rfQty ?? 0) && expUsd != null && expUsd < minUsd) {
    return muted('—', `Exposição de ${fmtMoneyTxt(expUsd)} no MM — abaixo do piso de `
      + `${fmtMoneyTxt(minUsd)}. Espelhar ${fmtPct(e.allocTarget)} disso seria `
      + `${fmtMoneyTxt(expUsd * (e.allocTarget ?? 0))}: não é afirmado como desvio.`);
  }
  const cls = rfAllocClass(e.allocPct, e.allocTarget);
  const dpp = (e.allocPct - e.allocTarget) * 100;
  /* ⭐ "Nada no RF" é um veredito, e a tela diz QUANTO deveria ter — a mesa não precisa fazer
     a conta para saber o tamanho do que está faltando. */
  if (!Math.abs(rfQty ?? 0)) {
    const falta = mmQty * (e.allocTarget ?? 0);
    return `<td class="check-cell ${cls}" title="${_escHtml(
      `⚠ NADA NO RF nesta linha.\n\n  MM: ${fmtFinalQtyTxt(mmQty)}\n  RF: zero\n`
      + `  Pelo alvo de ${fmtPct(e.allocTarget)}, deveria haver ~${fmtFinalQtyTxt(falta)}.`
      + (expUsd != null ? `\n\nExposição no MM: ${fmtMoneyTxt(expUsd)}.` : ''))}">⚠ nada no RF</td>`;
  }
  const tip = `QUANTIDADE, linha a linha (opção e demais instrumentos).\n\n`
    + `  MM: ${fmtFinalQtyTxt(mmQty)}\n  RF: ${fmtFinalQtyTxt(rfQty)}\n`
    + `  RF ÷ MM = ${fmtPct(e.allocPct)}  ·  alvo ${fmtPct(e.allocTarget)}`
    + `  (${dpp >= 0 ? '+' : ''}${dpp.toLocaleString('en-US', {maximumFractionDigits: 2})}pp)\n`
    + (e.expRatio != null
        ? `\nEm exposição: ${fmtPct(e.expRatio)} da do MM (alvo ${fmtPct(alvoExp)}), `
          + `pela razão dos NAVs ${e.navRatio.toLocaleString('en-US', {maximumFractionDigits: 3})}.\n`
        : '')
    + `\nVerde dentro de ±${(RF_ALLOC_REL_TOL * 100).toFixed(0)}% do alvo, amarelo até o dobro, `
    + `vermelho além — faixa RELATIVA ao alvo, porque ±2pp num alvo de ${fmtPct(e.allocTarget)} `
    + 'aceitaria quase o dobro e quase a metade dele.';
  return `<td class="check-cell ${cls}" title="${_escHtml(tip)}">${
    cls === 'alloc-ok' ? '✓' : '⚠ ' + fmtPct(_semZeroNegativo(e.allocPct))}</td>`;
}

/* Cabeçalho da coluna. `merged` = as linhas são de OUTRO trader (aba de quem recebe), e aí
   o rótulo é o apelido dele ("Check Abi"); na aba do próprio dono é "Check RF".

   ☠️ `quebra` (rótulo em DUAS linhas) é **opt-in, e tem de ser** (09/10/2026). Ela encolhe a
   coluna — o rótulo é o conteúdo mais largo dela —, mas deixa o `<thead>` uma linha mais alto,
   e **nem toda auxiliar desta tela sabe lidar com isso**:
     · auxiliar da seção 1 (`alloc-table`) → `_alignAuxTables` mede `thead.offsetHeight` AO VIVO
       e reposiciona o espaçador: pode quebrar, e é lá que a largura doía;
     · auxiliar da seção 2 (`pos-fxlegs`)  → alinha por um espaçador de altura FIXA
       (`AUX_HEAD_GAP`), que pressupõe os dois cabeçalhos da mesma altura. Quebrar ali
       desalinhou as duas tabelas linha a linha — foi o que a mesa reportou.
   Quem passar `quebra` numa auxiliar nova tem de garantir o alinhamento medido. */
function rfCheckHead(cfg, merged, quebra) {
  const tr  = cfg?.traders?.[0];
  /* ⭐ O ALVO vai no rótulo (pedido da mesa, 08/10/2026): poupa abrir o hover para lembrar
     contra o quê a coluna está medindo — do mesmo jeito que o check do Prev mostra os 30 %.
     ☠️ **E é o alvo de HOJE, não uma constante** (03/11/2026, pedido da mesa: *"não chame de
     4,4%, chame do percentual que é o necessário para estar de acordo com a proporção
     correta dos NAVs"*). Ele muda quando um dos dois NAVs anda — é esse o ponto. */
  const _alvoHoje = rfAllocTarget(cfg);
  const alvo = _alvoHoje != null ? ' ' + fmtPct(_alvoHoje) : '';
  // Duas linhas: "Check RF" em cima, o alvo embaixo — ver o comentário do cabeçalho da
  // auxiliar. O rótulo é o mais largo da coluna (as células são ✓ ou "⚠ 9,9%").
  const nome = merged ? (cfg?.labels?.[tr] ?? tr ?? 'sleeve') : 'RF';
  const lbl  = nome + (quebra && alvo ? '<br>' + alvo.trim() : alvo);
  const _fundo = rfSleeveFundLabel(cfg);
  const tip = 'Veredito do sleeve de RF nesta linha — o detalhe está no hover de cada célula.\n\n'
    + 'FUNDO CONFERIDO: ' + _fundo + ' — é o NAV dele que entra na conta; os outros fundos '
    + 'de RF da aba não recebem sleeve.\n\n'
    + 'Câmbio LINEAR (spot · NDF · forward): vem do agregado por MOEDA, contra o alvo de '
    + fmtPct(cfg?.exposure_ratio) + ' da exposição do MM.\n'
    + 'Opção e demais: linha a linha, pela QUANTIDADE, contra o alvo de boleta de '
    + (_alvoHoje != null ? fmtPct(_alvoHoje) : '—') + '.\n\n'
    + 'O alvo de boleta NÃO é constante: é ' + fmtPct(cfg?.exposure_ratio)
    + ' × NAV do ' + _fundo + ' ÷ NAV de MM do ' + (tr ?? 'trader')
    + ', refeito a cada carga. A regra combinada é a de EXPOSIÇÃO; a proporção de '
    + 'quantidade é o que a executa, e ela anda com os NAVs.\n\n'
    + '"—" = não afirmado (sem par no MM, abaixo do piso de material, ou falta um NAV).';
  return `<th title="${_escHtml(tip)}">Check ${lbl}</th>`;
}

/* ── DE ONDE SAI O ALVO DE HOJE ───────────────────────────────────────────────────────
   ☠️ **Este bloco era um CHECK e virou uma DECLARAÇÃO** (03/11/2026). Ele comparava a
   constante que a mesa boletava (4,4%) com o alvo que os NAVs do dia pediam, e mandava
   trocar a constante quando os dois se afastassem. A mesa resolveu a montante: *"faça de
   forma que seja dinâmico, dentro do target que combinamos dos 10%, ajustando pelo NAV
   atualizado"*. Com o alvo derivado a cada carga não há nada a atualizar — então o painel
   deixou de propor um número e passou a **dizer qual é o alvo de hoje e de onde ele saiu**.
   ⚠️ O que ele ainda informa é a DERIVA contra o dia do acordo (`alloc_target_ref`): não é
   alarme — é a deixa de que o ticket que a mesa boleta na mão mudou de tamanho desde então.
   ⛔ Sem um dos NAVs não há alvo: `semnav`, e a tela diz isso em vez de medir contra o
   número de outro dia. */
function _rfDrift(cfg) {
  const e   = rfAllocEval(null, null, cfg);
  const tol = cfg?.drift_tol ?? 0.05;
  if (e.allocTarget == null) return { e, tol, rel: null, nivel: 'semnav' };
  if (e.allocTargetRef == null) return { e, tol, rel: null, nivel: 'ok' };
  // COM sinal: + = o alvo de hoje está ACIMA do que foi combinado em out/2026.
  const rel = e.allocTarget / e.allocTargetRef - 1;
  const a   = Math.abs(rel);
  return { e, tol, rel, nivel: a <= tol ? 'ok' : a <= 2 * tol ? 'atencao' : 'longe' };
}

/* ── ⛔ ALERTA DE ESCOPO: ativo que o RF não pode carregar ────────────────────────────
   Regra do veículo (08/10/2026): no RF só entram os books de **juros e moedas** — nada de
   equities nem commodities. ⚠️ **Não é desvio de proporção, é posição que não deveria
   existir**, e por isso não basta pintar a célula de check: o alerta vem como FAIXA
   VERMELHA no topo da aba, nomeando instrumento, área e tamanho.
   ⭐ **Silêncio é o estado certo.** Sem linha fora do escopo isto não renderiza nada — um
   painel verde dizendo "tudo certo" todo dia treinaria a mesa a não ler a faixa no dia em
   que ela aparecesse. */
function renderRfEscopoAlerta(cfg) {
  const fora = cfg?.fora_escopo;
  if (!fora?.length) return '';
  /* A `area` é dado do JRS (inglês) e aparece crua ao lado de cada linha; na FRASE ela vira
     o nome do book em pt-BR, que é como a mesa enuncia a regra. Convenção da casa:
     interface em pt-BR, dado/ticker em inglês. */
  const BOOK = { Rates: 'juros', Currencies: 'moedas', Equities: 'bolsa', Commodities: 'commodities' };
  const ok   = (cfg.areas_ok ?? []).map(a => BOOK[a] ?? a).join(' e ') || 'juros e moedas';
  const tr   = cfg.traders?.[0] ?? 'trader';
  const li = fora.map(x => {
    const exp = (x.pl != null && x.pl_type === 'pct')
      ? ` · ${(x.pl * 100).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}% do NAV` : '';
    return `<li style="margin:1px 0"><b>${x.instrument_name ?? '—'}</b>`
      + ` <span style="color:var(--text-muted)">— ${x.area ?? '—'}`
      + `${x.subarea ? ' · ' + x.subarea : ''}</span>`
      + ` · ${fmtFinalQty(x.final_qty ?? 0)}${exp}</li>`;
  }).join('');
  return `<div class="card" style="border-left:4px solid var(--red);background:color-mix(in srgb, var(--red) 7%, var(--bg-card));flex:0 0 auto">
    <div style="font-size:12px;line-height:1.7">
      <b style="color:var(--red);font-size:13px">⛔ ${fora.length} posição(ões) FORA DO ESCOPO do RF</b>
      <div style="margin-top:2px">O veículo de RF carrega <b>só os books de ${ok}</b> — o que o
        ${tr} espelha ali não pode ter bolsa nem commodities. Estas linhas não deveriam existir:</div>
      <ul style="margin:4px 0 0 18px;padding:0">${li}</ul>
    </div>
  </div>`;
}

/* Painel do sleeve, no topo da aba. ⚠️ Sai MESMO SEM LINHA BOLETADA: ele é sobre os NAVs, e
   é justamente antes da 1ª boleta (ou num dia parado) que a mesa pergunta se a proporção
   ainda vale. */
/* ⓘ padrão da casa: glifo discreto + `title`. Usado ao longo do painel de regras para abrir
   a conta (os NAVs daquela parte, a fórmula do alvo) sem pôr parágrafo na tela. */
function _rfInfo(tip) {
  return `<span style="cursor:help;color:var(--text-muted);font-size:11px" title="${
    _escHtml(tip)}">ⓘ</span>`;
}

const _rfUsd = v => v == null ? '—'
  : 'USD ' + Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 });

/* ── PAINEL DE REGRAS DOS FUNDOS DE RF (03/11/2026) ───────────────────────────────────
   Pedido da mesa: *"bote as regras gerais de cada RF, de forma bem sucinta mas com tudo que
   precisamos saber de bate pronto... as informações extras você bota em um ⓘ ao longo do
   texto"*. Uma LINHA por fundo e nada de parágrafo: o que não cabe numa célula vai no ⓘ.

   ⛔ **Nenhuma regra é escrita aqui** — todas vêm de `funds.PORTFOLIORF_REGRAS` pelo payload
   (`portfoliorf_regras`). Um painel que soubesse as regras por conta própria seria o 2º lugar
   de onde elas podem divergir do que o check de fato aplica.
   ⚠️ **`local` × `global` é mandato DECLARADO, não conferido** — a `area` do JRS separa
   juros/câmbio/bolsa, e distinguir juros do Brasil de juros lá fora exige a `subarea`. O que
   o código acusa sozinho é bolsa/commodities em qualquer um e câmbio onde não pode; o resto é
   regra escrita. O ⓘ do mandato diz isso, para ninguém ler o painel como se fosse check. */
function renderRfRegrasPanel(data, cfg) {
  const regras = data?.portfoliorf_regras;
  if (!regras?.length) return '';
  const tr     = cfg?.traders?.[0] ?? null;
  const navMm  = tr ? cfg?.mm_nav?.[tr] : null;
  const expR   = cfg?.exposure_ratio;
  const navTot = regras.reduce((a, r) => a + (r.nav ?? 0), 0) || null;
  const sim = '<span style="color:var(--green);font-weight:600">sim</span>';
  const nao = '<span style="color:var(--red);font-weight:600">não</span>';
  const bk  = { Rates: 'juros', Currencies: 'câmbio', Equities: 'bolsa', Commodities: 'commodities' };
  const NL  = '\n';

  const linhas = regras.map(r => {
    /* ⓘ do alvo do espelho: é aqui que a conta se abre, com os DOIS NAVs daquela linha —
       pedido explícito da mesa ("mostrando os navs relevantes para aquela parte"). */
    const escopo = (r.sleeve_escopo || []).map(a => bk[a] ?? a).join(' e ');
    const alvoTip = r.sleeve_alvo == null
      ? (r.sleeve_escopo?.length
          ? `Falta o NAV do ${r.label} ou o de MM do ${tr ?? 'trader'} nesta data — sem os dois `
            + 'não há alvo a afirmar.'
          : `O ${r.label} não recebe espelho do ${tr ?? 'trader'}.`)
      : `${fmtPct(expR)} da exposição do ${tr} em ${escopo}, medida em % do NAV de cada fundo.`
        + NL + NL
        + `  NAV do ${r.label}:  ${_rfUsd(r.nav)}` + NL
        + `  NAV de MM do ${tr}: ${_rfUsd(navMm)}` + NL
        + `  alvo = ${fmtPct(expR)} × ${_rfUsd(r.nav)} ÷ ${_rfUsd(navMm)} = ${fmtPct(r.sleeve_alvo)}`
        + NL + NL
        + 'É a fração do TICKET de MM que a boleta tem de replicar aqui. Muda com os dois '
        + 'NAVs — não é constante.';
    const alvoCel = r.sleeve_escopo?.length
      ? `<b>${r.sleeve_alvo != null ? fmtPct(r.sleeve_alvo) : '—'}</b>`
        + ` <span style="color:var(--text-muted)">de ${escopo}</span> ${_rfInfo(alvoTip)}`
      : '<span style="color:var(--text-muted)">—</span>';

    const pr = r.pracas_ok || [];
    const mandTip = `O ${r.label} carrega ${(r.areas_ok || []).map(a => bk[a] ?? a).join(' e ')}`
      + `${pr.length === 1 ? ', só de praça ' + pr[0] : ', local e global'}.` + NL + NL
      + 'A PRAÇA sai da subárea do JRS: "Fixed Rates Brazil" é local, o resto é global '
      + '(G7, Emerging Markets, External Debt).' + NL
      + '⚠️ "global" INCLUI o local — fundo global também carrega Brasil. Quem tem corte de '
      + 'praça é só o Juros Local.' + NL + NL
      + '⛔ CAIXA fica fora deste check: Rates · Cash e Hedge_Cambial são tesouraria (LFT, '
      + 'mini dólar de carry, hedge do caixa), não posição de mandato — todo fundo tem caixa '
      + 'em BRL e todo caixa precisa de hedge, inclusive o que só opera juros. A estratégia '
      + '"Directional" dentro de Rates · Cash é nome de cadastro, não posição direcional.';
    const dtTip = `O ${r.label} ${r.daytrade ? 'pode' : 'NÃO pode'} girar no dia.` + NL + NL
      + '⚠️ Regra DECLARADA, não conferida aqui: quem trava o daytrade é o próprio JDS na '
      + 'boleta (mesa, 03/11/2026), então um check na tela não acrescentaria nada.';
    const navTip = `NAV usado em todo % desta aba para o ${r.label}.` + NL + NL
      + `  ${_rfUsd(r.nav)}` + (navTot ? `  (${fmtPct((r.nav ?? 0) / navTot)} do livro)` : '')
      + NL + NL + `Fonte: ${data?.fund_navs_meta?.nav_sources?.[r.fund] ?? '—'}`
      + `${data?.portfoliorf_nav_date ? ' · cota de ' + fmtDate(data.portfoliorf_nav_date) : ''}.`;

    return `<tr>
      <td style="font-weight:600;white-space:nowrap">${r.label}
        <div style="font-weight:400;color:var(--text-muted);font-size:10px">
          ${_rfUsd(r.nav)} ${_rfInfo(navTip)}</div></td>
      <td style="white-space:nowrap">${r.mandato ?? '—'} ${_rfInfo(mandTip)}</td>
      <td class="num" title="${_escHtml(dtTip)}">${
          r.daytrade == null ? '—' : r.daytrade ? sim : nao}</td>
      <td class="num" style="white-space:nowrap">${
          r.limite_deriv == null ? '—' : r.limite_deriv ? sim : nao}
        <span id="${_rfLimId(r.fund)}" style="color:var(--text-muted);font-size:11px"></span></td>
      <td class="num" style="white-space:nowrap">${r.veiculo_classe
          ? `classe <b>${r.veiculo_classe}</b> ${_rfInfo('Veículo offshore do ' + r.label
              + ': ' + r.veiculo + '. É por ele que o fundo toma risco lá fora; o NAV do check '
              + 'é SEMPRE o do fundo-cabeça, nunca o da classe.')}`
          : '<span style="color:var(--text-muted)">—</span>'}</td>
      <td style="white-space:nowrap">${alvoCel}</td>
    </tr>`;
  }).join('');

  /* Regras que valem para o CONJUNTO — uma linha só, cada uma com o seu ⓘ. */
  const tipBolsa = 'Regra do veículo de RF: nenhum dos fundos carrega bolsa nem commodities. '
    + 'Posição fora disso não é desvio de proporção, é o que não deveria existir — abre faixa '
    + 'vermelha no topo da aba e a célula de check sai em ⛔ ERRO, sem faixa de tolerância.';
  const tipDolar = 'Dólar direcional só pode estar no Juros e Moeda, que é quem tem câmbio no '
    + 'mandato. Quantidade de dólar em qualquer outro fundo é ERRO (faixa própria no topo da '
    + 'aba), e por isso o #PL dessas linhas é calculado sobre o NAV dele, não sobre a soma dos '
    + 'três.';
  const tipJuros = 'Duas afirmações, as duas conferidas na auxiliar:' + NL + NL
    + '  1. os TRÊS fundos carregam a mesma alocação de juros entre si — é o Check #PL, fundo '
    + 'contra livro;' + NL
    + '  2. e o livro inteiro espelha o EMota 1:1, cada um em % do NAV do seu fundo — é o '
    + 'Check EMota.' + NL + NL
    + '⚠️ Câmbio NÃO tem esse propósito: ele só existe no Juros e Moeda, então não há rateio '
    + 'a conferir. E o caixa (Rates · Cash, Hedge_Cambial) fica fora dos dois: é tesouraria, '
    + 'não alocação.';
  const tipAbi = tr
    ? `Os trades de ${tr} seguem o padrão dele: ${fmtPct(expR)} da exposição que ele carrega no `
      + 'MM, em cada fundo que recebe espelho, medida em % do NAV de cada um.' + NL + NL
      + 'Os de JUROS vão para o Juros e Moeda E para o Juros Global (ele costuma operar fora do '
      + 'Brasil, então não entram no Juros Local); os de CÂMBIO só para o Juros e Moeda.' + NL + NL
      + `NAV de MM do ${tr}: ${_rfUsd(navMm)} — é o denominador do lado dele em todos os alvos.`
    : 'Sem trader de espelho configurado.';

  /* ⚠️ O HTML é devolvido como STRING e inserido pelo chamador — os spans do % só existem
     no DOM no próximo tick. Daí o `setTimeout(0)`: ele é o primeiro momento em que
     `getElementById` acha o que preencher. */
  setTimeout(_rfPreencheLimites, 0);

  return `<div class="card" style="flex:0 0 auto">
    <div style="font-size:12px;line-height:1.6">
      <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap">
        <b>Regras dos fundos de RF</b>
        <span style="color:var(--text-muted);font-size:11px">NAV do livro <b>${_rfUsd(navTot)}</b>
          ${_rfInfo('Soma dos NAVs dos fundos da aba — é o denominador do #PL das linhas '
            + 'rateadas. As linhas de dólar e as offshore usam o NAV de UM fundo só.')}</span>
      </div>
      <table class="data-table" style="width:auto;margin-top:6px;white-space:nowrap">
        <thead><tr>
          <th>Fundo</th><th>Mandato</th><th>Daytrade</th>
          <th>Limite 100%<br>NAV deriv.</th><th>Offshore</th>
          <th>Espelho ${tr ?? 'MM'} (${fmtPct(expR)} da exp.)</th>
        </tr></thead>
        <tbody>${linhas}</tbody>
      </table>
      <div style="margin-top:6px;color:var(--text-muted);font-size:11px">
        Nos três: <b>bolsa e commodities não entram</b> ${_rfInfo(tipBolsa)}
        &nbsp;·&nbsp; dólar direcional só no <b>Juros e Moeda</b> ${_rfInfo(tipDolar)}
        &nbsp;·&nbsp; juros <b>alinhados entre os três</b> e espelhando o <b>EMota 1:1</b> ${_rfInfo(tipJuros)}
        &nbsp;·&nbsp; trades do <b>${tr ?? 'MM'}</b> no padrão dos ${fmtPct(expR)} ${_rfInfo(tipAbi)}
      </div>
    </div>
  </div>`;
}

/* ── O % que está BOLETADO hoje, ao lado do "tem limite?" ─────────────────────────────
   Pedido da mesa (03/11/2026): *"na regra dos derivativos, mostre entre parênteses, além do
   sim ou não, qual é o % atual pelo que tá boletado — nós temos a regra na aba Check
   Enquadramento"*.

   ⛔ **O número NÃO é recalculado aqui.** Ele sai do MESMO payload que a aba Check
   Enquadramento usa (`/enquadramento-rf`, cacheado em `posDataByTab[ENQ_RF_TAB_KEY]`), que é
   onde moram o PU ao vivo do DI, o nocional do dólar e o delta das opções. Refazer a conta
   neste painel seria um 2º lugar de onde o enquadramento pode divergir de si mesmo — e as
   duas telas ficariam dizendo números diferentes sobre a mesma regra.
   ⚠️ Por isso o painel desenha o espaço e PREENCHE depois: se a outra aba ainda não carregou,
   dispara UMA vez a mesma função que ela usa (o resultado fica no cache compartilhado, então
   abrir a aba depois não paga de novo) e escreve nos spans quando chegar. Sem o dado, o
   espaço fica vazio — nunca um número estimado. */
function _rfLimId(fund) {
  return 'rf_lim_' + String(fund || '').replace(/[^a-zA-Z0-9]/g, '_');
}

let _rfLimPedido = false;

function _rfPreencheLimites() {
  const d = (typeof ENQ_RF_TAB_KEY !== 'undefined') ? posDataByTab[ENQ_RF_TAB_KEY] : null;
  if (!d?.funds?.length) {
    // Uma tentativa só: a aba de enquadramento é cara (BBG + Oracle) e um retry em loop
    // numa tela que re-renderiza a cada ⟳ viraria tráfego de fundo permanente.
    if (!_rfLimPedido && typeof loadEnquadramentoRF === 'function') {
      _rfLimPedido = true;
      Promise.resolve(loadEnquadramentoRF()).then(_rfPreencheLimites).catch(() => {});
    }
    return;
  }
  for (const f of d.funds) {
    const el = document.getElementById(_rfLimId(f.fund_label));
    if (!el) continue;
    /* ⚠️ **"Nada boletado" e "ainda não carregou" não podem desenhar igual.** Enquanto o
       payload não chega o span fica VAZIO; chegando e sem derivativo no fundo, ele diz isso.
       Sem a distinção, `sim` sozinho se lê como falha de carga. */
    if (f.max_pct == null) {
      el.innerHTML = ' <span title="' + _escHtml('Nenhum derivativo boletado neste fundo '
        + 'nesta data (nem DI nem dólar) — não há % a mostrar.') + '">(sem derivativo)</span>';
      continue;
    }
    /* O que vai entre parênteses é a caixinha MAIOR — é ela que encosta no teto primeiro.
       O detalhe por caixinha vai no ⓘ, que é onde a mesa confere de onde veio. */
    const det = (f.buckets || []).filter(b => b.pct != null)
      .map(b => `${b.label}: ${fmtPct(b.pct)}`).join(' · ');
    const over = (f.buckets || []).some(b => b.over);
    el.innerHTML = ` (<b style="color:${over ? 'var(--red)' : 'var(--text-muted)'}">${
      fmtPct(f.max_pct)}</b>) ` + _rfInfo(
      `Quanto está BOLETADO hoje, em % do NAV do ${fundLabelMesa(f.fund_label, true)}, por `
      + `caixinha de derivativo:` + '\n\n  ' + (det || '—') + '\n\n'
      + `O número entre parênteses é a maior delas${f.limite_deriv === false
          ? ' — este fundo não tem teto, o % está aqui só como leitura.'
          : ' — é ela que encosta no limite de 100% primeiro.'}` + '\n\n'
      + 'Vem da aba Check Enquadramento (mesmo payload, mesma conta): PU ao vivo no DI, '
      + 'nocional × delta no dólar. As caixinhas não se compensam entre si.');
  }
}

/* ── O alvo do espelho, para a aba do PRÓPRIO trader de MM ────────────────────────────
   Lá não há painel de regras (os NAVs dos fundos de RF não são carregados naquela aba), e o
   que ele precisa saber é só: qual fundo recebe o espelho dele e em que proporção hoje. */
function renderRfTargetBanner(cfg, data) {
  if (!cfg) return '';
  const painel = renderRfRegrasPanel(data, cfg);
  if (painel) return painel;

  const { e, tol, rel, nivel } = _rfDrift(cfg);
  const tr    = cfg.traders?.[0] ?? 'trader';
  const navMm = cfg.mm_nav?.[tr];
  const fundo = rfSleeveFundLabel(cfg);
  const COR = { semnav: 'var(--yellow)', ok: 'var(--green)',
                atencao: 'var(--text-muted)', longe: 'var(--text-muted)' }[nivel];

  let veredito, detalhe;
  if (nivel === 'semnav') {
    veredito = '⚠ sem os dois NAVs — alvo não afirmado hoje';
    detalhe  = `Falta ${cfg.nav == null ? 'o NAV do ' + fundo : 'o NAV de MM do ' + tr}`
             + ' nesta data, e o alvo é derivado dos dois — a coluna de check sai em "—" em vez'
             + ' de medir contra o número de outro dia.';
  } else {
    veredito = `alvo de hoje ${fmtPct(e.allocTarget)} do ticket de MM`;
    const dppRef = (e.allocTargetRef != null) ? (e.allocTarget - e.allocTargetRef) * 100 : null;
    detalhe = `Para o <b>${fundo}</b> carregar <b>${fmtPct(e.expTarget)}</b> da exposição do `
      + `${tr} (cada uma em % do NAV do seu fundo), a boleta tem de sair em `
      + `<b>${fmtPct(e.allocTarget)}</b> do ticket de MM. O número vem dos NAVs abaixo e `
      + '<b>muda com eles</b> — não é constante. '
      + _rfInfo(`alvo = ${fmtPct(e.expTarget)} × NAV do ${fundo} ÷ NAV de MM do ${tr}`
          + '\n\n' + `  NAV do ${fundo}:  ${_rfUsd(cfg.nav)}` + '\n'
          + `  NAV de MM do ${tr}: ${_rfUsd(navMm)}`)
      + (dppRef != null && Math.abs(rel ?? 0) > tol
          ? ' <span style="color:var(--text-muted)">Em out/2026, quando a regra foi combinada, '
            + `isto dava ${fmtPct(e.allocTargetRef)}.</span>`
          : '');
  }

  const navLinha = `NAV do ${fundo} <b>${_rfUsd(cfg.nav)}</b> `
    + `<span style="color:var(--text-muted)">(${(cfg.nav_fund ?? '—').replace(/^JGP /, '')}`
    + `${cfg.nav_date ? ' · ' + fmtDate(cfg.nav_date) : ''}${cfg.nav_source ? ' · ' + cfg.nav_source : ''})</span>`
    + ` &nbsp;·&nbsp; NAV de MM do ${tr} <b>${_rfUsd(navMm)}</b>`;

  const semLinha = !cfg.n_rows
    ? ` <span style="color:var(--text-muted);font-weight:400;font-size:11px" title="${_escHtml(
        'Nenhuma posição do ' + tr + ' no ' + (cfg.fund ?? 'veículo') + ' nesta data. O painel acima é '
        + 'sobre os NAVs e vale assim mesmo; as tabelas de check só aparecem quando houver linha.')
      }">· sem linha boletada hoje</span>`
    : '';

  return `<div class="card" style="border-left:3px solid ${COR};flex:0 0 auto">
    <div style="font-size:12px;line-height:1.7">
      <b>Sleeve de RF no ${fundo} — ${fmtPct(e.expTarget)} da exposição do ${tr}</b>
      <span style="color:${COR};font-weight:600">&nbsp;&nbsp;${veredito}</span>${semLinha}
      <div style="color:var(--text);margin-top:2px">${detalhe}</div>
      <div style="margin-top:2px">${navLinha}</div>
    </div>
  </div>`;
}

/* ── Exposição por MOEDA — o check do câmbio linear ───────────────────────────────────
   Cada par decomposto em pernas contra o dólar (`EUR/AUD` = +EUR −AUD), somado por moeda,
   dos dois lados, cada um sobre o NAV do SEU fundo. É a régua do câmbio, porque a mesma
   exposição é montada com contratos diferentes em cada livro. A conta vem pronta do backend
   (`rf_sleeve.ccy_check` → `_rf_ccy_check`); aqui é só apresentação. */
function renderRfCcyCheck(cfg, tabId) {
  const c = cfg?.ccy_check;
  if (!c?.linhas?.length) return '';
  const alvo = cfg.exposure_ratio;
  const usd  = v => v == null ? '—'
    : (v < 0 ? '(' : '') + Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 })
      + (v < 0 ? ')' : '');
  const pct  = v => v == null ? '—'
    : (v < 0 ? '(' : '') + Math.abs(v * 100).toLocaleString('en-US',
        { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%' + (v < 0 ? ')' : '');
  const col  = v => v == null ? '' : (v < 0 ? 'style="color:var(--red)"' : '');

  const tr = c.linhas.map((l, i) => {
    const mutedRow = (l.small || l.numerario) ? ' style="color:var(--text-muted)"' : '';
    const rCls = l.ratio != null ? rfAllocClass(l.ratio, alvo) : '';
    const rTxt = l.ratio != null ? pct(l.ratio)
      : `<span style="color:var(--text-muted)" title="${_escHtml(
          l.numerario
            ? 'O dólar é o NUMERÁRIO dos dois NAVs — "exposição a USD" não é risco aqui. E ela '
              + 'não pode espelhar: no MM o euro vem de EUR/AUD, que não toca o dólar, e no RF de '
              + 'EUR/USD + AUD/USD, cujas pernas de dólar se cancelam. A linha fica como informação, '
              + 'fora do veredito e fora do agregado.'
            : l.small
              ? `Abaixo de US$ ${Number(c.min_usd).toLocaleString('en-US')} nos dois lados — resíduo de rolagem. `
                + 'A proporção aqui não diz nada, então não é afirmada.'
              : 'Sem exposição material no MM para servir de denominador.')}">—</span>`;
    return `<tr class="${i % 2 === 0 ? 'group-odd' : 'group-even'}"${mutedRow}>
      <td><b>${l.ccy}</b></td>
      <td class="num" ${col(l.mm_usd)}>${usd(l.mm_usd)}</td>
      <td class="num" ${col(l.mm_pct)}>${pct(l.mm_pct)}</td>
      <td class="num" ${col(l.rf_usd)}>${usd(l.rf_usd)}</td>
      <td class="num" ${col(l.rf_pct)}>${pct(l.rf_pct)}</td>
      <td class="num ${rCls}">${rTxt}</td>
    </tr>`;
  }).join('');

  const g = c.gross;
  const gCls = g.ratio != null ? rfAllocClass(g.ratio, alvo) : '';
  const gTr = `<tr style="border-top:2px solid var(--border)">
    <td><b>Agregado</b> <span style="color:var(--text-muted);font-size:10px" title="${_escHtml(
      'Soma dos MÓDULOS das moedas, SEM o dólar. Somar com sinal faria as pernas de um par se '
      + 'cancelarem e o total sairia ~0 dos dois lados, dizendo nada; e o dólar é o numerário '
      + 'dos dois NAVs, não risco.')}">módulos, ex-USD</span></td>
    <td class="num"><b>${usd(g.mm_usd)}</b></td>
    <td class="num"><b>${pct(g.mm_pct)}</b></td>
    <td class="num"><b>${usd(g.rf_usd)}</b></td>
    <td class="num"><b>${pct(g.rf_pct)}</b></td>
    <td class="num ${gCls}"><b>${pct(g.ratio)}</b></td>
  </tr>`;

  const foraTxt = Object.entries({ ...(c.fora?.mm ?? {}) })
    .map(([k, n]) => `${n}× ${k}`).join(' · ');
  const foraRf = Object.entries({ ...(c.fora?.rf ?? {}) })
    .map(([k, n]) => `${n}× ${k}`).join(' · ');
  const nota = (foraTxt || foraRf)
    ? `<div style="font-size:11px;color:var(--text-muted);margin-top:6px;white-space:normal;max-width:620px">`
      + `⛔ Fora desta conta (só câmbio linear entra): `
      + [foraTxt && `no MM ${foraTxt}`, foraRf && `no RF ${foraRf}`].filter(Boolean).join(' · ')
      + `. Opção de FX e futuro de dólar são conferidos <b>linha a linha, pela quantidade</b>, `
      + `nas colunas do sleeve à direita da tabela de posição — o nocional de uma opção é `
      + `nocional × delta e não é somável como exposição de moeda.</div>`
    : '';
  /* ☠️ Não é "uma perna omitida": a linha sem spot é pulada INTEIRA, então um cross
     (`EUR/MXN`) tira também a perna da moeda que TEM spot — e aí a razão de uma moeda
     listada aqui sai errada sem nada marcando a célula. Enquanto houver `sem_spot`, as
     colunas de check das linhas de câmbio saem como "—" (ver `rfCheckCell`). */
  const semSpot = c.sem_spot?.length
    ? `<div style="font-size:11px;color:var(--red);margin-top:4px">⚠ <b>agregado incompleto</b> — `
      + `sem spot de ${c.sem_spot.join(', ')}: a linha inteira é pulada, e um cross pulado `
      + `tira da conta também a perna da outra moeda. As razões acima podem estar erradas em `
      + `moeda que nem aparece nesta lista.</div>`
    : '';

  const veredito = g.ratio == null ? ''
    : `<span style="font-weight:600;color:${
        rfAllocClass(g.ratio, alvo) === 'alloc-ok' ? 'var(--green)'
        : rfAllocClass(g.ratio, alvo) === 'alloc-warn' ? 'var(--yellow)' : 'var(--red)'
      }">${rfAllocClass(g.ratio, alvo) === 'alloc-ok' ? '✓' : '⚠'} agregado ${pct(g.ratio)} · alvo ${pct(alvo)}</span>`;

  /* ⭐ **Colapsado por padrão, e no FIM da aba** (pedido da mesa, 08/10/2026): a leitura do dia
     a dia é a tabela de posição, e um card de 10 moedas acima dela empurrava tudo para baixo.
     ⚠️ Mas o VEREDITO fica no TÍTULO, que continua visível fechado — esconder o card inteiro
     tiraria da tela justamente o número que responde "a conta de 10% bate?". Mesmo padrão do
     card de MM Prev (pos-tabs.js): cabeçalho sempre à vista, corpo atrás da setinha. */
  /* ☠️ Id por ABA. Era `rfCcyWrap` fixo, e o card é renderizado nas DUAS abas que têm sleeve
     — dois elementos com o MESMO id no documento. O `getElementById` devolve sempre o
     primeiro (o da aba do PortfolioRF, escondido), então a setinha da aba do PAbinader
     abria o card da outra e, na tela, não acontecia nada. */
  const wrapId = `rfCcyWrap_${tabId || currentRenderTab()}`;
  return `<div class="card" style="flex:0 0 auto">
    <div class="section-copy-target">
      <div style="cursor:pointer;user-select:none" onclick="(function(btn,wrap){
        var open=wrap.style.display!=='none';
        wrap.style.display=open?'none':'';
        btn.textContent=open?'▶':'▼';
      })(this.querySelector('.rfCcyArrow'),document.getElementById('${wrapId}'))">
      <div class="section-title" style="padding:4px 0 8px 0;font-size:12px;display:flex;align-items:baseline;gap:14px;flex-wrap:wrap">
        <span>Exposição por moeda — RF × ${c.trader}
          <span style="font-weight:400;color:var(--text-muted);font-size:11px" title="${_escHtml(
            'Cada par decomposto em pernas CONTRA O DÓLAR (EUR/AUD = +EUR −AUD) e somado por moeda. '
            + 'É a régua do câmbio: a mesma exposição é montada com contratos diferentes em cada livro, '
            + 'então instrumento contra instrumento não compara nada.')}">câmbio linear · spot · NDF · forward</span>
        </span>
        ${veredito}
        <button class="btn btn-secondary" data-html2canvas-ignore="true"
                style="padding:2px 10px;font-size:12px;margin-left:auto" onclick="event.stopPropagation();copyCardImage(this)">⎘ Copiar</button>
        <span class="rfCcyArrow" style="font-size:13px;color:var(--text-muted)">▶</span>
      </div>
      </div>
      <div id="${wrapId}" style="display:none">
      <table class="data-table alloc-table" style="white-space:nowrap;width:auto">
        <thead><tr>
          <th>Moeda</th>
          <th title="${_escHtml('Exposição do book de MM do ' + c.trader + ' naquela moeda, em USD ao spot.')}">MM (USD)</th>
          <th title="${_escHtml('Sobre o NAV de MM do trader: USD ' + Number(c.nav_mm ?? 0).toLocaleString('en-US', {maximumFractionDigits:0}))}">% NAV MM</th>
          <th title="${_escHtml('Exposição do sleeve naquela moeda, em USD ao spot.')}">RF (USD)</th>
          <th title="${_escHtml('Sobre o NAV do fundo que detém o veículo: USD ' + Number(c.nav_rf ?? 0).toLocaleString('en-US', {maximumFractionDigits:0}))}">% NAV RF</th>
          <th title="${_escHtml('% NAV RF ÷ % NAV MM. É O CHECK: o RF tem de carregar ' + (alvo*100).toFixed(0)
            + '% do que o MM carrega. Verde dentro de ±' + (RF_ALLOC_REL_TOL*100).toFixed(0)
            + '% do alvo, amarelo até o dobro, vermelho além.')}">RF ÷ MM · alvo ${pct(alvo)}</th>
        </tr></thead>
        <tbody>${tr}${gTr}</tbody>
      </table>
      ${nota}${semSpot}
      </div>
    </div>
  </div>`;
}

/* Resumo de UMA linha para o rodapé das tabelas de check — o recado longo mora no painel.
   ⚠️ Diz **qual RF** está sendo conferido: a aba tem três fundos de RF desde 30/10/2026 e o
   sleeve mora só no `RF_SLEEVE_NAV_FUND`; "o RF" sozinho deixou de identificar alguma coisa. */
function rfTargetNote(cfg) {
  const { e, nivel } = _rfDrift(cfg);
  const fundo = rfSleeveFundLabel(cfg);
  const tr    = cfg?.traders?.[0] ?? 'trader';
  if (nivel === 'semnav') {
    return `<span style="color:var(--yellow)">Alvo não afirmado hoje — falta o NAV do `
         + `${fundo} ou o de MM do ${tr}, e o alvo é derivado dos dois.</span>`;
  }
  return `<span style="color:var(--text-muted)">Alvo de hoje <b>${fmtPct(e.allocTarget)}</b> do `
       + `ticket de ${tr} — é o que põe o <b>${fundo}</b> em ${fmtPct(e.expTarget)} da exposição `
       + `dele, pela razão dos NAVs do dia. Não é constante: muda com os NAVs.</span>`;
}


/* ⚰️ **`renderRfSleeveCheck` foi REMOVIDA (08/10/2026) — era inalcançável.** Ela existia como
   auxiliar autônoma para o caso "sleeve presente, mas sem break por fundo". Esse caso não
   existe: o break (`df_by_fund`) é montado sobre os fundos em `PORTFOLIORF_FUNDS ∪
   {RF_SLEEVE_FUND}`, e a própria linha do sleeve está nesse conjunto — logo, havendo sleeve,
   `fund_rows` nunca vem vazio e `hasFundBreak` é sempre true. Os checks moram DENTRO do break
   (`rfCheckCell`, uma auxiliar só). Ficavam ~50 linhas com um `colspan` que já não batia com
   o nº de colunas depois que as três viraram uma. */

/* ── ESPELHO DE JUROS: a coluna `Check EMota` (23/10/2026) ───────────────────────────
   "Geralmente seguimos a mesma alocação de juros do EMota no PortfolioRF, então ambos
   precisam estar alinhados" (mesa). Alvo **1:1** — a mesma exposição em % do NAV de cada
   um —, e não uma fração como nos outros dois checks da tela.

   A conta inteira mora no `rfMirrorEval` (pos-helpers.js); aqui é só o veredito. Fora do
   escopo de juros (LFT/caixa, dólar, hedge cambial, e as linhas do sleeve) a célula fica
   MUDA, sem fundo: pintar o que não foi conferido é pior que não pintar.

   ⚠️ O que a célula imprime quando não bate é a DIFERENÇA DE EXPOSIÇÃO, na unidade do #PL
   da linha (pedido da mesa) — `%` do NAV nas linhas de preço, "% do NAV por 100 bps" nas de
   taxa, que é a mesma unidade da coluna #PL ao lado. 3 casas quando o número é pequeno: com
   2 fixas um desvio de 15% num vértice pequeno imprimia "0.00" em VERMELHO. */
function _mirrorDiffTxt(diff, type) {
  const abs = Math.abs(diff);
  const dec = abs < 0.01 ? 3 : 2;
  const s = type === 'pct'
    ? (abs * 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%'
    : abs.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  return (diff >= 0 ? '+' : '−') + s;
}

/* ☠️ TOOLTIP NÃO ACEITA HTML — e o erro é silencioso. `fmtFinalQty`/`fmtPL` devolvem
   `<span style=…>`, que num `title=` aparece COMO TEXTO ("<span style="color:var(--red)">(705)").
   Daí estes dois formatadores de TEXTO PURO, na mesma convenção da tabela (negativo entre
   parênteses). ⚠️ Vale para qualquer tooltip novo desta tela. */
function _txtNum(v, dec) {
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  return v < 0 ? `(${s})` : s;
}

function _mirrorQtyTxt(v) {
  return v == null ? '—' : _txtNum(Math.round(v), 0);
}

function _mirrorExpTxt(v, type) {
  if (v == null) return '—';
  return type === 'pct' ? _txtNum(v * 100, 2) + '%' : _txtNum(v, 2);
}

function mirrorCheckCell(row, cfg, escopo) {
  const tr = cfg?.trader ?? 'EMota';
  if (!cfg) return '';
  /* `escopo` = o lado que está sendo conferido. Vazio = o livro do RF inteiro (modo
     consolidado); no modo "Por fundo" vem o rótulo do bloco, porque ali a linha avaliada é a
     do FUNDO — mesmo check, outro denominador, e a célula tem de dizer de quem fala. */
  const esc = escopo || 'RF';
  if (!row?.rf_mirror_scope) {
    return _checkVazio('—', `Fora do espelho de juros: o check compara com o book de MM do `
      + `${tr} só nas linhas de JUROS DIRECIONAIS.

Ficam de fora o caixa/carry (LFT), o `
      + `dólar do próprio RF e o hedge cambial — lá o ${tr} ou não tem a linha, ou a tem com `
      + `outra finalidade, e a razão não mediria nada.`);
  }
  const e   = rfMirrorEval(row, cfg);
  const un  = row.pl_type === 'pct' ? '% do NAV' : '% do NAV por 100 bps';
  const qtd = `  ${tr}: ${_mirrorQtyTxt(e.qMm)}  ⇒  equivale a ${_mirrorQtyTxt(e.qEq)} aqui `
            + `(pela razão dos NAVs)
  ${esc}: ${_mirrorQtyTxt(
                (typeof effectiveRowValues === 'function'
                  ? effectiveRowValues(row).final : row.final_qty) ?? 0)}`;

  if (e.caso == null) {
    return _checkVazio('—', `Não afirmado: falta o NAV de um dos dois lados, ou a linha não `
      + `tem posição em nenhum deles.`);
  }
  if (e.caso === 'so_rf') {
    return `<td class="check-cell alloc-bad" title="${_escHtml(
      `⚠ O ${tr} NÃO TEM esta linha.

${qtd}

Toda a exposição ${escopo ? 'do ' + esc : 'do RF'} aqui `
      + `(${_mirrorExpTxt(e.expRf, row.pl_type)} ${un}) está sem par no book dele.`)}">⚠ sem par</td>`;
  }
  if (e.caso === 'zerado_rf') {
    return `<td class="check-cell alloc-bad" title="${_escHtml(
      `⚠ ZERADO ${escopo ? 'NO ' + esc.toUpperCase() : 'NO RF'}, e o ${tr} carrega.

${qtd}

`
      + `Para igualar o %NAV dele, ${escopo ? 'este fundo' : 'o RF'} precisaria de `
      + `~${_mirrorQtyTxt(e.qEq)}.`)}">⚠ zerado ${escopo ? 'aqui' : 'no RF'}</td>`;
  }
  if (e.caso === 'oposto') {
    return `<td class="check-cell alloc-bad" title="${_escHtml(
      `⛔ LADOS OPOSTOS — ${escopo ? 'o ' + esc : 'o RF'} está de um lado e o ${tr} do outro.

${qtd}

Não existe `
      + `"a mais/a menos" aqui: é divergência de direção, não de tamanho.`)}">⛔ lado oposto</td>`;
  }

  const relPct = (e.rel * 100).toLocaleString('en-US', { maximumFractionDigits: 1 });
  const tip = `ESPELHO DE JUROS — a mesma exposição que o ${tr}, cada um sobre o NAV do seu `
    + `livro (alvo 1:1).${escopo ? ' Aqui o lado do RF é o ' + esc + '.' : ''}

`
    + `  ${esc.padEnd(5)} ${_mirrorExpTxt(e.expRf, row.pl_type).padStart(9)}  (${un})
`
    + `  ${tr.padEnd(5)} ${_mirrorExpTxt(e.expMm, row.pl_type).padStart(9)}
`
    + `  ${esc} ÷ ${tr} = ${fmtPct(e.ratio)}   (${e.rel >= 0 ? '+' : ''}${relPct}%)

`
    + qtd + `

`
    + `Verde dentro de ±${(e.tol * 100).toLocaleString('en-US', {maximumFractionDigits: 1})}% `
    + `da exposição dele, amarelo até o dobro, vermelho além`
    + (e.tol > (cfg.rel_tol ?? RF_MIRROR_REL_TOL) + 1e-9
        ? ` — faixa alargada nesta linha porque 1 contrato de diferença já passaria de `
          + `${((cfg.rel_tol ?? RF_MIRROR_REL_TOL) * 100).toFixed(0)}%, e abaixo disso a boleta não desce.`
        : '.');
  const cls = rfMirrorClass(e);
  return `<td class="check-cell ${cls}" title="${_escHtml(tip)}">${
    e.caso === 'ok' ? '✓'
      : (e.diff != null ? '⚠ ' + _mirrorDiffTxt(e.diff, row.pl_type)
                        : '⚠ ' + fmtPct(e.ratio))}</td>`;
}

/* Cabeçalho da coluna do espelho.
   ⚠️ **O rótulo é só "Check EMota"** (pedido da mesa, 23/10/2026). Ele nasceu com o alvo
   embaixo ("1:1"), como o `rfCheckHead` faz com o alvo do sleeve — mas ali o número é o que a
   mesa troca de tempos em tempos, e aqui ele é fixo por definição (a mesma alocação é a mesma
   alocação). O que o alvo explicava continua no `title`, que é onde a dúvida nasce.
   `extraTip` acrescenta uma linha ao tooltip — é por onde o modo "Por fundo" diz que o veredito
   é do LIVRO INTEIRO, informação que antes vivia num `(livro)` embaixo do rótulo. */
function mirrorCheckHead(cfg, extraTip) {
  const tr  = cfg?.trader ?? 'EMota';
  const tol = (cfg?.rel_tol ?? RF_MIRROR_REL_TOL) * 100;
  const tip = `A mesma alocação de JUROS do ${tr}: os dois carregam a mesma exposição, cada `
    + `um em % do NAV do seu livro (alvo 1:1).

`
    + `A razão sai da QUANTIDADE e é exata — o instrumento é o mesmo dos dois lados, então `
    + `preço e tamanho de contrato cancelam: exp_RF/exp_${tr} = (q_RF/q_${tr}) × (NAV_${tr}/NAV_RF).

`
    + `✓ = alinhado (±${tol.toLocaleString('en-US', {maximumFractionDigits: 1})}%, e nunca `
    + `menos que 1 contrato). Fora disso a célula mostra a DIFERENÇA DE EXPOSIÇÃO na unidade `
    + `do #PL da linha, com + = o RF carrega mais que o ${tr}.

`
    + `"—" = fora do espelho (caixa/carry, dólar, hedge cambial e as linhas do sleeve).`
    + (extraTip ? `

${extraTip}` : '');
  return `<th title="${_escHtml(tip)}">Check ${tr}</th>`;
}

/* ── ⛔ DÓLAR NO FUNDO ERRADO — regra do veículo (29/10/2026, pedido da mesa) ────────────
   *"Quando é dólar direcional, ele só pode estar no RF Juros e Moeda, o que tem offshore —
   então precisa acusar como ERRO quando tiver algo no Institucional."*

   O backend JÁ trata essas linhas como 100% do fundo offshore (`alloc_offshore_only`): é o
   NAV dele que vira denominador do #PL e é ele o alvo do check de alocação. O que faltava
   era conferir a PREMISSA — que o fundo Juros Local não carregue dólar nenhum.

   ☠️ **O `Check #PL` ao lado NÃO pega isto, e não é caso de borda.** Ele mede o desvio em
   **pp de NAV**, e a faixa verde vai até `ALLOC_TOL` (2pp): uma linha de dólar de −0,5 % do
   NAV com METADE dela no fundo errado dá 0,25pp de desvio e imprime **✓** — posição num
   fundo que não pode tê-la, lida como alocação em dia. O que decide aqui é a PRESENÇA de
   quantidade onde ela não pode existir, não o tamanho dela; por isso não há faixa de
   tolerância e o veredito é **ERRO**, não ⚠.
   ⚠️ Quantidade ZERADA não acusa: a linha pode ter existido no fundo e sido zerada no dia (o
   break imprime "—" nela), e acusar o que já não está lá treina a mesa a ignorar a coluna.
   ⚠️ Vale também para a linha `is_offshore`, cujo check hoje é só o rótulo "offshore": ela
   mora no veículo offshore, que é justamente o que faz o dólar ser do Juros e Moeda. */
const _DOLAR_FUNDO_EPS = 1e-9;
/* O mesmo teste na unidade do modo "por fundo" (pos-fundsplit.js), onde o que se tem é a
   FATIA da linha naquele bloco e não a quantidade de cada fundo. Folga maior porque a fatia
   é uma divisão (`q_fundo / q_livro`) e não uma quantidade crua — 1e-6 é 0,0001 % da linha,
   ordens de grandeza abaixo de qualquer posição de verdade. */
const _DOLAR_SHARE_EPS = 1e-6;

/* Fundos (que não o offshore) com quantidade nesta linha de dólar. `null` = nada errado. */
function dolarFundoErrado(byFund, fundLabels, offFund) {
  if (!offFund) return null;
  const errs = fundLabels
    .filter(fl => fl !== offFund)
    .map(fl => ({ fund: fl, qty: byFund?.[fl]?.final_qty ?? 0 }))
    .filter(x => Math.abs(x.qty) > _DOLAR_FUNDO_EPS);
  return errs.length ? errs : null;
}

function _dolarErroTip(errs, offFund) {
  const lista = errs.map(x => `${fundLabelMesa(x.fund, true)} ${fmtFinalQtyTxt(x.qty)}`).join(' · ');
  return 'ERRO — dólar fora do fundo certo.\n\n'
    + `Dólar direcional só pode estar no ${fundLabelMesa(offFund, true)}, que é o fundo com o `
    + 'veículo offshore. Há posição em: ' + lista + '.\n\n'
    + 'Não é desvio de rateio, é posição num fundo que não opera dólar — não há faixa de '
    + 'tolerância aqui. ⚠️ E enquanto durar, a exposição (#PL) da tabela principal também '
    + `está errada: ela é calculada sobre o NAV do ${fundLabelMesa(offFund, true)}.`;
}

/* As linhas de dólar com quantidade em fundo que não pode tê-la, para o alerta do topo da
   aba. Varre o livro INTEIRO — não a lista filtrada/visível: filtro e "✕ Ocultar zeradas"
   são escolha de leitura, e posição no fundo errado não pode sumir da tela por causa delas. */
function dolarFundoErros(mainRows, fundRows, fundNavs, offshoreFund) {
  if (!mainRows?.length || !fundRows?.length || !fundNavs) return [];
  const offFund = (offshoreFund && fundNavs[offshoreFund] != null) ? offshoreFund : null;
  if (!offFund) return [];
  const fundLabels = Object.keys(fundNavs);
  const fundIndex  = {};
  for (const fr of fundRows) {
    const k = `${fr.instrument_reference}||${fr.area}||${fr.subarea}||${fr.strategy}||${fr.maturity ?? ''}`;
    (fundIndex[k] ??= {})[fr.fund_label] = fr;
  }
  const out = [];
  for (const r of mainRows) {
    /* ⚠️ **Só linha de DÓLAR** (`dollar_kind`), não toda `alloc_offshore_only` (30/10/2026).
       A condição era a segunda, e funcionava enquanto o offshore fosse de um fundo só: as
       linhas de veículo têm `fund_label` da classe offshore, que não está em `fundNavs`, e
       por isso nunca acusavam. Com o `Juros Global` podendo carregar juros em moeda forte
       DIRETO no fundo (sem passar pelo veículo), aquela linha passaria a casar com um
       `fundLabels` e sairia na faixa como "dólar no fundo errado" — sendo juros, e estando
       no fundo certo. A regra da mesa é sobre dólar; o resto é o check de ESCOPO ao lado. */
    /* ☠️ **Caixa fica de fora** (03/11/2026): `Rates - Cash` é onde mora o dólar do hedge
       cambial, e a `strategy` "Directional" ali é nome de cadastro, não posição direcional.
       Todo fundo tem caixa em BRL e todo caixa precisa de hedge — acusar isso seria uma
       faixa vermelha diária sobre o que está certo. Ver `funds.PORTFOLIORF_SUBAREAS_CAIXA`. */
    if (!r.dollar_kind || r.is_rf_sleeve || r.dolar_caixa) continue;
    const k    = `${r.instrument_reference}||${r.area}||${r.subarea}||${r.strategy}||${r.maturity ?? ''}`;
    const errs = dolarFundoErrado(fundIndex[k] ?? {}, fundLabels, offFund);
    if (errs) out.push({ row: r, errs });
  }
  return out;
}

/* ── ⛔ ESCOPO POR FUNDO — o que cada fundo do RF pode carregar (30/10/2026) ─────────────
   Regra da mesa, com a entrada do `JGP RF Ativa Global-A`: *"só pode operar juros, não terá
   FX ... nem em equities (como todos os outros)"*. O backend decide (uma regra, em
   `funds.PORTFOLIORF_AREAS_OK`) e manda a lista pronta em `portfoliorf_escopo.fora`; aqui só
   se desenha.

   ☠️ **Câmbio não se identifica pela `area`.** O dólar do book de RF mora tanto em
   `Currencies - Directional BRL` quanto em `Rates - Cash` (o mini de carry) e
   `Rates - Hedge_Cambial` — medido em 30/10/2026. Por isso a classificação é por
   INSTRUMENTO (`portfoliorf_risk_kind`, no backend), e o que a faixa imprime ao lado do nome
   é a área CRUA do JRS, que é onde a mesa vai procurar a linha. Os dois números juntos é que
   contam a história: "Rates · Cash" + "conta como câmbio".
   ⭐ Silêncio é o estado certo — sem nada fora, nada é renderizado. */
function _escopoErroTip(row, fundos) {
  const quais = fundos.map(f => fundLabelMesa(f, true)).join(' · ');
  const rk    = row.prf_risk_kind ?? row.risk_kind ?? row.area;
  const kind  = _BOOK_PT[rk] ?? (rk ?? '—');
  /* ⚠️ O veredito tem DUAS causas e elas pedem frases diferentes: o BOOK (câmbio/bolsa
     onde não pode) e a PRAÇA (juros de fora num fundo que só faz Brasil). Dizer só "fora do
     escopo" manda a mesa procurar a coisa errada. */
  const praca = row.prf_praca ?? row.praca ?? null;
  return 'ERRO — fora do mandato deste fundo.\n\n'
    + `Há posição desta linha em: ${quais}. Para efeito da regra ela conta como `
    + `${kind}${praca ? ' ' + (praca === 'local' ? 'LOCAL (Brasil)' : 'GLOBAL (fora do Brasil)') : ''}`
    + `${row.area && rk && rk !== row.area
        ? ` (a área no JRS é "${row.area}${row.subarea ? ' · ' + row.subarea : ''}")` : ''}.\n\n`
    + 'Não é desvio de rateio, é posição num fundo que não a opera — não há faixa de '
    + 'tolerância aqui.';
}

const _BOOK_PT = { Rates: 'juros', Currencies: 'câmbio', Equities: 'bolsa',
                   Commodities: 'commodities' };

function renderPrfEscopoAlerta(data) {
  const fora = data?.portfoliorf_escopo?.fora;
  if (!fora?.length) return '';
  const okMap = data.portfoliorf_escopo.areas_ok || {};
  const li = fora.map(x => {
    const onde = (x.funds || []).map(f =>
      `<b>${fundLabelMesa(f.fund, true)}</b> ${fmtFinalQty(f.qty)}`).join(' · ');
    const kind = (_BOOK_PT[x.risk_kind] ?? x.risk_kind ?? '—')
      + (x.praca ? ' ' + (x.praca === 'local' ? 'local' : 'global') : '');
    /* A área crua vai junto SEMPRE que diferir da classificação — é a diferença entre
       "procure na linha de câmbio" e "procure no Rates · Cash", que é onde ela de fato
       está na tela. Omiti-la manda a mesa procurar no lugar errado. */
    /* A área crua vai junto SEMPRE que a classificação difira dela — é a diferença entre
       "procure na linha de câmbio" e "procure no Rates · Cash", que é onde ela de fato está
       na tela. E a PRAÇA entra junto, porque com ela o veredito muda de causa. */
    const org = (x.area && (x.risk_kind !== x.area || x.praca))
      ? `${x.area}${x.subarea ? ' · ' + x.subarea : ''} → conta como ${kind}`
      : `${x.area ?? '—'}${x.subarea ? ' · ' + x.subarea : ''}`;
    return `<li style="margin:1px 0"><b>${x.instrument_name ?? '—'}</b>`
      + ` <span style="color:var(--text-muted)">— ${org}</span> · ${onde}</li>`;
  }).join('');
  const pracaMap = data.portfoliorf_escopo.pracas_ok || {};
  const regras = Object.entries(okMap).map(([f, areas]) => {
    const pr = pracaMap[f] || [];
    /* Só diz a praça quando ela RESTRINGE: "juros local e global" é o estado normal e
       repeti-lo em duas das três linhas é ruído na faixa que tem de ser lida. */
    const prTxt = (pr.length === 1) ? ` ${pr[0]}` : '';
    return `<b>${fundLabelMesa(f, true)}</b>: ${areas.map(a => _BOOK_PT[a] ?? a).join(' e ')}${prTxt}`;
  }).join(' &nbsp;·&nbsp; ');
  return `<div class="card" style="border-left:4px solid var(--red);background:color-mix(in srgb, var(--red) 7%, var(--bg-card));flex:0 0 auto">
    <div style="font-size:12px;line-height:1.7">
      <b style="color:var(--red);font-size:13px">⛔ ${fora.length} posição(ões) FORA DO MANDATO DO FUNDO</b>
      <div style="margin-top:2px">${regras}. Estas linhas estão fora disso:</div>
      <ul style="margin:4px 0 0 18px;padding:0">${li}</ul>
    </div>
  </div>`;
}

/* ⛔ FAIXA VERMELHA no topo da aba. Mesma forma do alerta de escopo do sleeve, e pelo mesmo
   motivo: não é desvio de proporção, é posição que não deveria existir naquele fundo — a
   célula pintada na auxiliar não basta, porque a auxiliar pode estar filtrada ou o livro
   pode estar no modo "por fundo".
   ⭐ **Silêncio é o estado certo**: sem erro isto não renderiza nada. Um painel verde diário
   dizendo "o dólar está no fundo certo" treinaria a mesa a não ler a faixa no dia em que ela
   aparecesse. */
function renderDolarFundoAlerta(data, mainRows) {
  const erros = dolarFundoErros(mainRows, data?.fund_rows, data?.fund_navs,
                                data?.portfoliorf_offshore_fund);
  if (!erros.length) return '';
  const off = fundLabelMesa(data?.portfoliorf_offshore_fund, true);
  const li = erros.map(({ row, errs }) => {
    const onde = errs.map(x => `<b>${fundLabelMesa(x.fund, true)}</b> ${fmtFinalQty(x.qty, qtyDec(row))}`).join(' · ');
    return `<li style="margin:1px 0"><b>${row.instrument_name ?? '—'}</b>`
      + ` <span style="color:var(--text-muted)">— ${row.area ?? '—'}`
      + `${row.subarea ? ' · ' + row.subarea : ''}</span> · ${onde}</li>`;
  }).join('');
  return `<div class="card" style="border-left:4px solid var(--red);background:color-mix(in srgb, var(--red) 7%, var(--bg-card));flex:0 0 auto">
    <div style="font-size:12px;line-height:1.7">
      <b style="color:var(--red);font-size:13px">⛔ ${erros.length} posição(ões) de DÓLAR NO FUNDO ERRADO</b>
      <div style="margin-top:2px">Dólar direcional só pode estar no <b>${off}</b>, que é o fundo
        com o veículo offshore. Estas linhas têm quantidade em fundo que não opera dólar:</div>
      <ul style="margin:4px 0 0 18px;padding:0">${li}</ul>
      <div style="margin-top:4px;color:var(--text-muted)">⚠️ Enquanto durar, a exposição (#PL)
        destas linhas na tabela principal também está errada — ela é calculada sobre o NAV do
        ${off}, não sobre a soma dos fundos.</div>
    </div>
  </div>`;
}

/* Config das tabelas por fundo da aba corrente — o `renderFundBreakTable` recebe só as
   linhas e os NAVs, e precisa saber se algum fundo da aba ficou de fora por não ter NAV. */
function _pnlTablesForTab() {
  const d = (typeof posDataByTab !== 'undefined')
    ? (posDataByTab[currentRenderTab()] ?? positionsData) : null;
  return d?.pnl_fund_tables ?? null;
}

/* ── Fund breakdown table (portfoliorf) ───────────────────────────────────
   ⭐ É a ÚNICA auxiliar da aba, e desde 08/10/2026 ela também carrega os 2 checks do sleeve
   de RF: as linhas do outro trader passaram a viver na MESMA tabela principal (pedido da
   mesa), então os checks delas têm de ficar aqui, na mesma faixa alinhada — não numa 3ª
   tabela ao lado. Cada linha responde a pergunta que lhe cabe: as do PortfolioRF, o rateio
   entre os dois fundos dele; as do sleeve, a proporção contra o book de MM do dono. */
function renderFundBreakTable(mainRows, fundRows, fundNavs, filterFn, offshoreFund, rfCfg) {
  if (!fundRows?.length || !fundNavs) return '';
  // Colunas do sleeve: só quando há linha dele na tabela E o lado do MM veio no payload.
  const rfSleeveCols = !!rfCfg?.mm_rows?.length && mainRows.some(r => r.is_rf_sleeve);
  /* Espelho de juros (PortfolioRF × EMota). ⭐ A coluna existe quando o PAYLOAD traz o
     espelho — não quando há linha em escopo. É a mesma lição do `Check RF`: no dia em que o
     livro de juros estiver vazio, "não há juros no RF" é o veredito, e some justamente a
     coluna que tinha o que dizer. */
  const mirrorCfg  = (typeof rfMirrorCfg === 'function') ? rfMirrorCfg(currentRenderTab()) : null;
  const mirrorCols = !!mirrorCfg;
  const lookupMmRf   = rfSleeveCols ? makeMirrorLookup(rfCfg.mm_rows) : null;

  /* ⚠️ **A ordem das colunas é a do `pnl_fund_tables`, não alfabética** (30/10/2026). Com
     DOIS fundos o `sort()` por acaso dava a mesma ordem dos blocos do modo "Por fundo"; com
     o `Juros Global` entrando, passaria a dar outra (`Global` < `Inst Master` < `Master`) — a
     auxiliar numa ordem e os blocos ao lado noutra, sem erro nenhum e com tudo parecendo
     certo. Fundo inesperado (fora da config) entra no fim, para não sumir. */
  const _tabsCfg   = _pnlTablesForTab();
  const fundLabels = _tabsCfg
    ? _tabsCfg.map(t => t.fund).filter(f => fundNavs[f] != null)
        .concat(Object.keys(fundNavs).filter(f => !_tabsCfg.some(t => t.fund === f)).sort())
    : Object.keys(fundNavs).sort();
  const shortLabel = fl => fundLabelMesa(fl, true);
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

  const visRows = filterFn(mainRows.filter(r => !_hiddenForTab(currentRenderTab()).has(rowKey(r))));

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
    const isSleeve    = !!r.is_rf_sleeve;
    const totalQty    = r.final_qty || 0;
    const totalNavSum = fundLabels.reduce((s, fl) => s + (fundNavs[fl] ?? 0), 0);
    const groupPl     = r.pl;
    const fundPlArr   = [];
    // Linha cuja alocação vai 100% para o fundo offshore por desenho (hoje: dólar).
    // O sleeve offshore (`is_offshore`) segue no ramo próprio, sem check.
    const offOnly     = !!r.alloc_offshore_only && !r.is_offshore && !!offFund;
    if (offOnly) usedOffOnly = true;
    /* ⛔ Dólar com quantidade em fundo que não opera dólar — ver `dolarFundoErrado` acima.
       Avaliado para TODA linha `alloc_offshore_only` (a `is_offshore` inclusive, cujo check
       hoje é só o rótulo "offshore") e tem precedência sobre os dois ramos de check: é regra
       do veículo, não rateio. */
    const dolarErro   = (r.dollar_kind && !r.dolar_caixa && offFund)
      ? dolarFundoErrado(byFund, fundLabels, offFund) : null;
    /* ⛔ Escopo por fundo (backend, `funds.PORTFOLIORF_AREAS_OK`): câmbio no Juros Global,
       bolsa em qualquer um. Vem depois do dólar na precedência porque o backend já tira
       daqui o que a faixa do dólar cobre — as duas nunca falam da mesma linha. */
    const escopoErro  = r.prf_fora_escopo?.length ? r.prf_fora_escopo : null;
    // NAV contra o qual o backend calculou o #PL desta linha (`r.nav`): o consolidado nas
    // linhas rateadas, o NAV do fundo offshore nas de dólar. Usar `totalNavSum` fixo
    // reescalaria o #PL por fundo da linha de dólar (29,5/25,1 ≈ +17%).
    const refNav      = r.nav ?? totalNavSum;

    /* ☠️ Linha do SLEEVE não entra no rateio por NAV entre os dois Masters — ela mora 100%
       no veículo offshore, que não é coluna aqui. Sem este desvio as duas colunas sairiam
       zeradas e o "Check Qtd" acusaria um desvio de 100% que não existe. */
    if (isSleeve) {
      const dash = '<td class="num" style="color:var(--text-muted)">—</td>';
      const mmRf = lookupMmRf ? lookupMmRf(r) : null;
      // Mesmo tom da linha na tabela principal: as duas se leem como um par. O dono vai no
      // `title` da linha, não em texto ao lado do nome (a mesa pediu a cor, não o selo).
      return `<tr class="${rowClass} ${areaClass} sleeve-row" title="${_escHtml(
        'Linha do sleeve de RF — ' + (r.trader ?? '—') + ', 100% no ' +
        (rfCfg?.fund ?? 'veículo offshore') + '. Não entra no rateio entre os fundos do RF.')}">
        <td>${r.instrument_name ?? '—'}</td>
        ${dash.repeat(2 * fundLabels.length)}
        <td style="color:var(--text-muted);text-align:right;font-size:11px" title="${_escHtml(
          'Rateio entre os fundos do RF não se aplica: a linha é do sleeve.')}">sleeve</td>
        ${mirrorCols ? _checkVazio('—', 'Linha do sleeve de RF: o espelho de juros confere o '
            + 'livro do PortfolioRF contra o EMota, e esta linha é do outro trader — o check '
            + 'dela é a coluna ao lado.') : ''}
        ${rfSleeveCols ? rfCheckCell(rfCfg, { mmQty: mmRf?.final_qty ?? null,
            rfQty: effectiveRowValues(r).final ?? r.final_qty ?? 0, row: r }) : ''}
      </tr>`;
    }

    /* ⛔ **"% Qtd" e "Check Qtd" saíram** (mesa, 27/10/2026: *"não precisa delas, pelo PL e
       check PL já consigo bater se está ok ou não"*). As duas diziam a MESMA notícia que o
       `#PL`/`Check #PL` ao lado, só na unidade de quantidade — e o rateio por quantidade e o
       por exposição não podem divergir, porque o #PL de cada fundo É derivado da fatia de
       quantidade (`groupPl × fund_qty/totalQty × refNav/navF`, logo abaixo). Duas colunas
       para o mesmo veredito custavam largura numa tabela auxiliar que já é larga. */
    const cells = fundLabels.map(fl => {
      const fr       = byFund[fl];
      const fund_qty = fr?.final_qty ?? 0;
      const navF     = fundNavs[fl];

      let fundPl = null;
      if (!r.is_offshore && groupPl != null && totalQty !== 0 && navF && refNav) {
        fundPl = groupPl * (fund_qty / totalQty) * (refNav / navF);
      }
      fundPlArr.push(fundPl);

      const qtyCell = `<td class="num">${fund_qty !== 0 ? fmtFinalQty(fund_qty, qtyDec(r)) : '<span style="color:var(--text-muted)">—</span>'}</td>`;
      const plCell  = `<td class="num">${fundPl != null ? fmtPL(fundPl, r.pl_type) : '<span style="color:var(--text-muted)">—</span>'}</td>`;
      return qtyCell + plCell;
    }).join('');

    // Check #PL: #PL individual de cada fundo vs #PL do grupo
    // (o "Check Qtd" que ficava aqui saiu em 27/10/2026 — ver a nota no `cells` acima)
    let checkPlCell = '<td></td>';
    if (dolarErro) {
      checkPlCell = `<td class="check-cell alloc-bad" title="${_escHtml(
        _dolarErroTip(dolarErro, offFund))}">⛔ ERRO</td>`;
    } else if (escopoErro) {
      checkPlCell = `<td class="check-cell alloc-bad" title="${_escHtml(
        _escopoErroTip(r, escopoErro))}">⛔ ERRO</td>`;
    } else if (r.is_offshore) {
      /* ⭐ O rótulo nomeia o FUNDO desde 30/10/2026: com dois veículos offshore na aba
         (Segregated-N do Juros e Moeda, Segregated-I do Juros Global), "offshore" sozinho
         deixou de dizer de quem é o NAV que está no denominador do #PL ao lado. */
      checkPlCell = `<td style="color:var(--text-muted);text-align:right;font-size:11px"${
        r.alloc_fund ? ` title="${_escHtml('Linha offshore — 100% no ' + fundLabelMesa(r.alloc_fund, true)
          + '. O #PL é calculado sobre o NAV desse fundo, não sobre a soma dos três.')}"` : ''
        }>offshore${r.alloc_fund ? ' · ' + fundLabelMesa(r.alloc_fund, true) : ''}</td>`;
    } else if (offOnly && r.dolar_caixa) {
      /* ☠️ **Dólar de CAIXA não tem alvo de rateio** (03/11/2026). Ele é o hedge do caixa em
         BRL de CADA fundo — medido no dia: −50 no Juros Global e −41 no Juros e Moeda —, e o
         tamanho certo de cada um sai do caixa daquele fundo, que esta tela não tem. Comparar
         com o #PL do grupo (ou com o do fundo do dólar) acusaria qualquer repartição. É a
         mesma razão pela qual o caixa já ficava fora do espelho contra o EMota. */
      checkPlCell = _checkVazio('caixa',
        'Hedge do caixa em BRL deste fundo (Rates · Cash / Hedge_Cambial), não posição de '
        + 'mandato: cada fundo hedgeia o próprio caixa, e o tamanho certo depende do caixa '
        + 'dele — que esta tela não tem. Sem alvo, não há veredito. '
        + 'O #PL da tabela principal usa a soma dos NAVs dos fundos que carregam a linha.');
    } else if (offOnly) {
      // Só o fundo dono entra: os demais não carregam a posição por desenho, então
      // compará-los com o #PL do grupo acusaria a ausência esperada.
      const _alvoFd = r.alloc_fund ?? offFund;
      const fpOff  = fundPlArr[fundLabels.indexOf(_alvoFd)];
      const devPl  = (groupPl != null && fpOff != null) ? Math.abs(fpOff - groupPl) : null;
      // ⚠️ A cor passou a viver no `<td>` (classe `check-cell …`), não num `<span>` dentro:
      // o fundo tingido é da CÉLULA, e um span colorido por cima dele brigaria com o contraste.
      checkPlCell = devPl == null
        ? `<td class="num" style="color:var(--text-muted);text-align:right" title="Dólar — #PL conferido só em ${
            shortLabel(offFund)}">—</td>`
        : `<td class="check-cell ${devPl < 0.01 ? 'alloc-ok' : allocClass(devPl)}" title="Dólar — #PL conferido só em ${
            shortLabel(offFund)}">${devPl < 0.01 ? '✓'
              : `±${(devPl * 100).toLocaleString('en-US', {maximumFractionDigits:2})}pp`}</td>`;
    } else if (groupPl != null && fundPlArr.every(p => p != null)) {
      const devs   = fundPlArr.map(fp => Math.abs(fp - groupPl));
      const maxDev = Math.max(...devs);
      checkPlCell = `<td class="check-cell ${maxDev < 0.01 ? 'alloc-ok' : allocClass(maxDev)}">${
        maxDev < 0.01 ? '✓' : `±${(maxDev * 100).toLocaleString('en-US', {maximumFractionDigits:2})}pp`}</td>`;
    } else {
      checkPlCell = '<td style="color:var(--text-muted);text-align:right">—</td>';
    }

    const offMark = (offOnly && !r.dolar_caixa)
      ? ` <span class="alloc-off-only" title="Dólar — alocação 100% em ${shortLabel(r.alloc_fund ?? offFund)}. `
        + `Alvo do check e denominador do #PL são o NAV desse fundo, não o consolidado.">US$</span>`
      : '';

    return `<tr class="${rowClass} ${areaClass}">
      <td>${r.instrument_name ?? '—'}${offMark}</td>
      ${cells}
      ${checkPlCell}
      ${mirrorCols ? mirrorCheckCell(r, mirrorCfg) : ''}
      ${rfSleeveCols ? _checkVazio() : ''}
    </tr>`;
  }).join('');

  const headers = fundLabels.map(fl => {
    const navF   = fundNavs[fl];
    const navStr = navF != null
      ? `<br><small style="font-weight:normal;font-size:10px">${fmtNav(navF)}</small>`
      : '';
    return `<th colspan="2">${shortLabel(fl)}${navStr}</th>`;
  }).join('');
  const subHeaders = fundLabels.map(() => '<th>Qty</th><th>#PL</th>').join('');

  // Rodapé: diz por que aquelas linhas não seguem o rateio por NAV (a tela não pode
  // trocar o alvo do check em silêncio).
  const NC = 1 + 2 * fundLabels.length + 1 + (mirrorCols ? 1 : 0) + (rfSleeveCols ? 1 : 0);
  const footTr = usedOffOnly
    ? `<tr><td class="aux-foot" colspan="${NC}" style="font-size:11px;color:var(--text-muted)"><div>`
      + `US$ dólar (WDO/UC, opção DOL/USDBRL, spot-fwd USD/BRL): alocação vai 100% para `
      + `${shortLabel(offFund)} — o check usa esse alvo, não o rateio por NAV, e a exposição `
      + `(#PL) da tabela principal é calculada sobre o NAV desse fundo. `
      + `Quantidade em qualquer outro fundo é ⛔ <b>ERRO</b>, não desvio de rateio — `
      + `só esse fundo tem o veículo offshore.</div></td></tr>`
    : '';
  const rfFootTr = rfSleeveCols
    ? `<tr><td class="aux-foot" colspan="${NC}" style="font-size:11px"><div>${rfTargetNote(rfCfg)}</div></td></tr>`
    : '';
  /* ⚠️ **Fundo da aba SEM NAV não vira coluna aqui — e a posição dele não pode sumir calada.**
     As colunas saem do `fund_navs` de propósito: sem NAV não há `#PL`, e uma coluna a mais
     com "—" apagaria o `Check #PL` de TODAS as linhas (ele exige `#PL` em todos os fundos).
     Mas a quantidade continua existindo — ela aparece no modo "Por fundo" e no card de PnL
     daquele fundo —, então aqui vai dito, com o número, em vez de a soma das colunas
     simplesmente não fechar 100 %. Caso real: o `Juros Global` boletou no dia 30/10/2026 e o
     NAV dele só nasce ~16h de D+1. */
  /* ⚠️ **Dois estados diferentes, e misturá-los é que gera alarme falso** (03/11/2026): o
     fundo que OPERA e está sem NAV no dia é problema (⚠ amarelo); o que está cadastrado e
     ainda não nasceu é só informação. O flag vem do backend (`pnl_fund_tables[].ativo`). */
  const _tabs    = _pnlTablesForTab() || [];
  const semNav   = _tabs.filter(t => fundNavs[t.fund] == null && t.ativo !== false).map(t => t.fund);
  const aguarda  = _tabs.filter(t => t.ativo === false).map(t => t.fund);
  const navFootTr = (semNav.length
    ? `<tr><td class="aux-foot" colspan="${NC}" style="font-size:11px;color:var(--yellow)"><div>`
      + `⚠ ${semNav.map(f => fundLabelMesa(f, true)).join(' · ')} sem NAV nesta data — fica fora `
      + `desta tabela (sem NAV não há #PL, e uma coluna vazia apagaria o Check #PL das demais). `
      + `A posição dele está no modo <b>▤ Por fundo</b> e no card de PnL do fundo.`
      + `</div></td></tr>`
    : '')
    + (aguarda.length
    ? `<tr><td class="aux-foot" colspan="${NC}" style="font-size:11px;color:var(--text-muted)"><div>`
      + `${aguarda.map(f => fundLabelMesa(f, true)).join(' · ')} — cadastrado no controle, `
      + `ainda sem NAV e sem posição. Vira coluna aqui quando tiver NAV.`
      + `</div></td></tr>`
    : '');

  return `<table class="data-table alloc-table" style="white-space:nowrap;width:auto">
    <thead>
      <tr><th rowspan="2">Instrumento</th>${headers}<th rowspan="2">Check #PL</th>${mirrorCols ? mirrorCheckHead(mirrorCfg).replace('<th ', '<th rowspan="2" ') : ''}${rfSleeveCols ? rfCheckHead(rfCfg, true).replace('<th ', '<th rowspan="2" ') : ''}</tr>
      <tr>${subHeaders}</tr>
    </thead>
    <tbody>${rows}${footTr}${rfFootTr}${navFootTr}</tbody>
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
    /* ⚠️ Um só par (principal × auxiliar) nos DOIS modos — o modo "Por fundo" passou a viver
       DENTRO deste card (ver `renderFundSplitInline`), então aqui não há mais caso especial.
       O que o modo expandido acrescenta é a igualação da altura das linhas-cabeçalho de
       fundo, logo abaixo. */
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
      _alignFsHeads(document.getElementById(sectionBodyId(s)),
                    document.querySelector('#fund_break_portfoliorf tbody'));
    }
  }
  for (const [el, h] of writes) el.style.height = h + 'px';
}

/* ── Modo "Por fundo": a linha-CABEÇALHO das duas tabelas tem de ter a MESMA altura ──────
   O alinhamento linha a linha das duas tabelas é natural — elas têm a mesma sequência de
   linhas e a mesma altura de célula. A linha-cabeçalho de fundo é a exceção: na principal ela
   carrega rótulo + NAV + a tira NET daquele fundo, e na auxiliar só o rótulo. Sem igualar, a
   diferença de altura desloca TUDO o que vem abaixo dela — e no 2º bloco o erro se soma ao do
   1º.
   ⚠️ Reseta antes de medir, pelo mesmo motivo de sempre: a altura escrita no render anterior
   entraria na medida do seguinte. */
function _alignFsHeads(mainBody, auxBody) {
  if (!mainBody || !auxBody) return;
  /* ⚠️ As DUAS linhas de cada bloco (resumo + cabeçalho de coluna), na ordem do documento:
     desde 28/10/2026 cada bloco é uma "tabela" com cabeçalho próprio, e o cabeçalho também
     sai de alturas diferentes nas duas — na principal há `th` de duas linhas ("Qtd<br>
     Abertura"), na auxiliar nem sempre. Igualar só o resumo deixaria o desvio do cabeçalho
     se acumulando bloco a bloco, que é exatamente o que esta função existe para evitar. */
  const _SEL = 'tr.fs-head, tr.fs-colhead';
  const a = [...mainBody.querySelectorAll(_SEL)];
  const b = [...auxBody.querySelectorAll(_SEL)];
  if (!a.length || a.length !== b.length) return;
  for (const tr of [...a, ...b]) tr.style.height = '';
  const hs = a.map((tr, i) => Math.max(tr.getBoundingClientRect().height,
                                       b[i].getBoundingClientRect().height));
  a.forEach((tr, i) => { tr.style.height = hs[i] + 'px'; });
  b.forEach((tr, i) => { tr.style.height = hs[i] + 'px'; });
}

/* ── Tab switching ───────────────────────────────────────────────────────── */
