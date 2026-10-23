/* ═══════════════════════════════════════════════════════════════════════════════════════
   SEÇÃO 1 (Posição) do PortfolioRF — VISÃO POR FUNDO (out/2026, pedido da mesa)

   A seção 1 sempre mostrou UMA tabela com os dois fundos somados, e a quebra por fundo
   vivia na tabela AUXILIAR à direita (`renderFundBreakTable`). Os dois fundos passaram a
   operar diferente entre si — que é o mesmo motivo pelo qual a seção 2 (PnL) já tinha
   quebrado em duas tabelas —, então a mesa pediu a mesma leitura aqui: **duas tabelas
   empilhadas, uma por fundo**.

   ⭐ É um MODO, não uma substituição: o botão "Consolidado | Por fundo" no título alterna, e
   a consolidada continua existindo. Ela não é redundante — é nela que mora o Check #PL
   (que compara o #PL de cada fundo com o do grupo, e por definição precisa dos dois lados
   na mesma linha) e é dela que sai a leitura de posição do livro inteiro.

   ⭐ **A config das duas tabelas é a MESMA da seção 2** (`pnl_fund_tables`, que o backend
   serve de `funds.PORTFOLIORF_PNL_TABLES`): mesmo rótulo, mesma ordem, mesmo `includes`.
   Duplicar a definição aqui seria um 2º lugar de onde "quais fundos são" pode divergir da
   aba de PnL — e divergiria calado, porque as duas telas parecem iguais.
   Consequência de graça: o veículo offshore (Segregated Portfolio-N), que é `includes` do
   Offshore, leva junto as linhas do SLEEVE do PAbinader — que é onde elas de fato moram.

   ☠️ **O #PL de um fundo NÃO sai do `fund_rows`** — aquele break não passa pelo
   `compute_pl` do backend (só quantidades). Sai do RATEIO do #PL consolidado, que é a
   MESMA fórmula que a auxiliar já usava em produção:

       pl_fundo = pl_livro × (qtd_fundo / qtd_livro) × (nav_ref / nav_fundo)

   com `nav_ref = r.nav` (o NAV contra o qual o backend calculou o #PL da linha — o
   consolidado nas rateadas, o do fundo offshore nas de dólar). Reimplementar o
   `compute_pl` em JS seria um 2º lugar de onde a definição de #PL pode divergir da aba.

   ── OS CHECKS, E POR QUE CADA UM FICA ONDE FICA ──────────────────────────────────────
   A mesa pediu os checks mantidos "de forma coerente com a visualização". Coerente aqui
   não é "repetir tudo em cada tabela": é pôr cada check no nível em que ele É DEFINIDO.

   • **Check Qtd** (fatia do fundo × fatia do NAV) é POR FUNDO por natureza — ele pergunta
     se aquele fundo carrega a parte dele. Vai em cada tabela, com o desvio daquele fundo.
     Na consolidada ele é o `max` dos dois; aqui cada um aparece inteiro, que é mais fino.
   • **Check EMota** (espelho de juros) é do LIVRO INTEIRO — `funds.py:122`, "quem espelha é
     o livro do PortfolioRF inteiro, não um trader dentro do veículo". A conta é
     `exp_RF/exp_EM = (q_RF/q_EM) × (NAV_EM/NAV_RF)` com q e NAV CONSOLIDADOS. Recalculá-lo
     fundo a fundo mudaria o que ele afirma — nenhum fundo isolado precisa espelhar o EMota
     — e sairia vermelho em livro alinhado. Então ele é avaliado na linha CONSOLIDADA e
     aparece nas duas tabelas com o mesmo veredito, marcado `(livro)` no cabeçalho e dito no
     tooltip de cada célula. Repetido, sim; recalculado, não.
   • **Check Abi** (sleeve de RF) só existe onde o sleeve mora: o veículo offshore. Aparece
     SÓ na tabela que o contém (hoje a Offshore) — na outra ele não ficaria "vazio", ficaria
     errado, porque ali não há sleeve nenhum para conferir.
   ═════════════════════════════════════════════════════════════════════════════════════ */

