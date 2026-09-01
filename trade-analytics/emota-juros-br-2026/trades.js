/* =====================================================================
   trades.js — tela 2: TRADE A TRADE e POR BOLETA.
   Lê window.TA (data.js). Usa a camada-casa de gráficos (shared-web/plotly-jgp.js).

   Os dois níveis desta tela:
     · ciclo     — um trade = de zero a zero. Clicar abre o blotter DIÁRIO do
                   ciclo, que é onde se vê o "traded around the position".
     · execução  — boleta com o split entre fundos colapsado (MÉDIA de 4,01
                   fundos por execução; mediana 4,00 — as duas coincidem aqui,
                   mas o texto dizia "mediana" servindo a média). A coluna
                   `fundos` deixa o split visível.
   ===================================================================== */
(function () {
  /* ⚠️ `let`, nao `const`: os dados chegam pelo callback `window.__taData`,
     que o arquivo do par (trader, grupo) invoca. Ver `ta-sel.js`. */
  let TA = null, TR = null, EX = null, BL = null;
  const drawn = {};
  /* ⚠️ `telaVazia()` SUBSTITUI o conteúdo dos painéis pelo aviso. Depois
     disso `el('kpisGeral')` e cia. não existem mais, e qualquer render
     estoura com "Cannot set properties of null". Este flag corta o
     render na porta — clicar numa aba não pode reanimar o desenho sobre
     um DOM que foi apagado de propósito. */
  let VAZIO = false;

  const nf = (v, d = 1) =>
    v == null || !isFinite(v)
      ? '—'
      : (+v).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
  const brl = (v, d = 0) =>
    v == null || !isFinite(v)
      ? '—'
      : (v < 0 ? '−' : '') + 'R$ ' + Math.abs(v).toLocaleString('pt-BR',
          { minimumFractionDigits: d, maximumFractionDigits: d });
  const kbrl = (v) =>
    v == null || !isFinite(v) ? '—'
      : Math.abs(v) >= 1000 ? (v < 0 ? '−' : '') + 'R$ ' + nf(Math.abs(v) / 1000, 1) + ' mil'
      : brl(v);
  const pct = (v, d = 1) => (v == null || !isFinite(v) ? '—' : nf(v * 100, d) + '%');
  const bps = (v, d = 1) => (v == null || !isFinite(v) ? '—' : nf(v, d) + ' bps');
  const sgn = (v) => (v == null || !isFinite(v) ? '' : v < 0 ? ' neg' : '');
  const dt = (s) => (s ? s.slice(8, 10) + '/' + s.slice(5, 7) : '—');
  const el = (id) => document.getElementById(id);

  /* ⭐ ZERO ALINHADO NOS DOIS EIXOS — gêmeo do helper do `app.js` (01/09/2026).
     ☠️ Aqui a falha era pior que lá: no `figDrillPnl` as DUAS escalas estão em
     **R$**, e o zero de cada uma caía numa altura diferente. Barra de fluxo
     negativa aparecia acima da linha de acumulado positiva.
     ⚠️ Duplicado de propósito — as duas telas são IIFEs independentes, como já
     acontece com `table()` e `par()` (§5.-41). */
  function zeroAlinhado(...series) {
    const ext = series.map((v) => {
      let lo = 0, hi = 0;
      (v || []).forEach((x) => {
        const n = +x;
        if (x == null || !isFinite(n)) return;
        if (n < lo) lo = n;
        if (n > hi) hi = n;
      });
      return [lo, hi];
    });
    let f = 0;
    ext.forEach(([lo, hi]) => { if (hi > lo) f = Math.max(f, -lo / (hi - lo)); });
    f = Math.min(f, 0.9);
    const FOLGA = 1.06;
    return ext.map(([lo, hi]) => {
      if (f <= 0) return [0, (hi || 1) * FOLGA];
      const alto = Math.max(hi, (-lo * (1 - f)) / f) * FOLGA;
      return [(-f * alto) / (1 - f), alto];
    });
  }
  const P = () => PALETTE_JGP();

  /* preço: no DI é TAXA (3 casas); na opção é PRÊMIO em pontos; no título é PU */
  const preco = (r, v) => {
    if (v == null || !isFinite(v)) return '—';
    if (r.book === 'di') return nf(v, 3) + '%';
    if (r.book === 'titulo') return nf(v, 2);
    return nf(v, 2);
  };
  const rotBook = { di: 'DI', opcao: 'opção', titulo: 'NTN-B' };

  function kpi(k, v, d, cls) {
    return `<div class="kpi"><div class="k">${k}</div><div class="v${cls || ''}">${v}</div>` +
      (d ? `<div class="d">${d}</div>` : '') + '</div>';
  }
  /* Glossario desta tela. Mesma ideia do `GLOSS` do app.js (e mesma razao para
     `title` nativo: as tabelas rolam dentro de `.wrap{overflow-x:auto}` e um
     balao em CSS seria cortado nas ultimas colunas). Aqui as linhas sao UM
     trade, entao os termos mudam: nao ha media nem mediana. */
  /* ⭐ `CPMHV84` nao diz nada; `Digital Copom No Cut 260318` diz (pedido do
     usuario, 01/09/2026). O nome vai ENTRE PARENTESES ao lado do codigo — sem
     coluna nova, que foi a restricao pedida.
     ⚠️ So sai quando ACRESCENTA: a estrutura de IDI ja tem `ativo` descritivo
     (`IDIX9 07/26 P CONDOR 515200/...`) e ali `ativo_nome` vem null de
     proposito, senao a celula repetiria a mesma informacao duas vezes. */
  const comNome = (r, base) => (base || '')
    + (r && r.ativo_nome ? ' <span class="mdn">(' + r.ativo_nome + ')</span>' : '');

  const GLOSS = {
    result_bruto: 'No futuro de DI, a soma dos AJUSTES DIARIOS DA B3 do ciclo — o '
      + 'dinheiro que de fato entrou e saiu da conta do fundo. Nos demais ativos, o '
      + 'movimento de preco + cupom. Ainda SEM corretagem e SEM carrego do caixa. '
      + 'A coluna "so a taxa" ao lado mostra a mesma aposta com o prazo congelado: '
      + 'a diferenca entre as duas e o custo de carregar a posicao contra o CDI, e '
      + 'num daytrade ela e zero.',
    trade_id: 'Numero do CICLO, na ordem de abertura. Um ciclo e de zero a zero: '
      + 'abre, aumenta, reduz e zera = UM trade, mesmo com dezenas de boletas.',
    direcao: 'APLICADO = apostou em QUEDA de juros. TOMADO = apostou em ALTA. '
      + 'Atencao: na boleta do Sophis quantidade > 0 e APLICADO, o oposto do '
      + 'sinal do JRS.',
    pl: '#PL = DV01 x 1e4 / NAV, ou "% do patrimonio por 100 bp de taxa". Medido '
      + 'no PICO da posicao do ciclo, com o NAV do dia daquele pico.',
    dv01: 'Quanto o ciclo ganhava ou perdia, em R$, por 1 bp de taxa — no pico da '
      + 'posicao. Usa a taxa e o "du" reais daquele dia.',
    bps_taxa: 'Quanto a taxa andou A FAVOR dele, em bps, entre o preco medio de '
      + 'entrada e o de saida (VWAP contra VWAP, ponderado por contratos). E o '
      + 'retorno da aposta, independente do tamanho.',
    bps_nav: 'Contribuicao do ciclo para o fundo, em bps do NAV (1 bp = 0,01%), '
      + 'ja liquida de custo e usando o NAV de cada dia.',
    cupom: 'Cupom (ou dividendo) recebido enquanto a posicao estava viva. E dinheiro '
      + 'de verdade e entra no resultado do ciclo: na NTN-B ele pode ser varias '
      + 'vezes o movimento de preco.',
    carrego: 'Custo de oportunidade do CAIXA que o ativo consumiu, cobrado dia a dia '
      + 'no CDI, do value date da compra ao da venda (exclusive). E PARTE DO '
      + 'RESULTADO: um papel a vista pode ganhar no preco e perder no carrego. '
      + 'Futuro de DI nao paga — e margem, nao desembolso.',
    custo: 'Corretagem + emolumento da B3 + contraparte, somados das boletas do '
      + 'proprio ciclo. Vem da boleta do Sophis, nao e rateio.',
    result_taxa: 'So o movimento da TAXA, sem custo e sem carrego: o "du" fica '
      + 'congelado na abertura do ciclo de proposito, para separar a APOSTA do '
      + 'financiamento.',
    dias: 'Dias CORRIDOS entre a abertura e o fechamento do ciclo. 1 dia = '
      + 'daytrade.',
    pico_ct: 'A maior posicao que o ciclo teve, em contratos, medida no '
      + 'fechamento do dia.',
    giro_ct: 'Contratos negociados no ciclo, somando ida e volta. Maior que o '
      + 'pico quando ele negociou EM VOLTA da posicao.',
    resultado_liq: 'O que sobrou do ciclo DEPOIS de corretagem, emolumento e '
      + 'contraparte. E o numero que vale — as colunas de bruto e custo ao lado '
      + 'mostram a conta.',
    tam_rel: 'O #PL de pico deste ciclo dividido pelo #PL MEDIANO do livro dele. '
      + '1,0 = aposta do tamanho habitual; 3,0 = apostou 3x o normal. E a regua '
      + 'boa para "ele aposta mais quando esta certo?", porque nao depende de '
      + 'alocacao — o NAV muda por decisao da casa.',
    exec: 'Quantas EXECUCOES o ciclo teve: boletas ja com o split entre fundos '
      + 'colapsado. E o numero de negocios de verdade.',
    dias_op: 'Em quantos PREGOES ele mexeu na posicao. Menor que a duracao quando '
      + 'ele abriu, ficou parado e depois zerou.',
    dv01_ct: 'DV01 de UM contrato, em R$ por bp. Multiplicado pela quantidade da '
      + 'do o DV01 da posicao. Varia por vencimento e cai ao longo do ano.',
    caixa: 'O fluxo de caixa da execucao em R$, ja convertido de taxa para PU com '
      + 'o "du" congelado do ciclo. E a soma dele que da o resultado bruto.',
    preco: 'O preco negociado. Em futuro de DI e a TAXA em % ao ano; na NTN-B e o '
      + 'PU em R$; na opcao, o premio em pontos.',
    du_exec: 'Dias uteis ate o vencimento na data da execucao (base 252).',
    linhas: 'Quantas linhas de boleta foram colapsadas nesta execucao — uma por '
      + 'fundo do rateio.',
    lado: 'O lado da boleta como o Sophis registra. Em futuro de DI, COMPRA e '
      + 'aplicado (ganha com queda de juros).',
    fundos: 'Em quantos fundos a mesma execucao foi partida. Mediana de 4 — por '
      + 'isso a tabela mostra EXECUCOES, nao linhas de boleta.',
    papel: 'trade = negocio de mercado. cancelamento = grupo que neta a zero no '
      + 'mesmo preco e dia. abertura = boleta de virada de ano, a preco 0.',
  };
  const _esc = (t) => t.replace(/"/g, '&quot;');

  /* ⭐ ORDENACAO POR COLUNA, em TODA tabela (01/09/2026, pedido do usuario).
     Clicar no cabecalho ordena; clicar de novo inverte. Numero comeca do MAIOR
     para o menor (que e o que se quer ver primeiro num ranking); texto comeca em
     A-Z.
     ☠️ **A chave sai da celula RENDERIZADA, nao do campo cru** — e isso e uma
     escolha, nao preguica: quase toda coluna aqui e computada (`par()`,
     `terno()`, `comNome()`, o seletor de regua), entao nao existe um `r[k]`
     unico que corresponda ao que esta na tela. Ordenar por um campo que a
     celula nao mostra e pior que nao ordenar: o leitor ve a tabela se mexer sem
     seguir a coluna que ele clicou.
     ⚠️ Numero em pt-BR com sufixo de escala: `1.234,5`, `−R$ 2,3 mil`,
     `12,4 bps`, `5,7 pt`, `50,0%`. O `mil`/`MM`/`bi` TEM de ser aplicado, senao
     `R$ 900` ordena acima de `R$ 2,3 mil`.
     ⚠️ Celula sem valor (`—`) vai SEMPRE para o fim, nos dois sentidos: ela nao
     e "o menor", e sim "nao se aplica". */
  const ORD = {};
  const _semTag = (h) => String(h == null ? '' : h).replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  function _numBR(h) {
    const s0 = _semTag(h).replace(/\u2212/g, '-');
    const m = s0.match(/\d[\d.]*(?:,\d+)?/);
    if (!m) return null;
    let v = parseFloat(m[0].replace(/\./g, '').replace(',', '.'));
    if (!isFinite(v)) return null;
    /* ☠️ O SINAL NAO ENCOSTA NO NUMERO em `−R$ 3.156,0 mil` — tem o `R$ ` no
       meio. Um `-?\d` na frente do numero simplesmente nao casa o menos, e o
       valor entrava POSITIVO: medido, `−R$ 3.156,0 mil` aparecia em 2o lugar
       num ranking descendente, entre 7.289 e 1.712. O sinal se procura no que
       vem ANTES do primeiro digito. */
    if (/-/.test(s0.slice(0, m.index))) v = -v;
    if (/\bmil\b/i.test(s0)) v *= 1e3;
    else if (/\b(MM|mi)\b/i.test(s0)) v *= 1e6;
    else if (/\bbi\b/i.test(s0)) v *= 1e9;
    return v;
  }
  function _ordena(id, cols, rows) {
    const o = ORD[id];
    if (!o || !cols[o.i]) return rows;
    const c = cols[o.i];
    const bruto = (r) => (c.f ? c.f(r) : r[c.k]);
    const chave = c.num ? ((r) => _numBR(bruto(r)))
                        : ((r) => { const t = _semTag(bruto(r)).toLowerCase();
                                    return (t && t !== '—' && t !== '-') ? t : null; });
    return rows.slice().sort((a, b) => {
      const x = chave(a), y = chave(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;            // vazio sempre no fim
      if (y == null) return -1;
      return x === y ? 0 : (x > y ? 1 : -1) * o.d;
    });
  }
  function _thOrd(id, cols, i, dentro) {
    const o = ORD[id];
    const at = o && o.i === i;
    const seta = at ? (o.d > 0 ? ' ▲' : ' ▼') : '';
    return '<span class="ordth" data-ord="' + i + '">' + dentro
      + '<i class="ordseta">' + seta + '</i></span>';
  }
  function _ligaOrd(elm, cols, rows, redesenha) {
    elm.querySelectorAll('th .ordth').forEach((sp) => {
      sp.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const i = +sp.dataset.ord;
        const o = ORD[elm.id];
        /* numero comeca DESCENDENTE (ranking); texto, ascendente (A-Z) */
        ORD[elm.id] = (o && o.i === i) ? { i, d: -o.d }
                                       : { i, d: cols[i].num ? -1 : 1 };
        redesenha();
      });
    });
  }

  function table(elm, cols, rows, onRow) {
    if (!elm) return;
    const th = cols.map((c, i) => {
      const g = c.tip && GLOSS[c.tip];
      const dentro = g ? '<span class="hastip">' + c.t + '</span>' : c.t;
      return '<th' + (c.num ? ' class="num"' : '') + (g ? ' title="' + _esc(g) + '"' : '') + '>'
        + _thOrd(elm.id, cols, i, dentro) + '</th>';
    }).join('');
    /* ⚠️ O clique de LINHA indexa o array ORDENADO, nao o original — senao
       ordenar a tabela abriria o detalhe de outro trade. */
    const ord = _ordena(elm.id, cols, rows);
    const tb = ord.map((r, i) =>
      `<tr${onRow ? ' class="clickable" data-i="' + i + '"' : ''}>` +
      cols.map((c) => {
        const v = c.f ? c.f(r) : r[c.k];
        return `<td class="${c.num ? 'num' : 'lbl'}${c.cls ? ' ' + c.cls(r) : ''}">${v}</td>`;
      }).join('') + '</tr>').join('');
    elm.innerHTML = `<thead><tr>${th}</tr></thead><tbody>${tb}</tbody>`;
    if (onRow) {
      elm.querySelectorAll('tr.clickable').forEach((tr) =>
        tr.addEventListener('click', () => onRow(ord[+tr.dataset.i], tr)));
    }
    _ligaOrd(elm, cols, rows, () => table(elm, cols, rows, onRow));
  }

  /* ── cabeçalho, preenchido quando os dados chegam ──────────────────── */
  function cabecalho() {
    const t = el('pgTitulo');
    if (t) {
      t.textContent = TA.trader + ' — ' + (TA.grupo_rotulo || TA.grupo)
        + ' · trade a trade';
    }
    /* ☠️ **A DATA QUE A TELA MOSTRA E A DO DADO, NAO A DA GERACAO** (01/09/2026,
       reportado pelo usuario: "o atualizado na tela esta falando que foi
       atualizado hoje, mas nao parece ser verdade, esta ate o dia 28 agosto").
       `gerado_em` e quando o script rodou e nao tem relacao com ate quando o
       dado vai — rodar o gerador num domingo carimbava "atualizado" com a data
       do domingo sobre uma base que parava na sexta.
       ⚠️ O `title` abre POR FONTE, porque elas nao andam juntas: o ajuste da B3
       sai no fim do dia, a boleta entra no dia seguinte, o preco do gerencial
       tem ritmo proprio. Quando a tela parecer atrasada, e ali que se ve qual
       fonte segurou. */
    const _br = (iso) => (iso && iso.length === 10
      ? iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4) : (iso || '—'));
    const mb = el('mtBase');
    if (mb) {
      mb.textContent = _br(TA.dados_ate);
      const F = TA.fontes_ate || {};
      const det = Object.keys(F).map((k) => k + ': ' + _br(F[k])).join(' · ');
      mb.title = 'Último pregão que entrou na conta. Por fonte — ' + det
        + '. (relatório gerado em ' + _br(TA.gerado_em) + ')';
      /* ⚠️ AVISA quando alguma fonte esta ATRAS do corte: nao e erro, e ritmo
         diferente — mas o leitor tem de poder ver, em vez de descobrir por um
         numero que nao fecha. */
      const atras = Object.keys(F).filter((k) => F[k] && TA.dados_ate && F[k] < TA.dados_ate);
      if (atras.length) mb.innerHTML = _br(TA.dados_ate)
        + ' <span class="mdn">(' + atras.join(', ') + ' atrás)</span>';
    }
    if (el('ehJanela')) {
      el('ehJanela').textContent = TA.janela && TA.janela.de
        ? TA.janela.de + ' — ' + TA.janela.ate + ' · ' + TA.janela.pregoes + ' pregões'
        : 'sem operação no período';
    }
    if (el('pillMeta')) el('pillMeta').textContent = 'SOPHIS · ' + (TA.gerado_em || '—');
    if (el('mtNTrades')) el('mtNTrades').textContent = (TA.trades || []).length;
    if (el('mtNExec')) el('mtNExec').textContent = (TA.execucoes || []).length;
    if (el('mtNBoletas')) el('mtNBoletas').textContent = (TA.resumo || {}).boletas || 0;
    document.title = TA.trader + ' — ' + (TA.grupo_rotulo || TA.grupo)
      + ' · trade a trade · JGP Macro';
  }

  function telaVazia() {
    VAZIO = true;
    const motivo = TA.semArquivo
      ? '<strong>' + (TA.grupo_rotulo || TA.grupo) + '</strong> ainda não tem motor.'
      : '<strong>' + TA.trader + '</strong> não tem nenhuma operação de <strong>'
        + (TA.grupo_rotulo || TA.grupo) + '</strong> no período.';
    document.querySelectorAll('.tab').forEach((p) => {
      p.innerHTML = '<div class="aviso" style="margin-top:18px">' + motivo + '</div>';
    });
  }

  function ops(sel, vals, rot) {
    const s = el(sel);
    if (!s) return;
    /* idempotente: mantém só o 1º <option> (o "todos") e repovoa o resto */
    while (s.options.length > 1) s.remove(1);
    vals.forEach((v) => {
      const o = document.createElement('option');
      o.value = v; o.textContent = rot ? (rot[v] || v) : v;
      s.appendChild(o);
    });
  }
  const uniq = (a) => Array.from(new Set(a.filter((x) => x != null))).sort();

  /* ══════════════════ TRADE A TRADE ══════════════════ */
  function filtraTrades() {
    const dtOn = el('chkDT').checked, onOn = el('chkON').checked;
    const gOn = el('chkGanho').checked, pOn = el('chkPerda').checked;
    const bk = el('selBook').value, at = el('selAtivo').value;
    /* ⚠️ Ordem DECRESCENTE por data de abertura: o que interessa primeiro é o
       que ele acabou de fazer, não o que fez em janeiro. Desempate pelo
       `trade_id` (que já é crescente por abertura) para a ordem ser ESTÁVEL —
       sem ele, dois ciclos abertos no mesmo dia trocariam de lugar entre
       filtragens e o leitor veria a tabela "se mexer" sozinha. */
    return TR.filter((r) =>
      (r.daytrade ? dtOn : onOn) &&
      (r.ganhou ? gOn : pOn) &&
      (!bk || r.book === bk) &&
      (!at || r.ativo === at))
      .slice()
      .sort((a, b) => (a.abertura < b.abertura ? 1 : a.abertura > b.abertura ? -1
                       : (b.trade_id || 0) - (a.trade_id || 0)));
  }

  const COLS_TRADE = [
    { t: '#', num: 1, f: (r) => r.trade_id, tip: 'trade_id' },
    { t: 'contrato', f: (r) => comNome(r, r.vencimento || r.ativo) +
        (r.book !== 'di' ? ' <span class="tagmini">' + rotBook[r.book] + '</span>' : '') },
    { t: 'direção', f: (r) => r.direcao, tip: 'direcao' },
    { t: 'abriu', f: (r) => dt(r.abertura) },
    { t: 'fechou', f: (r) => dt(r.fechamento) },
    { t: 'dias', num: 1, tip: 'dias',
      f: (r) => (r.daytrade ? '<span class="tagmini">DT</span>' : nf(r.dias_corridos, 0)) },
    { t: 'entrada', num: 1, f: (r) => preco(r, r.taxa_entrada) },
    { t: 'saída', num: 1, f: (r) => preco(r, r.taxa_saida) },
    { t: 'bps taxa', num: 1, f: (r) => nf(r.bps_taxa, 1), tip: 'bps_taxa', cls: (r) => sgn(r.bps_taxa).trim() },
    { t: 'contratos', num: 1, f: (r) => nf(r.pico_contratos, 0), tip: 'pico_ct' },
    { t: 'DV01', num: 1, f: (r) => nf(r.dv01_pico_brl, 0), tip: 'dv01' },
    { t: '#PL', num: 1, f: (r) => nf(r.pl_pico, 2), tip: 'pl' },
    { t: 'tam.rel', num: 1, f: (r) => nf(r.tam_relativo, 2), tip: 'tam_rel' },
    { t: 'giro', num: 1, f: (r) => nf(r.giro_contratos, 0), tip: 'giro_ct' },
    { t: 'exec', num: 1, f: (r) => nf(r.n_execucoes, 0), tip: 'exec' },
    { t: 'dias op.', num: 1, f: (r) => nf(r.n_dias_operados, 0), tip: 'dias_op' },
    /* ⚠️ LÍQUIDO por padrão, como na tela anual: `result_liq_brl` é o que
       sobrou depois de corretagem + emolumento + contraparte. O bruto e o custo
       ficam em colunas próprias, aqui sempre visíveis — esta é a tela do
       detalhe, então não há o que esconder. */
    /* ⭐ O BRUTO é o AJUSTE DA B3 (o dinheiro), e a régua do `du` congelado vai
       ao lado como coluna própria. As duas medem coisas diferentes e a diferença
       entre elas é o carrego da posição de DI contra o CDI — ver ta/ajuste_b3.py. */
    { t: 'result. bruto', num: 1, f: (r) => kbrl(r.result_b3_brl != null ? r.result_b3_brl : r.result_brl),
      tip: 'result_bruto', cls: (r) => sgn(r.result_b3_brl != null ? r.result_b3_brl : r.result_brl).trim() },
    { t: 'só a taxa', num: 1, f: (r) => kbrl(r.result_brl), tip: 'result_taxa',
      cls: (r) => sgn(r.result_brl).trim() },
    { t: 'custo', num: 1, f: (r) => kbrl(r.custo_brl), tip: 'custo', cls: () => 'neg' },
    { t: 'cupom', num: 1, f: (r) => kbrl(r.cupom_brl), tip: 'cupom' },
    { t: 'carrego', num: 1, f: (r) => kbrl(r.carrego_brl), tip: 'carrego',
      cls: (r) => sgn(r.carrego_brl).trim() },
    { t: 'resultado', num: 1, f: (r) => kbrl(r.result_liq_brl), tip: 'resultado_liq',
      cls: (r) => sgn(r.result_liq_brl).trim() },
    { t: 'bps NAV', num: 1, f: (r) => bps(r.bps_nav_liq), tip: 'bps_nav', cls: (r) => sgn(r.bps_nav_liq).trim() },
    { t: '', f: (r) => (r.herdado ? '<span class="tagmini alt">herdado 2025</span>'
        : r.aberto ? '<span class="tagmini alt">aberto</span>' : '') },
  ];

  function pintaTrades() {
    const rows = filtraTrades();
    el('cntTrades').textContent =
      rows.length + ' de ' + TR.length + ' trades · ' +
      kbrl(rows.reduce((a, r) => a + (r.result_liq_brl || 0), 0));
    table(el('tblTrades'), COLS_TRADE, rows, abreDrill);
  }

  /* ── drill-down de um ciclo ───────────────────────────────────────── */
  function abreDrill(r) {
    const dv = el('drill');
    dv.hidden = false;
    el('drillTitulo').innerHTML =
      `Trade #${r.trade_id} &middot; ${comNome(r, r.ativo)} ` +
      `(${r.vencimento || rotBook[r.book]}) &middot; ` +
      `<strong>${r.direcao}</strong> &middot; ${dt(r.abertura)} → ${dt(r.fechamento)}`;

    el('drillKpis').innerHTML = [
      kpi('Resultado', kbrl(r.result_liq_brl),
          bps(r.bps_nav_liq) + ' do NAV · bruto ' + kbrl(r.result_b3_brl != null ? r.result_b3_brl : r.result_brl)
          + ' − custo ' + kbrl(r.custo_brl)
          + (r.carrego_brl ? ' + carrego ' + kbrl(r.carrego_brl) : ''),
          sgn(r.result_liq_brl)),
      kpi('Movimento de taxa', nf(r.bps_taxa, 1) + ' bps', 'a favor dele', sgn(r.bps_taxa)),
      kpi('Entrada → saída', preco(r, r.taxa_entrada) + ' → ' + preco(r, r.taxa_saida),
          'VWAP por contratos'),
      kpi('Tamanho', nf(r.pico_contratos, 0) + ' ct',
          'DV01 ' + brl(r.dv01_pico_brl) + '/bp · #PL ' + nf(r.pl_pico, 2)),
      kpi('Tam. relativo', nf(r.tam_relativo, 2) + '×', 'do habitual dele'),
      kpi('Negociou em volta', nf(r.n_execucoes, 0) + ' exec',
          nf(r.n_dias_operados, 0) + ' dias · giro ' + nf(r.giro_contratos, 0) + ' ct'),
      kpi('du congelado', nf(r.du_ref, 0), 'a régua do resultado'),
      kpi('Brokers', nf(r.n_brokers, 0), r.estrategia || '—'),
    ].join('');

    const b = BL.filter((x) => x.trade_id === r.trade_id);
    const t = theme();
    /* Eixo de datas do ciclo. O `tickformatstops` do `axJGP` (camada-casa) adapta o
       tick ao zoom e TEM PRECEDÊNCIA sobre `tickformat` no Plotly — sem anular, um
       ciclo de 3 dias saía com ticks de 6 em 6 horas. E `dtick` diário só entra em
       ciclo curto: num ciclo de 40 pregões daria 40 rótulos empilhados. */
    const eixoX = {
      tickformat: '%d/%m', tickformatstops: null,
      dtick: b.length <= 15 ? 86400000 : undefined,
    };

    /* posição e taxa dentro do trade */
    Plotly.newPlot(el('figDrill'), [
      { x: b.map((x) => x.data), y: b.map((x) => x.pos_eod), name: 'posição (contratos)',
        type: 'scatter', mode: 'lines+markers', line: { color: P()[0], width: 2, shape: 'hv' },
        fill: 'tozeroy', fillcolor: 'rgba(0,110,80,.14)',
        hovertemplate: '%{x|%d/%m}<br>%{y:,.0f} contratos<extra></extra>' },
      { x: b.map((x) => x.data), y: b.map((x) => x.taxa_dia), name: 'taxa de ajuste',
        type: 'scatter', mode: 'lines+markers', yaxis: 'y2',
        line: { color: P()[2], width: 2 },
        hovertemplate: '%{x|%d/%m}<br>%{y:.3f}%<extra></extra>' },
    ], baseLayout(t, {
      height: H_HALF(),
      xaxis: eixoX,
      yaxis: { title: { text: 'contratos' }, zeroline: true },
      /* ⛔ AQUI o `zeroAlinhado` NAO se aplica, e a excecao e a regra do proprio
         helper: o zero do eixo da TAXA nao esta no dominio dela. A taxa de
         ajuste vive em ~13%, e forcar o eixo a conter o 0 esmagaria a variacao
         do ciclo inteiro (decimos de ponto) numa linha reta. Zero se alinha
         quando ele SIGNIFICA a mesma coisa nos dois eixos — troca de sinal —,
         nao por simetria visual. */
      yaxis2: { title: { text: 'taxa (%)' }, overlaying: 'y', side: 'right', showgrid: false },
      legend: { orientation: 'h' }, hovermode: 'x unified',
    }), CFG);

    /* de onde veio o resultado: caixa das boletas × marcação do carregado */
    /* ⚠️ `barmode:'relative'` EMPILHA: o extremo do eixo esquerdo é a soma das
       duas barras do dia, não a maior delas. */
    const _ac = b.reduce((a, x) => (a.push((a.length ? a[a.length - 1] : 0) + x.pnl_dia), a), []);
    const [rgFlx, rgAcum] = zeroAlinhado(
      b.map((x) => Math.max(x.cash_trades || 0, 0) + Math.max(x.mtm || 0, 0))
       .concat(b.map((x) => Math.min(x.cash_trades || 0, 0) + Math.min(x.mtm || 0, 0))),
      _ac);
    Plotly.newPlot(el('figDrillPnl'), [
      { x: b.map((x) => x.data), y: b.map((x) => x.cash_trades), name: 'caixa das boletas',
        type: 'bar', marker: { color: P()[3] },
        hovertemplate: '%{x|%d/%m}<br>R$ %{y:,.0f}<extra></extra>' },
      { x: b.map((x) => x.data), y: b.map((x) => x.mtm), name: 'marcação do carregado',
        type: 'bar', marker: { color: P()[6] },
        hovertemplate: '%{x|%d/%m}<br>R$ %{y:,.0f}<extra></extra>' },
      { x: b.map((x) => x.data), y: _ac,
        name: 'resultado acumulado', type: 'scatter', mode: 'lines+markers',
        line: { color: P()[0], width: 2.4 }, yaxis: 'y2',
        hovertemplate: '%{x|%d/%m}<br>acum R$ %{y:,.0f}<extra></extra>' },
    ], baseLayout(t, {
      height: H_HALF(), barmode: 'relative', xaxis: eixoX,
      yaxis: { title: { text: 'fluxo (R$)' }, zeroline: true, range: rgFlx },
      yaxis2: { title: { text: 'acumulado (R$)' }, overlaying: 'y', side: 'right',
                showgrid: false, zeroline: true, range: rgAcum },
      legend: { orientation: 'h' },
    }), CFG);

    table(el('tblDrillBlotter'), [
      { t: 'pregão', f: (x) => x.data },
      { t: 'pos. abertura', num: 1, f: (x) => nf(x.pos_bod, 0) },
      { t: 'negociou', num: 1, f: (x) => (x.net ? nf(x.net, 0) : (x.negociou ? '0 (netou)' : '—')) },
      { t: 'pos. fecham.', num: 1, f: (x) => nf(x.pos_eod, 0) },
      { t: 'taxa ajuste', num: 1, f: (x) => nf(x.taxa_dia, 3) },
      { t: 'du dia', num: 1, f: (x) => nf(x.du_dia, 0) },
      { t: 'DV01', num: 1, f: (x) => nf(x.dv01_brl, 0) },
      { t: '#PL', num: 1, f: (x) => nf(x.pl, 2) },
      { t: 'caixa', num: 1, f: (x) => kbrl(x.cash_trades), cls: (x) => sgn(x.cash_trades).trim() },
      { t: 'mtm', num: 1, f: (x) => kbrl(x.mtm), cls: (x) => sgn(x.mtm).trim() },
      { t: 'resultado do dia', num: 1, f: (x) => kbrl(x.pnl_dia), cls: (x) => sgn(x.pnl_dia).trim() },
    ], b);

    const ex = EX.filter((x) => x.trade_id === r.trade_id);
    table(el('tblDrillExec'), COLS_EXEC, ex);
    dv.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ══════════════════ POR BOLETA ══════════════════ */
  const COLS_EXEC = [
    { t: 'pregão', f: (r) => r.trade_date },
    { t: 'trade', num: 1, f: (r) => (r.trade_id ? '#' + r.trade_id : '—') },
    { t: 'contrato', f: (r) => r.vencimento || r.ativo },
    { t: 'book', f: (r) => rotBook[r.book] || r.book },
    { t: 'lado', tip: 'lado', f: (r) => `<span class="lado ${r.lado}">${r.lado}</span>` },
    { t: 'contratos', num: 1, f: (r) => nf(Math.abs(r.quantity), 0) },
    { t: 'preço', num: 1, f: (r) => preco(r, r.price) },
    { t: 'du', num: 1, f: (r) => nf(r.du, 0) },
    { t: 'DV01/ct', num: 1, f: (r) => nf(r.dv01_contrato, 2), tip: 'dv01_ct' },
    { t: 'DV01', num: 1, f: (r) => nf(r.dv01_brl, 0), tip: 'dv01' },
    { t: 'caixa', num: 1, f: (r) => kbrl(r.caixa_brl), cls: (r) => sgn(r.caixa_brl).trim() },
    { t: 'broker', f: (r) => r.broker },
    { t: 'fundos', num: 1, f: (r) => nf(r.n_fundos, 0), tip: 'fundos' },
    { t: 'linhas', num: 1, f: (r) => nf(r.n_linhas, 0), tip: 'linhas' },
    { t: '', f: (r) => (r.papel === 'cancelamento'
        ? '<span class="tagmini alt">cancelamento</span>' : '') },
  ];

  function filtraExec() {
    const bk = el('selExecBook').value, at = el('selExecAtivo').value;
    const br = el('selExecBroker').value, ld = el('selExecLado').value;
    const canc = el('chkCanc').checked;
    /* mesma regra da tabela de ciclos: mais recente em cima */
    return EX.filter((r) =>
      (canc || r.papel !== 'cancelamento') &&
      (!bk || r.book === bk) && (!at || r.ativo === at) &&
      (!br || r.broker === br) && (!ld || r.lado === ld))
      .slice()
      .sort((a, b) => (a.trade_date < b.trade_date ? 1
                       : a.trade_date > b.trade_date ? -1
                       : String(a.ativo || '').localeCompare(String(b.ativo || ''))));
  }

  function pintaExec() {
    const rows = filtraExec();
    const giro = rows.reduce((a, r) => a + Math.abs(r.quantity), 0);
    el('cntExec').textContent =
      rows.length + ' de ' + EX.length + ' execuções · ' + nf(giro, 0) + ' contratos · ' +
      nf(rows.reduce((a, r) => a + (r.n_linhas || 0), 0), 0) + ' linhas de boleta';
    table(el('tblExec'), COLS_EXEC, rows);
  }

  function tabBoletas() {
    const t = theme();
    const vivos = EX.filter((r) => r.papel !== 'cancelamento');
    const brs = {};
    vivos.forEach((r) => {
      const k = r.broker || '—';
      brs[k] = brs[k] || { n: 0, q: 0 };
      brs[k].n += 1; brs[k].q += Math.abs(r.quantity);
    });
    const bk = Object.entries(brs).sort((a, b) => b[1].q - a[1].q);
    Plotly.newPlot(el('figBroker'), [
      { x: bk.map((b) => b[1].q), y: bk.map((b) => b[0]), name: 'giro (contratos)',
        type: 'bar', orientation: 'h', marker: { color: P()[0] },
        hovertemplate: '%{y}<br>%{x:,.0f} contratos<extra></extra>' },
      { x: bk.map((b) => b[1].n), y: bk.map((b) => b[0]), name: 'execuções',
        type: 'bar', orientation: 'h', marker: { color: P()[2] }, xaxis: 'x2',
        hovertemplate: '%{y}<br>%{x:,.0f} execuções<extra></extra>' },
    ], baseLayout(t, {
      height: H_HALF(), barmode: 'group',
      xaxis: { title: { text: 'contratos' } },
      xaxis2: { overlaying: 'x', side: 'top', title: { text: 'execuções' }, showgrid: false },
      yaxis: { automargin: true }, legend: { orientation: 'h' },
    }), CFG);

    const sp = {};
    vivos.forEach((r) => { sp[r.n_fundos] = (sp[r.n_fundos] || 0) + 1; });
    const ks = Object.keys(sp).map(Number).sort((a, b) => a - b);
    Plotly.newPlot(el('figSplit'), [
      { x: ks, y: ks.map((k) => sp[k]), type: 'bar', marker: { color: P()[1] },
        text: ks.map((k) => sp[k]), textposition: 'auto',
        hovertemplate: '%{x} fundos<br>%{y} execuções<extra></extra>' },
    ], baseLayout(t, {
      height: H_HALF(), xaxis: { title: { text: 'fundos na mesma execução' }, dtick: 1 },
      yaxis: { title: { text: 'execuções' } }, showlegend: false,
    }), CFG);
    pintaExec();
  }

  /* ── ligações ─────────────────────────────────────────────────────── */
  /* ⚠️ Preenche os <select> de filtro A PARTIR DOS DADOS, então só pode rodar
     DEPOIS que o par (trader, grupo) chegou — cada trader opera contratos e
     corretoras diferentes. Antes isto era código de topo, que com carga
     dinâmica rodaria com `TR` ainda nulo. Os listeners ficam fora daqui, para
     não empilhar um por carga. */
  function prepara() {
    ops('selBook', uniq(TR.map((r) => r.book)), rotBook);
    ops('selAtivo', uniq(TR.map((r) => r.ativo)));
    ops('selExecBook', uniq(EX.map((r) => r.book)), rotBook);
    ops('selExecAtivo', uniq(EX.map((r) => r.ativo)));
    ops('selExecBroker', uniq(EX.map((r) => r.broker)));
  }

  el('fTrades').addEventListener('change', pintaTrades);
  el('fExec').addEventListener('change', pintaExec);
  el('drillFechar').addEventListener('click', () => { el('drill').hidden = true; });

  const TABS = { trades: pintaTrades, boletas: tabBoletas };
  function render(tab) {
    /* ⚠️ Guarda obrigatória: o `JGPChrome.init` chama `onTab(abaAtiva)` na
       inicialização da casca, e isso acontece ANTES de o arquivo do par
       (trader, grupo) terminar de carregar — `TA` ainda é null. Sem esta linha
       a primeira aba estoura com "Cannot read properties of null". Quem
       realmente dispara o desenho é `__taData`. */
    if (!TA || VAZIO) return;
    const fn = TABS[tab];
    if (!fn || drawn[tab]) return;
    drawn[tab] = 1;
    try { fn(); } catch (e) { console.error('[' + tab + ']', e); }
  }
  window.__taRender = render;

  window.__taData = function (dados) {
    TA = dados;
    TR = TA.trades || []; EX = TA.execucoes || []; BL = TA.blotter || [];
    cabecalho();
    VAZIO = false;
    if (TA.vazio || !TR.length) { telaVazia(); return; }
    prepara();
    Object.keys(drawn).forEach((k) => delete drawn[k]);
    const ativo = document.querySelector('.tabbtn.on');
    render(ativo ? ativo.getAttribute('data-tab') : 'trades');
  };
  if (window.TA) window.__taData(window.TA);
})();
