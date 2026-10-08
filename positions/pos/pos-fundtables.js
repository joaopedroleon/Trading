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
  const t = tip ? ` title="${_rfEsc(tip)}"` : '';
  return `<td class="num" style="text-align:right;color:var(--text-muted)"${t}>${txt ?? '—'}</td>`;
}

function _checkCell(v, delta, tip) {
  const txt = (typeof v === 'string') ? v : fmtPct(_semZeroNegativo(v));
  const cls = allocClass(delta);
  const t   = tip ? ` title="${_rfEsc(tip)}"` : '';
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

   ⚠️ A soma é do livro INTEIRO, não o que está visível: a proporção alocada é
   propriedade da carteira, e um filtro de exibição não pode mudar o veredito.
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
    + `Soma o livro INTEIRO (um filtro de exibição não muda o veredito).`;
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
     O trader boleta ~4,4 % do ticket TAMBÉM no veículo do RF. */
  /* Baldes de ativo p/ o check de CÂMBIO — livro INTEIRO dos dois lados (ver `_allocBuckets`). */
  const buckets  = _allocBuckets(
    allRows.filter(r => r.group === 'MM' && r.trader === trader && !r.is_simulated),
    prevRows);

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

    /* ☠️ Declarado AQUI, antes do primeiro uso: o `Check Boleta` (logo abaixo) consulta o
       balde, e `const` numa arrow de `.map` tem temporal dead zone — com a declaração lá
       embaixo, no bloco do "% Alloc Final", a tabela inteira estourava com "Cannot access
       'bk' before initialization" e a auxiliar saía VAZIA, sem erro visível na tela. */
    const bk = _bucketCheck(mm, buckets, rowTarget);

    // Abert. MM Prev
    const prevQty = prev?.opening_qty ?? null;
    const prevQtyCell = `<td class="num">${prevQty != null ? fmtFinalQty(prevQty) : '<span style="color:var(--text-muted)">—</span>'}</td>`;

    // Qtd Operada MM Prev
    const prevTraded = prev?.traded_qty ?? null;
    const tradedCell = `<td class="num">${prevTraded != null ? fmtTradedQty(prevTraded) : '<span style="color:var(--text-muted)">—</span>'}</td>`;

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
          const buyDelta  = rowTarget != null && buyPct  != null ? buyPct  - rowTarget : null;
          const sellDelta = rowTarget != null && sellPct != null ? sellPct - rowTarget : null;
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
        const dealDelta = rowTarget != null ? dealPct - rowTarget : null;
        /* ⚠️ No dólar a boleta do Prev pode sair em OUTRO instrumento (mini dólar no MM, NDF
           no Prev) — comparar instrumento com instrumento acusaria um desvio que não existe.
           Aqui as duas também contam juntas, convertidas a USD pelo nocional por unidade.
           Sem o fator (linha que abriu e zerou no dia), volta ao % da própria linha. */
        // ⚠️ PASSA pelo `_checkCell` como todos os outros: este ramo nascera com um `<td>`
        // próprio e era o único check da tela sem o fundo tingido — a mesa pegou no print.
        dealCell = (bk && bk.opPct != null)
          ? _checkCell(bk.opPct, rowTarget != null ? bk.opPct - rowTarget : null,
              'DÓLAR — boleta do dia com futuro e NDF JUNTOS, em USD:\n'
              + '  MM   ' + fmtMoney(bk.opMm) + '\n  Prev ' + fmtMoney(bk.opPv) + '\n'
              + '  Prev ÷ MM = ' + fmtPct(bk.opPct)
              + (rowTarget != null ? '  ·  alvo ' + fmtPct(rowTarget) : ''))
          : _checkCell(dealPct, dealDelta);
      }
    }

    // % Alloc Final — em CÂMBIO vem do BALDE (ver `_bucketCheck`); no resto, da linha.
    const mmFinal   = mm.final_qty ?? 0;
    const prevFinal = prev?.final_qty ?? null;
    const finalPct  = mmFinal !== 0 && prevFinal != null ? prevFinal / mmFinal : null;
    const finalCls  = allocClass(finalPct != null && rowTarget != null ? finalPct - rowTarget : null);
    const finalCell = bk
      ? _bucketCell(bk, rowTarget)
      : _checkCell(finalPct, finalPct != null && rowTarget != null ? finalPct - rowTarget : null);

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
      <td class="num">${p.opening_qty != null ? fmtFinalQty(p.opening_qty) : muted}</td>
      <td class="num">${p.traded_qty  != null ? fmtTradedQty(p.traded_qty)  : muted}</td>
      <td class="num">${fmtFinalQty(p.final_qty ?? 0)}</td>
      ${_checkVazio('—', 'Linha sem par no MM — check de boleta não se aplica.')}
      ${bkO ? _bucketCell(bkO, target) : _checkVazio()}
      ${showRf ? _checkVazio() : ''}
    </tr>`;
  }).join('');
  const orphanSection = orphanRows.length
    ? `<tr class="area-divider"><td colspan="${NCOL}" style="font-weight:600;color:var(--text-muted)">Somente MM Prev</td></tr>${orphanTr}`
    : '';

  // Nota de rodapé: qual target valeu para as linhas marcadas com ↓ (e aviso se faltou o NAV).
  let footTr = '';
  if (usedReduced || missingFactor) {
    const blocked = (posDataByTab[currentRenderTab()]?.prev_no_br_equity_short_funds ?? [])
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
      ${showRf ? rfCheckHead(rfCfg, false) : ''}
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
    `<td class="num" style="color:var(--text-muted);text-align:right" title="${_rfEsc(tip)}">${txt}</td>`;
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
      ? `<td class="check-cell alloc-bad" title="${_rfEsc(
          `⛔ FORA DO ESCOPO: o veículo de RF carrega só os books de ${books}, e esta linha é de `
          + `${row.area ?? '—'} — mas tem ${fmtFinalQty(rfQty)} lá. Ver a faixa no topo da aba.`)}">⛔</td>`
      : `<td class="check-cell alloc-ok" title="${_rfEsc(
          `✓ Correto: ${row.area ?? 'este ativo'} não vai para o RF (o veículo carrega só os books `
          + `de ${books}), então zero aqui é o esperado — não é desvio de alocação.`)}">✓</td>`;
  }

  // ── câmbio linear: veredito das MOEDAS do par ────────────────────────────────────
  // ⚠️ Só vale o veredito por moeda quando EXISTE agregado — sem linha no sleeve ele não é
  // montado, e aí a régua volta a ser a quantidade da linha (que dirá "nada no RF").
  if (row?.is_fx && cfg?.ccy_check?.linhas?.length) {
    const c = cfg?.ccy_check;
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
    return `<td class="check-cell ${cls}" title="${_rfEsc(tip)}">${
      cls === 'alloc-ok' ? '✓' : '⚠ ' + fmtPct(_semZeroNegativo(pior.ratio))}</td>`;
  }

  // ── o resto (opção incluída): linha a linha, pela QUANTIDADE ─────────────────────
  const e = rfAllocEval(mmQty, rfQty, cfg);
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
    return muted('—', `Exposição de ${fmtMoney(expUsd)} no MM — abaixo do piso de `
      + `${fmtMoney(minUsd)}. Espelhar ${fmtPct(e.allocTarget)} disso seria `
      + `${fmtMoney(expUsd * (e.allocTarget ?? 0))}: não é afirmado como desvio.`);
  }
  const cls = rfAllocClass(e.allocPct, e.allocTarget);
  const dpp = (e.allocPct - e.allocTarget) * 100;
  /* ⭐ "Nada no RF" é um veredito, e a tela diz QUANTO deveria ter — a mesa não precisa fazer
     a conta para saber o tamanho do que está faltando. */
  if (!Math.abs(rfQty ?? 0)) {
    const falta = mmQty * (e.allocTarget ?? 0);
    return `<td class="check-cell ${cls}" title="${_rfEsc(
      `⚠ NADA NO RF nesta linha.\n\n  MM: ${fmtFinalQty(mmQty)}\n  RF: zero\n`
      + `  Pelo alvo de ${fmtPct(e.allocTarget)}, deveria haver ~${fmtFinalQty(falta)}.`
      + (expUsd != null ? `\n\nExposição no MM: ${fmtMoney(expUsd)}.` : ''))}">⚠ nada no RF</td>`;
  }
  const tip = `QUANTIDADE, linha a linha (opção e demais instrumentos).\n\n`
    + `  MM: ${fmtFinalQty(mmQty)}\n  RF: ${fmtFinalQty(rfQty)}\n`
    + `  RF ÷ MM = ${fmtPct(e.allocPct)}  ·  alvo ${fmtPct(e.allocTarget)}`
    + `  (${dpp >= 0 ? '+' : ''}${dpp.toLocaleString('en-US', {maximumFractionDigits: 2})}pp)\n`
    + (e.expRatio != null
        ? `\nEm exposição: ${fmtPct(e.expRatio)} da do MM (alvo ${fmtPct(alvoExp)}), `
          + `pela razão dos NAVs ${e.navRatio.toLocaleString('en-US', {maximumFractionDigits: 3})}.\n`
        : '')
    + `\nVerde dentro de ±${(RF_ALLOC_REL_TOL * 100).toFixed(0)}% do alvo, amarelo até o dobro, `
    + 'vermelho além — faixa RELATIVA, porque ±2pp num alvo de 4,4% aceitaria de 2,4% a 6,4%.';
  return `<td class="check-cell ${cls}" title="${_rfEsc(tip)}">${
    cls === 'alloc-ok' ? '✓' : '⚠ ' + fmtPct(_semZeroNegativo(e.allocPct))}</td>`;
}