/* ⭐ **A tela abre no ÚLTIMO modo usado** (23/10/2026, pedido da mesa: "deixa por default o
   último que estava selecionado — se eu tava vendo o por fundo, mantém por fundo até trocar").
   O modo é escolha de leitura, não estado de um dia: quem trabalha expandido não quer reabrir
   no consolidado a cada F5.
   ⚠️ É um FLAG de modo, não uma janela de datas — o alerta do §9 do CLAUDE.md da raiz
   (persistir janela relativa, nunca data absoluta) não se aplica aqui: não há nada que possa
   "envelhecer" dentro de um booleano.
   ⛔ E o default de quem nunca escolheu é o CONSOLIDADO (`!== '1'`), que é a leitura padrão do
   livro e a única com o Check #PL. */
const POS_FUND_SPLIT_KEY = 'pos.fundSplit.portfoliorf';
let posFundSplit = (() => {
  try { return localStorage.getItem(POS_FUND_SPLIT_KEY) === '1'; } catch { return false; }
})();

/* O split só existe onde há as três coisas: break por fundo, NAV por fundo e a config das
   tabelas. Faltando qualquer uma (payload antigo, snapshot estático) a aba segue
   consolidada e o botão nem aparece — em vez de desenhar duas tabelas vazias. */
function fundSplitAvailable(tabId) {
  const d = posDataByTab[tabId];
  return tabId === 'portfoliorf'
      && !!(d?.fund_rows?.length)
      && !!d?.fund_navs
      && Array.isArray(d?.pnl_fund_tables) && d.pnl_fund_tables.length > 0;
}

function fundSplitOn(tabId) { return posFundSplit && fundSplitAvailable(tabId); }

function setFundSplit(on) {
  posFundSplit = !!on;
  // ⚠️ `try` porque `localStorage` ESTOURA em janela anônima / site data bloqueado, e aí a
  // tela tem de seguir funcionando com o modo só na sessão.
  try { localStorage.setItem(POS_FUND_SPLIT_KEY, posFundSplit ? '1' : '0'); } catch {}
  const d = posDataByTab[activeTraderTab];
  if (d?.rows) renderSectionsForTab(activeTraderTab, d.rows);
}

/* Botão de modo. Vive no `.sec-tools` do card (consolidado) ou no título do bloco (split),
   e leva `data-html2canvas-ignore` como o resto das ferramentas: é controle, não dado. */
function fundSplitToggleHtml(tabId) {
  if (!fundSplitAvailable(tabId)) return '';
  const on = fundSplitOn(tabId);
  const tip = on
    ? 'Volta à tabela única com os dois fundos somados e a quebra por fundo na auxiliar à direita. É lá que fica o Check #PL (fundo contra grupo, na mesma linha).'
    : 'Mostra uma tabela por fundo, empilhadas, cada uma com o NAV e o #PL daquele fundo. O Check EMota continua sendo o do livro inteiro (a regra da mesa é sobre o PortfolioRF todo).';
  return `<button class="btn btn-secondary" data-html2canvas-ignore="true"
    style="padding:2px 10px;font-size:12px" onclick="setFundSplit(${on ? 'false' : 'true'})"
    title="${_rfEsc(tip)}">${on ? '▦ Consolidado' : '▤ Por fundo'}</button>`;
}

/* ── A TIRA DE MODO — fora do card, nos DOIS modos (23/10/2026, pedido da mesa) ──────────
   O botão nasceu no `.sec-tools` do card no modo consolidado e numa tira acima dos cards no
   modo por fundo. Alternar fazia ele PULAR de dentro do branco para fora, e voltar — o mesmo
   controle mudando de lugar conforme o estado que ele próprio comanda. Hoje a tira é uma só,
   sempre fora do card, e o botão fica no mesmo x/y nos dois modos.

   ⭐ **O rótulo diz o MODO EM QUE SE ESTÁ, e isso não é decoração:** o botão mostra o modo de
   DESTINO ("▤ Por fundo" quando se está no consolidado), então sozinho ele é ambíguo — lido
   rápido, parece dizer onde você está. Com a tira nomeando o estado atual, os dois juntos se
   leem sem dúvida. */
