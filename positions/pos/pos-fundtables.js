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

/* ⚠️ `clsOvr` deixa o chamador impor a FAIXA sem mexer no `ALLOC_TOL`, que seis checks
   compartilham — ver `rfQtdClass` em pos-helpers.js. */
function _checkCell(v, delta, tip, clsOvr) {
  const txt = (typeof v === 'string') ? v : fmtPct(_semZeroNegativo(v));
  const cls = clsOvr !== undefined ? clsOvr : allocClass(delta);
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
  const byKeyAll   = {};
  const swapGroups = {};
  for (const r of (mirrorRows ?? [])) {
    if (r.swap_detail != null) {
      const gk = `${r.instrument_reference}||${r.area}||${r.subarea}||${r.strategy}`;
      (swapGroups[gk] ??= []).push({ date: r.maturity ? new Date(r.maturity) : null, row: r });
    } else {
      /* ☠️ **Guarda TODAS as linhas da chave, não só a última** (04/11/2026). Era
         `byKey[k] = r`, na premissa de que o espelho tem no máximo uma linha por
         instrumento — verdade enquanto o sleeve tinha um veículo. Com dois (Class N e
         Class I), o mesmo `1MX6P` existe nos dois e o segundo APAGAVA o primeiro: a coluna
         conferia uma perna e ignorava a outra, sem erro e sem aviso. `byKeyAll` é o
         conjunto; `byKey` segue com a 1ª, para quem só quer uma representante. */
      const _mk = _mirrorKey(r);
      (byKeyAll[_mk] ??= []).push(r);
      if (!(_mk in byKey)) byKey[_mk] = r;
    }
  }
  const fn = function (mm) {
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
  // Todas as linhas do espelho que casam com a linha de MM (hoje: uma por veículo do
  // sleeve). SWAP consolidado não passa por aqui — lá vale o casamento por cluster.
  fn.all = mm => (mm.swap_detail != null)
    ? [fn(mm)].filter(Boolean)
    : (byKeyAll[_mirrorKey(mm)] ?? []);
  return fn;
}

function fmtPct(v) {
  return v == null ? '—' : (v * 100).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%';
}

/* ── Bloco "Somente MM Prev" — o desligamento por trader, hoje VAZIO ─────────
   O bloco lista as posições que SÓ o grupo Prev tem (sem par no MM).
   ☠️ **O EMota esteve aqui de set/2026 a 05/11/2026, e o custo apareceu.** A mesa havia
   pedido o desligamento porque na aba dele as linhas só-Prev não interessavam ao check de
   enquadramento (a opção de EWZ US Equity, que é do Prev e não do livro dele) e poluíam a
   auxiliar. Só que o corte é por TRADER, não por tipo de linha: em 05/11/2026 o Prev tinha
   **4 ODF28 em `Rates · Fixed Rates Brazil · Inclinacao`** sem par no MM, e a posição não
   aparecia em canto nenhum da tela — nem na principal (que itera o MM) nem aqui. A mesa
   reparou e pediu de volta: *"não está aparecendo na auxiliar como uma posição só dos
   prevs, preciso ver"*. Medido no mesmo dia: religar trazia **1** linha — justamente aquela.
   ⚠️ A lição fica com o Set: esconder uma CATEGORIA inteira para tirar o ruído de alguns
   exemplares dela esconde junto o caso que importa, e some em SILÊNCIO — não há nada na
   tela dizendo que existe linha fora. O mecanismo fica porque é barato, mas quem for usá-lo
   de novo deve mirar o que incomoda (área, instrumento), não a aba inteira.
   ⚠️ É só de EXIBIÇÃO: nada muda no casamento MM×Prev (o `matchedPrev` continua varrendo
   todas as linhas) nem no backend. */
const HIDE_SO_PREV_TRADERS = new Set();

/* ── Coluna `Check Boleta` — desligada por trader (05/11/2026) ─────────────────
   Ela confere a boleta DO DIA (Prev ÷ MM só do que girou), com os dois lados separados no
   daytrade (`C:… / V:…`). A mesa pediu para tirá-la da aba do PAbinader, onde já há duas
   colunas de veredito (Prev e RF) e a terceira virava ruído — mas a remoção valeu para
   TODAS as abas de trader, porque a auxiliar é a MESMA função, e a mesa reparou na falta
   no EMota e no ECotrim. Daí o interruptor por trader.
   ⚠️ Diferente do `HIDE_SO_PREV_TRADERS` acima, aqui o que some é uma COLUNA derivada e
   não LINHAS de posição — não há o risco de uma posição inteira desaparecer da tela sem
   aviso, que foi o que aquele Set custou. */
const HIDE_CHECK_BOLETA_TRADERS = new Set(['PAbinader']);

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
/* ⭐ `% + seta`, o formato que a coluna do sleeve já usava — a mesa pediu o mesmo no Check
   Prev (04/11/2026): o % sozinho diz QUANTO e não diz se passou, e as duas colunas de check
   vizinhas liam-se de jeitos diferentes. O `rfCheckCell` tem um `_vere` local idêntico
   (mantém-se lá por causa do ramo de câmbio, que decide a marca por outro caminho). */
function _checkCellVere(pct, delta, tip) {
  if (pct == null) return _checkCell(pct, delta, tip);
  const cls = allocClass(delta);
  const txt = `${fmtPct(_semZeroNegativo(pct))} ${cls === 'alloc-ok' ? '✓' : '⚠'}`;
  return _checkCell(txt, delta, tip);
}

// Quebra de linha para `title` (que não aceita HTML).
const _AL_NL = String.fromCharCode(10);

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
  return _checkCellVere(bk.pct, target != null ? bk.pct - target : null, tip);
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
  // A coluna `Check Boleta` existe por trader (ver `HIDE_CHECK_BOLETA_TRADERS`).
  const showBoleta = !HIDE_CHECK_BOLETA_TRADERS.has(trader);
  const NCOL     = 5 + (showRf ? 1 : 0) + (showBoleta ? 1 : 0);

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

    /* ⭐ **Abert. e Operada somam Prev + RF** (04/11/2026, pedido da mesa). As duas colunas
       mostravam só o Prev enquanto a de Total já somava os TRÊS veículos — ou seja, a
       auxiliar lia-se como "abertura, operada, total" e o total não fechava com as duas
       primeiras. Com o sleeve de RF na aba, somar os dois espelhos é o que torna a linha
       aritmética: `MM + (Prev+RF aberto) + (Prev+RF operado)` fecha no Total.
       ⚠️ `null` só quando NÃO HÁ nenhum dos dois: com um deles presente o outro vale zero,
       e imprimir "—" ali esconderia metade da conta. */
    const rfAll     = showRf ? (lookupRf.all ? lookupRf.all(mm) : [lookupRf(mm)].filter(Boolean)) : [];
    const _rfSum    = k => rfAll.reduce((a, x) => a + (x?.[k] ?? 0), 0);
    const _temEspelho = !!prev || !!rfAll.length;

    // Abert. Prev+RF
    const prevQty = _temEspelho ? (prev?.opening_qty ?? 0) + _rfSum('opening_qty') : null;
    const prevQtyCell = `<td class="num">${prevQty != null ? fmtFinalQty(prevQty, qtyDec(mm)) : '<span style="color:var(--text-muted)">—</span>'}</td>`;

    // Qtd Operada Prev+RF
    const prevTraded = _temEspelho ? (prev?.traded_qty ?? 0) + _rfSum('traded_qty') : null;
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
    /* ⭐ `% + seta`, como a coluna do sleeve ao lado (04/11/2026, pedido da mesa) — as duas
       colunas de check da auxiliar passaram a se ler do mesmo jeito. O `_bucketCell` (ramo
       de câmbio) já vai pelo mesmo helper. */
    const finalCell = bk
      ? _bucketCell(bk, rowTarget)
      : _checkCellVere(finalPct, dAlvo(finalPct),
          finalPct != null
            ? 'Posição do MM Prev contra a do MM nesta linha.' + _AL_NL
              + '  MM: ' + fmtFinalQtyTxt(mmFinal) + _AL_NL
              + '  Prev: ' + fmtFinalQtyTxt(prevFinal ?? 0) + _AL_NL
              + '  Prev ÷ MM = ' + fmtPct(finalPct)
              + (target != null ? '  ·  alvo ' + fmtPct(target) : '')
            : null);

    // Total dos veículos do livro. ⚠️ Com o sleeve de RF na aba ele entra aqui também —
    // senão a coluna diria "total" somando dois dos três veículos, e o número não bateria
    // com a mesma coluna da tabela de câmbio (pos-fxlegs.js), que soma os três.
    /* ☠️ **SOMA os veículos do sleeve** (04/11/2026). Era `lookupRf(mm)?.final_qty`, uma
       linha só — e com dois veículos o total do livro perdia a perna do Class I: em 04/11
       o `1MX6P` sairia como 442+132+20 = 594 quando o rateio foi de **600**.
       (`rfAll` já foi montado lá em cima, nas colunas de abertura e operada.) */
    const rfFinal   = _rfSum('final_qty');
    const total     = (mmFinal) + (prevFinal ?? 0) + rfFinal;
    const totalCell = `<td class="num">${fmtFinalQty(total, qtyDec(mm))}</td>`;

    return `<tr class="${rowClass} ${areaClass} ${tradedClass}">
      <td>${mm.instrument_name ?? '—'}${shortMark}</td>
      ${prevQtyCell}
      ${tradedCell}
      ${totalCell}
      ${showBoleta ? dealCell : ''}
      ${finalCell}
      ${showRf ? rfCheckCell(rfCfg, { mmQty: mmFinal, mmRow: mm, rfQty: rfAll.length ? rfFinal : null,
                                      row: rfLineRow(rfCfg, mm, rfAll) }) : ''}
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
      ${showBoleta ? _checkVazio('—', 'Linha sem par no MM — check de boleta não se aplica.') : ''}
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
      <th>${showRf ? 'Abert.<br>Prev+RF' : 'Abert.<br>MM Prev'}</th>
      <th>${showRf ? 'Qtd Operada<br>Prev+RF' : 'Qtd<br>Operada'}</th>
      <th>${showRf ? 'Total<br>MM+Prev+RF' : 'Total<br>MM+Prev'}</th>
      ${showBoleta ? '<th>Check<br>Boleta</th>' : ''}
      <th>Check<br>Prev</th>
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
function rfCheckCell(cfg, { mmQty, rfQty, row, mmRow } = {}) {
  const muted = (txt, tip) =>
    `<td class="num" style="color:var(--text-muted);text-align:right" title="${_escHtml(tip)}">${txt}</td>`;
  const alvoExp = cfg?.exposure_ratio;

  /* ⭐ **O % que está no RF vem ANTES da marca** (04/11/2026, pedido da mesa: *"fica com a
     setinha verde de OK quando está ok, mas eu quero que mostre além da setinha, antes dela,
     o % que está no RF"*). O ✓ sozinho dizia que passou, não QUANTO — e é o quanto que a mesa
     confere contra o alvo do cabeçalho.
     ⚠️ **O número é sempre a mesma pergunta — "quanto do que o trader tem no MM está no RF" —
     nas três réguas da coluna**, para que a comparação com o alvo (`Check Abi 4,5%`) valha em
     qualquer linha. No câmbio ele sai dos NOCIONAIS em USD da moeda (`rf_usd ÷ mm_usd`), não
     da razão de exposição que decide o veredito ali: aquela é contra 10 % (ela divide cada
     lado pelo SEU NAV) e, impressa nesta coluna, seria lida contra os 4,5 % do cabeçalho.
     ⛔ Isso NÃO muda veredito nenhum: o que decide continua sendo o que decidia (razão de
     exposição no câmbio, razão de quantidade no resto). Muda o que é IMPRESSO. */
  const _share = (num, den) =>
    (den != null && Math.abs(den) > 1e-12 && num != null) ? num / den : null;
  const _vere = (pct, marca) => pct == null ? marca
    : `${fmtPct(_semZeroNegativo(pct))} ${marca}`;

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
    /* ⭐ Aqui o alvo é ZERO, e o 0,0 % ao lado do ✓ é o que torna isso legível: a mesa vê que
       o certo é não ter nada, em vez de confiar que o ✓ está olhando a coisa certa. */
    return temRf
      ? `<td class="check-cell alloc-bad" title="${_escHtml(
          `⛔ FORA DO ESCOPO: o veículo de RF carrega só os books de ${books}, e esta linha é de `
          + `${row.area ?? '—'} — mas tem ${fmtFinalQtyTxt(rfQty)} lá. Ver a faixa no topo da aba.`)}">${
          _vere(_share(rfQty ?? 0, mmQty), '⛔')}</td>`
      : `<td class="check-cell alloc-ok" title="${_escHtml(
          `✓ Correto: ${row.area ?? 'este ativo'} não vai para o RF (o veículo carrega só os books `
          + `de ${books}), então zero aqui é o esperado — não é desvio de alocação.`
          + '\n\nO % ao lado é a fatia que está no RF: aqui o alvo é 0 %.')}">${
          _vere(_share(rfQty ?? 0, mmQty), '✓')}</td>`;
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
    const legs  = (c?.linhas ?? []).filter(l => l.ccy === base || l.ccy === quote);
    // ⚠ O USD fica fora de qualquer veredito: é o numerário dos dois NAVs (ver a tabela).
    const uteis = legs.filter(l => !l.numerario);
    const mat   = legs.filter(l => l.ratio != null && !l.mm_pequeno);
    const eLin  = rfAllocEval(mmQty, rfQty, cfg, row);

    /* ⭐ **O tooltip diz UMA coisa por caso** (05/11/2026, pedido da mesa) — ele vinha com
       três parágrafos de doutrina sobre por que a régua do câmbio é a moeda, e o que a mesa
       precisa ler é uma frase: **este vértice está na proporção**, ou **não está mas o
       agregado da(s) moeda(s) do par fechou**, ou **nem um nem outro**. O "porquê" da régua
       mora no cabeçalho da coluna e na tabela do topo da aba. */
    const _mat  = row.maturity
      ? ' ' + String(row.maturity).slice(0, 10).split('-').reverse().join('/') : '';
    const _vert = pair + _mat;
    const _linTxt = eLin.allocPct != null
      // `fmtFinalQtyTxt(0)` sai "—", e "RF — ÷ MM 9.336.765" lê-se como dado faltando em vez
      // de posição zerada, que é justamente o fato que esta linha está afirmando.
      ? `  este vértice:  RF ${Math.abs(rfQty ?? 0) > 0 ? fmtFinalQtyTxt(rfQty) : 'zero'}`
        + ` ÷ MM ${fmtFinalQtyTxt(mmQty)}`
        + ` = ${fmtPct(eLin.allocPct)}  ·  alvo ${fmtPct(eLin.allocTarget)}`
      : '  este vértice:  sem contraparte no MM para medir sozinho';
    /* O agregado de CADA moeda do par, uma linha por moeda, com o veredito ao lado — é ele
       que sustenta o "foi conferido no agregado" da frase de cima. */
    const _aggTxt = uteis.map(l => {
      // ⚠ "zerada" seria forte demais: o critério é estar abaixo do piso dos DOIS lados
      // (hoje US$ 200 mil no MM e US$ 8.883 no RF), e o AUD tem 3,7 mil lá — é resíduo.
      const v = l.veredito === 'ok_residuo' ? '✓ resíduo nos dois lados — nada a espelhar'
        : l.veredito === 'rf_sem_par'       ? '⛔ o RF carrega e o MM não'
        : l.ratio == null                   ? '— sem denominador'
        : `${fmtPct(l.ratio)}  ·  alvo ${fmtPct(alvoExp)}  `
          + (rfAllocClass(l.ratio, alvoExp) === 'alloc-ok' ? '✓' : '⚠');
      return `  agregado ${l.ccy}:  ${v}`;
    }).join('\n');
    const _rodape = '\n\nDetalhe em "Exposição por moeda", no topo da aba.';

    /* ☠️ **1º o erro sem absolvição possível: RF com a moeda, MM sem.** Vem ANTES da régua da
       linha porque a linha só absolve — e absolver também é decidir. O MM pode ter uma LINHA
       grande numa moeda cujo NET é ~0 (o `EUR/USD` de −548.964 convive com o `EUR/AUD` de
       +5.941.164), e aí um RF espelhando esse vértice em 4,4 % exatos diria ✓ carregando euro
       que o MM não tem. Mesma regra do dólar direcional: presença de posição onde ela não
       deveria existir não tem faixa de tolerância. */
    if (uteis.some(l => l.veredito === 'rf_sem_par')) {
      return `<td class="check-cell alloc-bad" title="${_escHtml(
        `⛔ ${_vert} NÃO está na proporção correta no RF — e o agregado da moeda também não: `
        + 'o RF carrega moeda que o book de MM não tem, então não há alocação a espelhar.'
        + `\n\n${_linTxt}\n${_aggTxt}` + _rodape)}">s/ par ⛔</td>`;
    }

    /* ⭐ **2º a PRÓPRIA LINHA (vértice+cross).** Batendo, o número que a mesa quer é o DELA —
       o mais específico que a tela tem a dizer, e não a fatia do balde, que mistura todos os
       pares daquela moeda. ⚠ Ela só ABSOLVE: linha fora de proporção não é evidência de erro
       em câmbio (o mesmo euro é montado com pares diferentes em cada livro) — cai para o balde. */
    if (eLin.allocPct != null && eLin.allocTarget
        && rfAllocClass(eLin.allocPct, eLin.allocTarget) === 'alloc-ok') {
      const dppL = (eLin.allocPct - eLin.allocTarget) * 100;
      return `<td class="check-cell alloc-ok" title="${_escHtml(
        `✓ ${_vert} está na proporção correta no RF.`
        + `\n\n${_linTxt}  (${dppL >= 0 ? '+' : ''}${
            dppL.toLocaleString('en-US', {maximumFractionDigits: 2})}pp)` + _rodape)}">${
        _vere(eLin.allocPct, '✓')}</td>`;
    }

    // 3º o BALDE da moeda. Sem denominador firme em nenhuma perna o estado é "zerada nos dois
    // lados" — o `rf_sem_par`, que é o outro jeito de não ter denominador, já saiu lá em cima.
    if (!mat.length) {
      if (!uteis.length) return muted('—', 'Par sem moeda conferível (só a perna de USD, que '
        + 'é o numerário dos dois NAVs e fica fora do veredito).');
      return `<td class="check-cell alloc-ok" title="${_escHtml(
        `✓ ${_vert} não está na proporção vértice a vértice — mas foi conferido o agregado: as `
        + 'moedas do par estão em resíduo nos dois lados (no MM o net se cancela entre pares), '
        + 'então não há exposição a espelhar.'
        + `\n\n${_linTxt}\n${_aggTxt}` + _rodape)}">OK ✓</td>`;
    }
    const pior = mat.reduce((a, b) =>
      Math.abs(b.ratio / alvoExp - 1) > Math.abs(a.ratio / alvoExp - 1) ? b : a);
    const cls  = rfAllocClass(pior.ratio, alvoExp);
    /* ☠️ **O número impresso NÃO é o `ratio` que decide o veredito.** O `ratio` é razão de
       EXPOSIÇÃO (cada lado sobre o SEU NAV) e vale contra os 10 %; esta coluna tem o alvo da
       boleta no cabeçalho, então imprimi-lo aqui seria oferecer um número para ser lido contra
       o alvo errado — medido: 18,6 % de exposição são ~8,4 % de nocional. O que sai é a fatia
       NOMINAL (`rf_usd ÷ mm_usd`), a mesma pergunta das outras réguas da coluna. */
    const fatia = _share(pior.rf_usd, pior.mm_usd);
    /* ⭐ Dentro do alvo o balde diz "OK", não um %: chegar aqui significa que a LINHA não
       fechou, então o % dela é justamente o que não bate e o do balde é de outra coisa.
       Fora do alvo o % FICA — ali ele é a medida do desvio. */
    return `<td class="check-cell ${cls}" title="${_escHtml(
      (cls === 'alloc-ok'
        ? `✓ ${_vert} não está na proporção vértice a vértice — mas foi conferido o agregado, `
          + 'e as moedas do par estão batidas com o que deveriam ser.'
        : `⚠ ${_vert} NÃO está na proporção correta no RF, e o agregado das moedas do par `
          + 'também não está.')
      + `\n\n${_linTxt}\n${_aggTxt}` + _rodape)}">${
      cls === 'alloc-ok' ? 'OK ✓' : _vere(fatia, '⚠')}</td>`;
  }

  /* ⭐ **ZERADO NOS DOIS LADOS é ✓, e virou caso próprio porque a tela dizia o CONTRÁRIO**
     (12/11/2026, achado da mesa). O PAbinader zerou o `3MO EURO EURIBOR Dec27` e o
     `3 MONTH SOFR FUT Dec27` no book de MM no mesmo pregão em que o RF zerou os dele — e
     esta coluna marcava **"⚠ nada no RF"**, que é o vermelho de quem NÃO espelhou o que
     devia. A causa de raiz estava no lado do MM (o `final_qty` vinha só com a abertura, sem
     a boleta do dia — ver o ☠️ em `get_trader_qty_by_fund`); com ela corrigida, a `allocPct`
     passa a ser `0/0` e o caminho de baixo cairia no "sem posição no MM para comparar", que
     é um traço mudo dizendo o que não é verdade: a linha EXISTE no book de MM, zerada.
     ⚠️ **Não confundir com `mmQty == null`** — aquilo é linha que não tem par no book de MM,
     e lá o check continua não sendo afirmado. Aqui há par, e os dois estão em zero. */
  if (mmQty != null && Math.abs(mmQty) < 1e-9 && Math.abs(rfQty ?? 0) < 1e-9) {
    const _zerouHoje = mmRow && Math.abs(mmRow.traded_qty ?? 0) > 1e-9;
    return `<td class="check-cell alloc-ok" title="${_escHtml(
      '✓ Zerado nos dois lados — não há exposição a espelhar.'
      + (_zerouHoje
          ? '\n\n  MM: zerado HOJE (abertura ' + fmtFinalQtyTxt(mmRow.opening_qty)
            + ', operada ' + fmtFinalQtyTxt(mmRow.traded_qty) + ')'
          : '\n\n  MM: zero')
      + '\n  RF: zero')}">zerado ✓</td>`;
  }

  // ── o resto (opção incluída): linha a linha, pela QUANTIDADE ─────────────────────
  // ⚠️ `row` entra na conta: é dela que sai o alvo do VEÍCULO daquela linha (Class N ×
  // Class I têm NAVs e alvos diferentes). Ver `rfAllocEval` em pos-helpers.js.
  const e = rfAllocEval(mmQty, rfQty, cfg, row);
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
  /* ⭐ Com dois veículos, o tooltip tem de dizer CONTRA QUAL FUNDO esta linha foi medida:
     dois alvos diferentes na mesma coluna, sem dizer de quem é cada um, leem-se como
     inconsistência. */
  const _ondeRf = row?.rf_sleeve_owner_label ? ` — no ${row.rf_sleeve_owner_label}` : '';
  const tip = `QUANTIDADE, linha a linha (opção e demais instrumentos)${_ondeRf}.\n\n`
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
  // ⭐ A fatia vem ANTES da marca, no verde e no amarelo — a coluna inteira se lê igual.
  return `<td class="check-cell ${cls}" title="${_escHtml(tip)}">${
    _vere(e.allocPct, cls === 'alloc-ok' ? '✓' : '⚠')}</td>`;
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
  /* ☠️ **O rótulo só anuncia um % quando existe UM alvo** (04/11/2026). Ele nasceu com o
     alvo embutido ("Check Abi 4,5%") porque havia um veículo só e o número valia para toda
     linha da coluna. Com dois, o alvo depende do que a linha É — juros espelha no Juros e
     Moeda **e** no Juros Global (≈5,9%), câmbio só no primeiro (4,5%) — e um número fixo no
     cabeçalho mandaria a mesa conferir metade da coluna contra o alvo errado.
     ⭐ Com um alvo só (um veículo, ou dois que aceitem as mesmas áreas) o rótulo volta a
     trazer o %, exatamente como antes — a regra é "anuncie o que for único". */
  const _porArea  = (typeof rfTargetsByArea === 'function') ? rfTargetsByArea(cfg) : [];
  const _alvos    = [...new Set(_porArea.map(x => x.alvo))];
  const _alvoHoje = _alvos.length === 1 ? _alvos[0] : rfAllocTarget(cfg);
  const alvo = (_alvos.length <= 1 && _alvoHoje != null) ? ' ' + fmtPct(_alvoHoje) : '';
  // Duas linhas: "Check RF" em cima, o alvo embaixo — ver o comentário do cabeçalho da
  // auxiliar. O rótulo é o mais largo da coluna (as células são ✓ ou "⚠ 9,9%").
  // ⚠️ Fallback sem a palavra "sleeve" (vocabulário interno que a mesa mandou tirar em
  // 05/11/2026): sem rótulo de trader, a coluna se chama pelo que ela confere.
  const nome = merged ? (cfg?.labels?.[tr] ?? tr ?? 'espelho') : 'RF';
  const lbl  = nome + (quebra && alvo ? '<br>' + alvo.trim() : alvo);
  const _fundo = rfSleeveFundLabel(cfg);
  /* A lista de alvos por área vai para o hover — é lá que cabe dizer POR QUE são dois, e
     ela sai do payload, não de texto escrito aqui. */
  const _linhasAlvo = _porArea.length
    ? _porArea.map(x => '  · ' + rfAreaPt(x.area) + ': ' + fmtPct(x.alvo)
        + ' (' + x.fundos.join(' + ') + ')').join('\n')
    : null;
  const tip = 'Veredito da posição espelhada do trader nesta linha — detalhe no hover de cada célula.\n\n'
    + (_porArea.length > 1
        ? 'O ALVO DEPENDE DO QUE A LINHA É, porque nem todo fundo de RF recebe todo book:\n'
          + _linhasAlvo + '\n\n'
        : 'FUNDO CONFERIDO: ' + _fundo + ' — é o NAV dele que entra na conta; os outros fundos '
          + 'de RF da aba não recebem sleeve.\n\n')
    + 'Câmbio LINEAR (spot · NDF · forward): vem do agregado por MOEDA, contra o alvo de '
    + fmtPct(cfg?.exposure_ratio) + ' da exposição do MM.\n'
    + 'Opção e demais: linha a linha, pela QUANTIDADE, contra o alvo da área dela.\n\n'
    + 'O alvo NÃO é constante: cada parcela é ' + fmtPct(cfg?.exposure_ratio)
    + ' × NAV do fundo ÷ NAV de MM do ' + (tr ?? 'trader')
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
      <b style="color:var(--red);font-size:15px">⛔ ${fora.length} posição(ões) FORA DO ESCOPO do RF</b>
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
/* ── GUIA DE ALOCAÇÃO — em que estratégia boletar para cair em quais fundos ─────────
   ⭐ Pedido da mesa (05/11/2026): "um guiazinho bem simples e direto junto às regras dos
   fundos". O trader não boleta fundo a fundo — boleta numa ESTRATÉGIA e o sistema reparte —,
   então escolher a estratégia É escolher quais fundos entram. Era a única regra da mesa que
   não aparecia em lugar nenhum da tela.
   ⚠️ As colunas são as do payload (`pnl_fund_tables`), na MESMA ordem do resto da aba —
   Local → Global → Juros e Moeda. Ordenar aqui por conta seria a 2ª ordem da tela.
   ⚠️ No bloco do trader do espelho a coluna é "o que chega no RF": as três estratégias
   repartem também no MM e no Prev dele, e dizer "nenhum" ali significa "nenhum RF", não
   "nada". Está escrito na linha, porque a confusão é natural. */