/* Cabeçalho da coluna. `merged` = as linhas são de OUTRO trader (aba de quem recebe), e aí
   o rótulo é o apelido dele ("Check Abi"); na aba do próprio dono é "Check RF". */
function rfCheckHead(cfg, merged) {
  const tr  = cfg?.traders?.[0];
  /* ⭐ O ALVO vai no rótulo (pedido da mesa, 08/10/2026): é o número fixo que a mesa troca
     de tempos em tempos, e tê-lo no cabeçalho poupa abrir o hover para lembrar contra o quê
     a coluna está medindo — do mesmo jeito que o check do Prev já mostra os 30 %. */
  const alvo = cfg?.alloc_target != null ? ' ' + fmtPct(cfg.alloc_target) : '';
  const lbl = (merged ? (cfg?.labels?.[tr] ?? tr ?? 'sleeve') : 'RF') + alvo;
  const tip = 'Veredito do sleeve de RF nesta linha — o detalhe está no hover de cada célula.\n\n'
    + 'Câmbio LINEAR (spot · NDF · forward): vem do agregado por MOEDA, contra o alvo de '
    + fmtPct(cfg?.exposure_ratio) + ' da exposição do MM.\n'
    + 'Opção e demais: linha a linha, pela QUANTIDADE, contra o alvo de boleta de '
    + fmtPct(cfg?.alloc_target) + '.\n\n'
    + '"—" = não afirmado (sem par no MM, ou abaixo do piso de material).';
  return `<th title="${_rfEsc(tip)}">Check ${lbl}</th>`;
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
      : `<span style="color:var(--text-muted)" title="${_rfEsc(
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
    <td><b>Agregado</b> <span style="color:var(--text-muted);font-size:10px" title="${_rfEsc(
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
  const semSpot = c.sem_spot?.length
    ? `<div style="font-size:11px;color:var(--yellow);margin-top:4px">⚠ sem spot: `
      + `${c.sem_spot.join(', ')} — perna omitida, não zerada.</div>`
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
          <span style="font-weight:400;color:var(--text-muted);font-size:11px" title="${_rfEsc(
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
          <th title="${_rfEsc('Exposição do book de MM do ' + c.trader + ' naquela moeda, em USD ao spot.')}">MM (USD)</th>
          <th title="${_rfEsc('Sobre o NAV de MM do trader: USD ' + Number(c.nav_mm ?? 0).toLocaleString('en-US', {maximumFractionDigits:0}))}">% NAV MM</th>
          <th title="${_rfEsc('Exposição do sleeve naquela moeda, em USD ao spot.')}">RF (USD)</th>
          <th title="${_rfEsc('Sobre o NAV do fundo que detém o veículo: USD ' + Number(c.nav_rf ?? 0).toLocaleString('en-US', {maximumFractionDigits:0}))}">% NAV RF</th>
          <th title="${_rfEsc('% NAV RF ÷ % NAV MM. É O CHECK: o RF tem de carregar ' + (alvo*100).toFixed(0)
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

/* ⚰️ **`renderRfSleeveCheck` foi REMOVIDA (08/10/2026) — era inalcançável.** Ela existia como
   auxiliar autônoma para o caso "sleeve presente, mas sem break por fundo". Esse caso não
   existe: o break (`df_by_fund`) é montado sobre os fundos em `PORTFOLIORF_FUNDS ∪
   {RF_SLEEVE_FUND}`, e a própria linha do sleeve está nesse conjunto — logo, havendo sleeve,
   `fund_rows` nunca vem vazio e `hasFundBreak` é sempre true. Os checks moram DENTRO do break
   (`rfCheckCell`, uma auxiliar só). Ficavam ~50 linhas com um `colspan` que já não batia com
   o nº de colunas depois que as três viraram uma. */

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
  const lookupMmRf   = rfSleeveCols ? makeMirrorLookup(rfCfg.mm_rows) : null;

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

    /* ☠️ Linha do SLEEVE não entra no rateio por NAV entre os dois Masters — ela mora 100%
       no veículo offshore, que não é coluna aqui. Sem este desvio as duas colunas sairiam
       zeradas e o "Check Qtd" acusaria um desvio de 100% que não existe. */
    if (isSleeve) {
      const dash = '<td class="num" style="color:var(--text-muted)">—</td>';
      const mmRf = lookupMmRf ? lookupMmRf(r) : null;
      // Mesmo tom da linha na tabela principal: as duas se leem como um par. O dono vai no
      // `title` da linha, não em texto ao lado do nome (a mesa pediu a cor, não o selo).
      return `<tr class="${rowClass} ${areaClass} sleeve-row" title="${_rfEsc(
        'Linha do sleeve de RF — ' + (r.trader ?? '—') + ', 100% no ' +
        (rfCfg?.fund ?? 'veículo offshore') + '. Não entra no rateio entre os dois Masters.')}">
        <td>${r.instrument_name ?? '—'}</td>
        ${dash.repeat(3 * fundLabels.length)}
        <td style="color:var(--text-muted);text-align:right;font-size:11px" title="${_rfEsc(
          'Rateio entre os dois Masters não se aplica: a linha é do sleeve.')}">sleeve</td>
        <td style="color:var(--text-muted);text-align:right;font-size:11px">sleeve</td>
        ${rfSleeveCols ? rfCheckCell(rfCfg, { mmQty: mmRf?.final_qty ?? null,
            rfQty: effectiveRowValues(r).final ?? r.final_qty ?? 0, row: r }) : ''}
      </tr>`;
    }

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
      checkCell = '<td style="color:var(--text-muted);text-align:right;font-size:11px">offshore</td>';
    } else if (offOnly) {
      // Alvo 100% no fundo offshore — NÃO é desligar o check, é trocar o alvo: qtd que
      // vaze para o outro fundo continua sendo acusada.
      const offQty = byFund[offFund]?.final_qty ?? 0;
      const pctOff = totalQty !== 0 ? offQty / totalQty : null;
      const dev    = pctOff != null ? Math.abs(pctOff - 1) : null;
      const lbl    = dev == null ? '—' : dev < 0.01 ? '✓' : `±${(dev * 100).toLocaleString('en-US', {maximumFractionDigits:1})}pp`;
      checkCell = `<td class="check-cell ${allocClass(dev)}" title="Dólar — alvo 100% em ${
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
      checkCell = maxDev == null
        ? '<td class="num" style="color:var(--text-muted);text-align:right">—</td>'
        : `<td class="check-cell ${cls}">${label}</td>`;
    }

    // Check #PL: #PL individual de cada fundo vs #PL do grupo
    let checkPlCell = '<td></td>';
    if (r.is_offshore) {
      checkPlCell = '<td style="color:var(--text-muted);text-align:right;font-size:11px">offshore</td>';
    } else if (offOnly) {
      // Só o fundo offshore entra: os demais não carregam a posição por desenho, então
      // compará-los com o #PL do grupo acusaria a ausência esperada.
      const fpOff  = fundPlArr[fundLabels.indexOf(offFund)];
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

    const offMark = offOnly
      ? ` <span class="alloc-off-only" title="Dólar — alocação 100% em ${shortLabel(offFund)}. `
        + `Alvo do check e denominador do #PL são o NAV desse fundo, não o consolidado.">US$</span>`
      : '';

    return `<tr class="${rowClass} ${areaClass}">
      <td>${r.instrument_name ?? '—'}${offMark}</td>
      ${cells}
      ${checkCell}
      ${checkPlCell}
      ${rfSleeveCols ? _checkVazio() : ''}
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
  const NC = 1 + 3 * fundLabels.length + 2 + (rfSleeveCols ? 1 : 0);
  const footTr = usedOffOnly
    ? `<tr><td colspan="${NC}" style="white-space:normal;font-size:11px;color:var(--text-muted)">`
      + `US$ dólar (WDO/UC, opção DOL/USDBRL, spot-fwd USD/BRL): alocação vai 100% para `
      + `${shortLabel(offFund)} — o check usa esse alvo, não o rateio por NAV, e a exposição `
      + `(#PL) da tabela principal é calculada sobre o NAV desse fundo.</td></tr>`
    : '';
  const rfFootTr = rfSleeveCols
    ? `<tr><td colspan="${NC}" style="white-space:normal;font-size:11px">${rfTargetNote(rfCfg)}</td></tr>`
    : '';

  return `<table class="data-table alloc-table" style="white-space:nowrap;width:auto">
    <thead>
      <tr><th rowspan="2">Instrumento</th>${headers}<th rowspan="2">Check Qtd</th><th rowspan="2">Check #PL</th>${rfSleeveCols ? rfCheckHead(rfCfg, true).replace('<th ', '<th rowspan="2" ') : ''}</tr>
      <tr>${subHeaders}</tr>
    </thead>
    <tbody>${rows}${footTr}${rfFootTr}</tbody>
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