function fundSplitBarHtml(tabId, label, warnHtml) {
  if (!fundSplitAvailable(tabId)) return '';
  return `<div class="section-title" style="padding:4px 0 8px 0;font-size:12px;display:flex;align-items:baseline;gap:10px;flex-wrap:wrap">
    <span>${label} <span style="font-weight:400;color:var(--text-muted);font-size:11px">— PortfolioRF</span></span>
    ${warnHtml || ''}
    <span style="margin-left:auto">${fundSplitToggleHtml(tabId)}</span>
  </div>`;
}

/* ── Chave do break por fundo ────────────────────────────────────────────────────────
   ⚠️ A MESMA do `renderFundBreakTable` (instrumento+área+subárea+estratégia+vencimento) —
   e NÃO o `rowKey`, que leva group/trader e não existe nas linhas de `fund_rows`. */
function _fsKey(r) {
  return `${r.instrument_reference}||${r.area}||${r.subarea}||${r.strategy}||${r.maturity ?? ''}`;
}

function fundSplitIndex(fundRows) {
  const idx = {};
  for (const fr of (fundRows || [])) (idx[_fsKey(fr)] ??= {})[fr.fund_label] = fr;
  return idx;
}

/* Linhas sintéticas de UM fundo: quantidades somadas dos `includes`, tudo o mais (preço,
   classificação, bbg_data, swap_detail) da linha principal, e o NAV daquele fundo.

   ☠️ **A MARRETA é keyed por `rowKey`, que NÃO tem o fundo** — a mesma linha principal
   gera as duas sintéticas com a mesma chave. Aplicá-la nas duas daria o valor CHEIO em
   cada uma, ou seja o dobro do livro, sem erro nenhum. Então ela é lida UMA vez na linha
   principal (`effectiveRowValues`) e entra aqui pela PROPORÇÃO do fundo; as sintéticas
   saem marcadas com `_fundSplit` e o `effectiveRowValues` as devolve cruas (ver a guarda
   lá). Sem marreta a razão é 1 e o Σ dos fundos bate o consolidado exatamente.
   É a mesma mecânica do `_pnlSynthFundRows` (pnl.js) na seção 2. */
function buildFundSplitRows(mainRows, idx, includes, navFund, totalNavSum) {
  const out = [];
  for (const r of mainRows) {
    const byFund = idx[_fsKey(r)] ?? {};
    let q = 0, oq = 0, tq = 0, bq = 0, sq = 0, bn = 0, sn = 0, gq = 0, hit = false;
    for (const fl of includes) {
      const fr = byFund[fl];
      if (!fr) continue;
      hit = true;
      q  += fr.final_qty        ?? 0;
      oq += fr.opening_qty      ?? 0;
      tq += fr.traded_qty       ?? 0;
      bq += fr.buy_qty          ?? 0;
      sq += fr.sell_qty         ?? 0;
      gq += fr.gross_traded_qty ?? 0;
      bn += (fr.buy_qty  ?? 0) * (fr.avg_buy_price  ?? 0);
      sn += (fr.sell_qty ?? 0) * (fr.avg_sell_price ?? 0);
    }
    if (!hit) continue;

    const eff      = effectiveRowValues(r);          // marreta do livro, lida UMA vez
    const rawTotal = r.final_qty || 0;
    const share    = rawTotal !== 0 ? q / rawTotal : 0;
    // Com marreta de quantidade, a sintética acompanha na proporção do fundo.
    const scale    = (eff.qtyOvr && rawTotal !== 0) ? (eff.final / rawTotal) : 1;

    const refNav   = r.nav ?? totalNavSum;
    const basePlEf = effectiveRowPl(r, eff);
    /* ☠️ **LIVRO ZERADO não é "#PL incalculável" — é ZERO** (23/10/2026, a mesa perguntou pelo
       ⚠ que aparecia no chip DI). O rateio divide por `rawTotal`, então a 1ª versão protegia a
       divisão por zero devolvendo `null`; só que `null` quer dizer "não deu para calcular", e o
       chip NET põe a linha em `missing` e acende o ⚠ ("1 linha(s) sem #PL calculável — FORA
       desta soma"). Medido no Jan28, que a mesa zerou no dia (−705 de abertura, +705 operados):
       os DOIS cards acusavam, e o consolidado — onde o backend devolve `pl: 0.0` — não.
       A soma estava certa nos dois; errado era o aviso, e um ⚠ que acende sem ter o que dizer
       treina a mesa a não ler os que têm.
       ⚠️ **Mas zero no livro não implica zero no FUNDO**: dois fundos podem carregar o mesmo
       vértice em lados opostos e se anular no consolidado. Aí a fração de cada um é 100/0 — aí
       sim é incalculável por rateio, e o ⚠ é o aviso certo. Por isso o zero só vale quando a
       posição DAQUELE fundo também é zero. */
    const plFund   = (basePlEf.pl == null || !navFund || !refNav) ? null
      : rawTotal !== 0 ? basePlEf.pl * share * (refNav / navFund)
      : (q === 0 ? 0 : null);

    out.push({
      ...r,
      _fundSplit:       true,
      _fsShare:         rawTotal !== 0 ? share : null,
      _fsMain:          r,
      nav:              navFund,
      opening_qty:      oq * scale,
      traded_qty:       tq * scale,
      final_qty:        q  * scale,
      buy_qty:          bq * scale,
      sell_qty:         sq * scale,
      gross_traded_qty: gq,
      avg_buy_price:    bq ? bn / bq : null,
      avg_sell_price:   sq ? sn / sq : null,
      usd_dv01:         r.usd_dv01 != null ? r.usd_dv01 * share * scale : null,
      pl:               plFund != null ? plFund * scale : null,
      pl_type:          basePlEf.type ?? r.pl_type,
    });
  }
  return out;
}