function renderRfAllocGuia(data) {
  const guia = data?.portfoliorf_alloc;
  if (!guia?.length) return '';
  const cols = (_pnlTablesForTab() ?? []).map(t => t.fund);
  if (!cols.length) return '';
  const marca = (e, f) => (e.fundos ?? []).includes(f)
    ? '<td class="num" style="text-align:center;color:var(--green);font-weight:700">✓</td>'
    : '<td class="num" style="text-align:center;color:var(--text-muted)">—</td>';
  const bloco = (titulo, itens, nota) => !itens.length ? '' : `
    <tr class="area-divider"><td colspan="${2 + cols.length}"
        style="font-weight:600;color:var(--text-muted)">${titulo}</td></tr>
    ${itens.map(e => `<tr>
      <td><b>${e.estrategia}</b></td>
      <td class="num" style="text-align:center;color:var(--text-muted)">${
        e.moeda === 'XXX' ? 'moeda est.' : (e.moeda ?? '—')}</td>
      ${cols.map(f => marca(e, f)).join('')}
    </tr>`).join('')}
    ${nota ? `<tr><td class="aux-foot" colspan="${2 + cols.length}"
        style="font-size:11px;color:var(--text-muted)"><div>${nota}</div></td></tr>` : ''}`;
  const doRf  = guia.filter(e => e.trader === 'PortfolioRF');
  const outros = [...new Set(guia.filter(e => e.trader !== 'PortfolioRF').map(e => e.trader))];
  return `
    <div style="margin-top:14px">
      <div style="font-size:12px;font-weight:600">Em que estratégia boletar
        ${_rfInfo('O trader boleta numa ESTRATÉGIA de alocação e o sistema reparte entre os '
          + 'fundos — ela é o único lugar onde se decide quais fundos entram no trade. '
          + 'A tabela diz, para cada uma, quais fundos de RF recebem.')}
      </div>
      <table class="data-table" style="width:auto;margin-top:5px;white-space:nowrap">
        <thead><tr>
          <th>Estratégia</th><th>Moeda</th>
          ${cols.map(f => `<th>${fundLabelMesa(f, true)}</th>`).join('')}
        </tr></thead>
        <tbody>
          ${bloco('PortfolioRF', doRf, '')}
          ${outros.map(t => bloco(t + ' — o que chega no RF',
              guia.filter(e => e.trader === t),
              'As três repartem também no MM e no Prev do ' + t
              + '; a tabela mostra só a perna que chega ao RF — "—" em toda a linha quer dizer '
              + '<b>nenhum RF</b>, não "nada boletado".')).join('')}
        </tbody>
      </table>
    </div>`;
}

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
        <!-- ⭐ **A FATIA DO LIVRO ao lado do NAV** (09/11/2026, pedido da mesa). Ela já
             existia, mas só dentro do ⓘ — e é o número que responde "quanto deste fundo
             tem no livro" sem fazer conta de cabeça com três NAVs de 7 dígitos. Fica na
             MESMA linha do NAV, não em coluna nova: é a mesma medida em outra unidade, e
             uma coluna para um número alargaria a tabela inteira. -->
        <div style="font-weight:400;color:var(--text-muted);font-size:10px">
          ${_rfUsd(r.nav)}${navTot && r.nav != null
            ? ` · <b style="color:var(--text)">${fmtPct(r.nav / navTot)}</b> do livro` : ''
          } ${_rfInfo(navTip)}</div></td>
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

  /* Regras que valem para o CONJUNTO — uma linha só, cada uma com o seu ⓘ.
     ☠️ **Esta frase era FIXA e ficou FALSA** (achado na revisão de 05/11/2026). Ela dizia
     "nenhum dos fundos carrega bolsa nem commodities", e em 05/11 o `Juros e Moeda` passou a
     poder carregar commodities — ouro e prata. O painel contradizia a si mesmo: a coluna
     Mandato ao lado, que vem do payload, já dizia "commodities (só ouro e prata)".
     ⭐ Agora sai do payload (`portfoliorf_regras`), como a coluna. Se a regra mudar de novo,
     a frase acompanha; texto fixo é o 2º lugar de onde ela diverge do que o check aplica. */
  const _comQuem = (regras ?? []).filter(x => (x.areas_ok ?? []).includes('Commodities'));
  const _metais  = [...new Set(_comQuem.flatMap(x => x.commodities_ok ?? []))];
  const _bolsaOk = (regras ?? []).filter(x => (x.areas_ok ?? []).includes('Equities'));
  const _fraseBolsa = (_bolsaOk.length ? 'bolsa: ' + _bolsaOk.map(x => x.label).join(' · ')
                                       : '<b>bolsa não entra</b>')
    + ' · ' + (_comQuem.length
        ? `<b>commodities só no ${_comQuem.map(x => x.label).join(' · ')}</b>`
          + (_metais.length ? ` (só ${_metais.join(' e ')})` : '')
        : '<b>commodities não entram</b>');
  const tipBolsa = 'Regra do veículo de RF. '
    + (_comQuem.length
        ? 'Commodity só no ' + _comQuem.map(x => x.label).join(' · ')
          + (_metais.length ? ', e só ' + _metais.join(' e ') + ' — a lista de raízes de ticker '
             + 'está em funds.PORTFOLIORF_METAL_ROOTS e falha FECHADA: commodity que não se '
             + 'identifique como metal permitido conta como fora do mandato. ' : '. ')
        : 'Nenhum dos fundos carrega commodities. ')
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
          ${_rfInfo('Soma dos NAVs dos três fundos da aba.'
            + NL + NL
            + '⚠️ NÃO é o denominador de toda linha: desde 09/11/2026 o #PL de CADA linha '
            + 'divide pela soma dos NAVs dos fundos ONDE AQUELA POSIÇÃO ESTÁ — os três quando '
            + 'ela está nos três, um só quando está num só. O hover da célula de #PL declara '
            + 'a base usada em cada linha.')}</span>
      </div>
      <table class="data-table" style="width:auto;margin-top:6px;white-space:nowrap">
        <thead><tr>
          <th>Fundo</th><th>Mandato</th><th>Daytrade</th>
          <th>Limite 100%<br>NAV deriv.</th><th>Offshore</th>
          <th>Espelho ${tr ?? 'MM'} (${fmtPct(expR)} da exp.)</th>
        </tr></thead>
        <tbody>${linhas}</tbody>
      </table>
      ${renderRfAllocGuia(data)}
      <div style="margin-top:6px;color:var(--text-muted);font-size:11px">
        ${_fraseBolsa} ${_rfInfo(tipBolsa)}
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
    /* ☠️ **SÓ COM A ABA ABERTA** (13/11/2026). O painel nasce junto com o card, e o card
       nasce no **PREFETCH** — o boot monta o DOM das 5 abas em background. Então este
       `loadEnquadramentoRF()` disparava sempre, mesmo com a mesa parada no EMota: medido,
       um 6º request no boot custando **2,9 s de Oracle + Bloomberg** para preencher um
       PARÊNTESE que só existe na aba do PortfolioRF — e competindo pelo terminal com os
       prefetches que vêm depois. ⚠️ Não atrasa a tabela da aba ativa (ela já pintou quando
       este sai, aos ~5,2 s), mas é trabalho inteiramente desperdiçado quando ninguém abre
       aquela aba, que é o caso comum.
       ⭐ É o MESMO padrão da 2ª onda de câmbio do PAbinader (`loadFxDealsForTab`): a query
       cara não roda no prefetch, e **abrir a aba é o gatilho** — o `showTraderTab` chama
       esta função ao abrir. Com o dado já em cache (a mesa tendo passado pela aba Check
       Enquadramento) o painel preenche na hora, sem request nenhum.
       ⚠️ Uma tentativa só (`_rfLimPedido`): a aba é cara e um retry em loop numa tela que
       re-renderiza a cada ⟳ viraria tráfego de fundo permanente. */
    const _abaAberta = (typeof activeTraderTab !== 'undefined')
                    && document.getElementById(`rfRegrasContainer-${activeTraderTab}`);
    if (_abaAberta && !_rfLimPedido && typeof loadEnquadramentoRF === 'function') {
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
/* ⚰️ **`renderRfTargetBanner` foi REMOVIDA (05/11/2026)** — pedido da mesa.
   Era a faixa do topo da aba de quem boleta: "Sleeve de RF no ‹fundo› — 10,0% da exposição
   do ‹trader› · alvo de hoje 4,5% do ticket de MM", mais o parágrafo de explicação, o ⓘ e a
   linha com os dois NAVs. Ela nasceu quando o alvo era uma constante e ninguém sabia de
   onde vinha; hoje o mesmo número está no rótulo e no hover da coluna `Check Abi` (que
   enumera os alvos por book) e na nota do rodapé da auxiliar (`rfTargetNote`) — a faixa
   virou a terceira cópia, e a mais cara, porque ocupava o alto da tela.
   ⚠️ O que ela também fazia e NÃO se perdeu: devolver o painel de regras quando havia um
   (`renderRfRegrasPanel`) — o `pos-tabs.js` passou a chamá-lo direto.
   ⚠️ O que se perdeu de propósito: o aviso "⚠ sem os dois NAVs" no TOPO. Ele continua,
   em texto, na nota do rodapé da auxiliar e nas células ("—" em vez de número). */

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
  /* Desvio RELATIVO ao alvo (`razão/alvo − 1`) — é a régua da COR (`rfAllocClass`) e é o que
     a coluna da razão não diz: 10,8% contra alvo de 10% é "+8% do alvo", não "+0,8pp". */
  const rel  = v => v == null ? '—'
    : (v < 0 ? '(' : '') + Math.abs(v * 100).toLocaleString('en-US',
        { maximumFractionDigits: 0 }) + '%' + (v < 0 ? ')' : '');
  const col  = v => v == null ? '' : (v < 0 ? 'style="color:var(--red)"' : '');
  const trdLbl = c.trader || 'MM';
  const rfLbl  = rfSleeveFundLabel(cfg);

  /* ⭐ **O VEREDITO virou COLUNA** (09/11/2026, mesa: *"bote tb uma coluna extra em que dá OK
     quando a exposição é mt pequena, pq aí a razão se torna menos relevante, pois
     provavelmente é resto de saldo"*). A regra pedida **já existia** — é o
     `veredito: 'ok_residuo'` que o backend carimba desde 05/11 —, só que vivia num selo de
     9px DENTRO da célula da razão, ao lado do número que ela justamente não decide. Hoje a
     razão é NÚMERO e o veredito é célula de check (`.check-cell`, a mesma das outras colunas
     da aba).
     ☠️ **E a cor estava sumindo em silêncio**: a célula saía com `class="num alloc-ok"`, e
     **não existe CSS para `alloc-*` sem `check-cell`** (positions-v2.css só casa
     `td.check-cell.alloc-*`). O veredito era calculado e nunca pintado.
     ⛔ **`l.small` NÃO serve para "é pequeno"**, apesar do nome: ele mede o piso de US$ 200
     mil nos DOIS lados, e o RF é ~2,3× menor e espelha ~10% — ali 200 mil seriam **0,7% do
     NAV do RF**, que é posição de verdade. Quem tem o piso certo (escalado, ~US$ 8,9 mil) é
     o `veredito` do backend. */
  const ccyCls = l => l.numerario ? ''
    : l.veredito === 'ok_residuo' ? 'alloc-ok'
    : l.veredito === 'rf_sem_par' ? 'alloc-bad'
    : (l.ratio != null && !l.mm_pequeno) ? rfAllocClass(l.ratio, alvo) : '';

  const tr = c.linhas.map((l, i) => {
    const mutedRow = l.numerario ? ' style="color:var(--text-muted)"' : '';
    const cls      = ccyCls(l);
    const desvio   = (l.ratio != null && alvo) ? (l.ratio / alvo - 1) : null;

    /* As quatro frases do veredito. A 2ª é a que a mesa pediu, e ela diz POR QUE o ✓ não veio
       da razão — com a razão a dois dígitos ao lado, um "OK" sem motivo se lê como erro. */
    let chkTxt, chkTip;
    if (l.numerario) {
      chkTxt = '—';
      chkTip = 'O dólar é o NUMERÁRIO dos dois NAVs — "exposição a USD" não é risco aqui. E ela '
        + 'não pode espelhar: no MM o euro vem de EUR/AUD, que não toca o dólar, e no RF de '
        + 'EUR/USD + AUD/USD, cujas pernas de dólar se cancelam. A linha fica como informação, '
        + 'fora do veredito.';
    } else if (l.veredito === 'ok_residuo') {
      chkTxt = 'OK · resíduo';
      chkTip = 'EXPOSIÇÃO PEQUENA NOS DOIS LADOS — não há o que espelhar, e a razão ao lado não '
        + 'decide nada (com denominador perto de zero ela oscila muito).' + _AL_NL + _AL_NL
        + 'MM: US$ ' + Math.abs(Math.round(l.mm_usd)).toLocaleString('en-US')
        + '  (régua de resíduo: US$ ' + Number(c.min_usd).toLocaleString('en-US') + ')' + _AL_NL
        + 'RF: US$ ' + Math.abs(Math.round(l.rf_usd)).toLocaleString('en-US')
        + '  (régua: US$ ' + Math.round(c.rf_min_usd ?? 0).toLocaleString('en-US') + ' — a do MM '
        + 'trazida pela proporção, porque o RF é menor e espelha uma fração)' + _AL_NL + _AL_NL
        + 'É o caso do resto de rolagem e da moeda cujas pernas se cancelam entre pares.';
    } else if (l.veredito === 'rf_sem_par') {
      chkTxt = '⛔ s/ par';
      chkTip = 'O RF CARREGA E O MM NÃO.' + _AL_NL + _AL_NL
        + 'MM: US$ ' + Math.abs(Math.round(l.mm_usd)).toLocaleString('en-US')
        + '  (abaixo da régua de resíduo, US$ ' + Number(c.min_usd).toLocaleString('en-US') + ')'
        + _AL_NL
        + 'RF: US$ ' + Math.abs(Math.round(l.rf_usd)).toLocaleString('en-US')
        + '  (acima da dele, US$ ' + Math.round(c.rf_min_usd ?? 0).toLocaleString('en-US') + ')'
        + _AL_NL + _AL_NL
        + 'Não há alocação a espelhar: isto não é desvio de proporção, é posição sem origem.';
    } else if (cls) {
      chkTxt = cls === 'alloc-ok' ? '✓'
        : (cls === 'alloc-bad' ? '⛔ ' : '⚠ ') + rel(desvio);
      chkTip = 'Razão ' + pct(l.ratio) + ' contra o alvo de ' + pct(alvo) + ' — '
        + (desvio >= 0 ? 'acima' : 'abaixo') + ' em ' + rel(Math.abs(desvio)) + ' do alvo.'
        + _AL_NL + _AL_NL
        + 'Verde até ' + (RF_ALLOC_REL_TOL * 100).toFixed(0) + '% de desvio do alvo, amarelo até '
        + 'o dobro, vermelho além. ⚠ A faixa é RELATIVA ao alvo: 2pp num alvo de ' + pct(alvo)
        + ' aceitariam quase metade e quase o dobro da alocação pedida.';
    } else {
      chkTxt = '—';
      chkTip = 'Sem denominador firme para a razão (falta o NAV de um dos lados) — não afirmado.';
    }

    /* A razão fica como NÚMERO, sem cor: quem dá o veredito é a coluna ao lado. A linha de MM
       pequena mantém o selo `peq.`, porque ali o aviso é sobre o NÚMERO (ruído-sensível), e
       não sobre o veredito — que nesse caso vem do backend e já tem célula própria. */
    const selo = (l.ratio != null && l.mm_pequeno && l.veredito == null)
      ? ' <span style="font-size:9px;font-weight:600;color:var(--text-muted)" title="'
        + _escHtml('A perna do MM tem US$ '
          + Math.abs(Math.round(l.mm_usd)).toLocaleString('en-US') + ', abaixo da régua de US$ '
          + Number(c.min_usd).toLocaleString('en-US') + ': o denominador é pequeno, então a razão '
          + 'mexe muito com pouco.') + '">peq.</span>'
      : '';
    const rTxt = l.ratio != null ? pct(l.ratio) + selo
      : '<span style="color:var(--text-muted)" title="' + _escHtml(
          l.numerario ? 'Perna de numerário — ver o check ao lado.'
            : 'O MM não carrega esta moeda — sem denominador não há razão.') + '">—</span>';

    return `<tr class="${i % 2 === 0 ? 'group-odd' : 'group-even'}"${mutedRow}>
      <td class="lbl">${l.ccy}</td>
      <td class="sep" ${col(l.mm_usd)}>${usd(l.mm_usd)}</td>
      <td ${col(l.mm_pct)}>${pct(l.mm_pct)}</td>
      <td class="sep" ${col(l.rf_usd)}>${usd(l.rf_usd)}</td>
      <td ${col(l.rf_pct)}>${pct(l.rf_pct)}</td>
      <td class="sep">${rTxt}</td>
      <td class="check-cell ${cls}" title="${_escHtml(chkTip)}">${chkTxt}</td>
    </tr>`;
  }).join('');

  /* ⚰️ **A linha AGREGADO e a tira "Quem leva o agregado" SAÍRAM** (09/11/2026, mesa: *"a
     linha agregado não faz sentido, pois o batimento é por moeda, a soma de tudo não diz
     nada"*). Ela somava os MÓDULOS das moedas dos dois lados e dividia — um número que não
     corresponde a posição nenhuma e que podia estar fora do alvo com TODAS as moedas dentro
     (e o contrário).
     ⭐ **E a remoção só é segura porque o alarme que ela carregava virou LINHA.** O agregado
     nasceu para pegar o `EUR/USD` de −85.000 de 05/11/2026, que levava o total de 10,6% a
     13,4% sem nenhuma linha acusando; hoje aquele caso é exatamente o veredito `rf_sem_par`,
     que marca a MOEDA em vermelho na coluna Check. Tirá-lo antes disso teria apagado o aviso.
     ⚠️ O backend segue publicando `gross` e `agg_ex` — **sem consumidor** desde esta mudança. */

  /* O card nasce COLAPSADO, então o título precisa carregar o veredito. Ele passou a ser a
     CONTAGEM por moeda, com os nomes: é a mesma pergunta ("está batendo?") respondida na
     unidade em que o batimento existe. */
  const julg  = c.linhas.filter(l => !l.numerario && ccyCls(l));
  const foraL = julg.filter(l => ccyCls(l) !== 'alloc-ok');
  const pior  = foraL.some(l => ccyCls(l) === 'alloc-bad') ? 'var(--red)' : 'var(--yellow)';
  /* ☠️ **A lista de nomes é LIMITADA a 3, e o motivo é a largura da IMAGEM.** O título vive
     DENTRO do `.section-copy-target`, que é `width: fit-content` — então, sendo mais largo que
     a tabela, é ELE quem dita a largura do print (a mesma armadilha do `.jgp-tbl-note`).
     Medido nesta tela: tabela 526px contra alvo de cópia **896px** com 1 moeda nomeada e
     **1.123px** com 7 — ou seja, de 370 para 597px de faixa branca morta. Com o teto, o pior
     caso fica perto do rótulo que havia antes (870px). O resto vai no `title`, e todas as
     moedas estão marcadas na coluna Check da tabela. */
  const _CCY_TIT_MAX = 3;
  const nomes = foraL.slice(0, _CCY_TIT_MAX).map(l => l.ccy).join(' · ')
    + (foraL.length > _CCY_TIT_MAX ? ` +${foraL.length - _CCY_TIT_MAX}` : '');
  const veredito = !julg.length ? ''
    : foraL.length
      ? '<span style="font-weight:600;color:' + pior + '" title="' + _escHtml(
          'Fora do alvo de ' + pct(alvo) + ' (ou com posição no RF sem par no MM): '
          + foraL.map(l => l.ccy).join(' · ') + '.' + _AL_NL + _AL_NL
          + 'O batimento é POR MOEDA — não há um número só para o conjunto.')
        + '">⚠ ' + foraL.length + ' de ' + julg.length + ' moedas fora do alvo · '
        + nomes + '</span>'
      : '<span style="font-weight:600;color:var(--green)" title="' + _escHtml(
          'Cada moeda dentro da faixa do alvo de ' + pct(alvo) + ', ou com exposição residual '
          + 'nos dois lados.') + '">✓ ' + julg.length + ' moedas no alvo</span>';

  const foraTxt = Object.entries({ ...(c.fora?.mm ?? {}) })
    .map(([k, n]) => `${n}× ${k}`).join(' · ');
  const foraRf = Object.entries({ ...(c.fora?.rf ?? {}) })
    .map(([k, n]) => `${n}× ${k}`).join(' · ');
  const nota = (foraTxt || foraRf)
    ? `<div class="jgp-tbl-note" style="font-size:11px;color:var(--text-muted);margin-top:6px;white-space:normal">`
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
    ? `<div class="jgp-tbl-note" style="font-size:11px;color:var(--red);margin-top:4px;white-space:normal">`
      + `⚠ <b>conta incompleta</b> — sem spot de ${c.sem_spot.join(', ')}: a linha inteira é `
      + `pulada, e um cross pulado tira da conta também a perna da outra moeda. As razões acima `
      + `podem estar erradas em moeda que nem aparece nesta lista.</div>`
    : '';

  /* ⭐ **Colapsado por padrão, e no FIM da aba** (pedido da mesa, 08/10/2026): a leitura do dia
     a dia é a tabela de posição, e um card de 10 moedas acima dela empurrava tudo para baixo.
     ⚠️ Mas o VEREDITO fica no TÍTULO, que continua visível fechado — esconder o card inteiro
     tiraria da tela justamente a resposta de "a conta dos 10% bate?". Mesmo padrão do card de
     MM Prev (pos-tabs.js): cabeçalho sempre à vista, corpo atrás da setinha. */
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
        <span>Exposição por moeda — RF × ${trdLbl}
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
      <table class="jgp-tbl">
        <thead>
          <tr>
            <th class="left" rowspan="2">Moeda</th>
            <th class="center sep" colspan="2" title="${_escHtml(
              'Book de MM do ' + trdLbl + ', em USD ao spot.' + _AL_NL + 'NAV: USD '
              + Number(c.nav_mm ?? 0).toLocaleString('en-US', { maximumFractionDigits: 0 })
            )}">MM · ${trdLbl}</th>
            <th class="center sep" colspan="2" title="${_escHtml(
              'Sleeve espelhado no veículo offshore, em USD ao spot.' + _AL_NL
              + 'NAV do(s) fundo(s) que o detêm: USD '
              + Number(c.nav_rf ?? 0).toLocaleString('en-US', { maximumFractionDigits: 0 })
            )}">RF · ${rfLbl}</th>
            <th class="center sep" colspan="2" title="${_escHtml(
              'O CHECK: o RF tem de carregar ' + (alvo * 100).toFixed(0) + '% da exposição do '
              + 'MM, cada lado medido em % do NAV do SEU fundo.')}">Proporção · alvo ${pct(alvo)}</th>
          </tr>
          <tr>
            <th class="sep">USD</th>
            <th>% NAV</th>
            <th class="sep">USD</th>
            <th>% NAV</th>
            <th class="sep" title="${_escHtml('% NAV RF ÷ % NAV MM.')}">RF ÷ MM</th>
            <th class="center" title="${_escHtml(
              'Veredito da moeda.' + _AL_NL
              + '✓ — dentro de ±' + (RF_ALLOC_REL_TOL * 100).toFixed(0) + '% do alvo (amarelo '
              + 'até o dobro, vermelho além)' + _AL_NL
              + 'OK · resíduo — exposição pequena DOS DOIS LADOS: a razão ao lado não decide '
              + 'nada, é resto de rolagem' + _AL_NL
              + '⛔ s/ par — o RF carrega a moeda e o MM não')}">Check</th>
          </tr>
        </thead>
        <tbody>${tr}</tbody>
      </table>
      ${nota}${semSpot}
      </div>
    </div>
  </div>`;
}

/* Resumo de UMA linha para o rodapé das tabelas de check — o recado longo mora no painel.
   ⚠️ Diz **qual RF** está sendo conferido: a aba tem três fundos de RF desde 30/10/2026 e o
   sleeve mora em um ou mais veículos (dois desde 04/11/2026), então esta nota declara contra
   qual fundo cada alvo foi medido; "o RF" sozinho deixou de identificar alguma coisa. */
function rfTargetNote(cfg) {
  const { e, nivel } = _rfDrift(cfg);
  const fundo = rfSleeveFundLabel(cfg);
  const tr    = cfg?.traders?.[0] ?? 'trader';
  if (nivel === 'semnav') {
    return `<span style="color:var(--yellow)">Alvo não afirmado hoje — falta o NAV do `
         + `${fundo} ou o de MM do ${tr}, e o alvo é derivado dos dois.</span>`;
  }
  /* ☠️ **Com mais de um alvo, a nota ENUMERA em vez de anunciar um número** (04/11/2026).
     Ela dizia "Alvo de hoje 4,5% do ticket", o que deixou de valer quando o Juros Global
     passou a receber a parte de juros: ali o alvo da linha de juros é 4,5% + 1,4%. Os alvos
     saem de `rfTargetsByArea` (payload), então um veículo novo entra na frase sozinho. */
  const porArea = (typeof rfTargetsByArea === 'function') ? rfTargetsByArea(cfg) : [];
  const alvos   = [...new Set(porArea.map(x => x.alvo))];
  if (alvos.length > 1) {
    const txt = porArea.map(x => `<b>${fmtPct(x.alvo)}</b> em ${rfAreaPt(x.area)}`
      + ` (${x.fundos.join(' + ')})`).join(' · ');
    return `<span style="color:var(--text-muted)">Alvo de hoje por book: ${txt} — do ticket `
         + `de ${tr}, o que põe cada fundo em ${fmtPct(e.expTarget)} da exposição dele. `
         + `Não é constante: muda com os NAVs.</span>`;
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
/* ☠️ **As casas decimais seguem o valor EXIBIDO, não o cru** (09/11/2026). Em linha `pct`
   eram 2 casas fixas sobre `valor × 100`, então **a faixa inteira do amarelo imprimia
   "0.00%"**: com o limiar em 0,005% do NAV, tudo entre verde e vermelho arredondava para
   zero e a célula dizia *"⚠ −0,00%"* — um alerta que mostra zero treina a mesa a ignorá-lo,
   e foi exatamente assim que a mesa pegou a faixa errada. */
/* ⚠️ `extra` dá uma casa a mais, e existe para o TOOLTIP. Na borda da faixa a célula
   imprime −0,005 ao lado de um "verde até 0,005" e as duas se contradizem — a diferença
   está na 4ª casa. A CÉLULA fica com 3 (a coluna é estreita); quem audita abre o hover, e é
   lá que o número tem de fechar com o limiar. */
function _mirrorDiffTxt(diff, type, extra) {
  const abs  = Math.abs(diff);
  const disp = type === 'pct' ? abs * 100 : abs;
  const dec  = (disp < 0.01 ? 3 : 2) + (extra ? 1 : 0);
  const s = disp.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec })
          + (type === 'pct' ? '%' : '');
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
    + (e.diff != null && e.tolAbs
        ? `Divergência: ${_mirrorDiffTxt(e.diff, row.pl_type, true)} (${un}).\n`
          + `Verde até ${_mirrorDiffTxt(e.tolAbs, row.pl_type, true).replace('+', '')}, `
          + `amarelo até ${_mirrorDiffTxt(2 * e.tolAbs, row.pl_type, true).replace('+', '')}, `
          + `vermelho além — faixa ABSOLUTA, na unidade da linha.\n`
          + `⚠ Não é relativa à exposição do ${tr}: ±5% de uma linha pequena é um desvio que `
          + `não existe na prática, e de uma linha grande é um que importa.`
          + (e.plLote ? `\n\n1 contrato aqui vale ~${
              _mirrorDiffTxt(e.plLote, row.pl_type, true).replace('+', '')} (${un})`
              + (Math.abs(e.diff) < e.plLote
                  ? ' — a diferença é MENOR que isso, então a boleta não consegue corrigir.'
                  : '.') : '')
        : `Sem #PL dos dois lados: o veredito cai na faixa RELATIVA de `
          + `±${(e.tol * 100).toLocaleString('en-US', {maximumFractionDigits: 1})}% da exposição `
          + `dele, amarelo até o dobro, vermelho além.`);
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
   ⚠️ Vale também para a linha `is_offshore`, cujo veredito hoje é o `_checkNaoRateada`
   (era o rótulo mudo "offshore" até 05/11/2026): ela mora no veículo offshore, que é
   justamente o que faz o dólar ser do Juros e Moeda. */