/* ── Linha-CABEÇALHO de fundo, dentro da tabela ──────────────────────────────────────
   O bloco de um fundo começa por uma `<tr class="fs-head">` que varre a tabela inteira
   (`colspan`) com rótulo, fundo, NAV (+ a procedência dele) e a tira NET DAQUELE fundo.
   ⭐ A tira NET vive AQUI, e não acima da tabela, porque ela é por denominador: o #PL de uma
   linha de fundo é fração do NAV DAQUELE fundo, e a tira do card continua sendo a do livro
   (ver o ☠️ em `renderFundSplitInline`). */
function _fsHeadHtml(b, data) {
  /* ⚠️ **Só RÓTULO, NAV e os nets** (23/10/2026, pedido da mesa). A linha nasceu repetindo o
     nome do fundo no JRS ("— RF Ativa Master-A"), os veículos agregados ("+ Offshore
     Segregated Portfolio") e a procedência do NAV ("· JDS c/ mov. do dia") — três informações
     que não mudam no dia a dia, numa divisória que aparece duas vezes por tela. O nome do
     fundo e os `includes` estão em `funds.PORTFOLIORF_PNL_TABLES`; a procedência do NAV
     continua declarada na seção de PnL e no painel do sleeve. */
  const navDate = data?.portfoliorf_nav_date ?? data?.nav_date;
  const navStr = b.nav != null
    ? fmtNav(b.nav, navDate, data?.opening_date)   // o ⚠ de NAV de outra data SOBREVIVE: é aviso, não enfeite
    : '<span style="color:var(--red)">⚠ NAV indisponível — #PL em branco</span>';
  return `<span class="fs-head-lbl">${b.t.label}</span>`
    + `<span style="font-weight:400;color:var(--text-muted);margin-left:14px">${navStr}</span>`
    /* ☠️ A classe `net-summary` TEM de vir junto: todo o estilo das pílulas está escopado em
       `.net-summary .net-chip` (positions-v2.css). Com um wrapper próprio, o chip saía como
       TEXTO CORRIDO ("NetDI (0.80)CDS Brazil +0.97") — sem moldura, sem respiro, e sem erro
       nenhum. O `fs-head-net` ao lado só desfaz o que a faixa tem de BLOCO (largura cheia e
       margem embaixo), que aqui viraria uma linha dentro da linha. */
    + `<span class="net-summary fs-head-net">${renderNetSummary(b.vis)}</span>`;
}

/* ── Os BLOCOS: um por fundo, na ordem da config ─────────────────────────────────────
   `vis` é o que de fato vai para a tela (sem as linhas ocultas pelo ✕), e é ele que manda na
   posição das linhas-cabeçalho e nas linhas da auxiliar — as duas tabelas têm de ter a MESMA
   sequência, senão o alinhamento linha a linha se perde.
   Bloco sem linha visível sai fora: um cabeçalho de fundo sozinho não diz nada que o NAV do
   topo já não diga. */
function fundSplitBlocks(data, mainRows) {
  const navs  = data.fund_navs || {};
  const total = Object.values(navs).reduce((a, b) => a + (b ?? 0), 0);
  const idx   = fundSplitIndex(data.fund_rows);
  const hid   = _hiddenForTab(currentRenderTab());
  return (data.pnl_fund_tables || []).map(t => {
    const rows = buildFundSplitRows(mainRows, idx, t.includes, navs[t.fund] ?? null, total);
    return { t, rows, vis: rows.filter(r => !hid.has(rowKey(r))), nav: navs[t.fund] ?? null };
  }).filter(b => b.vis.length);
}

/* ── O MODO, dentro do card do consolidado ───────────────────────────────────────────
   ⭐ **O card não muda** (23/10/2026, pedido da mesa: "fica no mesmo padrão, só expandindo os
   fundos"). O modo nasceu como DOIS cards com moldura própria, e a página mudava de cara ao
   alternar — outra auxiliar, outra largura (1750px → 1275px), o bloco de checks em outro
   lugar. Hoje a moldura é SEMPRE a do consolidado: mesmo card, mesmo título, mesma tabela,
   mesma auxiliar à direita, mesmos ids (`fund_break_*`, e por isso o alinhamento vertical
   continua sendo o mesmo código). Muda só O QUE entra no `tbody` e na auxiliar.

   ⭐ **O render de LINHA é o `renderTable`**, não uma cópia: as linhas sintéticas passam por
   ele como quaisquer outras (preço editável, marreta, ★, tooltip de BBG, ✕ de ocultar). As
   linhas-cabeçalho são INSERIDAS depois, nas posições que os blocos ditam — duplicar as ~100
   linhas de markup de célula seria um 2º lugar de onde a tabela pode divergir de si mesma.

   ☠️ **E a tira NET do card tem de ser APAGADA depois.** O `renderTable` a monta a partir do
   que renderizou — aqui, as linhas sintéticas —, e o #PL de cada uma é fração do NAV DO SEU
   FUNDO: somá-las na mesma tira seria somar frações de denominadores diferentes, a mesma
   armadilha do chip do sleeve. Neste modo o net do livro nem aparece (decisão da mesa): os
   nets que valem são os de cada bloco, na linha-cabeçalho dele. */
function renderFundSplitInline(tabId, s, data, mainRows) {
  const bodyId = sectionBodyId(s);
  const blocos = fundSplitBlocks(data, mainRows);
  renderTable(blocos.flatMap(b => b.rows), bodyId);

  const body = document.getElementById(bodyId);
  if (body && blocos.length) {
    const nCols = body.closest('table')?.querySelector('thead tr')?.childElementCount ?? 13;
    let at = 0;
    for (const b of blocos) {
      const tr = body.insertRow(at);
      tr.className = 'fs-head';
      tr.innerHTML = `<td colspan="${nCols}">${_fsHeadHtml(b, data)}</td>`;
      at += 1 + b.vis.length;
    }
  }
  /* ── Duas coisas que o `renderTable` acabou de derivar das linhas SINTÉTICAS, e que não
        podem ficar como ele as deixou. ──────────────────────────────────────────────── */
  const visLivro = mainRows.filter(r => !_hiddenForTab(currentRenderTab()).has(rowKey(r)));

  /* (1) ⛔ **A tira NET do card SOME neste modo** (23/10/2026, pedido da mesa: "não precisa do
     net geral; mostra só o NAV geral acima, e deixa os nets por fundo nos subtítulos"). Os nets
     que importam aqui são os de cada bloco, que vão na linha-cabeçalho; o do livro repetiria,
     acima, a soma de duas coisas que a tela acabou de separar.
     ⚠️ **Esvaziar é obrigatório, não cosmético**: o `renderTable` já escreveu ali a soma das
     linhas SINTÉTICAS, e o #PL de cada uma é fração do NAV DO SEU FUNDO — somá-las é somar
     frações de denominadores diferentes, a mesma armadilha do chip do sleeve. Deixar como
     estava publicaria um número errado; o `.net-summary:empty { display:none }` tira a faixa
     inteira, sem deixar vão. */
  const netEl = document.getElementById(bodyId.replace(/^body_/, 'netsum_'));
  if (netEl) netEl.innerHTML = '';

  /* (2) ☠️ **"✕ Ocultar zeradas" é sobre a linha do LIVRO, não sobre a fatia de um fundo.**
     O `syncHideZeroBtn` recebe as linhas que foram pintadas, e aqui há uma cópia por fundo:
     bastava a linha ser zero em UM deles para a chave entrar na lista — e como o conjunto de
     ocultas é keyed por `rowKey` (que não tem o fundo), ocultá-la some com ela nos DOIS
     blocos. Medido em 23/10/2026: o Jan31 está **−71 no Offshore** e zerado no Institucional,
     e o botão o levava junto; no consolidado, onde o total é −71, ele fica. Dois modos
     respondendo diferente à MESMA tecla. */
  if (typeof syncHideZeroBtn === 'function') syncHideZeroBtn(bodyId, visLivro);
  return blocos;
}