const _DOLAR_FUNDO_EPS = 1e-9;
/* O mesmo teste na unidade do modo "por fundo" (pos-fundsplit.js), onde o que se tem é a
   FATIA da linha naquele bloco e não a quantidade de cada fundo. Folga maior porque a fatia
   é uma divisão (`q_fundo / q_livro`) e não uma quantidade crua — 1e-6 é 0,0001 % da linha,
   ordens de grandeza abaixo de qualquer posição de verdade. */
const _DOLAR_SHARE_EPS = 1e-6;

/* Fundos (que não o offshore) com quantidade nesta linha de dólar. `null` = nada errado. */
/* ☠️ `labelsDe` soma o fundo-cabeça E os veículos dele — MESMO ponto cego das colunas de
   quantidade (ver `_labelsDe`): dólar tomado por um veículo offshore chega no `fund_rows`
   com o nome do VEÍCULO, e ler só `byFund[fundo]` dava zero — ou seja, o check de "dólar no
   fundo errado" ficaria cego justamente onde o dólar de fato mora. Sem a função (chamador
   antigo) volta ao comportamento anterior. */
function dolarFundoErrado(byFund, fundLabels, offFund, labelsDe) {
  if (!offFund) return null;
  const soma = fl => (labelsDe ? labelsDe(fl) : [fl])
    .reduce((a, x) => a + (byFund?.[x]?.final_qty ?? 0), 0);
  const errs = fundLabels
    .filter(fl => fl !== offFund)
    .map(fl => ({ fund: fl, qty: soma(fl) }))
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
  /* ☠️ **A FAIXA era CEGA para o dólar tomado por um VEÍCULO offshore** (achado na revisão
     de 05/11/2026). As chaves de `fundNavs` são só os fundos-CABEÇA, e o `fundIndex` é
     chaveado pelo `fund_label` da linha — que num `Segregated Portfolio-I` é o nome do
     VEÍCULO. Sem este de-para, `byFund[fundo]` dava `undefined`, a soma dava 0 e a faixa
     vermelha do topo CALAVA, enquanto a célula ⛔ ERRO da auxiliar — que já recebia o
     `_labelsDe` — acusava a MESMA linha. Dois caminhos para a mesma pergunta, e só um
     enxergava; é pior que nenhum, porque a faixa é o lugar onde a mesa confia em ver.
     ⚠️ Sai da config (`pnl_fund_tables[].includes`), a mesma do `renderFundBreakTable`. */
  const _tabs = (typeof _pnlTablesForTab === 'function') ? _pnlTablesForTab() : null;
  const _incl = {};
  for (const t of (_tabs ?? [])) _incl[t.fund] = t.includes;
  const _labelsDe = fl => _incl[fl] ?? [fl];
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
    const errs = dolarFundoErrado(fundIndex[k] ?? {}, fundLabels, offFund, _labelsDe);
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

/* ── ⚠️ BOLETA NA ÁREA ERRADA — faixa própria, em âmbar (05/11/2026) ──────────────
   ☠️ **Esta faixa existe porque um alarme certo quase morreu.** A `Digital Copom Cut 25bp`
   entra no JRS como `Currencies · Directional BRL`, e o check de MANDATO acusava ⛔ ERRO no
   Juros Local e no Juros Global. Classificar a digital como juros (o que ela é) calou o
   vermelho — e a mesa então contou que o vermelho estava certo: *"eu boletei na estratégia
   errada mesmo, não era pra estar em currencies"*. Certo pelo motivo errado.
   ⭐ São duas perguntas: *o fundo pode carregar isto?* (mandato, pela natureza REAL) e *a
   boleta está na área certa?* (esta). A 1ª não pode acusar o fundo certo por causa de um
   cadastro errado; a 2ª é que pega o cadastro errado.
   ⚠️ ÂMBAR, não vermelho: a posição PODE existir naquele fundo — o que está errado é onde
   ela foi lançada. Vermelho aqui competiria com a faixa de mandato, que é mais grave.
   ⚠️ O alcance é o da lista `funds.PORTFOLIORF_AREA_PADRAO` (hoje, duas entradas — a
   digital de COPOM e a opção de IDI): não existe
   no JRS um de-para instrumento → área esperada, então a faixa pega o que estiver lá.
   ⭐ Silêncio é o estado certo — sem divergência, nada é renderizado. */
function renderPrfAreaDivergenteAlerta(data) {
  const lista = data?.portfoliorf_escopo?.area_divergente;
  if (!lista?.length) return '';
  const li = lista.map(x => {
    const esp = _BOOK_PT[x.esperada] ?? x.esperada ?? '—';
    return `<li style="margin:1px 0"><b>${x.instrument_name ?? '—'}</b>`
      + ` <span style="color:var(--text-muted)">— boletada em <b>${x.cadastrada}`
      + `${x.subarea ? ' · ' + x.subarea : ''}</b>, o padrão é <b>${esp}</b></span>`
      + (x.qty != null ? ` · ${fmtFinalQty(x.qty)}` : '')
      + `<div style="color:var(--text-muted);font-size:11px;margin-left:2px">${x.porque ?? ''}</div></li>`;
  }).join('');
  return `<div class="card" style="border-left:4px solid var(--yellow);background:color-mix(in srgb, var(--yellow) 8%, var(--bg-card));flex:0 0 auto">
    <div style="font-size:12px;line-height:1.7">
      <b style="color:var(--yellow);font-size:15px">⚠ ${lista.length} posição(ões) BOLETADA(S) FORA DA ÁREA PADRÃO</b>
      <div style="margin-top:2px">O risco é permitido no fundo — o que está fora do lugar é o
        cadastro da boleta (área/estratégia). Conferir no JDS:</div>
      <ul style="margin:4px 0 0 18px;padding:0">${li}</ul>
    </div>
  </div>`;
}

function renderPrfEscopoAlerta(data) {
  const fora = data?.portfoliorf_escopo?.fora;
  if (!fora?.length) return '';
  const okMap = data.portfoliorf_escopo.areas_ok || {};
  const li = fora.map(x => {
    const onde = (x.funds || []).map(f =>
      `<b>${fundLabelMesa(f.fund, true)}</b> ${fmtFinalQty(f.qty)}`).join(' · ');
    const kind = (_BOOK_PT[x.risk_kind] ?? x.risk_kind ?? '—')
      + (x.praca ? ' ' + (x.praca === 'local' ? 'local' : 'global') : '');
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
  const commMap = data.portfoliorf_escopo.commodities_ok || {};
  const regras = Object.entries(okMap).map(([f, areas]) => {
    const pr = pracaMap[f] || [];
    /* Só diz a praça quando ela RESTRINGE: "juros local e global" é o estado normal e
       repeti-lo em duas das três linhas é ruído na faixa que tem de ser lida. */
    const prTxt = (pr.length === 1) ? ` ${pr[0]}` : '';
    /* ⚠️ Commodities têm 2º nível (só ouro e prata), e a regra na faixa TEM de dizê-lo:
       escrever "commodities" seco aqui faria a mesa ler como área inteira liberada — que é
       o oposto da regra, e justamente o que o check pega. */
    const comm = commMap[f] || [];
    const txt = areas.map(a => (a === 'Commodities' && comm.length)
      ? `commodities (só ${comm.join(' e ')})`
      : (_BOOK_PT[a] ?? a)).join(' e ');
    return `<b>${fundLabelMesa(f, true)}</b>: ${txt}${prTxt}`;
  }).join(' &nbsp;·&nbsp; ');
  return `<div class="card" style="border-left:4px solid var(--red);background:color-mix(in srgb, var(--red) 7%, var(--bg-card));flex:0 0 auto">
    <div style="font-size:12px;line-height:1.7">
      <b style="color:var(--red);font-size:15px">⛔ ${fora.length} posição(ões) FORA DO MANDATO DO FUNDO</b>
      <div style="margin-top:2px">${regras}. Estas linhas estão fora disso:</div>
      <ul style="margin:4px 0 0 18px;padding:0">${li}</ul>
    </div>
  </div>`;
}

/* ── ⚠ O QUE O BOOK DE MM TEM E O RF NÃO (11/11/2026) ─────────────────────────────────
   Pedido da mesa: *"se tiver alguma posição de juros do EMota que não está no RF, eu quero
   que avise na página do RF — um aviso absolutamente direto abaixo da tabela principal. O
   mesmo para o Abinader em juros e moeda"*.

   ⭐ **É o ponto cego das duas colunas de espelho da auxiliar.** `Check EMota` e `Check Abi`
   são POR LINHA, e uma posição que só existe no book de MM **não tem linha** — não sai
   cinza, não sai vermelha, não aparece. O `zerado_rf` do `rfMirrorEval` cobre metade do fato
   (a linha existe e está zerada); o instrumento que nunca entrou no RF é invisível.

   ⚠️ **ABAIXO da tabela, e não na faixa de alertas do topo**, por duas razões que se somam:
   a mesa já fixou que acima da Posição *"só os ERROS"* (05/11/2026) — e isto não é erro, é
   divergência de alocação, que ela pode ter decidido não espelhar; e o lugar de ler "falta
   isto" é logo depois da lista do que existe.

   ☠️ **Quem decide se a linha EXISTE é AQUI, não o backend** — o payload traz só o lado do
   MM (escopo + equivalência + piso aplicados em `rf_faltantes.py`). A razão é a MARRETA: a
   quantidade que a mesa digita na célula vive no `effectiveRowValues`, e um veredito
   calculado no servidor contradiria a tabela logo acima dele no primeiro número digitado.
   ⚠️ E casa por `instrument_reference` **ou** por `instrument_name`: o ref é a chave boa
   (é a do `rf_mirror.qty`), mas ele não sobrevive a toda linha do pipeline — numa linha que
   hoje é só boleta ele pode ser outro. Casar pelos dois só reduz falso positivo; é o nome,
   não o ref, que a mesa lê na tabela. */
function _rfFaltLadoRows(bloco, mainRows) {
  /* ⛔ O lado da tabela onde a contraparte DEVE estar. Misturar os dois faria a faixa do
     EMota ser absolvida por uma linha do sleeve (que é do PAbinader, e tem o check dela). */
  return (bloco?.via === 'sleeve')
    ? (mainRows || []).filter(r => r.is_rf_sleeve && r.trader === bloco.trader)
    : (mainRows || []).filter(r => !r.is_rf_sleeve);
}

/* O estado do ativo no RF: `null` = está lá (nada a dizer), 'zerada' = a linha existe e a
   quantidade efetiva é zero, 'ausente' = não há linha nenhuma. */
function _rfFaltEstado(item, lado) {
  const ref  = item.instrument_reference;
  const nome = item.instrument_name;
  const cand = lado.filter(r => (ref && r.instrument_reference === ref)
                             || (nome && r.instrument_name === nome));
  if (!cand.length) return 'ausente';
  const temQtd = cand.some(r => {
    const q = (typeof effectiveRowValues === 'function' ? effectiveRowValues(r).final
                                                        : r.final_qty) ?? 0;
    return Math.abs(q) > 0;
  });
  return temQtd ? null : 'zerada';
}

function renderRfFaltantes(data, mainRows) {
  const cfg = data?.rf_faltantes;
  if (!cfg?.blocos?.length) return '';

  const blocos = cfg.blocos.map(b => {
    const lado = _rfFaltLadoRows(b, mainRows);
    const ativos = (b.ativos || [])
      .map(x => ({ ...x, estado: _rfFaltEstado(x, lado) }))
      .filter(x => x.estado);
    /* ⛔ **As MOEDAS não passam pelo teste de linha** — elas já vêm decididas do agregado
       por moeda (`_rf_ccy_check`), que é a única régua válida em câmbio linear: o mesmo euro
       é montado com pares diferentes em cada livro, então procurar "a linha do EUR" na
       tabela não responde nada. É o espelho exato do veredito `rf_sem_par` de lá. */
    const moedas = b.moedas || [];
    return { b, ativos, moedas };
  }).filter(x => x.ativos.length || x.moedas.length);

  if (!blocos.length) return '';           // ⭐ silêncio é o estado normal

  const usd = v => v == null ? '—'
    : (v < 0 ? '(' : '') + Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 })
      + (v < 0 ? ')' : '');
  /* 2 casas, como a tabela "Exposição por moeda" — o `fmtPct` da aba tem 1, e numa exposição
     de 0,31 % do NAV ela arredonda para 0,3 %, que não casa com o número da outra tabela. */
  const pct2 = v => v == null ? '—'
    : (v < 0 ? '(' : '') + Math.abs(v * 100).toLocaleString('en-US',
        { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%' + (v < 0 ? ')' : '');

  /* ⭐ **O QUANTO, na régua do `#PL`** (13/11/2026, pedido da mesa: *"além da qtd mostre
     entre parênteses a exposição equivalente no gestor — os 200k de MXN são quanto de
     exposição pro Abi? o CDS é quanto no EMota?"*). A quantidade sozinha não dimensiona
     nada: 14,5 CDS e 952 DI são unidades diferentes, e sem o #PL a mesa não sabe qual das
     duas linhas é a que dói.
     ⚠️ **As DUAS unidades da casa, com e sem `%`** — juros em % do NAV por 100 bps (sem
     `%`), câmbio/bolsa em fração do NAV (com `%`). Mesmo critério do `fmtPL`; aqui o sinal
     sai como `−` em vez de parêntese porque o número já vive dentro de um.
     ⚠️ Em CINZA e depois da quantidade, de propósito: quem boleta lê a quantidade, o #PL é
     o calibre. */
  const _expNum = (v, t) => Math.abs(v * (t === 'pct' ? 100 : 1)).toLocaleString('en-US',
      { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + (t === 'pct' ? '%' : '');
  const expo = (v, t) => v == null ? ''
    : ` <span style="color:var(--text-muted)">(#PL ${v < 0 ? '\u2212' : ''}${_expNum(v, t)})</span>`;
  const expoTxt = (v, t) => v == null ? '—'
    : (v < 0 ? '\u2212' : '') + _expNum(v, t);
  const _UNIT_TXT = t => t === 'pct' ? 'fração do NAV, com %'
                                     : '% do NAV por 100 bps, sem %';
  const _SRC_TXT = { dv01: 'DV01 × taxa', bbg: 'preço da Bloomberg', d1: 'marcação de D-1' };

  /* ⭐ **UMA LINHA POR ITEM, e o resto em ⓘ** (11/11/2026, mesa: *"te pedi pra ser direto e
     você escreveu esse texto enorme. É pra ser simples e direto, só pontuando"*). A 1ª versão
     imprimia a regra do espelho, o escopo, a área/subárea, o rateio por fundo e um rodapé de
     quatro linhas sobre os cortes — tudo verdade, e tudo ruído na faixa que tem de ser lida
     de relance. É a regra da casa (`explicações em ⓘ, nunca soltas na tela`) aplicada aqui:
     a LINHA diz o ativo e os dois números, o `title` diz o porquê. */
  const skip = (cfg.skip_subareas || []).join(' e ') || 'caixa e hedge';
  const tipBloco = b => _escHtml(
    `${b.regra}.\n\nEscopo: ${b.escopo === 'juros'
      ? 'juros. O dólar do livro é hedge próprio e não entra.'
      : 'juros e moeda — ativo a ativo em juros, opção e futuro; por MOEDA no câmbio linear, '
        + 'porque o mesmo euro é montado com pares diferentes em cada livro.'}\n\n`
    + 'O "→ RF" é a quantidade equivalente de hoje: o ticket do MM trazido pela régua do '
    + 'espelho e pelos NAVs do dia, repartida só nos fundos cujo mandato aceita o ativo.\n\n'
    + `Ficam fora: ${skip} (hedge do caixa em BRL do próprio book, não alocação), o que não é `
    + 'mandato do RF (bolsa, commodities) e o que equivale a menos de '
    + `${String(cfg.min_qty_eq).replace('.', ',')} unidade — aí não há boleta a fazer.`);

  const cards = blocos.map(({ b, ativos, moedas }, iB) => {
    const n = ativos.length + moedas.length;
    const liAtivos = ativos.map(x => {
      const dec = (typeof qtyDec === 'function') ? qtyDec(x) : 0;
      /* O rateio por fundo vem do backend e já respeita o MANDATO de cada um (praça do
         juros, câmbio só onde é mandato) — é o número que desce na boleta. Vai no `title`:
         na linha ele dobrava a altura da faixa e não é o que se lê primeiro. */
      const porFundo = (x.fundos || []).filter(f => f.qty_eq != null)
        .map(f => `${fundLabelMesa(f.fund, true)} ${fmtFinalQtyTxt(f.qty_eq, dec)}`).join(' · ');
      /* O #PL dos dois lados no hover: na LINHA fica só o do gestor (foi o que a mesa
         pediu), mas é o par que mostra a régua do bloco valendo — 1:1 no EMota, 1/10 no
         sleeve. E a PROCEDÊNCIA junto, como em toda marcação desta tela. */
      const tipExp = x.pl_mm == null
        ? '\n\nExposição não afirmada: falta o insumo de preço/risco deste instrumento '
          + 'nesta passagem (opção sem delta, título do Tesouro — que precisa do pricer). '
          + 'A quantidade acima é o fato; o calibre não é inventado.'
        : `\n\nExposição — #PL em ${_UNIT_TXT(x.pl_type)}:`
          + `\n  ${b.label}: ${expoTxt(x.pl_mm, x.pl_type)}`
          + `\n  equivalente no RF: ${expoTxt(x.pl_eq, x.pl_type)}`
          + `\n  fonte: ${_SRC_TXT[x.pl_src] ?? x.pl_src ?? '—'} — a MESMA cadeia da coluna #PL da tabela.`;
      const tip = `${x.area ?? '—'}${x.subarea ? ' · ' + x.subarea : ''}`
        + tipExp
        + (porFundo ? `\n\nNo RF: ${porFundo}` : '')
        + (x.estado === 'zerada'
            ? '\n\nA linha EXISTE na tabela acima, zerada — o check da auxiliar já a marca.'
            : '\n\nNão há linha deste ativo no RF: nenhuma coluna de check consegue acusá-lo.');
      return `<li style="margin:1px 0" title="${_escHtml(tip)}"><b>${_escHtml(x.instrument_name ?? '—')}</b>`
        + (x.estado === 'zerada'
            ? ' <span style="font-size:10px;color:var(--text-muted)">zerada</span>' : '')
        + ` <span style="color:var(--text-muted)">—</span> ${_escHtml(b.label)}`
        + ` <b>${fmtFinalQtyTxt(x.qty_mm, dec)}</b>${expo(x.pl_mm, x.pl_type)}`
        + ` <span style="color:var(--text-muted)">→ RF</span> <b>${fmtFinalQtyTxt(x.qty_eq, dec)}</b></li>`;
    }).join('');
    /* ⭐ Na moeda o "quanto é isso de exposição" já existia dos dois lados (`mm_pct` vem do
       agregado por moeda) — só não estava na LINHA. Aqui o % é do NAV do gestor, a mesma
       pergunta que o `#PL` responde nas linhas de juros. */
    const liMoedas = moedas.map(m => `<li style="margin:1px 0" title="${_escHtml(
        `Câmbio LINEAR: o check é por MOEDA, não por vértice.\n\n${b.label}: US$ `
        + `${usd(m.mm_usd)} (${pct2(m.mm_pct)} do NAV dele)\nRF: US$ ${usd(m.rf_usd)}`
        + `\n  alvo: US$ ${usd(m.rf_alvo_usd)} (${pct2(m.rf_alvo_pct)} do NAV do RF)`
        + `\n\nMesma régua da tabela "Exposição por moeda", no fim da aba.`)}">`
      + `<b>${_escHtml(m.ccy)}</b>`
      + ` <span style="font-size:10px;color:var(--text-muted)">moeda</span>`
      + ` <span style="color:var(--text-muted)">—</span> ${_escHtml(b.label)}`
      + ` <b>US$ ${usd(m.mm_usd)}</b>`
      + (m.mm_pct == null ? ''
          : ` <span style="color:var(--text-muted)">(${pct2(m.mm_pct)} do NAV)</span>`)
      + ` <span style="color:var(--text-muted)">→ RF</span> <b>US$ ${usd(m.rf_alvo_usd)}</b></li>`).join('');
    return `<div style="margin-top:${iB ? 8 : 0}px">
      <b style="color:var(--yellow);font-size:13px">⚠ ${_escHtml(b.label)} tem ${n}`
      + ` ${n > 1 ? 'posições' : 'posição'} de ${_escHtml(b.escopo)} que o RF não tem</b>`
      + ` <span style="color:var(--text-muted);cursor:help;font-weight:400" title="${tipBloco(b)}">ⓘ</span>
      <ul style="margin:3px 0 0 18px;padding:0">${liAtivos}${liMoedas}</ul>
    </div>`;
  });

  return `<div class="card" data-html2canvas-ignore="true"
       style="border-left:4px solid var(--yellow);background:color-mix(in srgb, var(--yellow) 7%, var(--bg-card));flex:0 0 auto">
    <div style="font-size:12px;line-height:1.55">${cards.join('')}</div>
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
      <b style="color:var(--red);font-size:15px">⛔ ${erros.length} posição(ões) de DÓLAR NO FUNDO ERRADO</b>
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
/* ── Linha NÃO RATEADA: "só ‹fundo›" × "⛔ ERRO" ─────────────────────────────
   ☠️ **Saíram os rótulos mudos "sleeve" e "offshore"** (05/11/2026, pedido da mesa: *"não
   gosto desse negócio de chamar de sleeve, não entendi o conceito; quando for uma posição só
   do Juros e Moeda, mostra que é isso — que é o caso de commodity metálica e moedas — e caso
   diferente disso, mostre que tem erro"*). Eles diziam de que MECANISMO a linha veio (o
   espelho do trader de MM; o veículo offshore) — vocabulário interno — em vez de responder a
   pergunta da coluna, que é *"a repartição entre os fundos está certa?"*.
   ⭐ **E a resposta é derivável**: o backend carimba `prf_funds_ok` — os fundos que PODERIAM
   carregar aquela linha, pelas MESMAS regras do check de mandato. Se o único que pode é o
   fundo onde ela está, a concentração é a regra sendo cumprida (câmbio e ouro/prata só cabem
   no Juros e Moeda) → **✓ só no JM**. Se os outros também podiam, ela deveria ter
   sido rateada → **⛔ ERRO**.
   ⭐ **O fundo sai em SIGLA** (09/11/2026, pedido da mesa) — `fundSigla`, em pos-format.js.
   A célula dizia `✓ só Juros e Moeda` numa coluna cujas demais células são `✓` ou
   `±0,006%`: 15 caracteres de nome de fundo dentro de uma coluna de veredito, e a coluna
   inteira alargava por causa de duas linhas de câmbio. O nome por extenso continua no
   `title` — abreviar o veredito, nunca a explicação.
   ⚠️ **O "só no" ficou** (mesma conversa, 2ª passada): sem ele a célula vira `✓ JM`, que se
   lê como "o JM está ✓" — mais um fundo aprovado numa linha rateada — em vez de "esta linha
   mora num fundo só, e é o certo". A sigla encurta o NOME; quem carrega o veredito é a
   frase.
   ⚠️ Sem `prf_funds_ok` (payload antigo / snapshot) devolve `null` e o chamador mantém o
   comportamento anterior — melhor um rótulo velho que um veredito inventado. */
function _checkNaoRateada(r, fundosComQtd) {
  const podem = r?.prf_funds_ok;
  if (!Array.isArray(podem) || !podem.length) return null;
  const onde = [...new Set(fundosComQtd.filter(Boolean))];
  if (onde.length !== 1) return null;          // rateada (ou em nenhum): não é este caso
  const lbl = fundLabelMesa(onde[0], true);
  const soEle = podem.length === 1 && podem[0] === onde[0];
  if (soEle) {
    return `<td class="check-cell alloc-ok" title="${_escHtml(
      'SÓ o ' + lbl + ' pode carregar esta linha, e é onde ela está — não há rateio a '
      + 'conferir.' + _AL_NL + _AL_NL
      + 'Pelas regras dos fundos (mandato, praça e, em commodity, o metal), os demais não '
      + 'podem tê-la. É o caso de câmbio e de ouro/prata.')}">✓ só no ${fundSigla(onde[0])}</td>`;
  }
  const outros = podem.filter(f => f !== onde[0]).map(f => fundLabelMesa(f, true));
  return `<td class="check-cell alloc-bad" title="${_escHtml(
    'ERRO — linha concentrada num fundo só, e os outros podiam carregá-la.' + _AL_NL + _AL_NL
    + 'Está 100% no ' + lbl + '. Também poderiam tê-la: ' + outros.join(' · ') + '.' + _AL_NL + _AL_NL
    + 'Linha que cabe em mais de um fundo deveria ser rateada entre eles pelo NAV — '
    + 'concentração aqui não é desvio de proporção, é rateio que não aconteceu.')}">⛔ ERRO</td>`;
}

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
  /* ☠️ **A coluna é do FUNDO-CABEÇA; o `fund_rows` vem pelo VEÍCULO** (05/11/2026, pedido
     da mesa: *"quero ver a qtd em cada um dos fundos mesmo que sejam posições do offshore
     — os 3 de gold que tão no Juros e Moeda devem aparecer, assim como as moedas e as
     opções de moeda"*). O break por fundo chaveia por `fund_label`, e uma posição tomada
     pelo `Segregated Portfolio-N` chega com o nome do VEÍCULO — `byFund['JGP RF Ativa
     Master-A']` dá `undefined` e a linha saía com TRAÇO nas seis colunas, como se o fundo
     não tivesse a posição. Era o caso das opções de ouro e de todo o câmbio offshore.
     ⭐ O de-para sai da PRÓPRIA config (`pnl_fund_tables[].includes`), que é a mesma lista
     que o PnL e o modo "Por fundo" usam — nenhuma constante nova, e um veículo novo entra
     aqui sozinho. Fundo fora da config cai em si mesmo, como antes. */
  const _inclDe = {};
  for (const t of (_tabsCfg ?? [])) _inclDe[t.fund] = t.includes;
  const _labelsDe = fl => _inclDe[fl] ?? [fl];
  const _frSum = (bf, fl, k) => _labelsDe(fl).reduce((a, x) => a + (bf[x]?.[k] ?? 0), 0);
  const _frTem = (bf, fl) => _labelsDe(fl).some(x => bf[x]);
  // Fundo que recebe 100% do dólar (backend: `portfoliorf_offshore_fund`). Sem ele —
  // payload antigo / snapshot estático — o check cai no comportamento anterior.
  const offFund  = (offshoreFund && fundNavs[offshoreFund] != null) ? offshoreFund : null;

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
    /* Fundos que de fato CARREGAM a linha — a entrada do `_checkNaoRateada` nos dois ramos
       de linha não rateada (offshore e dólar).
       ☠️ **É por QUANTIDADE, não por existir linha no break** (09/11/2026). A nota de
       05/11 já dizia "os fundos vêm do que TEM QUANTIDADE", mas o código perguntava
       `byFund[fl]` — a linha EXISTE —, e posição **zerada continua no break** (a mesma
       armadilha do elo da nota de corretagem, em §"A NOTA adianta o futuro"). Resultado:
       linha que esteve em dois fundos e hoje está num só saía de "concentrada" para
       "rateada entre dois" por causa de uma linha de qty 0, perdendo o veredito e caindo
       no rótulo mudo. O `dolarFundoErrado` ao lado já media por quantidade (com eps). */
    const _ondeQtd    = fundLabels.filter(fl => _frSum(byFund, fl, 'final_qty') !== 0);
    const isSleeve    = !!r.is_rf_sleeve;
    const totalQty    = r.final_qty || 0;
    const totalNavSum = fundLabels.reduce((s, fl) => s + (fundNavs[fl] ?? 0), 0);
    const groupPl     = r.pl;
    const fundPlArr   = [];
    // Linha cuja alocação vai 100% para o fundo offshore por desenho (hoje: dólar).
    // O sleeve offshore (`is_offshore`) segue no ramo próprio, sem check.
    const offOnly     = !!r.alloc_offshore_only && !r.is_offshore && !!offFund;
    /* ⛔ Dólar com quantidade em fundo que não opera dólar — ver `dolarFundoErrado` acima.
       ⚠️ O gatilho é `dollar_kind`, com o dólar de CAIXA (`dolar_caixa`) isento — não
       `alloc_offshore_only`; ver a nota de 30/10/2026 em `dolarFundoErros`. Vale para a
       linha `is_offshore` também (cujo veredito, quando não há erro de dólar, é o
       `_checkNaoRateada`) e tem precedência sobre os dois ramos de check: é regra do
       veículo, não rateio. */
    const dolarErro   = (r.dollar_kind && !r.dolar_caixa && offFund)
      ? dolarFundoErrado(byFund, fundLabels, offFund, _labelsDe) : null;
    /* ⛔ Escopo por fundo (backend, `funds.PORTFOLIORF_AREAS_OK`): câmbio no Juros Global,
       bolsa em qualquer um. Vem depois do dólar na precedência porque o backend já tira
       daqui o que a faixa do dólar cobre — as duas nunca falam da mesma linha. */
    const escopoErro  = r.prf_fora_escopo?.length ? r.prf_fora_escopo : null;
    // NAV contra o qual o backend calculou o #PL desta linha (`r.nav`): o consolidado nas
    // linhas rateadas, o NAV do fundo offshore nas de dólar. Usar `totalNavSum` fixo
    // reescalaria o #PL por fundo da linha de dólar (29,5/25,1 ≈ +17%).
    const refNav      = r.nav ?? totalNavSum;

    /* ☠️ Linha do SLEEVE não entra no rateio por NAV entre os fundos-cabeça — ela mora
       100% nos veículos offshore. A quantidade de cada veículo CHEGA às colunas, mas pelo
       de-para `_labelsDe` (ver o ⭐ logo abaixo), não pela fatia de NAV: sem este desvio o
       #PL por fundo sairia do rateio e acusaria um desvio que não existe. O veredito do
       ramo é o `_slvCheck`. */
    if (isSleeve) {
      const dash = '<td class="num" style="color:var(--text-muted)">—</td>';
      const mmRf = lookupMmRf ? lookupMmRf(r) : null;
      /* ⭐ **A QUANTIDADE DE CADA VEÍCULO entra nas colunas por fundo** (04/11/2026, pedido da
         mesa: *"na consolidada deveria ser uma linha só, e aí na tabela auxiliar mostrar a
         qtd em cada um deles"*). A linha principal mostra os 26 contratos somados; é aqui que
         se vê que 20 estão no Juros e Moeda e 6 no Juros Global.
         ⚠️ O `byFund` de uma linha de sleeve é chaveado pelo **VEÍCULO** (`...-N`, `...-I`), não
         pelo fundo-cabeça que titula a coluna — daí o mapa invertido. Sem ele a busca dá
         `undefined` em toda coluna e as células voltam a sair traço, em silêncio.
         ⭐ **E o `Check #PL` passou a ser CALCULADO** (04/11/2026, pedido da mesa: *"agora é
         relevante que não mostre 'sleeve' no caso dos offshore, porque tem mais de um
         offshore — temos que mostrar os valores de fato para checar se está de acordo"*).
         ⭐ **E o check é o MESMO das linhas rateadas, sem exceção nenhuma**, porque o alvo das
         duas pernas é `10% × NAV_fundo ÷ NAV_MM` — ou seja a quantidade de cada veículo é
         **proporcional ao NAV do fundo dele**, que é exatamente a hipótese do rateio. Se as
         pernas estão na proporção, o #PL de cada fundo dá o MESMO número do consolidado, e o
         `max |#PL_fundo − #PL_grupo|` responde "a divisão entre os dois RFs está certa?".
         Aferido em 04/11: 20 no Juros e Moeda dão 2,685 % e 6 no Juros Global dão 2,529 %
         contra 2,647 % consolidados — desvio máximo **0,12pp**, ✓.
         ⚠️ O denominador é a soma dos NAVs dos veículos QUE RECEBEM a linha, não dos três
         fundos: o `Juros Local` não recebe sleeve, e incluí-lo faria toda linha acusar.
         Isso já vem pronto do backend no `r.nav`. */
      const _veicDe = {};
      const sleevePlArr = [];
      // Quebra de linha para o `title` (que não aceita HTML) sem depender de escape.
      const NL = String.fromCharCode(10), NLNL = NL + NL;
      const _plTxt = (v, t) => v == null ? '—'
        : (v * (t === 'pct' ? 100 : 1)).toLocaleString('en-US', {maximumFractionDigits: 2})
          + (t === 'pct' ? '%' : '');
      for (const [veic, dono] of Object.entries(rfCfg?.owner_by_fund ?? {})) _veicDe[dono] = veic;
      /* ⚠️ Mesmo de-para das linhas normais (`_labelsDe`), que soma fundo-cabeça + veículos.
         O mapa `_veicDe` fica só para o `title` dizer em qual veículo a perna foi boletada. */
      const _totSlv = fundLabels.reduce((a, fl) => a + _frSum(byFund, fl, 'final_qty'), 0);
      const sleeveCells = fundLabels.map(fl => {
        if (!_frTem(byFund, fl)) return dash + dash;
        const q    = _frSum(byFund, fl, 'final_qty');
        const navF = fundNavs[fl];
        // Mesma fórmula das linhas rateadas: a fatia da quantidade, reescalada do NAV de
        // referência (aqui a SOMA dos NAVs dos veículos) para o NAV daquele fundo.
        const plF = (r.pl != null && _totSlv !== 0 && navF && refNav)
          ? r.pl * (q / _totSlv) * (refNav / navF) : null;
        sleevePlArr.push({ fl, pl: plF });
        return `<td class="num" title="${_escHtml(
            'Boletado no ' + (_veicDe[fl] ?? fl) + '.')}">${fmtFinalQty(q, qtyDec(r))}</td>`
          + `<td class="num">${plF != null ? fmtPL(plF, r.pl_type) : '<span style=\"color:var(--text-muted)\">—</span>'}</td>`;
      }).join('');
      /* Mesmo veredito das linhas rateadas (ver o ⭐ acima). Só com DUAS pernas ou mais:
         com uma só, `#PL do fundo ≡ #PL do grupo` por construção e o ✓ seria vazio — ali o
         rótulo "sleeve" continua sendo a resposta honesta. */
      const _slvCheck = (sleevePlArr.length > 1 && r.pl != null
                         && sleevePlArr.every(x => x.pl != null))
        ? (() => {
            const dev = Math.max(...sleevePlArr.map(x => Math.abs(x.pl - r.pl)));
            return `<td class="check-cell ${dev < 0.01 ? 'alloc-ok' : allocClass(dev)}" title="${
              _escHtml('Divisão da linha do sleeve entre os veículos de RF.' + NLNL
                + 'O alvo de cada perna é 10% da exposição do MM sobre o NAV DAQUELE fundo, '
                + 'então a quantidade de cada uma é proporcional ao NAV dele — e, estando na '
                + 'proporção, o #PL de cada fundo dá o mesmo do consolidado.' + NLNL
                /* ☠️ `title` NÃO aceita HTML e o `fmtPL` devolve `<span style=…>` — a tag
                   sairia como texto no balão. E o rótulo vem do próprio item: `fundLabels[i]`
                   deslocava o nome, porque fundo sem perna não entra na lista. */
                + sleevePlArr.map(x => '  · ' + shortLabel(x.fl) + ': ' + _plTxt(x.pl, r.pl_type)).join(NL)
                + NL + '  · consolidado: ' + _plTxt(r.pl, r.pl_type)
                + NLNL + 'Desvio máximo ' + (dev * 100).toLocaleString('en-US',
                    {maximumFractionDigits: 2}) + 'pp.')}">${
              dev < 0.01 ? '✓' : '±' + (dev * 100).toLocaleString('en-US',
                  {maximumFractionDigits: 2}) + 'pp'}</td>`;
          })()
        : (_checkNaoRateada(r, (r.rf_sleeve_owner_funds || []))
           /* ⚠️ Sem `prf_funds_ok` (payload antigo) cai no rótulo de antes — mas sem a palavra
              "sleeve", que é vocabulário interno: o que a célula tem a dizer é que uma perna
              só não tem divisão a conferir. */
           ?? `<td style="color:var(--text-muted);text-align:right;font-size:11px" title="${_escHtml(
                'Uma perna só: não há divisão entre fundos a conferir.')}">—</td>`);
      // Mesmo tom da linha na tabela principal: as duas se leem como um par. O dono vai no
      // `title` da linha, não em texto ao lado do nome (a mesa pediu a cor, não o selo).
      return `<tr class="${rowClass} ${areaClass} sleeve-row" title="${_escHtml(
        // ⚠️ A linha pode viver em DOIS veículos (juros espelha nos dois RFs), então o
        // texto nomeia os que ela toca — `rf_sleeve_owner_label` já vem com os dois unidos
        // por ' + ' quando é o caso. O antigo "100% no <veículo>" seria falso aí.
        // ⚠️ O NOME vem primeiro: a coluna Instrumento saiu da auxiliar (05/11/2026) e
        // este `title` é o único lugar onde a linha se identifica quando lida sozinha.
        (r.instrument_name ?? '—') + ' — posição de ' + (r.trader ?? '—')
        + ' (trader de MM) espelhada no '
        + (r.rf_sleeve_owner_label || rfCfg?.nav_fund_label || 'veículo offshore')
        + ((r.rf_sleeve_funds || []).length
            ? ' (' + r.rf_sleeve_funds.join(' · ') + ')' : '')
        + '. A divisão entre os RFs segue o NAV de cada um — é o que a coluna de check mede.'
        )}">
        ${sleeveCells}
        ${_slvCheck}
        ${mirrorCols ? _checkVazio('—', 'Linha de outro trader: o espelho de juros confere o '
            + 'livro do PortfolioRF contra o EMota, e esta linha é do outro trader — o check '
            + 'dela é a coluna ao lado.') : ''}
        ${rfSleeveCols ? rfCheckCell(rfCfg, { mmQty: mmRf?.final_qty ?? null, mmRow: mmRf,
            rfQty: effectiveRowValues(r).final ?? r.final_qty ?? 0,
            /* ⚠️ O alvo vem por ELEGIBILIDADE (`rfLineRow`), igual à aba de quem boleta: a
               linha de JUROS deve espelhar nos DOIS fundos, então o alvo é 4,5% + 1,4%
               mesmo que só uma perna tenha sido boletada — é assim que a perna que falta
               aparece. Usar o alvo dos veículos TOCADOS daria ✓ numa linha pela metade. */
            row: rfLineRow(rfCfg, r, [r]) }) : ''}
      </tr>`;
    }

    /* ⛔ **"% Qtd" e "Check Qtd" saíram** (mesa, 27/10/2026: *"não precisa delas, pelo PL e
       check PL já consigo bater se está ok ou não"*). As duas diziam a MESMA notícia que o
       `#PL`/`Check #PL` ao lado, só na unidade de quantidade — e o rateio por quantidade e o
       por exposição não podem divergir, porque o #PL de cada fundo É derivado da fatia de
       quantidade (`groupPl × fund_qty/totalQty × refNav/navF`, logo abaixo). Duas colunas
       para o mesmo veredito custavam largura numa tabela auxiliar que já é larga. */
    const cells = fundLabels.map(fl => {
      // Soma o fundo-cabeça E os veículos dele (ver `_labelsDe`): posição offshore chega
      // pelo nome do veículo e sairia como traço na coluna do dono.
      const fund_qty = _frSum(byFund, fl, 'final_qty');
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
      /* ☠️ **Era o rótulo mudo "offshore · ‹fundo›"** — dizia de que VEÍCULO a linha veio, que
         é vocabulário interno, em vez de responder se a repartição está certa. Hoje vai pelo
         mesmo veredito das linhas do espelho (ver `_checkNaoRateada`): ✓ quando só aquele
         fundo pode carregar a linha, ⛔ quando os outros podiam e ela não foi rateada. */
      /* ☠️ **Os fundos vêm do que TEM QUANTIDADE, não de `alloc_fund`** (revisão de
         05/11/2026). Passar `[r.alloc_fund || offFund]` dava sempre UM fundo, então o
         `_checkNaoRateada` nunca via uma linha offshore RATEADA entre os dois veículos —
         ela saía ⛔ ERRO mesmo repartida certo. Com os donos reais, linha em mais de um
         fundo cai no check normal (desvio em pp), que é o veredito dela. */
      checkPlCell = _checkNaoRateada(r, _ondeQtd.length ? _ondeQtd : [r.alloc_fund || offFund])
        ?? `<td style="color:var(--text-muted);text-align:right;font-size:11px"${
          r.alloc_fund ? ` title="${_escHtml('100% no ' + fundLabelMesa(r.alloc_fund, true)
            + '. O #PL é calculado sobre o NAV desse fundo, não sobre a soma dos três.')}"` : ''
          }>${r.alloc_fund ? 'só no ' + fundSigla(r.alloc_fund) : '—'}</td>`;
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
      /* ⭐ **MESMO VEREDITO DAS MOEDAS OFFSHORE** (09/11/2026, pedido da mesa: *"e a regra do
         mini dólar? não tá aparecendo só no JM... dos futuros de BRL em geral, grande ou
         mini... deveria ser a mesma lógica das moedas offshore"*). Dólar contra BRL (UC/DOL
         cheio, WDO mini, opção de DOL/USDBRL, NDF) e moeda offshore são a MESMA pergunta —
         *"a linha está no único fundo que pode carregá-la?"* —, e estavam respondendo em
         dois idiomas: a moeda com o veredito por `prf_funds_ok` (`✓ só no JM`) e o dólar com
         um número, por viver num ramo que nasceu antes do `_checkNaoRateada`.
         ☠️ **E o número do dólar não dizia nada: ele só sabia imprimir `✓`.** O ramo mede
         `|#PL(fundo do dólar) − #PL(livro)|`, mas (a) quantidade em QUALQUER outro fundo é
         pega antes pelo `dolarErro`, com precedência, e (b) desde 09/11 o denominador do
         `#PL` é o NAV dos fundos ONDE A QUANTIDADE ESTÁ — ou seja, chegando aqui vale
         `fund_qty == totalQty` e `refNav == navF`, e a conta é `#PL × 1 × 1`, idêntica por
         construção. Um check que não tem como reprovar é um check que não existe.
         ⚠️ A conta FICA como fallback (`??`), para o caso em que o break não fecha com a
         quantidade da linha principal: ali o `±` é o único aviso de que as duas visões
         discordam, e apagá-lo seria esconder inconsistência de dado atrás de um ✓. */
      const _vere = _checkNaoRateada(r, _ondeQtd.length ? _ondeQtd : [_alvoFd]);
      if (_vere) { checkPlCell = _vere; } else {
      const fpOff  = fundPlArr[fundLabels.indexOf(_alvoFd)];
      const devPl  = (groupPl != null && fpOff != null) ? Math.abs(fpOff - groupPl) : null;
      // ⚠️ A cor passou a viver no `<td>` (classe `check-cell …`), não num `<span>` dentro:
      // o fundo tingido é da CÉLULA, e um span colorido por cima dele brigaria com o contraste.
      // Mesma régua do ramo geral e do Check EMota — ver `rfExpoClass`.
      const _dCls = rfExpoClass(devPl, r);
      const _dTol = rfMirrorTol(r);
      const _dUn  = r.pl_type === 'pct' ? '% do NAV' : '% do NAV por 100 bps';
      checkPlCell = devPl == null
        ? `<td class="num" style="color:var(--text-muted);text-align:right" title="Dólar — #PL conferido só em ${
            shortLabel(offFund)}">—</td>`
        : `<td class="check-cell ${_dCls}" title="${_escHtml(
            `DÓLAR — #PL conferido só no ${fundLabelMesa(_alvoFd, true)}: os demais não `
            + `carregam a posição por desenho, e compará-los acusaria a ausência esperada.\n\n`
            + `  ${fundLabelMesa(_alvoFd, true)}: ${_mirrorExpTxt(fpOff, r.pl_type)}\n`
            + `  livro: ${_mirrorExpTxt(groupPl, r.pl_type)}   (${_dUn})\n\n`
            + `Divergência: ${_mirrorDiffTxt(devPl, r.pl_type, true).replace('+', '')}.\n`
            + `Verde até ${_mirrorDiffTxt(_dTol, r.pl_type, true).replace('+', '')}, amarelo até `
            + `${_mirrorDiffTxt(2 * _dTol, r.pl_type, true).replace('+', '')}, vermelho além — `
            + `a MESMA faixa do Check EMota.`)}">${
            _dCls === 'alloc-ok' ? '✓'
              : '±' + _mirrorDiffTxt(devPl, r.pl_type).replace('+', '')}</td>`;
      }
    } else if (groupPl != null && fundPlArr.every(p => p != null)) {
      /* ⭐ **MESMA RÉGUA DO CHECK EMOTA** (09/11/2026) — ver `rfExpoClass` em pos-helpers.js.
         ☠️ Esta coluna vivia em 0,02/0,04 (o `ALLOC_TOL`, que é de outra grandeza: fatia em
         pp) enquanto o EMota mede **diferença de #PL**. Resultado medido em 09/11: o
         `ONE-DAY BANK DEP Jan31` tinha 0,0051 de desvio e saía **amarelo no EMota e verde
         aqui**, células vizinhas, o mesmo número.
         ☠️ **E o sufixo "pp" estava errado em linha de juros seco**: a célula fazia
         `desvio × 100` e escrevia pp — verdade em linha de PRÊMIO (fração do NAV → pontos
         percentuais), falso em PL por 100 bps, que não é fração: 0,0051 saía como
         **±0,51pp**, que não é meio ponto de nada. O `_mirrorDiffTxt` resolve os dois casos
         porque decide o sufixo pelo `pl_type`. */
      const maxDev = Math.max(...fundPlArr.map(fp => Math.abs(fp - groupPl)));
      const _plCls = rfExpoClass(maxDev, r);
      const _tolPl = rfMirrorTol(r);
      const _un    = r.pl_type === 'pct' ? '% do NAV' : '% do NAV por 100 bps';
      /* A célula não tinha TOOLTIP nenhum: imprimia o maior desvio sem dizer de QUAL fundo,
         nem quanto era cada um. Agora lista os três contra o grupo. */
      const _det = fundLabels.map((fl, i) => `  ${fundLabelMesa(fl, true)}: `
        + `${_mirrorExpTxt(fundPlArr[i], r.pl_type)}  `
        + `(${_mirrorDiffTxt(fundPlArr[i] - groupPl, r.pl_type)})`).join('\n');
      const _tip = `RATEIO ENTRE OS FUNDOS — o #PL de cada um contra o do livro `
        + `(${_mirrorExpTxt(groupPl, r.pl_type)}, ${_un}). Linha rateada na proporção dos NAVs `
        + `dá o MESMO #PL nos três, então qualquer diferença é desvio de rateio.\n\n`
        + _det + `\n\nMaior divergência: ${_mirrorDiffTxt(maxDev, r.pl_type, true)}.\n`
        + `Verde até ${_mirrorDiffTxt(_tolPl, r.pl_type, true).replace('+', '')}, amarelo até `
        + `${_mirrorDiffTxt(2 * _tolPl, r.pl_type, true).replace('+', '')}, vermelho além — `
        + `a MESMA faixa do Check EMota, porque é a mesma grandeza.`;
      checkPlCell = `<td class="check-cell ${_plCls}" title="${_escHtml(_tip)}">${
        _plCls === 'alloc-ok' ? '✓'
          : '±' + _mirrorDiffTxt(maxDev, r.pl_type).replace('+', '')}</td>`;
    } else {
      checkPlCell = '<td style="color:var(--text-muted);text-align:right">—</td>';
    }


    /* ⚠️ Sem célula de nome (ver o ⛔ no `<thead>`): o nome vai para o `title` da linha, e o
       marcador de dólar (`offMark`) junto — ele só fazia sentido colado ao nome. */
    return `<tr class="${rowClass} ${areaClass}" title="${_escHtml(
        (r.instrument_name ?? '—') + (offOnly && !r.dolar_caixa
          ? ' · US$ dólar: alocação 100% em ' + shortLabel(r.alloc_fund ?? offFund) : ''))}">
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

  // ⛔ Sem o `1 +` da coluna Instrumento, que saiu em 05/11/2026 (ver o `<thead>`).
  const NC = 2 * fundLabels.length + 1 + (mirrorCols ? 1 : 0) + (rfSleeveCols ? 1 : 0);
  /* ⚰️ **OS DOIS RODAPÉS SAÍRAM (09/11/2026, mesa: *"acho que esses avisos não precisam
     mais né? temos as regras todas embaixo"*).** Eram o do dólar ("alocação vai 100% para
     o Juros e Moeda…") e o do alvo do espelho ("Alvo de hoje por book: 5,9% em juros…"),
     dois parágrafos na largura da auxiliar, todo dia.
     ⭐ **Os dois nasceram ANTES do painel de regras do topo (03/11/2026) e viraram cópia
     dele** — que é exatamente o 2º lugar de onde a regra pode divergir do que o código faz,
     a razão pela qual o painel foi derivado do `funds.PORTFOLIORF_REGRAS` em vez de
     digitado. Conferido texto a texto antes de remover, para não sumir com fato nenhum:
       · dólar → linha "dólar direcional só no Juros e Moeda" do painel, cujo ⓘ (`tipDolar`)
         já traz a frase inteira, **inclusive** a do `#PL` sobre o NAV daquele fundo; e,
         desde 09/11, o veredito `✓ só no JM` na própria célula, com o porquê no `title`;
       · alvo do espelho → coluna "Espelho PAbinader (10,0% da exp.)" do painel, com o alvo
         de CADA fundo na linha dele e o ⓘ (`tipAbi`) dizendo que juros vai aos dois e
         câmbio só ao Juros e Moeda — mais o alvo da LINHA impresso na própria célula de
         `Check Abi` e repetido no `title` dela.
     ⚠️ O `rfTargetNote` FICA: ele ainda é o rodapé da tabela de alocação da aba do
     PAbinader, que não tem painel de regras (lá a frase é a única fonte). */
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
      <!-- ⛔ **A coluna Instrumento SAIU** (05/11/2026, pedido da mesa): ela repetia a 1a
           coluna da tabela principal — e esta auxiliar já está alinhada LINHA A LINHA com
           ela, ou seja o nome ao lado era o MESMO nome da linha da esquerda. E custava:
           nome de instrumento é o conteúdo mais largo da tabela, e numa width:auto a
           coluna nasce do maior conteúdo dela. Com três fundos (6 colunas de número + 3
           checks) isso levava o par de tabelas a não caber na linha, e o flex-wrap descia
           a auxiliar para baixo da principal — justamente o que ela não pode fazer, porque
           fora do lado ela perde a referência de QUAL linha é cada uma.
           O nome continua no title de cada linha, para a auxiliar se ler sozinha quando a
           mesa a copia.
           (Sem crase neste comentário: ele vive dentro de um template literal.) -->
      <tr>${headers}<th rowspan="2">Check #PL</th>${mirrorCols ? mirrorCheckHead(mirrorCfg).replace('<th ', '<th rowspan="2" ') : ''}${rfSleeveCols ? rfCheckHead(rfCfg, true).replace('<th ', '<th rowspan="2" ') : ''}</tr>
      <tr>${subHeaders}</tr>
    </thead>
    <tbody>${rows}${navFootTr}</tbody>
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