/* ── A auxiliar do modo expandido ────────────────────────────────────────────────────
   Mesma moldura da auxiliar do consolidado — começa pelo **Instrumento** e termina nos
   checks —, com uma linha-espaçador `fs-head` para cada cabeçalho de fundo, na mesma
   posição. É isso que mantém as duas tabelas lado a lado, linha a linha, sem JS de medição
   por linha (só a altura das linhas-cabeçalho é igualada; ver `_alignAuxTables`).

   ⛔ **O `Check #PL` não vem para cá** (e não é esquecimento): ele compara o #PL de um fundo
   com o do grupo **na mesma linha**, e aqui os dois lados estão em blocos diferentes. O
   `% do livro` ocupa o lugar dele e responde a pergunta que este modo faz — quanto desta
   linha do livro está neste fundo. */
function renderFundSplitAuxInline(data, blocos, rfCfg, mirrorCfg) {
  if (!blocos?.length) return '';
  const navs   = data.fund_navs || {};
  const total  = Object.values(navs).reduce((a, b) => a + (b ?? 0), 0);
  const offFd  = (data.portfoliorf_offshore_fund && navs[data.portfoliorf_offshore_fund] != null)
    ? data.portfoliorf_offshore_fund : null;
  const sleeveCols = !!rfCfg?.mm_rows?.length
    && blocos.some(b => b.vis.some(r => r.is_rf_sleeve));
  const lookupMmRf = sleeveCols ? makeMirrorLookup(rfCfg.mm_rows) : null;
  const mirrorCols = !!mirrorCfg;
  const NC = 3 + (mirrorCols ? 1 : 0) + (sleeveCols ? 1 : 0);

  const corpo = blocos.map(b => {
    const navShare = (b.nav && total) ? (b.nav / total) : null;
    const holdsOff = !!offFd && b.t.includes.includes(offFd);
    let prevArea = null, prevSubarea = null, subareaIdx = -1;

    const linhas = b.vis.map((r, i) => {
      const newArea    = r.area    !== prevArea;
      const newSubarea = r.subarea !== prevSubarea;
      if (newSubarea) subareaIdx++;
      const rowClass  = subareaIdx % 2 === 0 ? 'group-odd' : 'group-even';
      const areaClass = newArea && i > 0 ? 'area-divider' : '';
      prevArea = r.area; prevSubarea = r.subarea;

      const main  = r._fsMain;
      const share = r._fsShare;

      /* ☠️ `_semZeroNegativo`: em JS `0 / -945` é **−0**, e `fmtPct` imprimiria "-0.0%" — que
         num livro de posição se lê como VENDIDO. Medido: o Jan31, 100% no Offshore, dava
         share −0,0000 no Institucional. Mesma armadilha do check do sleeve. */
      const shareCell = `<td class="num" title="${_rfEsc(
        'Fatia desta linha do livro que está no ' + b.t.label + '.')}">${
        share != null ? fmtPct(_semZeroNegativo(share)) : '<span style="color:var(--text-muted)">—</span>'}</td>`;

      /* ── Check Qtd: fatia da posição × fatia do NAV ────────────────────────────────
         ☠️ **COM SINAL, e isso é o que faz a coluna dizer algo por fundo** (23/10/2026, a
         mesa: "os checks no por fundo não fazem sentido, estão dando a mesma coisa"). Com
         DOIS fundos os desvios são espelhos um do outro por aritmética — se o Offshore tem
         5,9pp a MAIS da linha do que do NAV, o Institucional tem 5,9pp a MENOS —, então em
         módulo os dois blocos imprimiam o MESMO número e a coluna parecia estar medindo o
         consolidado. O sinal separa os dois e diz quem está carregando demais: medido no
         Jan31, **+26,2pp no Offshore** (100% da linha, 73,8% do NAV) contra **−26,2pp no
         Institucional** (0% da linha, 26,2% do NAV). */
      const _pp = d => `${d >= 0 ? '+' : '−'}${Math.abs(d * 100).toLocaleString('en-US', {maximumFractionDigits:1})}pp`;
      let qtyCheck;
      if (r.is_rf_sleeve) {
        qtyCheck = _checkVazio('sleeve', 'Linha do sleeve de RF: mora 100% no '
          + (rfCfg?.fund ?? 'veículo offshore') + ', não entra no rateio por NAV entre os Masters.');
      } else if (r.is_offshore) {
        qtyCheck = _checkVazio('offshore', 'Posição do veículo offshore — não é rateada entre os Masters.');
      } else if (main?.alloc_offshore_only && offFd) {
        // Dólar: alvo 100% no fundo offshore — neste bloco o alvo é 1 se ele o contém, 0 se não.
        const alvo = holdsOff ? 1 : 0;
        const dev  = share != null ? share - alvo : null;
        qtyCheck = _checkCell(
          dev == null ? '—' : Math.abs(dev) < 0.01 ? '✓' : _pp(dev),
          dev,
          `Dólar — alvo ${alvo === 1 ? '100%' : '0%'} neste bloco (a posição vai inteira para o fundo offshore), não o rateio por NAV.`
          + (dev != null && Math.abs(dev) >= 0.01
              ? `
Este fundo está com ${_pp(dev)} ${dev > 0 ? 'a MAIS' : 'a MENOS'} do que deveria.` : ''));
      } else {
        const dev = (share != null && navShare != null) ? share - navShare : null;
        qtyCheck = _checkCell(
          dev == null ? '—' : Math.abs(dev) < 0.01 ? '✓' : _pp(dev),
          dev,
          navShare != null
            ? `Fatia da posição neste fundo (${share != null ? fmtPct(share) : '—'}) contra a fatia do `
              + `NAV dele (${fmtPct(navShare)}).`
              + (dev != null && Math.abs(dev) >= 0.01
                  ? `

${_pp(dev)}: este fundo carrega ${dev > 0 ? 'MAIS' : 'MENOS'} desta linha do `
                    + `que o tamanho dele no livro pede — e o outro, na mesma medida ao contrário.`
                  : '')
            : 'Sem o NAV dos dois fundos não dá para conferir o rateio.');
      }

      /* ── Check EMota: DE CADA FUNDO (23/10/2026, decisão da mesa) ───────────────────
         O veredito era o do LIVRO INTEIRO, avaliado na linha consolidada e repetido igual nos
         dois blocos — e foi exatamente isso que a mesa estranhou ("os checks no por fundo não
         fazem sentido, estão dando a mesma coisa, parece que o check tá sendo feito pelo
         consolidado"). Hoje vai a linha SINTÉTICA: o `rfMirrorEval` lê `row.nav` e
         `row.final_qty`, que nela são os DAQUELE fundo, então a razão passa a ser
         `%NAV do fundo ÷ %NAV do EMota`. Mesma conta, outro denominador.
         ⚠️ **O que isso afirma é mais exigente**, e é bom saber por quê: nenhum fundo isolado
         "precisa" espelhar o EMota — o que a mesa espelha é o livro. Então a coluna fica
         vermelha sempre que o RATEIO entre os fundos desviar, dizendo em exposição o que o
         `Check Qtd` ao lado já diz em pp de quantidade. Os dois são a mesma notícia em
         unidades diferentes; o veredito do livro continua na aba consolidada. */
      let mirrorCell = '';
      if (mirrorCols) {
        mirrorCell = r.is_rf_sleeve
          ? _checkVazio('—', 'Linha do sleeve de RF: o espelho de juros confere o livro do '
              + 'PortfolioRF contra o EMota, e esta linha é do outro trader — o check dela é a '
              + 'coluna ao lado.')
          : mirrorCheckCell(r, mirrorCfg, b.t.label);
      }

      // ── Check Abi: a linha do sleeve, onde ela estiver ────────────────────────────
      let sleeveCell = '';
      if (sleeveCols) {
        const mmRf = (lookupMmRf && main) ? lookupMmRf(main) : null;
        sleeveCell = r.is_rf_sleeve
          ? rfCheckCell(rfCfg, { mmQty: mmRf?.final_qty ?? null, rfQty: r.final_qty ?? 0, row: r })
          : _checkVazio();
      }

      return `<tr class="${rowClass} ${areaClass}${r.is_rf_sleeve ? ' sleeve-row' : ''}">
        <td>${r.instrument_name ?? '—'}</td>${shareCell}${qtyCheck}${mirrorCell}${sleeveCell}</tr>`;
    }).join('');

    /* Espaçador do cabeçalho do fundo. Leva o rótulo (e não fica em branco) porque a auxiliar
       tem de se ler sozinha — é ela que a mesa copia para conferir. A ALTURA é igualada à da
       linha-cabeçalho da principal no `_alignAuxTables`: esta aqui não tem a tira NET e sairia
       mais baixa, desalinhando tudo o que vem abaixo. */
    return `<tr class="fs-head"><td colspan="${NC}">`
      + `<span class="fs-head-lbl">${b.t.label}</span></td></tr>${linhas}`;
  }).join('');

  return `<table class="data-table alloc-table" style="white-space:nowrap;width:auto">
    <thead><tr>
      <th>Instrumento</th>
      <th title="${_rfEsc('Quanto desta linha do livro está neste fundo.')}">% do<br>livro</th>
      <th title="${_rfEsc('A fatia da posição neste fundo bate com a fatia do NAV dele?')}">Check<br>Qtd</th>
      ${mirrorCols ? mirrorCheckHead(mirrorCfg,
          'NO MODO "POR FUNDO" o veredito é DE CADA FUNDO: a exposição daquele bloco, em % do '
          + 'NAV dele, contra a do EMota em % do NAV dele. ⚠️ Mais exigente que o do livro — '
          + 'nenhum fundo isolado precisa espelhar o EMota, então ele acusa também o desvio de '
          + 'RATEIO entre os dois fundos, que é o que o Check Qtd ao lado mede em pp. O '
          + 'veredito do LIVRO está na aba consolidada.') : ''}
      ${sleeveCols ? rfCheckHead(rfCfg, true) : ''}
    </tr></thead>
    <tbody>${corpo}</tbody>
  </table>`;
}

/* Aviso de linha que não entra em bloco nenhum — some da tela sem o aviso, e é assim que se
   descobre chave que deixou de casar com o break por fundo. Mesmo alerta da seção 2. */
function fundSplitWarnHtml(tabId, s, data) {
  if (!fundSplitOn(tabId)) return '';
  const idx  = fundSplitIndex(data.fund_rows);
  const rows = sortRows(sectionRowsFor(tabId, s, tabDisplayRows(tabId)));
  const orph = rows.filter(r => !r.is_simulated && !idx[_fsKey(r)]);
  const sim  = rows.filter(r => r.is_simulated);
  return [
    orph.length ? `<span style="color:var(--yellow);font-size:11px" title="${_rfEsc(
      [...new Set(orph.map(r => r.instrument_name))].join(', '))}">⚠ ${orph.length} posição(ões) sem break por fundo — fora dos blocos</span>` : '',
    sim.length ? `<span style="color:var(--yellow);font-size:11px" title="Linha hipotética, sem fundo — só aparece no modo Consolidado">⚡ ${sim.length} linha(s) simulada(s) fora do split</span>` : '',
  ].filter(Boolean).join('');
}
