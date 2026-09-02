/* =====================================================================
   app.js — tela 1: ANÁLISE ANUAL do trader.
   Lê window.TA (data.js). Usa a camada-casa de gráficos (shared-web/plotly-jgp.js).

   Escopo: PAlves, juros BR, 2026. Posição e resultado vêm SÓ das boletas do
   Sophis; o NAV do JRS entra apenas como denominador de #PL e de bps.
   ===================================================================== */
(function () {
  /* ⚠️ `TA` e `let`, nao `const`: os dados chegam DEPOIS, pelo callback
     `window.__taData` que o arquivo do par (trader, grupo) invoca. Ler
     `window.TA` aqui no topo daria `undefined` — o <script> dos dados e
     injetado pelo `ta-sel.js` e pode terminar depois deste arquivo. */
  let TA = null, R = null, D = null, TR = null;
  const drawn = {};
  /* ⚠️ `telaVazia()` SUBSTITUI o conteúdo dos painéis pelo aviso. Depois
     disso `el('kpisGeral')` e cia. não existem mais, e qualquer render
     estoura com "Cannot set properties of null". Este flag corta o
     render na porta — clicar numa aba não pode reanimar o desenho sobre
     um DOM que foi apagado de propósito. */
  let VAZIO = false;

  /* ── formatação (pt-BR; o livro é BRL) ─────────────────────────────── */
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
  /* ☠️ "% do resultado bruto" MENTE quando o bruto e negativo ou ~zero.
     Medido no EMota 2026: custo R$ 1,17 MM sobre um bruto de −R$ 941 mil saia
     como "1.046% do resultado bruto" — um numero que nao quer dizer nada, num
     lugar de destaque. O peso do custo so e legivel contra um bruto POSITIVO;
     fora disso a regua honesta e o NAV, que existe sempre. */
  /* ⭐ Custo em BPS DO NAV (pedido do usuario, 31/08/2026). E a regua que
     compara entre traders e entre anos — R$ 58 mil de custo num livro de R$ 23
     MM nao e o mesmo que R$ 58 mil num de R$ 200 MM.
     ⚠️ As PARTES saem por rateio do total: `custo_bps` e a soma dia a dia sobre
     o NAV daquele dia, e refazer isso por componente exigiria a serie de cada
     taxa. O rateio e exato porque as tres somam o total, e a alternativa (nao
     mostrar as partes em bps) perderia mais do que ganha. */
  /* ⚠️ As partes tambem tem de SOMAR o total em bps, pelo mesmo motivo do
     percentual: com 1 casa, 11,3 + 13,1 dava 24,4 contra um total de 24,5. A
     ULTIMA parte absorve o residuo — com duas partes isso e exato, e a que
     absorve e a de custo operacional (a que a mesa nao negocia), nao a
     corretagem, que e a linha sobre a qual se toma decisao. */
  /* ⚠️ A BASE E O CUSTO DIARIO (`custo_total_bps`), nao o dos ciclos fechados
     (`custo_bps` do `stats`). Sao bases diferentes — a mesma diferenca que ja
     existe entre `custo_total_brl` e `custo_brl` —, e esta ficha e a do custo
     DIARIO: as partes ao lado (`custo_broker_brl`/`custo_market_brl`) saem de
     `ag["custo_dia"]`, entao o total tem de sair de la tambem, senao as partes
     nao somam o todo (§5.-16).
     ⚠️ `custo_bps` continua no payload e serve as TABELAS de recorte, que somam
     ciclos. Nao trocar um pelo outro por conveniencia. */
  function bpsPartes() {
    const tot = Math.abs(R.custo_total_bps != null ? R.custo_total_bps
                                                   : (R.custo_bps || 0));
    const b0 = Math.round(tot * (R.custo_broker_brl || 0)
                          / (R.custo_total_brl || 1) * 10) / 10;
    return [b0, Math.round((tot - b0) * 10) / 10, Math.round(tot * 10) / 10];
  }
  /* ⚠️ Recebe a CHAVE, nao o valor: comparar por valor erraria a parte se as
     duas taxas coincidissem por acaso — e "acaso" aqui e um livro pequeno com
     poucas boletas, que existe. */
  /* ☠️ DEVOLVIA BPS SEMPRE, ate com a pagina em REAIS (reportado pelo usuario).
     E o espelho do erro que a auditoria de regua pegou, e igualmente incoerente:
     troca-se para reais e a ficha de custo continua em bps. */
  const bpsCusto = (qual) => {
    const tot = R.custo_total_bps != null ? R.custo_total_bps : R.custo_bps;
    if (tot == null || !R.custo_total_brl) return '—';
    if (!emBps()) {
      return kbrl(qual === 'broker' ? R.custo_broker_brl
                : qual === 'market' ? R.custo_market_brl : R.custo_total_brl);
    }
    const [b0, b1, tt] = bpsPartes();
    return bps(qual === 'broker' ? b0 : qual === 'market' ? b1 : tt);
  };
  /* ⭐ A ficha de custo tem de dar a resposta na REGUA ATIVA. Em bps ela mostra
     bps e o detalhe traz os reais; em reais, o inverso. O custo em bps existe
     desde 31/08/2026 justamente por ser comparavel entre traders e anos, entao
     ele nao some quando a pagina esta em R$ — ele troca de lugar. */
  const custoK = (qual) => {
    if (emBps()) return bpsCusto(qual);
    return kbrl(qual === 'broker' ? R.custo_broker_brl
              : qual === 'market' ? R.custo_market_brl : R.custo_total_brl);
  };
  const custoKalt = (qual) => {
    if (!emBps()) {
      const tot = R.custo_total_bps != null ? R.custo_total_bps : R.custo_bps;
      if (tot == null || !R.custo_total_brl) return '—';
      const [b0, b1, tt] = bpsPartes();
      return bps(qual === 'broker' ? b0 : qual === 'market' ? b1 : tt);
    }
    return kbrl(qual === 'broker' ? R.custo_broker_brl
              : qual === 'market' ? R.custo_market_brl : R.custo_total_brl);
  };
  /* ☠️ PERCENTUAL ARREDONDADO UM A UM NAO SOMA 100. O usuario viu "36% + 65%"
     na ficha de custo. Metodo do MAIOR RESTO (Hare): trunca todos, e distribui
     as unidades que faltam para quem tem o maior resto.
     ⚠️ So funciona se as partes somarem o TOTAL — e nao somavam: as boletas de
     cancelamento entravam nas partes e nao no total (R$ 1.695,75 no PAlves, 2,9
     pontos). Corrigido no `report.py`; este helper cuida do resto. */
  function pctInteiros(vals, total) {
    const t = total || vals.reduce((a, b) => a + (b || 0), 0);
    if (!t) return vals.map(() => 0);
    const ex = vals.map((v) => 100 * (v || 0) / t);
    const base = ex.map((v) => Math.floor(v));
    let falta = 100 - base.reduce((a, b) => a + b, 0);
    const ordem = ex.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0]);
    for (let k = 0; k < ordem.length && falta > 0; k++, falta--) base[ordem[k][1]] += 1;
    return base;
  }
  /* [corretagem, custos operacionais] em % inteiro, somando 100 */
  const shCusto = () => pctInteiros([R.custo_broker_brl, R.custo_market_brl],
                                    R.custo_total_brl);
  function pesoCusto(R) {
    const b = R.pnl_bruto_brl, c = R.custo_total_brl;
    /* ⚠️ O detalhe traz sempre a OUTRA regua — nunca repete a que ja esta no
       valor da linha. Repetir "24,5 bps do NAV" sob um numero que ja e
       "24,5 bps" gastava a linha sem informar. */
    const emBps = custoKalt('total');
    if (b != null && c != null && b > 0) {
      /* ⚠️ Acima de 100% o percentual PARECE erro de formatacao. "1.046% do
         resultado bruto" e verdade (o custo foi 10,5x o bruto) e mesmo assim
         nao se le — "10,5x o resultado bruto" diz a mesma coisa e se le. */
      /* ⚠️ O "% do resultado BRUTO" so aparece com a quebra aberta. Sem ela a
         tela e liquida por definicao (§5.4) e o leitor nao tem o bruto na tela
         para conferir a fracao — citar um numero invisivel e o mesmo tipo de
         confusao de regua que o §5.-32 custou. */
      if (!DETALHE) return emBps;
      const m = c / b;
      const peso = m > 1 ? nf(m, 1) + '× o resultado bruto'
                         : pct(m, 0) + ' do resultado bruto';
      return peso + (emBps ? ' · ' + emBps : '');
    }
    return DETALHE ? (emBps + ' — o bruto foi negativo, então não há "% do bruto"')
                   : emBps;
  }
  /* par(média, mediana) — UMA célula com as DUAS posições centrais, sempre nesta
     ordem, com a mediana em cinza. Existe porque a alternativa (uma coluna para
     cada) levava as tabelas de corte a 20 colunas e 1.961px, obrigando a rolar
     na horizontal para ver o número principal. O cabeçalho traz os dois nomes
     POR EXTENSO — a ordem nunca é adivinhada. */
  /* terno(média, mediana, ponderada) — só para "bps de taxa", que é a única
     métrica com TRÊS leituras legítimas. A 3ª (ponderada por DV01 × quantidade
     girada) é a que reconcilia com o dinheiro: Σ(bps × dv01 × Q) = R$ 90.063
     contra R$ 89.341 de resultado real. A simples trata um trade de 1 contrato
     igual a um de 4.500. */
  const terno = (a, b, c, fmt) => {
    const f = fmt || ((v) => nf(v, 1));
    const g = (v) => (v == null || !isFinite(v) ? '—' : f(v));
    return g(a) + ' <span class="mdn">/ ' + g(b) + '</span> <b class="pnd">/ ' + g(c) + '</b>';
  };
  /* bcl(bruto, custo, líquido) — a história do custo numa célula só. O LÍQUIDO
     vem em negrito porque é o headline; o custo em vermelho, entre os dois, para
     a subtração ficar legível. Existe pelo mesmo motivo do `par`: três colunas
     separadas levavam tblHorizonte/tblBook a 15 colunas e 1.691px contra 1.421px
     de container, obrigando a rolar para ver o número que importa. */
  const bcl = (bruto, custo, liq, fmt) => {
    const f = fmt || kbrl;
    const g = (v) => (v == null || !isFinite(v) ? '—' : f(v));
    /* empilhado em 2 linhas: numa linha só a célula tinha 3 valores em R$ e
       levava tblHorizonte/tblBook a 1.645px contra 1.421px de container. */
    return '<b>' + g(liq) + '</b>'
         + '<span class="bcl2">' + g(bruto)
         + ' <span class="cst">− ' + g(Math.abs(custo || 0)) + '</span></span>';
  };
  const par = (a, b, fmt) => {
    const f = fmt || ((v) => nf(v, 2));
    const A = a == null || !isFinite(a) ? '—' : f(a);
    const B = b == null || !isFinite(b) ? '—' : f(b);
    return A + ' <span class="mdn">/ ' + B + '</span>';
  };
  const sgn = (v) => (v == null || !isFinite(v) ? '' : v < 0 ? ' neg' : '');
  /* ⭐ O SUBTITULO DO `real` — hoje ele volta a ser "o resultado como foi",
     e desta vez e VERDADE (01/09/2026). A opcao entrou na analise pela regua
     dela (§5.-54), entao `real == o ano` e nao ha base a declarar: o usuario
     pediu para tirar o aviso, e o que o tornava necessario deixou de existir.
     ⚠️ O ramo do aviso FICA, sem aparecer: o que sobra de fora hoje sao so os
     ciclos sem tamanho medivel em regua nenhuma, e eles somam 0,00 bps na base
     inteira (aferido). Se um dia sobrar algo material, a ficha diz — em vez de
     voltar a mostrar um `real` que nao e o ano sem ninguem notar. */
  const foraDoSizing = () => {
    const S = TA.sizing || {};
    if (!S.n_fora || Math.abs(S.fora_bps || 0) < 0.05) return 'o resultado como foi';
    return '⚠️ fora, ' + nf(S.n_fora, 0) + ' sem tamanho medível ('
         + bps(S.fora_bps) + ') → o ano fecha em ' + bps(S.ano_bps);
  };
  const taxa = (v) => (v == null || !isFinite(v) ? '—' : nf(v, 3) + '%');

  /* ⭐ A REGUA DA PAGINA (01/09/2026). 'bps' e o PADRAO: e a unica regua
     comparavel entre traders e entre anos — R$ 32 mil num livro de R$ 23 MM nao
     e o mesmo que R$ 32 mil num de R$ 200 MM, e o NAV alocado muda por decisao
     da casa, nao do gestor. 'brl' mostra o financeiro.
     Mesmo mecanismo do DETALHE: `let` de modulo, invalidacao de `drawn`,
     localStorage em try/catch e volta ao topo.
     ⛔ NAO recarrega a pagina. Quem recarrega e o ta-sel.js (trader/ativo/ano),
     porque la muda o ARQUIVO de dados; aqui muda so a unidade de leitura. */
  let REGUA = 'bps';
  const emBps = () => REGUA === 'bps';

  /* ⭐ OS QUATRO HELPERS DA REGUA. Cada call site chama um deles e passa os DOIS
     valores; quem decide qual sai e o `REGUA`.
     ☠️ Fazer isso com um `if` em cada call site daria ~40 ifs, e um deles
     ficaria para tras em silencio — foi assim que a §5.-23 deixou o titulo sem
     exposicao por meses, sem um unico erro na tela. Um helper so tem um lugar
     para errar. */
  const K = (vbps, vbrl) => (emBps() ? bps(vbps) : kbrl(vbrl));
  const KP = (mb, mdb, mr, mdr) =>
    (emBps() ? par(mb, mdb, (v) => nf(v, 1)) : par(mr, mdr, kbrl));
  /* o formatador cru da regua ativa — para `bcl` e para rotulo de barra */
  const kfmt = () => (emBps() ? ((v) => nf(v, 1)) : kbrl);
  /* ⭐ O valor da OUTRA regua, para o detalhe da ficha e o hover do grafico. O
     financeiro NUNCA se perde quando a pagina esta em bps: ele so sai do lugar
     de destaque. */
  const Kalt = (vbps, vbrl) => (emBps() ? kbrl(vbrl) : bps(vbps));
  /* ⭐ AS COLUNAS DE RESULTADO, num lugar so (01/09/2026).
     ☠️ Em regua de BPS, `resultado` e `bps NAV` mostravam **o mesmo numero**:
     desde o §5.-37 a coluna `resultado` segue a regua, entao em bps ela ja e o
     bps do NAV. Duas colunas identicas lado a lado fazem o leitor procurar a
     diferenca que nao existe — e ainda empurram a tabela para a rolagem
     horizontal, que e o que a §5.3 gastou trabalho para evitar.
     ⭐ Em REAIS as duas continuam, e ali sao complementares: uma da o dinheiro,
     a outra a fracao do patrimonio.
     ⚠️ Com o DETALHE ligado as duas ficam SEMPRE: a celula de resultado vira
     `bruto − custo = liquido` em R$ e a de bps traz o par bruto/liquido — nao
     sao a mesma coisa em nenhuma regua.
     ⚠️ Nasceu de uma funcao porque sao TRES tabelas (corte, direcao, contrato):
     tres copias e como os call sites ficam para tras um a um (§5.-39). */
  const colsResultado = () => [
    DETALHE
      ? { t: 'resultado<br><i>bruto − custo/carrego = <b>líquido</b></i>', num: 1,
          tip: 'resultado_bcl',
          f: (r) => bcl(r.total_bruto_brl, r.custo_brl, r.total_brl) }
      : { t: 'resultado', num: 1, tip: 'resultado_bcl',
          f: (r) => K(r.total_bps, r.total_brl),
          cls: (r) => sgn(r.total_brl).trim() },
    ...(DETALHE
      ? [{ t: 'bps NAV<br><i>bruto / <b>líquido</b></i>', num: 1, tip: 'bps_nav',
           f: (r) => par(r.total_bps_bruto, r.total_bps, (v) => nf(v, 1)) }]
      : emBps()
        ? []          /* ⛔ seria a copia exata da coluna acima */
        : [{ t: 'bps NAV', num: 1, f: (r) => bps(r.total_bps), tip: 'bps_nav',
             cls: (r) => sgn(r.total_bps).trim() }]),
  ];
  /* rotulo de eixo (`uni`) e sufixo curto de cabecalho (`ubps`) */
  const uni = () => (emBps() ? 'bps do NAV' : 'R$');
  const ubps = () => (emBps() ? 'bps' : 'R$');

  /* -- GLOSSARIO ----------------------------------------------------------
     A explicacao de cada campo NAO-OBVIO, num lugar so. Vira `title=` no rotulo
     do KPI e no `<th>` da tabela, com sublinhado pontilhado avisando que ha algo
     a ler.

     ATENCAO ao porque de `title` nativo e nao um balao de CSS: as tabelas de
     corte vivem dentro de `.wrap{overflow-x:auto}`, e um balao em `::after`
     seria CORTADO pelo container ao passar o mouse nas ultimas colunas —
     justamente as que mais precisam de explicacao. O `title` e desenhado pelo
     browser por cima de tudo e nunca clipa.

     E so entra o que NAO e obvio. "Trades", "Resultado" e "Custo" ficam de fora
     quando o rodape do KPI ja diz o que sao — tooltip em campo obvio treina o
     leitor a ignorar tooltip. */
  /* ⭐ `CPMHV84` nao diz nada; `Digital Copom No Cut 260318` diz (pedido do
     usuario, 01/09/2026). O nome vai ENTRE PARENTESES ao lado do codigo — sem
     coluna nova, que foi a restricao pedida.
     ⚠️ So sai quando ACRESCENTA: a estrutura de IDI ja tem `ativo` descritivo
     (`IDIX9 07/26 P CONDOR 515200/...`) e ali `ativo_nome` vem null de
     proposito, senao a celula repetiria a mesma informacao duas vezes. */

  const GLOSS = {
    composto: 'O retorno COMPOSTO sobre o NAV: multiplica (1 + resultado do dia / '
      + 'NAV daquele dia), dia a dia. ⚠️ NAO e a soma dos bps diarios — somar '
      + 'trata R$ 1 de janeiro e R$ 1 de agosto como a mesma coisa, e o NAV do '
      + 'trader muda por decisao da casa (o do PAlves andou 14% em 12 meses). '
      + 'A diferenca entre o composto e a soma e a composicao de 2a ordem: no '
      + 'EMota 2026 sao -40,3 contra -39,5 bps. As duas estao certas e respondem '
      + 'perguntas diferentes; a ficha mostra a COMPOSTA, que e a que um cotista '
      + 'teria capturado.',
    pts_col: 'PONTOS de preco capturados pelas OPCOES daquele recorte — media, '
      + 'mediana e PONDERADA pelo tamanho (R$/ponto x contratos girados/2). '
      + '⛔ Nao ha soma, de proposito: somar pontos daria peso 1 a cada ciclo, e '
      + 'um -16 pt em 7.895 contratos (-R$ 126 mil) pesaria mais que um -13 pt em '
      + '51.500 (-R$ 690 mil). A PONDERADA e a que reconcilia com o dinheiro: '
      + 'multiplicada pelo tamanho do livro, devolve o resultado bruto em R$. '
      + 'Cada ponto e um ponto PERCENTUAL: de '
      + 'probabilidade na digital de COPOM (cotada de 0 a 100, vira 100 se o '
      + 'cenario ocorre) e de payoff na estrutura de IDI (teto 100). '
      + '⛔ E a coluna equivalente ao "bps taxa", NAO uma alternativa a ela: a '
      + 'opcao nao entra no bps de taxa porque o preco dela nao e taxa, e o DI '
      + 'nao entra aqui porque nao se cota em pontos. Nunca ha valor nas duas.',
    mov_contrato: 'Quanto o preco andou a favor, na unidade de cada instrumento. '
      + 'No DI e no papel e o movimento da TAXA em bps (media / mediana / '
      + 'ponderada por DV01 x giro). Na OPCAO sao PONTOS de preco, no mesmo terno '
      + '(media / mediana / ponderada por R$/ponto x giro) — cada '
      + 'ponto e um ponto percentual: de probabilidade na digital de COPOM, de '
      + 'payoff na estrutura de IDI (teto 100). ⛔ Sao unidades diferentes na '
      + 'mesma coluna, por isso o sufixo: nao se somam verticalmente.',
    tam_contrato: 'O TAMANHO da aposta, na regua de cada instrumento. No DI e no '
      + 'papel e o #PL (DV01 x 1e4 / NAV = % do patrimonio por 100 bp). Na OPCAO '
      + 'e o PREMIO em bps do NAV — o dinheiro posto em risco, que e a regua dela '
      + 'porque opcao nao tem DV01. ⛔ Nao se somam: um e sensibilidade a taxa, o '
      + 'outro e capital exposto.',
    pts: 'Quantos PONTOS do preco a opcao capturou — entrada contra saida, com o '
      + 'sinal da direcao. E a regua natural do instrumento: a digital de COPOM e '
      + 'cotada em PROBABILIDADE (0 a 100, e vira 100 se o cenario ocorre) e a '
      + 'estrutura de IDI e montada para payoff maximo 100. Comprar a 20 e ver '
      + 'virar 0 e "-20 pontos" — perdeu o premio inteiro. '
      + '⚠️ Ponto NAO e reais: quanto vale cada ponto depende do numero de '
      + 'contratos e do R$/ponto do instrumento (100 na digital ate 26/05/2025, '
      + '1 depois).',
    bps_taxa_terno: 'Quanto a TAXA andou a favor dele entre o preco medio de '
      + 'entrada e o de saida, com o prazo CONGELADO na abertura. ⛔ NAO e o '
      + 'resultado: e bruto, sem custo, sem carrego e noutra regua que o resto '
      + 'da tela — mede se ele LEU A CURVA, nao o que ele levou. '
      + 'A PONDERADA (por DV01 x giro) e a que descreve o livro; a simples trata '
      + 'um ciclo de 1 contrato igual a um de 4.500.',
    premio: 'O PREMIO que ele pos na mesa nesse trade, em bps do NAV do dia do '
      + 'pico da posicao. E a regua de TAMANHO da opcao — o paralelo do #PL para '
      + 'quem nao tem DV01. ⛔ Nao se soma nem se compara com #PL: um e R$ de '
      + 'premio sobre o NAV, o outro e R$/bp sobre o NAV.',
    premio_dia: 'O premio de TODAS as opcoes vivas naquele pregao, em bps do NAV '
      + 'do dia. ⚠️ Maior que o premio por trade porque soma as posicoes '
      + 'simultaneas — a mesma relacao que ha entre o #PL do dia e o por trade.',
    risco_max: 'O PIOR CASO daquele trade, em bps do NAV. Comprado perde no '
      + 'maximo o premio; VENDIDO perde o teto do payoff menos o premio. Medido '
      + 'nas digitais vendidas da base, essa razao vai de 0,14 a 4,56 — o premio '
      + 'sozinho superestima o risco de um vendido caro em 7x e subestima o de um '
      + 'vendido barato em 4,6x. ⛔ Fica "nao determinado" quando o payoff e '
      + 'ilimitado de um lado (perna solta, estrutura com razoes que nao netam): '
      + 'assumir 100 ali seria inventar.',
    regua: 'A UNIDADE das analises da pagina, escolhida na barra de abas. '
      + 'BPS DO NAV (padrao) = resultado dividido pelo patrimonio alocado ao '
      + 'trader, calculado dia a dia com o NAV DAQUELE dia. E a unica regua '
      + 'comparavel entre traders e entre anos: R$ 32 mil num livro de R$ 23 MM '
      + 'nao e o mesmo que R$ 32 mil num de R$ 200 MM. REAIS = o financeiro. '
      + 'O RESULTADO TOTAL aparece em R$ nas duas. ⛔ DV01, giro e custo por '
      + 'perna ficam SEMPRE em R$: sao sensibilidade e preco unitario, nao '
      + 'resultado. Acerto, payoff, profit factor e #PL nao tem unidade.',
    par_mm_bps: 'Media e mediana em bps do NAV, por trade. ⚠️ Vencedor e '
      + 'perdedor sao separados pelo resultado em REAIS (e a mesma particao que '
      + 'gera o acerto e o payoff). Como o NAV muda ao longo do ano, um trade '
      + 'que ganhou dinheiro pode ter bps do NAV negativo — entao um "ganho '
      + 'medio" em bps pode sair negativo num recorte pequeno. Reparticionar '
      + 'por bps mudaria acerto, payoff e profit factor de todas as secoes.',
    payoff_regua: 'Payoff = ganho medio / perda media, NA REGUA ATIVA. As duas '
      + 'versoes existem porque o NAV muda ao longo do ano: a razao dos bps NAO '
      + 'e a razao dos reais. O BREAK-EVEN ao lado e (1-acerto)/acerto — '
      + 'adimensional, o mesmo nas duas reguas.',
    premio_dia: 'O PREMIO das opcoes vivas no fechamento do pregao, marcado ao '
      + 'preco do dia, sobre o NAV do trader. E a regua de tamanho da opcao — '
      + 'ela nao tem DV01, entao nao tem #PL. ⛔ NAO SOMA com o #PL: um e R$ por '
      + 'bp de taxa sobre o NAV, o outro e R$ de premio sobre o NAV.',
    premio_trade: 'O premio de UMA posicao de opcao, na quantidade de PICO e ao '
      + 'preco medio de entrada, sobre o NAV do dia do pico. E o paralelo exato '
      + 'do #PL por trade. ⚠️ E MAGNITUDE: comprado e vendido aparecem os dois '
      + 'positivos, e o lado esta na coluna de direcao.',
    risco_max: 'O pior caso da posicao. COMPRADO perde no maximo o premio pago. '
      + 'VENDIDO perde o TETO DO PAYOFF menos o premio recebido — e a diferenca '
      + 'nao e pequena: nas digitais vendidas da base a razao risco/premio vai de '
      + '0,14 a 4,56. O teto e 100 pontos na digital de COPOM (definicao do '
      + 'contrato) e a distancia entre strikes na estrutura de IDI (a B3 lista o '
      + 'IDI em passo 100). ⛔ Perna solta e estrutura de payoff ilimitado saem '
      + 'como "nao determinado" — nunca se assume 100.',
    ponto_brl: 'Quantos REAIS vale 1 ponto de premio, por contrato. A digital de '
      + 'COPOM foi REDENOMINADA em 26/05/2025: valia R$ 100,00 por ponto e passou '
      + 'a valer R$ 1,00. Sem isso o premio de 2020-2024 sairia 100x menor.',
    pl_dia: 'O #PL do LIVRO INTEIRO num pregao: a soma de TODAS as posicoes '
      + 'vivas naquele dia. #PL = DV01 x 1e4 / NAV, que se le "% do patrimonio '
      + 'do trader por 100 bp de movimento da taxa". ⚠️ E maior que o #PL por '
      + 'trade porque ele carrega mais de uma posicao ao mesmo tempo — a razao '
      + 'entre os dois e o numero medio de ativos simultaneos.',
    pl_trade: 'O #PL de UMA posicao, medido no dia de PICO dela. ⚠️ Nao e '
      + 'comparavel com o "#PL do dia", que soma todas as posicoes vivas: no '
      + 'GBranquinho de 2026 o do dia da 1,33 e o por trade 0,74, e a razao 1,80 '
      + 'e exatamente a media de 1,90 ativos carregados por pregao. Os dois '
      + 'estao certos; sao perguntas diferentes.',
    top10: 'O decil de trades com maior #PL — as apostas grandes dele. O valor e '
      + 'quanto esses trades renderam, em bps do NAV. As duas fracoes ao lado '
      + 'medem CONCENTRACAO: quanto do movimento total (soma dos bps em modulo) '
      + 'e quanto do risco total (soma dos #PL) esta nesse decil. '
      + 'NAO e "% do resultado do livro": o resultado liquido e a diferenca entre '
      + 'ganhos e perdas parecidos, entao dividir por ele produz numeros como '
      + '-187% ou 729%, que nao querem dizer nada.',
    extremo: 'O maior ganho e a maior perda de UM ciclo no periodo — extremos '
      + 'observados, nao media nem mediana. Servem para dimensionar a cauda: um '
      + 'livro cujo melhor trade e multiplo do ganho medio ganha por poucos '
      + 'acertos grandes, nao por consistencia. '
      + '⚠️ Na regua de bps, o maior ganho pode ser de um trade DIFERENTE do '
      + 'maior ganho em R$ — o NAV do dia entra no denominador.',
    pernas: 'Quantas PERNAS de DI foram negociadas no periodo. Um contrato '
      + 'comprado e depois vendido conta 2x, porque a corretora cobra nas duas. '
      + 'E o denominador do custo por perna.',
    pregoes: 'Em quantos pregoes do ano ele tinha alguma posicao aberta no '
      + 'fechamento — CONTAGEM de dias, nao fracao. No resto do tempo estava '
      + 'zerado.',
    pl: 'Unidade de tamanho da mesa. #PL = DV01 x 1e4 / NAV, que se le "% do '
      + 'patrimonio do trader por 100 bp de movimento da taxa". #PL 0,50 = a '
      + 'posicao ganha ou perde 0,5% do PL se a curva andar 100 bp. E a unica '
      + 'regua que compara vencimentos: 100 contratos de ODF37 sao ~2x o risco '
      + 'de 100 de ODF31.',
    dv01: 'Quanto a posicao ganha ou perde, em REAIS, se a taxa andar 1 bp. Muda '
      + 'todo dia: depende da taxa de ajuste e dos dias uteis ate o vencimento, e '
      + 'o "du" so encolhe (no ODF27 o DV01 caiu 62% em 2026).',
    bps_nav: 'Resultado do corte em bps do NAV do trader (1 bp = 0,01%). '
      + 'Calculado dia a dia com o NAV DAQUELE dia, nao com o NAV de hoje nem com '
      + 'a media do ano — o NAV andou 14% em 2026. '
      + '⚠️ Nao confundir com BPS DE TAXA, que e movimento da taxa e nao tem NAV '
      + 'nenhum no denominador.',
    bps_taxa: 'QUANTO A TAXA ANDOU a favor dele, em bps, entre o preco medio de '
      + 'entrada e o de saida (VWAP contra VWAP, ponderado por contratos). E o '
      + 'retorno da APOSTA e nao depende de quanto ele apostou. Nao confundir com '
      + 'bps do NAV, que e contribuicao para o fundo. '
      + '⛔ O seletor de regua da barra NAO mexe nesta coluna: ela ja e em bps, '
      + 'mas de OUTRA coisa.',
    giro_dv01: 'Quanto RISCO ele girou naquele vertice, em R$ por bp: o giro de '
      + 'contratos multiplicado pelo DV01 de cada dia. Contar CONTRATOS mentiria '
      + '— o DV01 por contrato vai de R$ 0,72 (ODJ26) a R$ 24,00 (ODF37), 33x.',
    du: 'Dias UTEIS entre a data do trade e o vencimento do contrato (base 252). '
      + 'E o que define o DV01: quanto maior o du, mais o contrato anda por bp.',
    payoff: 'Ganho MEDIO dos vencedores dividido pela perda MEDIA dos perdedores. '
      + 'E um MULTIPLO, nao tem unidade: payoff 1,7 = quando acerta ele ganha 1,7x '
      + 'o que perde quando erra. So se le contra o break-even ao lado — acima '
      + 'dele o perfil ganha dinheiro mesmo errando a maioria das vezes.',
    payoff_par: 'Ganho dividido por perda, nas tres leituras. MEDIA e a regua da '
      + 'casa (e a que entra na expectativa). MEDIANA descreve o trade tipico e '
      + 'ignora os outliers. BREAK-EVEN = (1 - acerto) / acerto: o payoff minimo '
      + 'para o corte nao perder dinheiro. Payoff acima do break-even = fecha.',
    breakeven: 'O payoff MINIMO para o corte empatar, dado o acerto dele: '
      + '(1 - acerto) / acerto. Com 40% de acerto o break-even e 1,50 — abaixo '
      + 'disso nao fecha de jeito nenhum.',
    pf: 'Soma de TODOS os ganhos dividida pela soma de TODAS as perdas, em R$. '
      + 'Acima de 1 o livro ganha dinheiro. 1,06 = ele ganha R$ 1,06 para cada '
      + 'R$ 1,00 que perde. Margem fina.',
    expectativa: 'Quanto ele ganha no trade MEDIO — ja contando os que perderam. '
      + 'Mostrada em BPS DO NAV, que e o que compara entre traders e entre anos: '
      + 'R$ 300 por trade num livro de R$ 23 MM nao e a mesma expectativa que '
      + 'R$ 300 num de R$ 200 MM. O valor em reais vai no detalhe. '
      + '⚠️ Media e mediana podem ter SINAIS OPOSTOS — o trade tipico perde e o '
      + 'livro ganha pela cauda; por isso as duas aparecem.',
    acerto: 'Fracao dos ciclos que terminaram com dinheiro no bolso DEPOIS do '
      + 'custo. Acerto baixo nao e defeito por si: com payoff alto o perfil fecha '
      + 'errando a maioria das vezes.',
    acerto_par: 'LIQUIDO = sobrou dinheiro depois de corretagem e emolumento (e o '
      + 'headline). BRUTO = a taxa andou a favor, independente do custo, e mede a '
      + 'DECISAO direcional. Os dois existem porque sao perguntas diferentes.',
    n: 'Numero de CICLOS de posicao, nao de boletas. Um ciclo e de zero a zero: '
      + 'abre, aumenta, reduz e zera = UM trade, mesmo com 91 boletas dentro.',
    dias: 'Duracao do ciclo em dias CORRIDOS, da abertura ao fechamento. Mediana '
      + 'de 1 dia = metade do livro e daytrade.',
    dd: 'A maior queda da curva de resultado composta, do pico ate o fundo, em '
      + 'bps do NAV. Mede o buraco que o trader teve de aguentar no caminho.',
    composto_OLD: 'Retorno COMPOSTO sobre o NAV, em bps: multiplica (1 + resultado do '
      + 'dia / NAV do dia) ao longo do ano. NAO e a soma dos bps — somar trataria '
      + 'R$ 1 de janeiro e R$ 1 de agosto como a mesma fracao do patrimonio.',
    tempo_risco: 'Em quantos pregoes do ano ele tinha alguma posicao aberta no '
      + 'fechamento. No resto do tempo estava zerado.',
    custo: 'Corretagem + emolumento da B3 + taxa de contraparte, somados da '
      + 'PROPRIA boleta do Sophis (nao e rateio nem estimativa). Sai em R$ e e '
      + 'proporcional ao GIRO, nao ao risco: quem gira mais paga mais.',
    carrego: 'Custo de oportunidade do CAIXA. Ativo a vista (NTN-B, opcao) '
      + 'tira dinheiro do fundo, e esse dinheiro renderia CDI na mao do '
      + 'tesoureiro — o gerencial cobra isso. Incide dia a dia sobre o saldo, '
      + 'do value date da COMPRA (inclusive) ao da VENDA (exclusive). Futuro '
      + 'de DI nao paga: e margem, nao desembolso do principal. Sinal '
      + 'negativo = custo; positivo = o fundo rendeu (posicao vendida).',
    resultado_bcl: 'BRUTO = no futuro de DI e a soma dos AJUSTES DIARIOS DA B3 '
      + '(o dinheiro que de fato entrou e saiu da conta do fundo, dia a dia); nos '
      + 'demais ativos e o movimento de preco + cupom recebido. Do bruto saem a '
      + 'CORRETAGEM (+ emolumento + contraparte) e o CARREGO DO CAIXA (CDI sobre o '
      + 'dinheiro que o ativo a vista prendeu). LIQUIDO = o que sobrou, e e o numero '
      + 'que vale. Numa NTN-B o carrego pode virar o sinal do trade.',
    resultado_taxa: 'A outra regua: quanto a TAXA andou a favor dele, com o prazo '
      + 'congelado na abertura do trade. Nao e o dinheiro — e a medida da DECISAO, '
      + 'limpa do carrego. A diferenca entre ela e o ajuste da B3 e exatamente o '
      + 'custo de carregar a posicao de DI contra o CDI. Num daytrade as duas '
      + 'coincidem, porque nao ha pernoite.',
    sizing_valor: 'Quanto o TAMANHO das apostas acrescentou (ou tirou) de '
      + 'resultado, em bps. E a diferenca entre o resultado real e um '
      + 'contrafactual em que todo trade tivesse o TAMANHO TIPICO DO TIPO DELE. '
      + 'Negativo = ele apostou mais justamente onde errou. '
      + '⭐ O contrafactual reescala o LIQUIDO, nao o bruto: o custo e '
      + 'proporcional ao giro, entao um trade metade do tamanho paga metade da '
      + 'corretagem. E cobre o livro INTEIRO — a opcao entra pela regua de '
      + 'premio, que escala igual (dobrar contratos dobra premio e resultado).',
    direcao_agg: 'APLICADO = apostou em QUEDA de juros; TOMADO = apostou em ALTA. '
      + 'Na boleta do Sophis quantidade > 0 e APLICADO — o oposto do sinal do JRS.',
    corr_tam: 'Correlacao entre o TAMANHO RELATIVO da aposta e o resultado que '
      + 'ela teria NO TAMANHO TIPICO. Positiva = ele concentra risco nos trades '
      + 'bons, que e a habilidade mais rara. Zero = o tamanho nao carrega '
      + 'informacao. ⚠️ O eixo do resultado e NORMALIZADO pelo tamanho de '
      + 'proposito: contra o resultado cru a correlacao seria mecanica — posicao '
      + 'maior gera |resultado| maior sem habilidade nenhuma. '
      + '⭐ Roda no livro INTEIRO: cada ciclo e medido contra a media da regua '
      + 'DELE (#PL no DI e no papel, premio em bps do NAV na opcao), e a razao e '
      + 'adimensional — as duas reguas nunca se somam.',
    corr_tam_taxa: 'A leitura SO DO DI E DO PAPEL: #PL de pico contra o movimento '
      + 'da TAXA em bps. Responde "ele leu a curva?", que e outra pergunta — e '
      + 'nao inclui opcao porque o preco dela nao e taxa. Fica ao lado da de '
      + 'cima para as duas nao serem confundidas.',
    tam_norm: 'TAMANHO RELATIVO: o tamanho do ciclo dividido pela MEDIA dos '
      + 'ciclos da mesma regua. 1,00x e o tipico do tipo dele, 2,00x e o dobro. '
      + '⭐ Existe para pôr books de reguas diferentes no mesmo eixo: no DI e no '
      + 'papel a regua e o #PL (R$/bp / NAV) e na opcao e o premio (R$ / NAV) — '
      + 'os dois numeros nao se comparam, mas as RAZOES sim. '
      + '☠️ Nao confundir com `tam_relativo`, que divide pela MEDIANA e so '
      + 'existe no DI: aquele diz "grande para ele", este diz "grande para o '
      + 'tipo do instrumento".',
    top10: 'Quanto os 10% MAIORES trades somaram, em bps do NAV — maiores pelo '
      + 'TAMANHO RELATIVO, entao a opcao concorre com o DI em pe de igualdade. '
      + 'Diz se as apostas grandes e que fizeram o ano — para o bem ou para o mal.',
    execucoes: 'BOLETAS sao as linhas cruas: a mesma execucao aparece uma vez por '
      + 'fundo (media de 4,02 fundos). EXECUCOES e o numero depois de colapsar '
      + 'esse split — e o numero de negocios de verdade.',
    nav: 'Capital alocado ao trader pela casa, em R$. E o unico numero que este '
      + 'estudo tira do JRS, e entra so como DENOMINADOR de #PL e de bps, nunca '
      + 'como posicao ou resultado.',
    par_mm: 'MEDIA e MEDIANA do mesmo numero. A mediana descreve o caso tipico; a '
      + 'media carrega os outliers. Quando as duas divergem muito, o corte tem um '
      + 'trade grande dentro dele em vez de um habito de tamanho.',
    bps_taxa_terno_OLD: 'MEDIA simples entre ciclos (um trade de 1 contrato pesa igual '
      + 'a um de 4.500) / MEDIANA (o ciclo tipico) / PONDERADA por DV01 x giro. A '
      + 'ponderada e a unica que reproduz o dinheiro de verdade.',
    fee_broker: 'CORRETAGEM: o que a corretora cobra pela execucao. Varia por '
      + 'corretora e e negociada — e a unica das tres taxas sobre a qual a mesa '
      + 'tem alguma alavanca.',
    fee_market: 'CUSTOS OPERACIONAIS: o emolumento da B3 e a taxa de contraparte, '
      + 'somados. Os dois sao custo de mercado e de liquidacao, tabelados e sem '
      + 'alavanca da mesa — ao contrario da corretagem, que e negociada.',
    custo_ct: 'Custo total dividido pelo numero de PERNAS de DI negociadas. Um '
      + 'contrato comprado e depois vendido conta 2x, porque a corretora cobra nas '
      + 'duas. Varia por vencimento: o emolumento da B3 e proporcional ao valor do '
      + 'contrato, entao um ODF31 custa mais que um ODJ26.',
    daytr: 'Quantos dos ciclos do vertice foram DAYTRADE (abriram e zeraram no '
      + 'mesmo dia).',
    venc: 'Data de vencimento do contrato. E ela que define o "du" e, por '
      + 'consequencia, o DV01 de cada dia.',
    quartil: 'Os ciclos ordenados por TAMANHO RELATIVO (contra a media da regua '
      + 'de cada um) e cortados em quatro grupos iguais. Q1 = o quarto das '
      + 'apostas menores, Q4 = o das maiores. '
      + 'Serve para ver se apostar grande deu certo — se o padrao for monotonico '
      + 'de Q1 a Q4, o tamanho carrega informacao; se alternar, e ruido.',
    horizonte: 'DAYTRADE = abriu e zerou no mesmo dia. CARREGOU POSICAO = passou '
      + 'pelo menos uma noite posicionado. Sao dois perfis de risco e de acerto '
      + 'diferentes dentro do mesmo livro.',
    book: 'O tipo de instrumento: futuro de DI, opcao (digital de COPOM e put de '
      + 'IDI) ou NTN-B a vista. Cada um tem regua de exposicao e de resultado '
      + 'propria, por isso ficam separados.',
    contrato: 'O vencimento do futuro de DI. Cada vencimento e um ativo economico '
      + 'diferente: nao se somam contratos de vencimentos distintos, porque o '
      + 'DV01 por contrato e diferente.',
    giro_ct: 'Contratos negociados no corte, somando os dois lados (ida e volta). '
      + 'Nao e comparavel entre vencimentos — para isso use o giro em R$/bp.',
    pico_ct: 'A maior posicao que o ciclo chegou a ter, em contratos, medida no '
      + 'fechamento do dia.',
  };
  /* tip(chave) -> atributos prontos para o rotulo. Devolve string vazia quando a
     chave nao existe, para o call site nao precisar de guarda. */
  const _esc = (t) => t.replace(/"/g, '&quot;');
  const tip = (k) => (GLOSS[k] ? ' class="hastip" title="' + _esc(GLOSS[k]) + '"' : '');

  /* ⚠️ POR QUE O KPI DE CIMA E OS TOTAIS DAS TABELAS NAO BATEM.
     A regua do KPI e DIARIA: marca toda posicao todo pregao, inclusive a que
     ficou ABERTA no fim do ano. As tabelas somam CICLOS, e ciclo aberto fica
     fora — sem perna de saida nao ha "acertou ou errou", nem preco medio de
     saida, nem payoff (§6 do CLAUDE.md).
     ☠️ A 1a versao dizia so "Inclui a marcacao da posicao aberta; a soma dos
     ciclos nas tabelas abaixo, nao." — o usuario perguntou o que aquilo queria
     dizer, e tinha razao: a frase nomeia a diferenca sem mostra-la. Com os tres
     numeros na conta, ela se explica sozinha. */
  /* ☠️ EM BPS A CONTA NAO E A DA 1a LINHA DA FICHA, e a nota tem de dizer isso.
     `bps_compostos` e Π(1 + pnl_dia/NAV) − 1; a decomposicao "fechados +
     aberto" e uma SOMA de bps diarios. As duas sao diferentes pela composicao
     de 2a ordem (§5.1). Escrever "X + Y = resultado composto" seria uma conta
     que nao fecha na tela, e o leitor iria procurar o erro que nao existe. */
  function notaAberto() {
    const n = R.n_abertos || 0;
    if (!n) return '';
    const bps_ = emBps();
    const fech = bps_ ? bps(R.pnl_ciclos_fechados_bps) : kbrl(R.pnl_ciclos_fechados_brl);
    const ab = bps_ ? R.pnl_aberto_bps : R.pnl_aberto_brl;
    const abTxt = bps_ ? bps(Math.abs(ab)) : kbrl(Math.abs(ab));
    const tot = bps_ ? bps(R.pnl_total_bps) : kbrl(R.pnl_total_brl);
    return 'Este número é a régua <b>diária</b>: marca toda posição todo pregão, '
      + 'inclusive ' + (n > 1 ? 'as ' + n + ' que ficaram abertas' : 'a que ficou aberta')
      + ' no fim do período. As tabelas abaixo somam só <b>trades fechados</b>. '
      + 'Daí a conta: ' + fech + ' de ciclos fechados '
      + (ab >= 0 ? '+ ' : '− ') + abTxt + ' da posição aberta = ' + tot + '. '
      + (bps_
          ? '<b>É a SOMA dos bps diários</b> — o resultado composto da primeira '
            + 'linha é Π(1 + resultado do dia ÷ NAV) − 1 e fica ligeiramente '
            + 'diferente; a sobra é a composição de 2ª ordem, não um erro. '
          : '')
      + 'Ciclo sem perna de saída não entra nas estatísticas — não há preço médio '
      + 'de saída nem "acertou ou errou".';
  }

  /* ⭐ FICHA — o modelo que substituiu os KPIs soltos (31/08/2026).
     ☠️ **Cartao isolado nao diz a que grupo pertence.** O Retrato do ano tinha 9
     caixinhas em fila e nada dizia que "Custo" e "Carrego" sao a mesma conta, ou
     que "Acerto" e "Payoff" respondem a mesma pergunta — o leitor reagrupava de
     cabeca. E a fila quebrava em 2-3 linhas conforme a largura, entao a
     vizinhanca mudava de tamanho de janela.

     `linha(rotulo, valor, detalhe, classe, chave_do_glossario, destaque)` e
     `ficha(titulo, linhas, nota)`. A 1a linha de cada ficha e o numero
     PRINCIPAL dela (`dst`), o resto sao os que o qualificam. */
  function linha(k, v, d, cls, tk, dst) {
    if (v == null || v === '' || v === '—') return '';
    return '<div class="fl' + (dst ? ' dst' : '') + '">'
      + '<dt><span' + tip(tk) + '>' + k + '</span>'
      + (d ? '<i>' + d + '</i>' : '') + '</dt>'
      + '<dd class="' + (cls || '').trim() + '">' + v + '</dd></div>';
  }
  function ficha(t, linhas, nota) {
    const corpo = (linhas || []).filter(Boolean).join('');
    if (!corpo) return '';
    return '<section class="ficha"><h4 class="ficha-h">' + t + '</h4>'
      + '<dl>' + corpo + '</dl>'
      + (nota ? '<p class="ficha-n">' + nota + '</p>' : '') + '</section>';
  }
  /* ⭐ ANTI-COLISAO DE ROTULO em nuvem de pontos (31/08/2026).
     ☠️ Todo rotulo saia em 'top center', entao duas bolas proximas escreviam uma
     por cima da outra — o usuario reportou no acerto x payoff ("carregou
     posicao" comendo o losango do livro e o "tomado").
     ⚠️ O Plotly NAO tem desvio de colisao para texto de scatter; o que ele
     aceita e um `textposition` POR PONTO. Entao cada rotulo e empurrado na
     direcao que FOGE dos vizinhos: soma-se o vetor de repulsao dos pontos
     proximos (em coordenadas normalizadas pelo range dos eixos, senao bps e %
     nao sao comparaveis) e escolhe-se a das 4 posicoes mais alinhada com ele.
     ⚠️ `obst` sao pontos que ocupam espaco mas nao levam rotulo — o losango do
     livro inteiro e um deles. */
  function posRotulos(pts, xr, yr, obst) {
    const nx = (v) => (v - xr[0]) / ((xr[1] - xr[0]) || 1);
    const ny = (v) => (v - yr[0]) / ((yr[1] - yr[0]) || 1);
    const P4 = [['top center', 0, 1], ['bottom center', 0, -1],
                ['middle right', 1.35, 0], ['middle left', -1.35, 0]];
    const todos = pts.concat(obst || []);
    return pts.map((p, i) => {
      let dx = 0, dy = 0;
      todos.forEach((q, j) => {
        if (i === j) return;
        const ex = nx(p.x) - nx(q.x), ey = ny(p.y) - ny(q.y);
        const d2 = ex * ex + ey * ey;
        if (d2 < 0.05) { const w = 1 / (d2 + 1e-4); dx += ex * w; dy += ey * w; }
      });
      if (!dx && !dy) return 'top center';
      let nome = 'top center', best = -Infinity;
      P4.forEach((o) => { const sc = o[1] * dx + o[2] * dy;
                          if (sc > best) { best = sc; nome = o[0]; } });
      return nome;
    });
  }
  /* ⭐ PASSE MEDIDO, depois do heuristico. Duas bolas quase coincidentes
     colidem em QUALQUER posicao, e antes de desenhar nao da para saber a
     largura do texto (depende da fonte e do tamanho do card). Aqui as caixas
     sao MEDIDAS no DOM e a que ainda cruza vai girando entre as 8 posicoes ate
     nao cruzar mais.
     ⚠️ Isto usa `Plotly.restyle`, que o CLAUDE.md da raiz proibe em HOVER —
     redesenhar por movimento de mouse pisca. Aqui e um passe UNICO apos o
     `newPlot`, com teto de 8 iteracoes; nao roda em interacao nenhuma. */
  function ajustaRotulos(gd, ti, pos) {
    const CAND = ['top center', 'bottom center', 'middle right', 'middle left',
                  'top right', 'bottom left', 'top left', 'bottom right'];
    for (let it = 0; it < 8; it++) {
      const ns = [...gd.querySelectorAll('.scatterlayer text')];
      if (ns.length !== pos.length) return;
      const rc = ns.map((n) => n.getBoundingClientRect());
      let mudou = false;
      for (let i = 0; i < rc.length && !mudou; i++) {
        for (let j = i + 1; j < rc.length; j++) {
          const a = rc[i], b = rc[j];
          if (a.left < b.right && b.left < a.right
              && a.top < b.bottom && b.top < a.bottom) {
            pos[j] = CAND[(CAND.indexOf(pos[j]) + 1) % CAND.length];
            mudou = true; break;
          }
        }
      }
      if (!mudou) return;
      Plotly.restyle(gd, { textposition: [pos.slice()] }, [ti]);
    }
  }
  /* ⭐ ROTULO CURTO PARA EIXO DE CATEGORIA (01/09/2026).
     ☠️ Quando a aba de Contratos passou a mostrar TODOS os books, a estrutura de
     IDI entrou com nomes de ate 54 caracteres
     (`IDIX9 01/24 P BUTTERFLY 380800/380900/381000 [1:-2:1]`) contra uma margem
     inferior de 28px — e o eixo x virou uma tarja ilegivel, com os rotulos
     comendo uns aos outros.
     ⚠️ Encurta SO o eixo: o nome inteiro continua no hover e no `title` da
     tabela. Truncar com reticencias nao serviria — `IDIX9 01/24 P BUT…` e
     `IDIX9 01/24 P PUT…` ficariam iguais na tela. */
  /* ⭐ A DIGITAL DE COPOM MOSTRA O NOME, NAO O CODIGO (01/09/2026, pedido do
     usuario: "troca para as digitais de copom mostrarem o nome e nao o codigo
     CPM..."). `CPMMV84` nao diz nada; `No Cut jun/26` diz o cenario e a reuniao.
     ⚠️ O codigo NAO some — vai para o `title` da celula e para o hover, que e
     onde se confere contra o Sophis.
     ⛔ So a DIGITAL entra aqui: a estrutura de IDI ja tem `ativo` descritivo
     (e por isso `ativo_nome` vem nulo nela, de proposito — ver `opcoes.nome_de`),
     e quem a encurta e o `rotCurto` abaixo. */
  const _MES3 = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun',
                 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  function _digital(nome) {
    const m = String(nome || '')
      .match(/^Digital\s+Copom\s+(.+?)\s+(\d{2})(\d{2})(\d{2})(_old)?$/i);
    if (!m) return null;
    const im = parseInt(m[3], 10) - 1;
    if (im < 0 || im > 11) return null;
    /* ⚠️ o sufixo `_old` distingue DUAS digitais da MESMA reuniao e mesmo
       strike (`No Hike 250620` e `250620_old`) — sem ele as duas colapsariam
       no mesmo rotulo e o eixo teria duas barras com o mesmo nome. */
    const ant = m[5] ? ' (ant.)' : '';
    return { curto: m[1] + ' ' + _MES3[im] + '/' + m[2] + ant,
             longo: 'Digital Copom ' + m[1] + ' '
                    + m[4] + '/' + m[3] + '/' + m[2] + ant };
  }
  /* rotulo de TABELA (tem largura): nome por extenso na digital, vertice no DI
     e no papel, `ativo` descritivo na estrutura de IDI. */
  function rotLongo(r) {
    const d = _digital(r && r.ativo_nome);
    if (d) return d.longo;
    return String((r && r.vencimento) || (r && r.ativo) || '');
  }
  const _ABREV = [[/BUTTERFLY/i, 'fly'], [/CONDOR/i, 'cdr'],
                  [/PUT SPREAD/i, 'p.spr'], [/CALL SPREAD/i, 'c.spr'],
                  [/ESTRUTURA (\d+)/i, '$1p']];
  function rotCurto(r) {
    const d = _digital(r && r.ativo_nome);
    if (d) return d.curto;
    const v = r && r.vencimento;
    if (v && String(v).length <= 12) return String(v);   // DI (Jan26) e papel (B Ago26)
    const a = String((r && r.ativo) || v || '');
    const m = a.match(/^IDIX\d*\s+(\d{2}\/\d{2})\s+([PC])\s+(.+)$/i);
    if (!m) return a.length <= 14 ? a : a.slice(0, 13) + '…';
    let tipo = m[3];
    for (const [re, ab] of _ABREV) if (re.test(tipo)) { tipo = tipo.replace(re, ab).match(/^\S+/)[0]; break; }
    return 'IDI ' + m[1] + ' ' + tipo.slice(0, 5);
  }
  /* o que vai no HOVER: o rotulo legivel MAIS o codigo cru, porque o eixo so
     tem o curto e e no hover que se confere contra o Sophis. */
  function rotHover(r) {
    const l = rotLongo(r), a = String((r && r.ativo) || '');
    return l && a && l !== a ? l + ' · ' + a : (l || a);
  }
  const fichas = (...fs) => '<div class="fichas">' + fs.filter(Boolean).join('') + '</div>';
  /* ⭐ ORDENACAO POR COLUNA, em TODA tabela (01/09/2026, pedido do usuario).
     Clicar no cabecalho ordena; clicar de novo inverte. Numero comeca do MAIOR
     para o menor (que e o que se quer ver primeiro num ranking); texto comeca em
     A-Z.
     ☠️ **A chave sai da celula RENDERIZADA, nao do campo cru** — e isso e uma
     escolha, nao preguica: quase toda coluna aqui e computada (`par()`,
     `terno()`, `rotLongo()`, o seletor de regua), entao nao existe um `r[k]`
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

  function table(el, cols, rows) {
    if (!el) return;
    const th = cols.map((c, i) => {
      const g = c.tip && GLOSS[c.tip];
      const dentro = g ? '<span class="hastip">' + c.t + '</span>' : c.t;
      return '<th' + (c.num ? ' class="num"' : '') + (g ? ' title="' + _esc(g) + '"' : '') + '>'
        + _thOrd(el.id, cols, i, dentro) + '</th>';
    }).join('');
    const ord = _ordena(el.id, cols, rows);
    const tb = ord.map((r) =>
      '<tr>' + cols.map((c) => {
        const v = c.f ? c.f(r) : r[c.k];
        return `<td class="${c.num ? 'num' : 'lbl'}${c.cls ? ' ' + c.cls(r) : ''}">${v}</td>`;
      }).join('') + '</tr>').join('');
    el.innerHTML = `<thead><tr>${th}</tr></thead><tbody>${tb}</tbody>`;
    _ligaOrd(el, cols, rows, () => table(el, cols, rows));
  }
  const P = () => PALETTE_JGP();
  /* ⚠️ NÃO usar índice da paleta para "negativo": --d1 (PALETTE_JGP[4]) é
     verde-CLARO no padrão JGP, então barra de prejuízo saía verde. A cor de
     negativo da casa é a var --red; a de linha de referência é --s3 (cinza). */
  const NEG = () => cssv('--red');
  const REF = () => cssv('--s3');
  const el = (id) => document.getElementById(id);

  /* ⭐ ZERO ALINHADO NOS DOIS EIXOS (01/09/2026, pedido do usuário: *"nesse
     gráfico de tamanho da posição ao longo do tempo, o 0 do PL e do DV01 deve
     ser alinhado, não tem por que não ser. 0 é 0"*).
     ☠️ Num eixo duplo o Plotly escala cada eixo SOZINHO, então a linha do zero
     de cada um cai numa ALTURA DIFERENTE do mesmo card — e o leitor lê as duas
     séries contra a mesma horizontal. No `figRisco` o DV01 cruzava de TOMADO
     para APLICADO numa altura em que a área de #PL ainda estava cheia; a troca
     de sinal parecia acontecer com o livro montado.
     ⚠️ **Nenhum eixo é CORTADO — os dois são EXPANDIDOS.** O zero vai para a
     fração `f = max(−min / (max − min))` da altura: manda o eixo que mais
     precisa de espaço negativo, e os outros ganham folga vazia. Dado nenhum
     sai da vista, e a altura da barra continua proporcional ao valor (o que a
     nota do `rangemode:'tozero'` do `figCurva` exige é que a base seja o zero,
     não que o eixo termine nele). */
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
    /* ⚠️ teto de 0,9: uma série 100% negativa pediria `f = 1`, o que achataria
       o eixo do companheiro (que é positivo) numa fatia de altura zero. */
    f = Math.min(f, 0.9);
    const FOLGA = 1.06;          // o respiro que o eixo automático daria no topo
    return ext.map(([lo, hi]) => {
      if (f <= 0) return [0, (hi || 1) * FOLGA];
      const alto = Math.max(hi, (-lo * (1 - f)) / f) * FOLGA;
      return [(-f * alto) / (1 - f), alto];
    });
  }
  /* DETALHE = mostrar a quebra bruto × custo × líquido. Default false: a tela é
     LÍQUIDA, e o líquido é o número que interessa. Ver o interruptor no fim. */
  let DETALHE = false;

  /* ── cabeçalho, preenchido quando os dados chegam ──────────────────── */
  function cabecalho() {
    const t = el('pgTitulo');
    const ano = (TA.janela && TA.janela.de) ? String(TA.janela.de).slice(0, 4) : '';
    if (t) {
      t.textContent = TA.trader + ' — ' + (TA.grupo_rotulo || TA.grupo)
        + (ano ? ', ' + ano : '');
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
    document.title = TA.trader + ' — ' + (TA.grupo_rotulo || TA.grupo) + ' · JGP Macro';

    /* ⛔ ONDE a opcao NAO entra — declarado, e com o escopo certo.
       ⚠️ A 1a versao dizia que a pagina inteira excluia opcao, e estava errado:
       a exclusao vale SO para as analises de TAMANHO (#PL, DV01, quartis,
       contrafactual), porque opcao tem exposicao em premio e nao em DV01.
       Resultado, custo, carrego, acerto, payoff e duracao contam a opcao — um
       condor E uma decisao. Dizer "excluindo opcoes" sem qualificar faria o
       leitor descontar o resultado dela do total, que esta la. */
    const ex = TA.excluidos;
    const bx = el('ehExcluidos');
    if (bx) {
      if (ex && ex.n > 0) {
        /* ⚠️ A regua do aviso ACOMPANHA a regua da pagina: opcao nao tem #PL,
           mas tem `bps_nav_liq`, entao nao ha razao para o unico numero deste
           bloco ficar em R$ quando o resto da tela esta em bps. */
        bx.innerHTML = '<b>As análises de tamanho não incluem ' + ex.rotulo + '.</b> '
          + 'São ' + nf(ex.n, 0) + ' trade' + (ex.n > 1 ? 's' : '')
          + ' (resultado líquido ' + K(ex.result_bps, ex.result_brl) + ') que <b>contam</b> '
          + 'no resultado, no custo, no acerto e no payoff, mas ficam fora de '
          + '#PL, DV01, quartis de tamanho e do contrafactual de sizing. '
          /* ⭐ APONTA PARA A SAIDA: a opcao nao ficou sem regua de tamanho —
             ganhou a dela. Sem este link o aviso sugeria que aquele risco
             simplesmente nao e medido em lugar nenhum. */
          /* ⚠️ ERA "os graficos afetados dizem titulos e DI no titulo" — e hoje
             o escopo e uma ETIQUETA no cabecalho de cada secao (papeis e DI ·
             so DI · so opcoes). Aviso que descreve uma tela que nao existe mais
             e pior que aviso nenhum: manda o leitor procurar o que nao ha. */
          + 'Elas têm DUAS réguas próprias: '
          + '<a href="#secOpcoes">o prêmio em bps do NAV</a> e os '
          + '<b>pontos de preço</b> (coluna <i>pts %</i>). '
          + '<span class="mdn">' + ex.motivo
          + '. Cada seção traz no título a etiqueta do que ela cobre.</span>';
        bx.style.display = '';
      } else {
        bx.style.display = 'none';
      }
    }
  }

  /* ── quando o par (trader, grupo) nao tem uma linha ────────────────────
     ⚠️ Caso REAL, nao borda: LAguiar e PAbinader nao operam juros BR. A tela
     tem de DIZER isso — mostrar as abas vazias faria o leitor achar que quebrou,
     e manter a selecao anterior seria pior ainda (numero de outro trader). */
  function telaVazia() {
    VAZIO = true;
    const motivo = TA.semArquivo
      ? '<strong>' + (TA.grupo_rotulo || TA.grupo) + '</strong> ainda não tem motor. '
        + 'O grupo está na lista porque vai existir — mas a régua de exposição e a de '
        + 'resultado dele são outras (nocional e variação cambial no câmbio, curva no '
        + 'swap), então é motor novo, não filtro novo.'
      : '<strong>' + TA.trader + '</strong> não tem nenhuma operação de <strong>'
        + (TA.grupo_rotulo || TA.grupo) + '</strong> no período. '
        + 'Não é erro de carga: o filtro de grupo é um predicado sobre o instrumento, '
        + 'e nenhuma boleta dele casou.';
    document.querySelectorAll('.tab').forEach((p) => {
      p.innerHTML = '<div class="aviso" style="margin-top:18px">' + motivo + '</div>';
    });
    const tb = el('tabbar');
    if (tb) tb.querySelectorAll('.tabbtn').forEach((b, i) => {
      b.style.display = i === 0 ? '' : 'none';
    });
  }

  /* ══════════════════ RETRATO DO ANO ══════════════════ */
  function tabVisao() {
    const S = TA.sizing || {};
    /* ⭐ TRES SUBSECOES, na ordem em que a pergunta se faz: quanto rendeu →
       quanto custou → como foram os trades. Antes eram 9 cartoes em fila.
       ⚠️ Todo numero daqui e LIQUIDO. Com DETALHE, cada linha abre a conta. */
    el('kpisGeral').innerHTML = fichas(
      ficha('Resultado', [
        /* ⚠️ O total DIARIO inclui a marcacao da posicao ABERTA; a soma dos
           ciclos (as tabelas abaixo) nao — ciclo aberto fica fora das
           estatisticas e o `result_brl` dele e o caixa da compra. A nota da
           ficha diz isso, para as duas nao parecerem divergir por erro. */
        /* ⚠️ O BPS vem PRIMEIRO (pedido do usuario, 31/08/2026): e a regua
           comparavel entre traders e entre anos. O financeiro depende do NAV
           alocado, que muda por decisao da casa — R$ 32 mil num livro de R$ 23
           MM nao e o mesmo que R$ 32 mil num de R$ 200 MM. */
        linha('Resultado composto', bps(R.bps_compostos),
            DETALHE ? 'bruto ' + bps(R.bps_compostos_bruto) + ' · sobre o NAV do trader'
                    : 'sobre o NAV do trader, dia a dia',
            sgn(R.bps_compostos), 'composto', true),
        /* ⛔ O RESULTADO TOTAL FICA EM R$ NAS DUAS REGUAS (pedido explicito do
           usuario). E o unico numero da pagina que nao troca de unidade: o
           gestor precisa ver o dinheiro que fez, independente da regua de
           leitura escolhida. Em bps o detalhe passa a trazer o total em bps. */
        /* ☠️ O DETALHE TRAZIA UM SEGUNDO BPS, e ele NAO batia com o de cima:
           `-39,5` embaixo de `-40,3`. Nao era erro de conta — sao duas coisas:
           a linha de cima e o resultado COMPOSTO (multiplica `1+ret` dia a dia)
           e aquele era a SOMA dos bps diarios. A diferenca e a composicao de 2a
           ordem, e ela cresce com o tamanho do resultado.
           ⛔ Dois numeros para a "mesma" coisa no mesmo cartao, sem dizer qual e
           qual, so podia gerar a pergunta que gerou. O bps da ficha e o COMPOSTO
           (§5.1); esta linha existe para dar o REAIS, e e so isso que ela da. A
           diferenca entre as duas reguas esta escrita no tooltip do composto.
           ⚠️ Na quebra o `bruto - custo + carrego` fecha contra a SOMA, nao
           contra o composto — por isso ela sai em R$, onde fecha exato. */
        linha('Em reais', kbrl(R.pnl_total_brl),
            DETALHE ? 'bruto ' + kbrl(R.pnl_bruto_brl) + ' − custo '
                      + kbrl(R.custo_total_brl) + ' + carrego '
                      + kbrl(R.carrego_total_brl)
                    : 'depois de custo e carrego',
            sgn(R.pnl_total_brl), 'resultado_bcl'),
        linha('Pior drawdown', bps(R.pior_drawdown_bps),
            DETALHE ? 'na curva líquida (bruta ' + bps(R.pior_drawdown_bruto_bps) + ')'
                    : 'na curva composta', ' neg', 'dd'),
      ], notaAberto()),

      /* ⚠️ SEM `neg` nas linhas de custo: custo e sempre custo, e pintar tudo
         de vermelho rouba o destaque de onde o sinal informa.
         ⚠️ O CARREGO saiu daqui (pedido do usuario): nao e custo de transacao e
         nao e o que esta ficha responde. Ele continua na conta do resultado e
         na quebra do modo DETALHE. */
      ficha('Custo', [
        linha('Custo total', custoK('total'), pesoCusto(R), '', 'custo', true),
        linha('Corretagem', custoK('broker'),
            custoKalt('broker') + ' · ' + shCusto()[0] + '% do custo',
            '', 'fee_broker'),
        linha('Custos operacionais', custoK('market'),
            custoKalt('market') + ' · ' + shCusto()[1] + '% do custo',
            '', 'fee_market'),
      ]),

      ficha('Os trades', [
        linha('Acerto', pct(R.hit),
            DETALHE ? 'ciclos que sobraram > 0 · bruto ' + pct(R.hit_bruto)
                    : 'ciclos que sobraram > 0 depois do custo', '', 'acerto', true),
        linha('Trades', nf(R.n, 0), R.n_daytrade + ' daytrades', '', 'n'),
        /* ⭐ Conceito com nome tecnico leva a DEFINICAO na 1a linha, nao so no
           tooltip: quem nao sabe o que e payoff nao sabe que precisa passar o
           mouse. O numero de referencia vem depois. */
        /* ⚠️ O payoff acompanha a REGUA: a razao dos bps nao e a razao dos
           reais (o NAV muda ao longo do ano). O BREAK-EVEN ao lado nao troca —
           e (1−acerto)/acerto, adimensional, e serve as duas. */
        linha('Payoff', nf(emBps() ? R.payoff_bps : R.payoff, 2),
            'ganho médio ÷ perda média em ' + ubps() + ' — precisa de '
            + nf(R.payoff_breakeven, 2) + ' para empatar neste acerto',
            (emBps() ? R.payoff_bps : R.payoff) > R.payoff_breakeven ? '' : ' neg',
            'payoff_regua'),
        linha('Profit factor', nf(R.profit_factor, 2),
            'total ganho ÷ total perdido — acima de 1 o livro é positivo', '', 'pf'),
      ]),

      /* ⭐ RESUMO DAS OUTRAS ABAS no retrato (pedido do usuario, 31/08/2026).
         O retrato do ano tem de responder sozinho, sem obrigar a percorrer as 5
         abas — as abas ficam para o detalhe e o grafico. Media E mediana em par,
         como manda a §5.3. */
      ficha('Ganho × perda', [
        linha('Expectativa por trade', K(R.exp_bps, R.exp_brl),
            'mediana ' + K(R.exp_mediana_bps, R.exp_mediana_brl) + ' · '
            + Kalt(R.exp_bps, R.exp_brl) + ' na outra régua',
            sgn(emBps() ? R.exp_bps : R.exp_brl), 'expectativa', true),
        linha('Ganho médio', K(R.ganho_medio_bps, R.ganho_medio),
            'mediana ' + K(R.ganho_mediano_bps, R.ganho_mediano), '',
            emBps() ? 'par_mm_bps' : 'par_mm'),
        linha('Perda média', K(R.perda_media_bps, R.perda_media),
            'mediana ' + K(R.perda_mediana_bps, R.perda_mediana), ' neg',
            emBps() ? 'par_mm_bps' : 'par_mm'),
        linha('Duração média', nf(R.dur_media, 1) + ' d',
            'mediana ' + nf(R.dur_mediana, 0) + ' d · dias corridos', '', 'dias'),
      ]),

      /* ☠️ DUAS REGUAS DE #PL na mesma ficha, e confundi-las PARECE erro de
         conta — o usuario viu 1,33 no dia contra 0,75 por trade e estranhou,
         com razao. A do DIA soma todas as posicoes vivas; a do TRADE e uma
         posicao so. Os rotulos agora dizem qual e qual, e a nota fecha a conta
         com o numero de ativos simultaneos. */
      ficha('Posicionamento', [
        /* ⭐ A MEDIA LIDERA, a mediana vem embaixo (01/09/2026, pedido do
           usuario: "mostre media tb, pra ficar consistente, mostra a mediana
           embaixo como 2a info, nao principal"). ☠️ O motivo e de LEITURA, nao
           de estatistica: as duas linhas seguintes desta MESMA ficha (#PL por
           trade quando acerta / quando erra) ja lideravam com a MEDIA, entao o
           leitor comparava 0,69 (mediana do dia) contra 0,56 (media por trade)
           — reguas diferentes lado a lado, que e exatamente a confusao da
           §5.-27 que os rotulos vieram resolver. As duas continuam na tela;
           mudou qual e o numero grande. */
        linha('#PL do dia — livro inteiro', nf(R.pl_medio_dia, 2),
            'média · mediana ' + nf(R.pl_mediano_dia, 2)
            + ' · máximo ' + nf(R.pl_max_dia, 2), '', 'pl_dia', true),
        linha('#PL por trade — quando acerta', nf(S.pl_medio_vencedor, 2),
            'média · mediana ' + nf(S.pl_mediano_vencedor, 2), '', 'pl_trade'),
        linha('#PL por trade — quando erra', nf(S.pl_medio_perdedor, 2),
            'média · mediana ' + nf(S.pl_mediano_perdedor, 2), '', 'pl_trade'),
        linha('Tempo em risco', pct(R.tempo_em_risco, 0),
            R.pregoes_com_posicao + ' de ' + R.pregoes_total + ' pregões',
            '', 'tempo_risco'),
      ], 'O #PL do dia é maior porque soma as posições vivas: são '
       + nf(R.ativos_por_pregao_medio, 1) + ' ativos por pregão em média (máx '
       + nf(R.ativos_por_pregao_max, 0) + '). Títulos e DI — opção não tem DV01.')
    );

    /* curva composta + drawdown, 2 painéis com x compartilhado */
    const x = D.map((r) => r.data);
    const t = theme();
    /* DUAS curvas quando o DETALHE esta ligado: a bruta (movimento de taxa) e a
       LIQUIDA (o que sobrou). A distancia entre elas E o custo. Mostrar so a
       bruta seria vender um resultado que nao existiu; so a liquida esconderia
       que a decisao de taxa foi boa. */
    Plotly.newPlot(el('figEquity'), [
      ...(DETALHE ? [{ x, y: D.map((r) => r.bps_acum), name: 'composto BRUTO (bps)',
        type: 'scatter', mode: 'lines', line: { color: P()[2], width: 1.4, dash: 'dot' },
        yaxis: 'y',
        hovertemplate: '%{x|%d/%m/%Y}<br>bruto %{y:.1f} bps<extra></extra>' }] : []),
      { x, y: D.map((r) => r.bps_liq_acum),
        name: DETALHE ? 'composto LÍQUIDO (bps)' : 'composto (bps)', type: 'scatter',
        mode: 'lines', line: { color: P()[0], width: 2.2 }, yaxis: 'y',
        customdata: D.map((r) => r.custo_acum),
        hovertemplate: '%{x|%d/%m/%Y}<br><b>%{y:.1f} bps</b>'
                     + '<br>custo acumulado R$ %{customdata:,.0f}<extra></extra>' },
      { x, y: D.map((r) => r.dd_liq * 1e4), name: 'drawdown (bps)', type: 'scatter',
        mode: 'lines', fill: 'tozeroy', line: { color: NEG(), width: 1 },
        fillcolor: 'rgba(200,60,60,.16)', yaxis: 'y2',
        hovertemplate: '%{x|%d/%m/%Y}<br>DD %{y:.0f} bps<extra></extra>' },
    ], baseLayout(t, {
      height: H_FULL(),
      /* ⚠️ DOIS PAINEIS EMPILHADOS (`domain`), nao eixo duplo sobreposto: o
         drawdown vive colado no zero e so desce, e sobrepo-lo a curva composta
         faria as duas se cruzarem sem que nenhuma leitura ganhasse. Empilhado,
         cada painel tem o SEU zero e o eixo x e compartilhado (`anchor: 'y2'`).
         ⚠️ A curva fica em BPS nas duas reguas, de proposito: ela e COMPOSTA
         (multiplica 1 + ret do dia), e composicao so existe sobre uma fracao —
         em reais a mesma serie seria uma soma, que e outra conta. */
      yaxis: { domain: [0.34, 1], title: { text: 'bps do NAV (composto)' },
               zeroline: true },
      yaxis2: { domain: [0, 0.24], title: { text: 'drawdown' } },
      xaxis: { anchor: 'y2' }, showlegend: DETALHE, legend: { orientation: 'h' },
      hovermode: 'x unified',
    }), CFG);

    /* resultado por mês + #PL médio */
    const M = TA.por_mes;
    /* ☠️ bps do MES e a SOMA dos bps DIARIOS, nunca `pnl_do_mes / nav_do_mes`
       — o motor ja divide pelo NAV DAQUELE dia antes de somar (§5.1). E a soma
       dos meses NAO da o composto do ano: falta a composicao de 2a ordem. O
       `.cfonte` do card diz isso por escrito, abaixo. */
    const mv = (r) => (emBps() ? r.bps : r.pnl);
    const mfmt = emBps() ? '%{y:.1f} bps' : 'R$ %{y:,.0f}';
    const mnum = emBps() ? ':.1f' : ':,.0f';
    const mpre = emBps() ? '' : 'R$ ';
    const msuf = emBps() ? ' bps' : '';
    /* ⚠️ `barmode:'relative'` EMPILHA — o extremo do eixo e a soma das barras
       do mes (a de custo e sempre negativa), nao o maior valor de uma delas. */
    const mcu = (r) => (DETALHE ? -(emBps() ? r.custo_bps : r.custo) : 0);
    const [rgMes, rgPlMes] = zeroAlinhado(
      M.map((r) => Math.max(mv(r), 0) + Math.max(mcu(r), 0))
       .concat(M.map((r) => Math.min(mv(r), 0) + Math.min(mcu(r), 0))),
      M.map((r) => r.pl_med).concat(M.map((r) => r.pl_mediana)));
    Plotly.newPlot(el('figMes'), [
      { x: M.map((r) => r.data), y: M.map(mv),
        name: DETALHE ? 'resultado LÍQUIDO' : 'resultado', type: 'bar',
        marker: { color: M.map((r) => (mv(r) < 0 ? NEG() : P()[0])) },
        customdata: M.map((r) => (emBps() ? [r.bps_bruto, r.custo_bps]
                                          : [r.pnl_bruto, r.custo])),
        hovertemplate: '%{x}<br><b>' + mfmt + '</b>'
                     + '<br>bruto ' + mpre + '%{customdata[0]' + mnum + '}' + msuf
                     + ' − custo ' + mpre + '%{customdata[1]' + mnum + '}' + msuf
                     + '<extra></extra>' },
      ...(DETALHE ? [{ x: M.map((r) => r.data),
        y: M.map((r) => (emBps() ? -r.custo_bps : -r.custo)), name: 'custo',
        type: 'bar', marker: { color: 'rgba(200,60,60,.42)' },
        hovertemplate: '%{x}<br>custo ' + mfmt + '<extra></extra>' }] : []),
      /* as DUAS posições centrais do #PL do mês, sobre TODOS os pregões do mês
         (base que mistura tamanho e frequência — é o "risco médio carregado").
         O hover traz também o par calculado só sobre os dias COM posição, que é
         o tamanho limpo de frequência. A queda ao longo do ano aparece nas
         quatro leituras, então o achado não depende de qual se escolhe. */
      { x: M.map((r) => r.data), y: M.map((r) => r.pl_med), name: '#PL médio (mês)',
        type: 'scatter', mode: 'lines+markers', yaxis: 'y2',
        line: { color: P()[2], width: 2 },
        customdata: M.map((r) => [r.pl_med_pos, r.pl_mediana_pos, r.dias_com_pos]),
        hovertemplate: '%{x}<br><b>#PL MÉDIO no mês %{y:.2f}</b>'
                     + '<br>só nos %{customdata[2]} dias com posição:'
                     + '<br>  média %{customdata[0]:.2f} · mediana %{customdata[1]:.2f}<extra></extra>' },
      /* ⚠️ Nasce DESMARCADA (`visible:'legendonly'`): a mediana e a média do #PL
         andam quase juntas na maioria dos meses, e as duas linhas juntas sobre as
         barras poluem o gráfico. Fica um clique na legenda — não some do estudo.
         O par completo (inclusive só nos dias COM posição) segue no hover da
         linha de média, então nada de informação se perde por padrão. */
      { x: M.map((r) => r.data), y: M.map((r) => r.pl_mediana), name: '#PL mediano (mês)',
        type: 'scatter', mode: 'lines+markers', yaxis: 'y2', visible: 'legendonly',
        line: { color: P()[2], width: 2, dash: 'dot' }, marker: { size: 5 },
        hovertemplate: '%{x}<br><b>#PL MEDIANO no mês %{y:.2f}</b><extra></extra>' },
    ], baseLayout(t, {
      height: H_HALF(), barmode: 'relative',
      yaxis: { title: { text: uni() }, zeroline: true, range: rgMes },
      yaxis2: { title: { text: '#PL' }, overlaying: 'y', side: 'right',
                showgrid: false, range: rgPlMes },
      legend: { orientation: 'h' },
    }), CFG);

    /* ── AS DUAS TABELAS DE CORTE ────────────────────────────────────────
       ⚠️ `colsStat` e montada A CADA render porque depende de DETALHE — nao
       pode ser constante de modulo. Sem detalhe: uma coluna de resultado
       (liquida) e uma de bps. Com detalhe: a celula `bruto − custo = liquido`
       e o par de bps. */
    const colsStat = [
      { t: 'n', num: 1, f: (r) => nf(r.n, 0), tip: 'n' },
      DETALHE
        ? { t: 'acerto<br><i>líquido / bruto</i>', num: 1, tip: 'acerto',
            f: (r) => par(r.hit, r.hit_bruto, (v) => pct(v)) }
        : { t: 'acerto', num: 1, f: (r) => pct(r.hit), tip: 'acerto' },
      /* ⚠️ payoff e uma RAZAO, mas as parcelas dela nao sao: em bps do NAV o
         payload traz o par proprio (`payoff_bps`), que nao e o mesmo numero do
         financeiro quando o NAV andou dentro do ano. */
      { t: 'payoff<br><i>média / mediana</i>', num: 1, tip: 'payoff',
        f: (r) => (emBps() ? par(r.payoff_bps, r.payoff_mediana_bps)
                           : par(r.payoff, r.payoff_mediana)) },
      { t: 'break-even', num: 1, f: (r) => nf(r.payoff_breakeven, 2), tip: 'breakeven' },
      /* ⚠️ ganho, perda e expectativa SEGUEM A REGUA (§5.-37): em bps do NAV a
         coluna sai em bps. O payload traz o par `_bps` de cada uma justamente
         para isso — nao se reescala aqui. */
      { t: 'ganho<br><i>média / mediana</i>', num: 1, tip: 'ganho',
        f: (r) => KP(r.ganho_medio_bps, r.ganho_mediano_bps, r.ganho_medio, r.ganho_mediano) },
      { t: 'perda<br><i>média / mediana</i>', num: 1, tip: 'perda', cls: () => 'neg',
        f: (r) => KP(r.perda_media_bps, r.perda_mediana_bps, r.perda_media, r.perda_mediana) },
      { t: 'expectativa<br><i>média / mediana</i>', num: 1, tip: 'exp',
        cls: (r) => sgn(r.exp_brl).trim(),
        f: (r) => KP(r.exp_bps, r.exp_mediana_bps, r.exp_brl, r.exp_mediana_brl) },
      { t: 'bps taxa<br><i>média / mediana / <b>ponderada</b></i>', num: 1,
        tip: 'bps_taxa_terno',
        f: (r) => terno(r.bps_taxa_medio, r.bps_taxa_mediano, r.bps_taxa_ponderado) },
      /* ⭐ O EQUIVALENTE DA OPCAO (01/09/2026, pedido do usuario). A opcao nao
         entra em `bps taxa` — e nao deve: o preco dela nao e taxa. ✅ Aferido
         que ela ja sai NULA (nao zero) ali, entao nunca puxou a media.
         ⛔ Coluna SEPARADA, nunca dentro da de bps taxa: sao unidades diferentes
         e somar as duas verticalmente nao quer dizer nada. */
      /* ☠️ **NAO SOMA** (01/09/2026, apontado pelo usuario: "nao faz sentido
         aqui a soma dos pontos no caso das opcoes"). A coluna somava, e a soma
         dava peso 1 a cada ciclo: no EMota 2026 o `-16,0 pt` de 7.895 contratos
         (-R$ 126 mil) pesava MAIS que o `-13,4 pt` de 51.500 (-R$ 690 mil), e um
         condor de 108.000 contratos girados entrava com 0,0 pt. O `-38,4 pt` da
         celula nao era dinheiro, nem movimento tipico, nem comparavel entre
         recortes. ⭐ Hoje e o MESMO terno de `bps taxa` — media / mediana /
         ponderada —, porque o problema e identico: movimento de preco com
         tamanhos diferentes atras. A ponderada usa R$/ponto x giro/2 e
         RECONCILIA com o dinheiro (identidade exata nos 118 ciclos da base). */
      { t: 'pts %<br><i>média / mediana / <b>ponderada</b></i>', num: 1, tip: 'pts_col',
        f: (r) => (r.result_pts_mediano == null ? '—'
                   : terno(r.result_pts_medio, r.result_pts_mediano,
                           r.result_pts_ponderado)) },
      { t: '#PL<br><i>média / mediana</i>', num: 1, tip: 'pl_trade',
        f: (r) => par(r.pl_medio, r.pl_mediano) },
      { t: 'dias<br><i>média / mediana</i>', num: 1, tip: 'duracao',
        f: (r) => par(r.dur_media, r.dur_mediana, (v) => nf(v, 1)) },
    ].concat(colsResultado());
    table(el('tblHorizonte'),
      [{ t: 'horizonte', f: (r) => r.horizonte, tip: 'horizonte' }].concat(colsStat),
      TA.por_horizonte);
    table(el('tblBook'),
      [{ t: 'book', f: (r) => r.rotulo || r.book, tip: 'book' }].concat(colsStat),
      TA.por_book);
  }

  /* ══════════════════ TAMANHO & RISCO ══════════════════ */
  function tabPortfolio() {
    /* ⚠️ o decil da ficha de Concentração vem do `sizing_skill` (o mesmo `S` do
       `blocoSizing`), não do `resumo` — lido aqui porque a ficha mora na 1ª
       faixa da seção, com as outras duas de tamanho carregado. */
    const S = TA.sizing || {};
    /* cada KPI de posição central traz a irmã no rodapé, nomeada por extenso */
    /* ⛔ Tudo aqui e a regua de TAMANHO — logo, sem opcao (ver `_base_tamanho`
       no report.py). A ficha diz isso na nota, porque o leitor que ve "#PL
       mediano 0,40" tem de saber sobre que base. */
    el('kpisRisco').innerHTML = fichas(
      ficha('Exposição do dia — livro inteiro', [
        /* ⭐ MEDIA no numero grande, mediana embaixo — a MESMA ordem da ficha
           de Posicionamento do Retrato (pedido do usuario, 01/09/2026). Duas
           fichas mostrando o mesmo `#PL do dia` com reguas de destaque
           diferentes e o que faz o leitor achar que os numeros divergem.
           ⚠️ O rotulo deixou de ser "#PL mediano": ele nomeava a regua, e a
           regua agora esta no subtitulo com a irma ao lado (§5.3).
           ⚠️ o glossario "% do PL por 100 bp, nos dias com posicao" saiu daqui
           (pedido do usuario): a definicao ja mora no tooltip `pl` e na aba
           "Como e medido", e repeti-la empurrava a mediana para o fim da linha. */
        linha('#PL do dia', nf(R.pl_medio_dia, 2),
            'média · mediana ' + nf(R.pl_mediano_dia, 2),
            '', 'pl', true),
        linha('#PL máximo', nf(R.pl_max_dia, 2),
            'maior exposição do ano — não é média nem mediana', '', 'pl'),
        /* ⚠️ O DV01 em REAIS so aparece na regua FINANCEIRA (pedido do usuario,
           01/09/2026). Na regua de bps a ficha inteira ja fala em #PL — que e o
           proprio DV01 normalizado pelo NAV —, entao a linha em R$ repete a
           mesma informacao noutra unidade e convida a somar duas escalas.
           ⭐ Em reais ela volta, porque ali e a unica linha que da a MAGNITUDE
           absoluta do risco. */
        /* ⚠️ media primeiro aqui tambem: e o MESMO numero da linha de cima em
           outra unidade (DV01 = #PL x NAV / 1e4), entao liderar com mediana
           enquanto o #PL lidera com media poria as duas reguas na mesma ficha. */
        emBps() ? '' : linha('DV01 do dia', kbrl(R.dv01_medio_dia) + '/bp',
            'média · mediana ' + kbrl(R.dv01_mediano_dia) + '/bp · máximo '
            + kbrl(R.dv01_max_brl) + '/bp',
            '', 'dv01'),
      ], 'Títulos e DI. Opção não tem DV01, então fica fora desta régua.'),

      ficha('Presença no mercado', [
        linha('Pregões com posição', nf(R.pregoes_com_posicao, 0),
            'de ' + R.pregoes_total + ' no ano — contagem, não média', '', 'pregoes', true),
        linha('Tempo em risco', pct(R.tempo_em_risco, 0),
            'fração dos pregões com o livro montado', '', 'tempo_risco'),
        /* ⭐ ESTE NÚMERO SÓ EXISTIA DENTRO DE UMA FRASE (02/09/2026): era a
           reconciliação do §5.-27 escrita na nota da ficha de tamanho por trade
           ("...que soma as 1,8 posições vivas em média"). É um fato de PRESENÇA
           NO MERCADO e merece linha própria — e é ele que fecha a conta entre o
           `#PL do dia` (livro inteiro) e o `#PL por trade` (uma posição). */
        linha('Posições vivas por pregão', nf(R.ativos_por_pregao_medio, 1),
            'média nos dias com posição — é o que separa o #PL do dia do #PL por trade',
            '', 'pl_dia'),
      ]),

      /* ⭐ **CONCENTRAÇÃO virou ficha** (02/09/2026, pedido do usuário: *"reorganiza
         essas infos, não está bem formatado; os 2 primeiros blocos muito longos, os
         de baixo pequenos"*). Era a 4ª linha de "Existe relação?" — o que deixava
         aquela ficha com 4 linhas contra 2 das vizinhas — e as duas frações viviam
         AMASSADAS no subtítulo, que quebrava em duas linhas.
         ⚠️ O número grande continua sendo o ABSOLUTO, e isso é o §5.-20: fração de
         um líquido quase zero explode (deu −187% no PAlves). As duas frações rodam
         sobre bases que não trocam de sinal, então podem ser linha. */
      (S.top10pct_bps == null ? '' : ficha('Concentração', [
        linha('Os 10% maiores', bps(S.top10pct_bps),
            'o que os ' + nf(S.top10pct_n, 0) + ' maiores trades fizeram, em bps do NAV',
            sgn(S.top10pct_bps), 'top10', true),
        linha('Fatia do movimento', pct(S.top10pct_share_mov, 0),
            'Σ |bps| do decil ÷ Σ |bps| de todos', '', 'top10'),
        linha('Fatia do risco', pct(S.top10pct_share_risco, 0),
            'Σ #PL do decil ÷ Σ #PL de todos', '', 'top10'),
      ], 'O número grande é o resultado ABSOLUTO do decil, não uma fração do '
       + 'líquido — dividir por um líquido quase zero explode.'))
    );

    const x = D.map((r) => r.data);
    const t = theme();
    /* ⛔ **ESTE GRAFICO DEIXOU DE TER EIXO DUPLO** (01/09/2026). Ele mostrava
       `#PL` a esquerda e `DV01 R$/bp` a direita — e as duas sao A MESMA SERIE,
       uma dividida pelo NAV do dia. O eixo da direita nao trazia informacao
       nova; trazia um SEGUNDO ZERO, em outra altura, e foi isso que o usuario
       viu ("o 0 do PL e do DV01 deve ser alinhado, 0 e 0").
       ⭐ A resposta certa nao era alinhar dois zeros: era **deixar a REGUA
       decidir a unidade**, como ja mandam o §5.-33 (o DV01 em R$ sai da ficha
       no modo bps, porque #PL ja e o DV01 sobre o NAV) e o §5.-39. Em bps a
       tela fala #PL; em reais, R$/bp. Um eixo, um zero.
       ☠️ **E a serie estava ERRADA, nao so mal escalada.** O `dv01_liq` somava
       `dv01_brl`, que ja vem em MODULO — logo ele NUNCA ficava negativo, e a
       linha rotulada *"DV01 liquido — + = tomado"* desenhava um livro sempre
       tomado. Aferido depois da correcao: **os 26 payloads** tem pregao com
       liquido negativo, e AJakurski 2022/2024/2026 sao INTEIRAMENTE aplicados.
       ⭐ As duas pontas viraram AREAS (tomado acima do zero, aplicado abaixo),
       com o liquido em linha por cima: `tom + apl` e o liquido e `tom − apl` e
       o risco carregado, entao o grafico responde tamanho E direcao de uma vez.
       Antes, com uma area de MODULO, um spread perfeito (ECotrim 2024, razao
       124.744×) aparecia como um livro cheio e direcional. */
    const ex = (r) => (emBps() ? r.pl_liq : r.dv01_liq);
    const eT = (r) => (emBps() ? r.pl_tom : r.dv01_tom);
    const eA = (r) => (emBps() ? r.pl_apl : r.dv01_apl);
    const uex = emBps() ? '#PL' : 'DV01 R$/bp';
    const fex = emBps() ? '%{y:.2f}' : 'R$ %{y:,.0f}/bp';
    const fcd = emBps() ? '%{customdata[0]:.2f}' : 'R$ %{customdata[0]:,.0f}';
    Plotly.newPlot(el('figRisco'), [
      { x, y: D.map(eT), name: 'tomado', type: 'scatter', mode: 'lines',
        fill: 'tozeroy', line: { color: NEG(), width: 0.8 },
        fillcolor: 'rgba(200,60,60,.20)',
        hovertemplate: 'tomado ' + fex + '<extra></extra>' },
      { x, y: D.map(eA), name: 'aplicado', type: 'scatter', mode: 'lines',
        fill: 'tozeroy', line: { color: P()[0], width: 0.8 },
        fillcolor: 'rgba(0,110,80,.20)',
        hovertemplate: 'aplicado ' + fex + '<extra></extra>' },
      /* ⚠️ o liquido e a SOMA das duas areas, entao ele anda por dentro delas —
         e onde as duas existem no mesmo dia, a distancia ate a borda e a ponta
         que esta sendo compensada (a inclinacao carregada). */
      { x, y: D.map(ex), name: 'líquido (+ = tomado)', type: 'scatter',
        mode: 'lines', line: { color: cssv('--ink'), width: 1.6 },
        customdata: D.map((r) => [(emBps() ? r.pl : r.dv01_brl)]),
        hovertemplate: '<b>líquido ' + fex + '</b>'
                     + '<br>risco carregado (módulo) ' + fcd + '<extra></extra>' },
    ], baseLayout(t, {
      height: H_FULL(),
      /* ⭐ o zero e UM so, e por isso ele nao precisa de conserto: a linha cinza
         e a fronteira entre tomado e aplicado, e vale para tudo que esta no
         card. `zeroline` explicito porque o gráfico existe para essa fronteira. */
      yaxis: { title: { text: uex }, zeroline: true,
               zerolinecolor: REF(), zerolinewidth: 1 },
      legend: { orientation: 'h' }, hovermode: 'x unified',
    }), CFG);

    /* ☠️ O `figCusto` era desenhado AQUI, e o elemento dele mora em
       `<section id="tab-custo">`. Como `drawn` e por aba, abrir a aba **Custo**
       sem passar antes por "Tamanho & risco" deixava o card VAZIO — e o
       seletor de regua, que re-renderiza so a aba ativa, faria o card parecer
       quebrado a cada troca. Hoje ele e desenhado pelo `tabCusto`. */

    const vivos = D.filter((r) => r.pl > 0).map((r) => r.pl);
    Plotly.newPlot(el('figPlDist'), [
      { x: vivos, type: 'histogram', nbinsx: 24, marker: { color: P()[0] },
        hovertemplate: '#PL %{x}<br>%{y} pregões<extra></extra>' },
    ], baseLayout(t, {
      height: H_HALF(), xaxis: { title: { text: '#PL' } },
      yaxis: { title: { text: 'pregões' } }, showlegend: false,
    }), CFG);

    /* onde na curva: por vértice, ordenado por du.
       ⚠️ O giro é em DV01 R$/bp, NÃO em contratos. Contrato não é unidade
       comparável entre vencimentos — o DV01 por contrato vai de ~4 R$/bp num
       ODN26 a ~24 num ODF37, então contar contrato faz a ponta curta parecer
       várias vezes maior do que o risco que ela foi. O `giro_dv01_brl` já vem
       do motor como `giro_contratos × dv01_contrato`, somado por vértice. */
    /* ☠️ Ordenar por `du_mediano` PÕE O EIXO FORA DE ORDEM: o `du` é medido na
       data do trade, então um Jan27 negociado cedo tem du maior que um Abr27
       negociado tarde — e Abr27 aparecia antes de Jan27. Ordem alfabética não
       resolve (Apr27 < Jan27). A régua é a data de VENCIMENTO. */
    /* ⛔ **A OPCAO SAI DAQUI** (01/09/2026, pedido do usuario: "onde ele opera
       na curva na secao 04 precisamos tirar as opcoes"). Este grafico responde
       *onde na CURVA*, e o eixo dele e o giro em **DV01/#PL** — duas coisas que
       a opcao nao tem: ela nao ocupa vertice de curva (uma digital de COPOM e
       uma aposta na REUNIAO, nao num prazo) e a exposicao dela e premio, nao
       R$/bp. 📏 Medido no EMota 2026: as 5 opcoes entravam com barra de giro
       **ZERO** e ocupavam 5 das 12 categorias — 40% do eixo sem nada no eixo
       principal, so o ponto de resultado boiando sobre um vertice inventado.
       ⭐ A lista NAO e escrita a mao: sai de `TA.excluidos.books`, o mesmo
       registro (`ta/books.py`, `exposicao != "dv01"`) que ja tira a opcao dos
       quartis e do contrafactual. Quando chegar um book de cambio, ele sai
       daqui sozinho. A regua propria da opcao continua no bloco de premio. */
    const _semDv01 = new Set((TA.excluidos && TA.excluidos.books) || []);
    const C = TA.por_contrato.filter((r) => !_semDv01.has(r.book))
      .sort((a, b) => String(a.maturity || '').localeCompare(String(b.maturity || '')));
    /* ☠️ O EIXO CORTAVA AS PALAVRAS (01/09/2026, reportado pelo usuario: "esta
       comendo a legenda do eixo x, cortando palavras"). Desde que a aba passou
       a trazer TODOS os books, este eixo recebia o `ativo` cru da opcao — ate
       54 caracteres (`IDIX9 01/26 P BUTTERFLY 482800/482900/483000 [1:-2:1]`)
       contra `margin.b` de 28px: os rotulos saiam da area, sobravam pedacos
       ("-ERE") e encostavam na legenda. ⭐ A cura ja existia e nao estava
       ligada aqui — `rotCurto`, escrito para o `figContratos`, mais o mesmo
       trio `tickangle` + `automargin` + `tickfont` daquele grafico. O nome
       inteiro (e o codigo) continua no hover. */
    const cx = C.map(rotCurto);
    const chover = C.map(rotHover);
    /* ⭐ zero do giro e zero do resultado na MESMA horizontal — ver `zeroAlinhado` */
    const [rgGiro, rgRes] = zeroAlinhado(
      C.map((r) => (emBps() ? r.giro_pl : r.giro_dv01_brl)),
      C.map((r) => (emBps() ? r.total_bps : r.total_brl)));
    Plotly.newPlot(el('figCurva'), [
      /* ⭐ COR SEPARA NOMINAL DE REAL (01/09/2026). O papel entrou na curva
         (pedido do usuario) e ele NAO e o mesmo eixo: NTN-B e taxa REAL e DI e
         NOMINAL. Um `B Ago28` ao lado de um `Jan28` sem marca convidaria a
         le-los como o mesmo vertice — daí o prefixo `B` no rotulo E a cor. */
      { x: cx, y: C.map((r) => (emBps() ? r.giro_pl : r.giro_dv01_brl)),
        name: emBps() ? 'giro (#PL)' : 'giro (R$/bp de DV01)', type: 'bar',
        marker: { color: C.map((r) => (r.book === 'titulo' ? P()[4] || P()[1] : P()[2])) },
        customdata: C.map((r, i) => [r.giro_contratos, r.dv01_mediano, r.dv01_medio,
                                     r.n, chover[i]]),
        hovertemplate: '<b>%{customdata[4]}</b><br>giro '
                     + (emBps() ? '%{y:.1f} #PL' : 'R$ %{y:,.0f}/bp')
                     + '<br>%{customdata[0]:,.0f} contratos'
                     + '<br>DV01 do trade — mediana R$ %{customdata[1]:,.0f}/bp'
                     + ' · média R$ %{customdata[2]:,.0f}/bp'
                     + '<br>%{customdata[3]} ciclos<extra></extra>' },
      /* ⭐ O GIRO TAMBEM SEGUE A REGUA (01/09/2026, pedido do usuario: "na
         regua de bps do NAV deve ser o total de PLs girados, e nao o total de
         DV01"). ⚠️ O `giro_pl` NAO e `giro_dv01_brl / NAV`: e somado dia a dia
         sobre o NAV DAQUELE dia (§5.1), porque o giro de janeiro pesa contra um
         patrimonio diferente do de agosto. */
      { x: cx, y: C.map((r) => (emBps() ? r.total_bps : r.total_brl)),
        name: 'resultado (' + uni() + ')', type: 'scatter', mode: 'markers', yaxis: 'y2',
        marker: { color: C.map((r) => ((emBps() ? r.total_bps : r.total_brl) < 0
                                       ? NEG() : P()[0])), size: 11 },
        customdata: chover,
        hovertemplate: '<b>%{customdata}</b><br>resultado '
                     + (emBps() ? '%{y:.1f} bps' : 'R$ %{y:,.0f}') + '<extra></extra>' },
    ], baseLayout(t, {
      height: H_HALF(),
      /* ⚠️ `rangemode: 'tozero'` é obrigatório aqui: o eixo automático do Plotly
         corta a base e a ALTURA DA BARRA deixa de ser proporcional ao giro —
         num gráfico cujo ponto é comparar tamanho entre vértices, isso mente. */
      /* ⚠️ `range` NAO desfaz o que o `rangemode:'tozero'` protegia: a barra
         continua nascendo no zero e a altura dela segue proporcional ao valor.
         O que aquela nota proibia era o eixo automatico CORTAR a base num
         positivo — o `zeroAlinhado` so acrescenta folga VAZIA abaixo do zero. */
      yaxis: { title: { text: emBps() ? 'giro (#PL)' : 'giro R$/bp' }, range: rgGiro },
      yaxis2: { title: { text: uni() }, overlaying: 'y', side: 'right', showgrid: false,
                zeroline: true, range: rgRes },
      /* ⚠️ `automargin` sozinho cresce a margem mas NAO afasta os rotulos entre
         si — quem faz isso e o ANGULO. ⭐ E aqui ele e **-90**, nao os -45 do
         `figContratos`, porque este eixo tem DUAS variaveis que o outro nao
         tem: o card e METADE da largura (732px medidos contra ~1.490px) e o
         numero de categorias muda por trader (10 no ECotrim, **17 no PAlves**).
         Em angulo obliquo a pegada horizontal e `comprimento x cos(θ)`, entao
         cada combinacao (largura x nº de vertices) exige um θ diferente —
         medido: a -45 colidiam ate 6 rotulos, a -60 ainda 6 no PAlves a 1280px.
         ⭐ A **-90 a pegada deixa de depender do comprimento** (vira a altura da
         linha, ~12px) e o eixo passa a ser correto por construcao enquanto a
         passada for maior que isso — na pior combinacao da base ela e ~22px.
         O `margin.b` e o piso; o `automargin` sobe dali conforme o rotulo. */
      xaxis: { tickangle: -90, automargin: true, tickfont: { size: 9 } },
      margin: { b: 96 },
      /* ☠️ **`legend: {orientation:'h'}` SOZINHO JOGA A LEGENDA PARA BAIXO** —
         e foi ela que os rotulos estavam "comendo" (01/09/2026). O `baseLayout`
         do `plotly-jgp` faz `Object.assign`, que substitui o OBJETO INTEIRO:
         passar so a orientacao descarta o `yanchor:'bottom', y:1.0` da casa, e
         o Plotly cai no default dele, que e ABAIXO do eixo x. Medido aqui: a
         legenda em y 3762-3791 contra rotulos em 3739-3793 — 6 colisoes.
         ⚠️ Nao e exclusivo deste grafico (sao 11 no arquivo), mas so aqui o
         eixo x tem rotulo longo e inclinado disputando a mesma faixa. Onde o
         rotulo e curto a legenda embaixo nao encosta em nada e fica como esta
         — mexer nas 11 moveria a legenda de toda a tela sem ninguem ter pedido. */
      legend: { orientation: 'h', yanchor: 'bottom', y: 1.0, xanchor: 'left', x: 0 },
    }), CFG);

    /* as DUAS réguas de tamanho, explicitamente rotuladas: a mediana descreve o
       trade típico do corte, a média carrega o outlier. Antes a coluna dizia só
       "#PL med" e o leitor não sabia qual das duas estava lendo. */
    table(el('tblDirecao'), [
      { t: 'direção', f: (r) => r.direcao, tip: 'direcao_agg' },
      { t: 'n', num: 1, f: (r) => nf(r.n, 0), tip: 'n' },
      { t: 'acerto', num: 1, f: (r) => pct(r.hit) },
      { t: 'payoff<br><i>média / mediana</i>', num: 1, f: (r) => par(r.payoff, r.payoff_mediana) },
      { t: 'bps taxa<br><i>média / mediana / <b>ponderada</b></i>', num: 1,
        tip: 'bps_taxa_terno',
        f: (r) => terno(r.bps_taxa_medio, r.bps_taxa_mediano, r.bps_taxa_ponderado) },
      /* ⭐ O EQUIVALENTE DA OPCAO (01/09/2026, pedido do usuario). A opcao nao
         entra em `bps taxa` — e nao deve: o preco dela nao e taxa. ✅ Aferido
         que ela ja sai NULA (nao zero) ali, entao nunca puxou a media.
         ⚠️ Faltava o outro lado: sem uma coluna propria, o recorte de opcao
         ficava com um traco e nada. `pts %` e a regua dela — cada ponto do preco
         e um ponto PERCENTUAL (de probabilidade na digital, de payoff na
         estrutura de IDI). ⛔ Coluna SEPARADA, nunca dentro da de bps taxa: sao
         unidades diferentes e somar as duas verticalmente nao quer dizer nada. */
      /* ☠️ **NAO SOMA** (01/09/2026, apontado pelo usuario: "nao faz sentido
         aqui a soma dos pontos no caso das opcoes"). A coluna somava, e a soma
         dava peso 1 a cada ciclo: no EMota 2026 o `-16,0 pt` de 7.895 contratos
         (-R$ 126 mil) pesava MAIS que o `-13,4 pt` de 51.500 (-R$ 690 mil), e um
         condor de 108.000 contratos girados entrava com 0,0 pt. O `-38,4 pt` da
         celula nao era dinheiro, nem movimento tipico, nem comparavel entre
         recortes. ⭐ Hoje e o MESMO terno de `bps taxa` — media / mediana /
         ponderada —, porque o problema e identico: movimento de preco com
         tamanhos diferentes atras. A ponderada usa R$/ponto x giro/2 e
         RECONCILIA com o dinheiro (identidade exata nos 118 ciclos da base). */
      { t: 'pts %<br><i>média / mediana / <b>ponderada</b></i>', num: 1, tip: 'pts_col',
        f: (r) => (r.result_pts_mediano == null ? '—'
                   : terno(r.result_pts_medio, r.result_pts_mediano,
                           r.result_pts_ponderado)) },
      { t: '#PL<br><i>média / mediana</i>', num: 1, tip: 'pl',
        f: (r) => par(r.pl_medio, r.pl_mediano) },
      { t: 'DV01<br><i>média / mediana</i>', num: 1, f: (r) => par(r.dv01_medio, r.dv01_mediano, (v) => nf(v, 0)) },
      { t: 'giro R$/bp', num: 1, f: (r) => nf(r.giro_dv01_brl, 0), tip: 'giro_dv01' },
    ].concat(colsResultado()), TA.por_direcao);
    blocoSizing();
    blocoPremio();
  }

  /* ══════════ ④ O TAMANHO DAS OPCOES — premio em bps do NAV ══════════
     Pedido do usuario: "o que devemos olhar nesses casos é o quanto de bps do
     nav colocamos de premio".
     ⛔ REGUA PROPRIA, BLOCO PROPRIO. Premio e R$ de premio sobre o NAV; #PL e
     R$/bp sobre o NAV. Nao se somam, nao dividem coluna e nao entram no mesmo
     grafico — e a confusao que a §5.-27 corrigiu, e ela custou uma pergunta do
     usuario ("me parece incoerente").
     ⚠️ O bloco SOME quando o trader nao tem opcao no ano: mostrar tres tracos e
     um grafico vazio nao informa nada. */
  function blocoPremio() {
    const S = TA.sizing || {};
    const tem = (R.n_premio || 0) > 0;
    const sec = el('secOpcoes'), cards = el('cardsPremio'), tb = el('tblPremio');
    [sec, cards, el('kpisPremio'), tb && tb.parentElement].forEach((e) => {
      if (e) e.style.display = tem ? '' : 'none';
    });
    if (!tem) return;

    /* ⚠️ `n_sem_teto` NAO e detalhe: sem teto derivavel o risco maximo nao
       existe, e a ficha DIZ isso em vez de assumir 100 (regra da §5.-24). */
    const semTeto = R.n_sem_teto || 0;
    el('kpisPremio').innerHTML = fichas(
      /* ⭐ MEDIA no numero grande, mediana embaixo — as TRES linhas de destaque
         deste bloco (01/09/2026, pedido do usuario: "a secao 5 do Tamanho &
         risco fugiu do padrao geral da pagina"). Era o ultimo bloco da tela
         ainda liderando com mediana; §5.-53 ja tinha virado o #PL e a duracao.
         ⛔ O par continua obrigatorio (§5.3) — mudou QUAL dos dois e o grande. */
      ficha('Prêmio na mesa', [
        linha('Prêmio por trade', bps(R.premio_bps_medio),
            'média · mediana ' + bps(R.premio_bps_mediano)
            + ' · maior ' + bps(R.premio_bps_max), '', 'premio', true),
        linha('Prêmio somado', bps(R.premio_bps_soma),
            kbrl(R.premio_brl_soma) + ' em ' + nf(R.n_premio, 0) + ' trades',
            '', 'premio'),
        /* ⭐ A regua NATURAL da opcao: cada ponto do preco e um ponto percentual
           de probabilidade (digital) ou de payoff (estrutura de IDI, teto 100). */
        /* ☠️ Era "pontos SOMADOS no ano" e a soma nao queria dizer nada
           (mesma razao da coluna `pts %`): ela dava peso 1 a cada ciclo, entao
           uma digital de 7.895 contratos empurrava o total mais que um condor
           de 51.500. ⭐ O headline agora e a PONDERADA por R$/ponto x giro —
           o movimento que, aplicado ao livro inteiro, da o resultado em R$. */
        linha('Pontos capturados', nf(R.result_pts_ponderado, 1) + ' pt',
            'ponderado pelo tamanho · mediana ' + nf(R.result_pts_mediano, 1)
            + ' pt por trade · média ' + nf(R.result_pts_medio, 1) + ' pt',
            sgn(R.result_pts_ponderado), 'pts'),
      ], 'É o dinheiro que ele pôs na mesa, sobre o NAV do dia do pico da posição '
       + '— o paralelo do #PL, e nunca a mesma coluna que ele.'),

      ficha('Prêmio vivo, por dia', [
        linha('Prêmio do dia', bps(R.premio_pl_medio_dia),
            'média · mediana ' + bps(R.premio_pl_mediano_dia)
            + ' · máximo ' + bps(R.premio_pl_max_dia), '', 'premio_dia', true),
        linha('Pregões com opção', nf(R.pregoes_com_opcao, 0),
            'de ' + R.pregoes_total + ' no ano', '', 'premio_dia'),
      ], 'Soma TODAS as opções vivas no pregão; a ficha ao lado é uma posição só.'),

      ficha('Pior caso', [
        /* ⚠️ Esta linha nao tinha a irma NENHUMA — so `mediana · maior`. O campo
           `risco_max_bps_medio` foi criado no `report.py` junto com esta troca:
           inverter o destaque sem a media existir deixaria a ficha com um par
           quebrado, que e o que a §5.3 proibe. */
        linha('Risco máximo por trade', bps(R.risco_max_bps_medio),
            'média · mediana ' + bps(R.risco_max_bps_mediano)
            + ' · maior ' + bps(R.risco_max_bps_max), '', 'risco_max', true),
        linha('Risco máximo somado', bps(R.risco_max_bps_soma),
            'se tudo virasse contra ao mesmo tempo', '', 'risco_max'),
      ], semTeto
         ? '⚠️ ' + nf(semTeto, 0) + ' trade' + (semTeto > 1 ? 's' : '')
           + ' sem teto derivável ficam FORA desta conta — payoff ilimitado de um '
           + 'lado, e assumir 100 seria inventar.'
         : 'Comprado perde o prêmio; vendido perde o teto do payoff menos o prêmio.')
    );

    const t = theme();
    const x = D.map((r) => r.data);
    Plotly.newPlot(el('figPremio'), [
      { x, y: D.map((r) => r.premio_pl), name: 'prêmio vivo (bps)',
        type: 'scatter', mode: 'lines', fill: 'tozeroy',
        line: { color: P()[2], width: 1.6 }, fillcolor: 'rgba(120,120,120,.12)',
        hovertemplate: '%{x|%d/%m/%Y}<br>%{y:.1f} bps do NAV<extra></extra>' },
    ], baseLayout(t, {
      height: Math.round(H_HALF() * 0.75),
      yaxis: { title: { text: 'prêmio vivo (bps do NAV)' }, rangemode: 'tozero' },
      showlegend: false,
    }), CFG);

    /* premio x risco maximo: a diagonal e onde os dois coincidem (o COMPRADO).
       Tudo acima dela e vendido — e a distancia ate a diagonal E o que o premio
       sozinho esconderia. */
    const O = (TR || []).filter((r) => r.book === 'opcao' && r.premio_bps != null);
    const mx = Math.max(1, ...O.map((r) => Math.max(r.premio_bps || 0, r.risco_max_bps || 0)));
    /* ☠️ ESTE GRAFICO ERA `premio × risco maximo`, e nao dizia NADA — era a
       identidade x = x. Motivo: para quem COMPRA, o risco maximo E o premio, e
       quase todo trade do livro e comprado, entao os pontos caiam todos na
       diagonal. Um grafico so informa quando os dois eixos podem divergir.
       ⭐ `premio colocado × resultado` (pedido do usuario) responde a pergunta
       que o bloco existe para fazer: **poe mais premio na mesa e ganha mais?**
       — o analogo, para a opcao, do `tamanho × retorno` que o DI ja tinha.
       ⚠️ Os dois eixos em bps do NAV: e a unica unidade em que premio e
       resultado se comparam. O y segue a regua; o x NAO — premio e sempre
       exposicao, e ve-lo em R$ nao ajuda a comparar entre anos. */
    const pmx = Math.max(1, ...O.map((r) => r.premio_bps || 0));
    Plotly.newPlot(el('figPremioRisco'), [
      /* a horizontal do zero: acima ganhou, abaixo perdeu */
      { x: [0, pmx * 1.05], y: [0, 0], name: 'zero', type: 'scatter', mode: 'lines',
        line: { color: REF(), width: 1, dash: 'dash' }, hoverinfo: 'skip',
        showlegend: false },
      /* ⚠️ a diagonal NEGATIVA e o piso de quem COMPRA: perder todo o premio.
         Nenhum comprado pode ficar abaixo dela, e encostar nela e a opcao ter
         virado po. E referencia, nao serie — por isso tracejada e sem legenda. */
      { x: [0, pmx * 1.05], y: [0, -pmx * 1.05], name: 'perde todo o prêmio',
        type: 'scatter', mode: 'lines', line: { color: NEG(), width: 1, dash: 'dot' },
        hovertemplate: 'piso do comprado: perder o prêmio inteiro<extra></extra>' },
      { x: O.map((r) => r.premio_bps),
        y: O.map((r) => (emBps() ? r.bps_nav_liq : r.result_liq_brl)),
        text: O.map(rotHover),
        name: 'trades', type: 'scatter', mode: 'markers',
        marker: { size: 12, opacity: 0.82,
                  color: O.map((r) => ((r.bps_nav_liq || 0) < 0 ? NEG() : P()[0])),
                  symbol: O.map((r) => (r.direcao === 'vendido' ? 'diamond' : 'circle')) },
        customdata: O.map((r) => [r.direcao, r.result_pts,
                                  (emBps() ? r.result_liq_brl : r.bps_nav_liq)]),
        hovertemplate: '<b>%{text}</b> (%{customdata[0]})'
                     + '<br>prêmio %{x:.1f} bps do NAV'
                     + (emBps() ? '<br>resultado %{y:.1f} bps · R$ %{customdata[2]:,.0f}'
                                : '<br>resultado R$ %{y:,.0f} · %{customdata[2]:.1f} bps')
                     + '<br>%{customdata[1]:.1f} pontos de preço<extra></extra>' },
    ], baseLayout(t, {
      height: Math.round(H_HALF() * 0.75),
      xaxis: { title: { text: 'prêmio colocado (bps do NAV)' }, rangemode: 'tozero' },
      yaxis: { title: { text: 'resultado (' + uni() + ')' }, zeroline: false },
      legend: { orientation: 'h' },
    }), CFG);

    table(el('tblPremio'), [
      { t: 'trade',
        f: (r) => '<span title="' + _esc(r.ativo) + '">' + rotLongo(r) + '</span>' },
      { t: 'direção', f: (r) => r.direcao },
      { t: 'abertura', f: (r) => r.abertura },
      { t: 'prêmio<br><i>bps do NAV</i>', num: 1, tip: 'premio',
        f: (r) => bps(r.premio_bps) },
      { t: 'risco máximo<br><i>bps do NAV</i>', num: 1, tip: 'risco_max',
        f: (r) => (r.risco_max_bps == null ? 'não determinado' : bps(r.risco_max_bps)) },
      /* ⭐ RESULTADO EM PONTOS (pedido do usuario): a digital e cotada em
         PROBABILIDADE (0 a 100) e a estrutura de IDI e montada para payoff
         maximo 100 — entao "capturou 28 pontos" se le direto, e "R$ 129,7 mil"
         so se le sabendo quantos contratos havia. O financeiro fica no hover. */
      { t: 'pontos<br><i>capturados</i>', num: 1, tip: 'pts',
        f: (r) => (r.result_pts == null ? '—' : nf(r.result_pts, 1) + ' pt'),
        cls: (r) => sgn(r.result_pts).trim() },
      { t: 'resultado', num: 1, f: (r) => K(r.bps_nav_liq, r.result_liq_brl),
        cls: (r) => sgn(r.result_liq_brl).trim() },
    ], O.slice().sort((a, b) => (b.premio_bps || 0) - (a.premio_bps || 0)));
  }

  /* ⭐ ERA A ABA "SIZING" — hoje o 3o bloco de "Tamanho & risco" (31/08/2026).
     Continua funcao propria: o bloco tem 3 fichas e 3 graficos, e fundi-lo no
     corpo do `tabPortfolio` daria uma funcao de 400 linhas sem ganhar nada.
     Quem chama e o `tabPortfolio`, no fim. */
  function blocoSizing() {
    const S = TA.sizing || {};
    /* ⛔ LIVRO PEQUENO DEMAIS PARA A PERGUNTA (01/09/2026). O `report._base_tamanho`
       devolve `sizing: {}` quando nao ha ciclos com #PL suficientes — e o bloco
       desenhava tres fichas com `—` em toda linha, mais uma tabela de quartis
       vazia. ☠️ Caixa vazia nao diz se falta DADO ou se quebrou; o leitor
       assume o segundo. 📏 Medido no AJakurski 2024: **3 ciclos, 1 com tamanho
       medivel** — nao ha quartil a formar, e dizer isso e a resposta certa.
       ⚠️ Os graficos do bloco ficam de fora junto: `figSizing`, `figQuartis` e
       `figContraf` rodam sobre a mesma base. */
    /* ⚠️ a guarda olha `corr_tam_bps_eq`, a correlacao da tela — a antiga
       (`corr_tam_result`) e so do DI, e um livro so de opcao a teria nula sem
       que faltasse base alguma. */
    const _semSz = !S || !Object.keys(S).length || S.corr_tam_bps_eq == null;
    if (_semSz) {
      const n = (R && R.n_tamanho != null) ? R.n_tamanho : 0;
      el('kpisSizing').innerHTML = fichas(ficha('Sem base para medir sizing', [
        linha('Ciclos com tamanho medível', nf(n, 0),
            'a pergunta "ele aposta mais quando está certo?" precisa de uma '
            + 'distribuição de tamanhos — com este número de ciclos não há '
            + 'quartil a formar', '', 'n_tamanho', true),
      ], 'Não é falha de carga: o livro deste ano é pequeno demais para a '
       + 'estatística. As demais seções da tela seguem válidas.'));
      ['figSizing', 'figQuartis', 'figContraf'].forEach((id) => {
        const g = el(id);
        if (g) g.innerHTML = '<div class="vaziofig">sem ciclos suficientes</div>';
      });
      const tq = el('tblQuartis');
      if (tq) {
        tq.innerHTML = '<tbody><tr><td class="mdn">sem ciclos suficientes para '
          + 'formar quartis de tamanho</td></tr></tbody>';
      }
      return;
    }
    /* ⭐ A pergunta do sizing tem tres etapas, e a ficha segue a ordem do
       argumento: existe relacao entre tamanho e acerto? · o tamanho difere
       entre acerto e erro? · quanto isso VALEU em bps? */
    el('kpisSizing').innerHTML = fichas(
      ficha('Existe relação?', [
        /* ⭐ A CORRELACAO PASSOU A SER `tam_norm × bps_eq` (01/09/2026) — a
           regua comum, que inclui a opcao. ☠️ E o eixo y NAO e o resultado
           cru: correlacionar tamanho com `bps_nav_liq` teria contaminacao
           MECANICA (posicao maior gera |resultado| maior sem habilidade
           nenhuma). `bps_eq` e o resultado NORMALIZADO pelo tamanho, entao a
           correlacao mede so a decisao — e e a mesma nuvem que o contrafactual
           soma logo abaixo. */
        linha('Correlação tamanho × retorno', nf(S.corr_tam_bps_eq, 3),
            'Pearson · tamanho relativo × resultado no tamanho típico',
            sgn(S.corr_tam_bps_eq), 'corr_tam', true),
        linha('Spearman', nf(S.corr_tam_bps_eq_spearman, 3),
            'por ordem — imune a outlier', sgn(S.corr_tam_bps_eq_spearman), 'corr_tam'),
        /* ⛔ a leitura SO DO DI, que responde outra pergunta ("ele leu a
           curva?") e por isso nao substitui a de cima: `bps_taxa` e movimento
           de TAXA, que a opcao nao tem. */
        linha('Só em taxa (DI e papel)', nf(S.corr_tam_result, 3),
            'Pearson (#PL × bps de taxa) em ' + nf(S.n_corr_taxa, 0) + ' ciclos '
            + '— a leitura "ele leu a curva?"', sgn(S.corr_tam_result), 'corr_tam_taxa'),
        /* ⛔ "Os 10% maiores" MUDOU DE FICHA (02/09/2026): virou a ficha
           `Concentração`, na faixa de cima. Ele respondia outra pergunta
           ("as apostas grandes puxam o livro?") e era a 4ª linha aqui, o que
           deixava esta ficha 2× mais alta que as vizinhas. */
      ], 'Livro inteiro — ' + ((S.books || []).join(' · ') || 'todos os books')
       + '. Cada ciclo medido contra a média da régua DELE.'),

      /* ⭐ A REGUA RELATIVA LIDERA e o #PL fica embaixo (01/09/2026). Nao e
         preferencia de layout: o #PL cobre so DI e papel, entao com a opcao
         dentro da analise a linha em #PL passou a descrever um SUBCONJUNTO da
         ficha. `1,20×` = "20% maior que o tipico do tipo dele", e isso vale
         para o condor e para o ODF31 na mesma coluna. */
      ficha('Tamanho por trade — acerta × erra', [
        linha('Tamanho médio quando acerta', nf(S.tam_norm_medio_vencedor, 2) + '×',
            'mediana ' + nf(S.tam_norm_mediano_vencedor, 2) + '× · em #PL (títulos e DI) '
            + nf(S.pl_medio_vencedor, 2), '', 'tam_norm', true),
        linha('Tamanho médio quando erra', nf(S.tam_norm_medio_perdedor, 2) + '×',
            'mediana ' + nf(S.tam_norm_mediano_perdedor, 2) + '× · em #PL (títulos e DI) '
            + nf(S.pl_medio_perdedor, 2), '', 'tam_norm'),
      ], '1,00× é o tamanho típico do tipo do instrumento — #PL no DI e no papel, '
       + 'prêmio em bps do NAV na opção. ⚠️ É UMA posição por vez: não confundir '
       + 'com o #PL do dia, que soma as posições vivas (a linha "Posições vivas '
       + 'por pregão", acima, é a que fecha essa conta).'),

      ficha('Quanto o sizing valeu', [
        linha('Valor do sizing', bps(S.valor_do_sizing_bps), 'real − tamanho igual',
            sgn(S.valor_do_sizing_bps), 'sizing_valor', true),
        /* ☠️ O rotulo era "o resultado como foi" e MENTIA (01/09/2026, reportado
           pelo usuario: "-22,1 bps contra -40 bps aprox do resultado real").
           Este `real` e o da BASE DE SIZING — sem opcao, que nao tem #PL e cai
           no `dropna` do `sizing_skill`. A conta sempre esteve certa; o rotulo
           e que descrevia o numero do ano. ⭐ Agora a propria linha fecha a
           conta: `real + fora = ano`. */
        linha('Real', bps(S.real_bps), foraDoSizing(), sgn(S.real_bps), 'sizing_valor'),
        linha('Tamanho igual', bps(S.tamanho_igual_bps),
            'contrafactual: todo trade no tamanho típico do tipo dele',
            sgn(S.tamanho_igual_bps), 'sizing_valor'),
      ], 'A média preserva o risco total de cada régua, então o contrafactual '
       + 'REDISTRIBUI o mesmo risco — não arrisca menos.')
    );

    const t = theme();
    /* ⭐ **A NUVEM PASSOU A SER A DO CONTRAFACTUAL** (01/09/2026, pedido do
       usuario para incluir a opcao). Era `#PL x bps_taxa`, e isso amarrava o
       grafico ao DI por DUAS razoes de uma vez: `#PL` nao existe na opcao e
       `bps_taxa` tampouco (o preco dela nao e taxa). Pior: a ficha ao lado
       somava OUTRA conta (`bps_nav_liq` reescalado), entao grafico e numero
       nao falavam do mesmo objeto.
       ⭐ Hoje os dois eixos sao a regua comum, e fecham entre si:
         x = `tam_norm` — tamanho do ciclo / media da regua DELE (1,00 = tipico)
         y = `bps_eq`   — `bps_nav_liq / tam_norm`, o resultado que o ciclo
                          teria NO tamanho tipico. `Sigma bps_eq == tamanho_igual_bps`
                          (aferido nos 22 payloads), entao cada ponto E a
                          contribuicao dele ao contrafactual.
       ☠️ E o y precisa ser normalizado: plotar `bps_nav_liq` cru contra tamanho
       teria dependencia MECANICA — posicao maior faz |resultado| maior sem
       habilidade nenhuma, e a inclinacao mediria a propria escala. */
    const sz = TR.filter((r) => r.tam_norm != null && r.bps_eq != null);
    /* reta de tendência (mínimos quadrados) — a inclinação É a resposta */
    const xs = sz.map((r) => r.tam_norm), ys = sz.map((r) => r.bps_eq);
    const n = xs.length, mx = xs.reduce((a, b) => a + b, 0) / n,
          my = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
    const b1 = den ? num / den : 0, b0 = my - b1 * mx;
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    /* ⚠️ A FORMA do marcador diz a REGUA (circulo = #PL, losango = premio) e a
       cor diz ganhou/perdeu. Sem isso o leitor nao teria como saber que um
       ponto em `1,2x` e um condor medido em premio e nao um DI medido em #PL —
       e a legenda do card promete as duas reguas no mesmo eixo. */
    const _simb = (r) => (r.book === 'opcao' ? 'diamond' : 'circle');
    const _rot = (r) => rotLongo(r) + ' · ' + r.abertura
                 + (r.book === 'opcao' ? ' · prêmio ' + nf(r.premio_bps, 1) + ' bps'
                                       : ' · #PL ' + nf(r.pl_pico, 2));
    const _serie = (ok, nome, cor) => ({
      x: sz.filter((r) => !!r.ganhou === ok).map((r) => r.tam_norm),
      y: sz.filter((r) => !!r.ganhou === ok).map((r) => r.bps_eq),
      text: sz.filter((r) => !!r.ganhou === ok).map(_rot),
      name: nome, type: 'scatter', mode: 'markers',
      marker: { color: cor, size: 10, opacity: 0.75,
                symbol: sz.filter((r) => !!r.ganhou === ok).map(_simb) },
      hovertemplate: '%{text}<br>tamanho %{x:.2f}× do típico'
                   + '<br>%{y:.1f} bps nesse tamanho<extra></extra>',
    });
    Plotly.newPlot(el('figSizing'), [
      _serie(true, 'ganhou', P()[0]),
      _serie(false, 'perdeu', NEG()),
      { x: [x0, x1], y: [b0 + b1 * x0, b0 + b1 * x1], name: 'tendência',
        type: 'scatter', mode: 'lines',
        line: { color: P()[2], width: 2, dash: 'dash' },
        hovertemplate: 'inclinação ' + nf(b1, 1)
                     + ' bps por unidade de tamanho relativo<extra></extra>' },
    ], baseLayout(t, {
      height: H_FULL(),
      xaxis: { title: { text: 'tamanho relativo (1,00 = típico do tipo dele)' } },
      yaxis: { title: { text: 'resultado no tamanho típico (bps do NAV)' }, zeroline: true },
      legend: { orientation: 'h' },
    }), CFG);

    const Q = S.quartis || [];
    Plotly.newPlot(el('figQuartis'), [
      { x: Q.map((r) => r.q), y: Q.map((r) => r.bps), name: 'resultado (bps)', type: 'bar',
        marker: { color: Q.map((r) => (r.bps < 0 ? NEG() : P()[0])) },
        hovertemplate: '%{x}<br>%{y:.1f} bps<extra></extra>' },
      { x: Q.map((r) => r.q), y: Q.map((r) => r.hit), name: 'acerto', type: 'scatter',
        mode: 'lines+markers', yaxis: 'y2', line: { color: P()[2], width: 2 },
        hovertemplate: '%{x}<br>acerto %{y:.0%}<extra></extra>' },
    ], baseLayout(t, {
      height: H_HALF(), yaxis: { title: { text: 'bps do NAV' }, zeroline: true },
      /* ⛔ 2a excecao ao `zeroAlinhado`: `acerto` e uma FRACAO limitada a [0,1],
         e o zero dela e uma BORDA de dominio, nao uma troca de sinal. Alinhar
         imprimiria ticks de "−20% de acerto" para casar com as barras negativas
         de bps. A faixa fixa [0,1] tambem mantem a altura da linha comparavel
         entre traders e anos, que e o motivo de ela ser fixa. */
      yaxis2: { title: { text: 'acerto' }, overlaying: 'y', side: 'right',
                showgrid: false, tickformat: '.0%', range: [0, 1] },
      legend: { orientation: 'h' },
    }), CFG);

    Plotly.newPlot(el('figContraf'), [
      /* "tamanho igual" = todo trade no tamanho MÉDIO da régua dele. A média, e
         não a mediana, porque a média preserva o risco TOTAL de cada régua — o
         contrafactual redistribui o mesmo risco em vez de encolher o livro. */
      { x: ['real', 'tamanho igual (todo trade no tamanho MÉDIO do tipo dele)'],
        y: [S.real_bps, S.tamanho_igual_bps], type: 'bar',
        marker: { color: [S.real_bps < 0 ? NEG() : P()[0],
                          S.tamanho_igual_bps < 0 ? NEG() : P()[1]] },
        text: [bps(S.real_bps), bps(S.tamanho_igual_bps)], textposition: 'auto',
        hovertemplate: '%{x}<br>%{y:.1f} bps<extra></extra>' },
    ], baseLayout(t, {
      height: H_HALF(), yaxis: { title: { text: 'bps do NAV' }, zeroline: true },
      showlegend: false,
    }), CFG);

    table(el('tblQuartis'), [
      { t: 'quartil de tamanho', f: (r) => r.q, tip: 'quartil' },
      { t: 'n', num: 1, f: (r) => nf(r.n, 0), tip: 'n' },
      /* ⭐ o quartil e formado pela REGUA COMUM (`tam_norm`), entao ela vem
         primeiro; o `#PL` fica ao lado e sai `—` num quartil so de opcao — que
         e o correto, e nao um buraco. */
      { t: 'tamanho<br><i>média / mediana</i>', num: 1, tip: 'tam_norm',
        f: (r) => par(r.tam_norm_medio, r.tam_norm, (v) => nf(v, 2) + '×') },
      { t: '#PL<br><i>média / mediana · títulos e DI</i>', num: 1, tip: 'pl',
        f: (r) => (r.pl == null && r.pl_medio == null ? '—' : par(r.pl_medio, r.pl)) },
      { t: 'acerto', num: 1, f: (r) => pct(r.hit), tip: 'acerto' },
      { t: 'bps taxa<br><i>média / mediana / <b>ponderada</b></i>', num: 1,
        tip: 'bps_taxa_terno',
        f: (r) => terno(r.bps_taxa_medio, r.bps_taxa, r.bps_taxa_ponderado) },
      /* ⚠️ SEGUE A REGUA: em bps a coluna sai em bps. Estas quatro colunas de
           `resultado` estavam cravadas em R$ e apareciam em reais numa pagina
           inteira em bps do NAV — o mesmo modo de falhar do bloco de helpers
           (um call site fica para tras em silencio). */
        { t: 'resultado', num: 1, f: (r) => K(r.bps, r.brl), cls: (r) => sgn(r.brl).trim(),
        tip: 'resultado_bcl' },
      { t: 'bps NAV', num: 1, f: (r) => bps(r.bps), cls: (r) => sgn(r.bps).trim(),
        tip: 'bps_nav' },
    ], Q);
  }

  /* ══════════════════ ACERTO & PAYOFF ══════════════════ */
  function tabHabilidade() {
    /* ⭐ TRES perguntas distintas, e cada ficha responde uma:
       com que frequencia acerta · quanto ganha quando acerta contra quanto perde
       quando erra · e o que sobra por trade. Antes eram 8 cartoes em fila, com
       "Acerto" e "Duracao MEDIANA" lado a lado sem relacao nenhuma. */
    el('kpisHab').innerHTML = fichas(
      ficha('Com que frequência acerta', [
        linha('Acerto', pct(R.hit), R.n + ' ciclos fechados', '', 'acerto', true),
        linha('Payoff das médias', nf(R.payoff, 2),
            'medianas ' + nf(R.payoff_mediana, 2) + ' · precisa de '
            + nf(R.payoff_breakeven, 2) + ' para empatar neste acerto',
            R.payoff > R.payoff_breakeven ? '' : ' neg', 'payoff'),
        /* ⭐ MEDIA no numero grande, mediana embaixo (01/09/2026, pedido do
           usuario) — a mesma inversao do §5.-53, e aqui ela corrige uma
           DIVERGENCIA entre duas abas: o Retrato do ano ja mostrava
           `Duracao media` liderando com a media, e esta ficha liderava com a
           mediana. O mesmo campo com destaques diferentes em duas telas e o
           que faz parecer que os numeros divergem. */
        linha('Duração média', nf(R.dur_media, 1) + ' d',
            'mediana ' + nf(R.dur_mediana, 0) + ' d · dias corridos', '', 'dias'),
      ]),

      ficha('Ganho × perda', [
        /* ☠️ ESTAS QUATRO LINHAS IGNORAVAM O SELETOR — `kbrl` cravado. A tela
           inteira em bps do NAV e o ganho/perda em reais, no MESMO cartao.
           ⚠️ E o Retrato do ano ja usava o helper: o erro estava so aqui, que e
           exatamente o modo de falhar que o bloco dos helpers descreve — um call
           site fica para tras em silencio. */
        linha('Ganho médio', K(R.ganho_medio_bps, R.ganho_medio),
            'mediana ' + K(R.ganho_mediano_bps, R.ganho_mediano)
            + ' · por trade vencedor · ' + Kalt(R.ganho_medio_bps, R.ganho_medio),
            '', 'par_mm', true),
        linha('Perda média', K(R.perda_media_bps, R.perda_media),
            'mediana ' + K(R.perda_mediana_bps, R.perda_mediana)
            + ' · por trade perdedor · ' + Kalt(R.perda_media_bps, R.perda_media),
            ' neg', 'par_mm'),
        /* ⚠️ NAO usa `par_mm`: aquele tooltip fala de media contra mediana, e
           aqui e UM trade — nao ha posicao central de nada. */
        linha('Melhor trade', K(R.melhor_bps, R.melhor), 'um único ciclo', '', 'extremo'),
        linha('Pior trade', K(R.pior_bps, R.pior), 'um único ciclo', ' neg', 'extremo'),
      ]),

      ficha('O que sobra por trade', [
        /* ☠️ ESTA LINHA NAO SEGUIA A REGUA, e o defeito so aparecia no modo
           REAIS (01/09/2026, achado pela varredura de "quem lidera com
           mediana"). O valor estava cravado em `bps(...)` enquanto o subtitulo
           usava `K()`/`Kalt()`, que seguem o seletor — entao em reais a ficha
           mostrava `0,1 bps` em cima de `mediana −R$ 1,1 mil`: **o numero e a
           irma dele em reguas diferentes, lado a lado**, que e exatamente a
           incoerencia da §5.-27 e o modo de falhar da §5.-37 (um call site fica
           para tras quando o helper migra).
           ⚠️ E o subtitulo dava a MEDIANA DUAS VEZES, uma em cada regua
           (`mediana X · Y (mediana Z)`) — ruido que so existia porque o valor
           nao acompanhava. ⭐ Agora e identico ao da ficha do Retrato do ano,
           que ja estava certo: valor em `K()`, irma em `K()`, e a outra regua
           nomeada no fim. */
        linha('Expectativa média', K(R.exp_bps, R.exp_brl),
            'mediana ' + K(R.exp_mediana_bps, R.exp_mediana_brl) + ' · '
            + Kalt(R.exp_bps, R.exp_brl) + ' na outra régua',
            sgn(emBps() ? R.exp_bps : R.exp_brl), 'expectativa', true),
        /* ☠️ ESTAS DUAS LINHAS SAO DE OUTRA REGUA, e o subtitulo dizia "e a que
           da o dinheiro" — verdade ate o ajuste da B3 entrar (§5.-10), FALSA
           depois. `bps_taxa` e o movimento de TAXA com `du` congelado: bruto,
           sem custo, sem carrego. Ficava ao lado de uma expectativa LIQUIDA sem
           nenhum sinal de que sao coisas diferentes.
           ⚠️ Continuam aqui porque respondem uma pergunta legitima — "ele leu a
           curva?" — mas o rotulo agora NOMEIA a regua, em vez de deixar o leitor
           supor que e resultado. */
        linha('Movimento de taxa — ponderado', nf(R.bps_taxa_ponderado, 2) + ' bp',
            'quanto a TAXA andou a favor, por DV01 × giro. ⚠️ bruto, sem custo — '
            + 'mede a leitura da curva, não o dinheiro', '', 'bps_taxa_terno'),
        linha('Movimento de taxa — simples', nf(R.bps_taxa_medio, 2) + ' bp',
            'mediana ' + nf(R.bps_taxa_mediano, 2) + ' bp · a aposta típica, sem peso',
            '', 'bps_taxa_terno'),
      ], 'A expectativa pode trocar de sinal entre média e mediana: o trade típico '
       + 'perde e o livro ganha pela cauda.')
    );

    const t = theme();
    /* hit × payoff: cada corte do livro é um ponto, com a curva de break-even */
    /* ☠️ O ROTULO DE CADA BOLA ESTAVA SENDO APAGADO. Era
       `{ n: r.horizonte, ...r }` — e o spread vem DEPOIS, entao o `n` das
       linhas (a CONTAGEM de ciclos) sobrescrevia o rotulo. O que aparecia
       escrito em cima de cada bola era o numero de ciclos, e o hover repetia
       essa contagem duas vezes sem nunca dizer de quem era o ponto. O usuario
       perguntou "o que e cada bola?" — nao dava para saber.
       ⚠️ Chave PROPRIA (`rot`), nao uma que possa colidir com o payload. */
    const cortes = []
      .concat(TA.por_horizonte.map((r) => ({ ...r, rot: r.horizonte, fam: 'horizonte' })))
      .concat(TA.por_direcao.map((r) => ({ ...r, rot: r.direcao, fam: 'direção' })))
      .concat(TA.por_contrato.filter((r) => r.n >= 3)
        .map((r) => ({ ...r, rot: r.vencimento || r.ativo, fam: 'contrato' })))
      .filter((r) => r.hit > 0 && r.hit < 1 && r.payoff != null);
    const hx = []; for (let h = 0.08; h <= 0.92; h += 0.01) hx.push(h);
    /* o range tem de sair ANTES do trace: o anti-colisao normaliza por ele */
    const yTopo = Math.max(5, 1.15 * Math.max(0,
      ...cortes.map((r) => r.payoff || 0), R.payoff || 0));
    const xRng = [0.05, 0.95];
    const posTxt = posRotulos(cortes.map((r) => ({ x: r.hit, y: r.payoff })),
      xRng, [0, yTopo], [{ x: R.hit, y: R.payoff }]);
    Plotly.newPlot(el('figHitPayoff'), [
      { x: hx, y: hx.map((h) => (1 - h) / h), name: 'break-even', type: 'scatter',
        mode: 'lines', line: { color: REF(), width: 1.4, dash: 'dash' },
        hovertemplate: 'acerto %{x:.0%} → payoff %{y:.2f}<extra></extra>' },
      { x: cortes.map((r) => r.hit), y: cortes.map((r) => r.payoff),
        text: cortes.map((r) => r.rot),
        name: 'cortes do livro', type: 'scatter', mode: 'markers+text',
        textposition: posTxt, textfont: { size: 10 },
        /* tamanho = nº de ciclos · cor = o corte deu ou não dinheiro */
        marker: { size: cortes.map((r) => Math.max(8, Math.min(26, Math.sqrt(r.n) * 4))),
                  color: cortes.map((r) => (r.total_brl < 0 ? NEG() : P()[0])), opacity: 0.8 },
        customdata: cortes.map((r) => [r.payoff_mediana, r.n, r.fam, r.total_brl]),
        hovertemplate: '<b>%{text}</b> — por %{customdata[2]}'
                     + '<br>acerto %{x:.0%}'
                     + '<br>payoff das MÉDIAS %{y:.2f}'
                     + '<br>payoff das MEDIANAS %{customdata[0]:.2f}'
                     + '<br>%{customdata[1]} ciclos · R$ %{customdata[3]:,.0f}<extra></extra>' },
      { x: [R.hit], y: [R.payoff], name: 'livro todo', type: 'scatter', mode: 'markers',
        marker: { size: 20, color: P()[2], symbol: 'diamond',
                  line: { color: cssv('--ink'), width: 1.6 } },
        hovertemplate: '<b>LIVRO TODO</b><br>acerto %{x:.0%} · payoff %{y:.2f}'
                     + '<extra></extra>' },
    ], baseLayout(t, {
      height: H_HALF(),
      xaxis: { title: { text: 'acerto' }, tickformat: '.0%', range: xRng },
      /* ⚠️ o eixo é o payoff das MÉDIAS — é o que entra na conta de expectativa
         (hit×ganho − (1−hit)×perda) e o que a curva de break-even compara. O
         payoff das medianas vai no hover de cada ponto. */
      /* ☠️ O range era FIXO em [0, 5] e engolia ponto. Medido no EMota 2026: o
         Jan28 tem payoff 6,64 e simplesmente nao aparecia — justamente o corte
         de MAIOR payoff do livro, que e o que o grafico existe para mostrar.
         ⚠️ Piso de 5 para a curva de break-even continuar legivel quando todos
         os payoffs sao baixos; teto pelo dado quando algum passa disso. */
      yaxis: { title: { text: 'payoff = ganho MÉDIO ÷ perda MÉDIA' }, range: [0, yTopo] },
      legend: { orientation: 'h' },
    }), CFG).then((gd) => ajustaRotulos(gd, 1, posTxt.slice()));

    /* ☠️ ESTE GRAFICO TAMBEM ESTAVA CRAVADO EM R$ — eixo "R$ por trade" numa
       pagina em bps do NAV. Mesmo modo de falhar do `figDuracao` e das colunas
       de tabela: o helper de regua chegou e este call site ficou.
       ⭐ Agora as tres barras (ganho · perda · expectativa) seguem o seletor, e
       a OUTRA regua vai no hover — o financeiro nunca some, so sai do eixo. */
    const gpB = emBps();
    const gpMed  = gpB ? [R.ganho_medio_bps, R.perda_media_bps, R.exp_bps]
                       : [R.ganho_medio, R.perda_media, R.exp_brl];
    const gpMdn  = gpB ? [R.ganho_mediano_bps, R.perda_mediana_bps, R.exp_mediana_bps]
                       : [R.ganho_mediano, R.perda_mediana, R.exp_mediana_brl];
    const gpAlt  = gpB ? [R.ganho_medio, R.perda_media, R.exp_brl]
                       : [R.ganho_medio_bps, R.perda_media_bps, R.exp_bps];
    const gpAltM = gpB ? [R.ganho_mediano, R.perda_mediana, R.exp_mediana_brl]
                       : [R.ganho_mediano_bps, R.perda_mediana_bps, R.exp_mediana_bps];
    const gpFmt = gpB ? '%{y:.1f} bps' : 'R$ %{y:,.0f}';
    const gpAltF = gpB ? 'R$ %{customdata:,.0f}' : '%{customdata:.1f} bps';
    Plotly.newPlot(el('figGanhoPerda'), [
      /* as duas réguas lado a lado, em vez de três barras de média sozinhas */
      { x: ['ganho', 'perda', 'expectativa'], name: 'MÉDIA',
        y: gpMed, type: 'bar', customdata: gpAlt,
        marker: { color: [P()[0], NEG(), (gpMed[2] || 0) < 0 ? NEG() : P()[2]] },
        hovertemplate: '%{x} — MÉDIA<br>' + gpFmt + '<br>' + gpAltF + '<extra></extra>' },
      { x: ['ganho', 'perda', 'expectativa'], name: 'MEDIANA',
        y: gpMdn, type: 'bar', customdata: gpAltM,
        marker: { color: [P()[0], NEG(), (gpMdn[2] || 0) < 0 ? NEG() : P()[2]],
                  opacity: 0.45, line: { color: cssv('--ink'), width: 1 } },
        hovertemplate: '%{x} — MEDIANA<br>' + gpFmt + '<br>' + gpAltF + '<extra></extra>' },
    ], baseLayout(t, {
      height: H_HALF(),
      yaxis: { title: { text: (gpB ? 'bps do NAV' : 'R$') + ' por trade' }, zeroline: true },
      showlegend: false,
    }), CFG);

    const di = TR.filter((r) => r.book === 'di' && r.bps_taxa != null && !r.aberto);
    Plotly.newPlot(el('figBpsTaxa'), [
      { x: di.filter((r) => r.ganhou).map((r) => r.bps_taxa), name: 'ganhou',
        type: 'histogram', marker: { color: P()[0] }, opacity: 0.78, nbinsx: 30 },
      { x: di.filter((r) => !r.ganhou).map((r) => r.bps_taxa), name: 'perdeu',
        type: 'histogram', marker: { color: NEG() }, opacity: 0.78, nbinsx: 30 },
    ], baseLayout(t, {
      height: H_HALF(), barmode: 'overlay',
      xaxis: { title: { text: 'bps de taxa a favor (movimento capturado)' }, zeroline: true },
      yaxis: { title: { text: 'trades' } }, legend: { orientation: 'h' },
    }), CFG);

    /* ☠️ ESTE GRAFICO TINHA SELETOR PROPRIO, e por isso ficava em REAIS numa
       pagina inteira em bps. Ele nasceu (31/08/2026) antes do seletor GLOBAL de
       regua; quando o global chegou, viraram dois controles para a mesma
       decisao — e o markup do local saiu na reorganizacao da secao, deixando o
       codigo cair no `else` com 'brl' cravado.
       ⭐ Hoje segue o `emBps()` global, como todo o resto. Duas reguas para a
       mesma pergunta e uma a mais: so em R$ a nuvem se espalha pela ALOCACAO e
       nao pela decisao (o mesmo ciclo vale 10x mais num livro de R$ 200 MM que
       num de R$ 23 MM); em bps a dispersao vira a do trade. O financeiro nao se
       perde — vai no hover. */
    function desenhaDuracao() {
      const eb = emBps();
      const val = (r) => (eb ? r.bps_nav_liq : r.result_liq_brl);
      const fmt = eb ? '%{y:.1f} bps' : 'R$ %{y:,.0f}';
      const serie = (ok, cor, nome) => ({
        x: di.filter((r) => !!r.ganhou === ok).map((r) => r.dias_corridos),
        y: di.filter((r) => !!r.ganhou === ok).map(val),
        text: di.filter((r) => !!r.ganhou === ok).map((r) => r.vencimento),
        customdata: di.filter((r) => !!r.ganhou === ok)
          .map((r) => (eb ? r.result_liq_brl : r.bps_nav_liq)),
        name: nome, type: 'scatter', mode: 'markers',
        marker: { color: cor, size: 9, opacity: 0.75 },
        hovertemplate: '%{text}<br>%{x} dias · <b>' + fmt + '</b><br>'
          + (eb ? 'R$ %{customdata:,.0f}' : '%{customdata:.1f} bps')
          + '<extra></extra>',
      });
      Plotly.newPlot(el('figDuracao'), [
        serie(true, P()[0], 'ganhou'), serie(false, NEG(), 'perdeu'),
      ], baseLayout(t, {
        height: H_HALF(),
        xaxis: { title: { text: 'dias corridos do ciclo' } },
        yaxis: { title: { text: eb ? 'resultado (bps do NAV)' : 'resultado (R$)' },
                 zeroline: true },
        legend: { orientation: 'h' },
      }), CFG);
    }
    desenhaDuracao();
  }

  /* ══════════════════ SIZING ══════════════════ */

  /* ══════════════════ CONTRATOS ══════════════════ */
  /* ══════════════════ CUSTO ══════════════════
     ⭐ Aba propria desde 31/08/2026. Estava dentro de "Posicao & risco", onde
     ninguem procuraria — custo nao e tamanho. Ganhou o slot que a fusao de
     "Posicao & risco" com "Sizing" liberou. */
  function tabCusto() {
    const t = theme();
    /* ── PARA ONDE VAI O CUSTO ──────────────────────────────────────────────
       As 3 taxas saem da MESMA boleta do Sophis, então não há rateio nem
       estimativa: é o que a corretora e a B3 cobraram, boleta a boleta. */
    el('kpisCusto').innerHTML = fichas(
      ficha('Composição do custo', [
        linha('Custo total', bpsCusto('total'), pesoCusto(R), '', 'custo', true),
        linha('Corretagem', bpsCusto('broker'),
            kbrl(R.custo_broker_brl) + ' · ' + shCusto()[0]
            + '% do custo — a única com alguma alavanca da mesa', '', 'fee_broker'),
        /* ⭐ Contraparte SOMADA ao emolumento: os dois sao taxa de mercado, nao
           negociaveis, e a contraparte e ~5% do custo. Linha propria dividia a
           atencao sem acrescentar decisao. */
        linha('Custos operacionais', bpsCusto('market'),
            kbrl(R.custo_market_brl) + ' · ' + shCusto()[1]
            + '% do custo — tabelado, sem alavanca', '', 'fee_market'),
      ]),

      ficha('Custo unitário', [
        /* ⚠️ DUAS casas: `R$ 1,123` se le como MILHAR num relance, e o numero
           e um real e doze centavos. E o rotulo e "contrato", nao "perna"
           (decisao do usuario) — que cada compra e cada venda contam fica no
           detalhe, que e onde a ressalva pertence. */
        linha('Por contrato de DI', 'R$ ' + nf(R.custo_por_contrato_di, 2),
            'cada compra e cada venda contam', '', 'custo_ct', true),
        linha('Contratos girados', nf(R.contratos_di_pernas, 0),
            'o denominador da linha acima', '', 'pernas'),
      ], 'Varia por vencimento: o emolumento da B3 é proporcional ao valor do '
       + 'contrato, então um ODF31 custa mais que um ODJ26.')
    );

    /* custo acumulado × resultado bruto: a distância entre as duas linhas é o
       líquido, e o cruzamento diz em que ponto do ano o custo já tinha comido
       o que a taxa deu.
       ⚠️ SEGUE A REGUA nas tres series — foi o pedido do usuario ("no custo,
       quando seleciono a regua em reais, mostra so em bps"). O acumulado em bps
       e SOMA de bps diarios, nao composicao: aqui as tres parcelas precisam
       fechar `bruto − custo = liquido`, e composto nao fecha. */
    const cx = D.map((r) => r.data);
    const cf = emBps() ? '%{y:.1f} bps' : 'R$ %{y:,.0f}';
    Plotly.newPlot(el('figCusto'), [
      { x: cx, y: D.map((r) => (emBps() ? r.bps_b3_acum : r.pnl_acum)),
        name: 'resultado BRUTO acumulado (' + uni() + ')',
        type: 'scatter', mode: 'lines', line: { color: P()[2], width: 1.4, dash: 'dot' },
        hovertemplate: '%{x|%d/%m/%Y}<br>bruto ' + cf + '<extra></extra>' },
      { x: cx, y: D.map((r) => (emBps() ? r.bps_liq_acum : r.pnl_liq_acum)),
        name: 'LÍQUIDO acumulado (' + uni() + ')',
        type: 'scatter', mode: 'lines', line: { color: P()[0], width: 2.2 },
        hovertemplate: '%{x|%d/%m/%Y}<br><b>líquido ' + cf + '</b><extra></extra>' },
      { x: cx, y: D.map((r) => (emBps() ? r.custo_bps_acum : r.custo_acum)),
        name: 'custo acumulado (' + uni() + ')',
        type: 'scatter', mode: 'lines', fill: 'tozeroy', line: { color: NEG(), width: 1.2 },
        fillcolor: 'rgba(200,60,60,.12)',
        hovertemplate: '%{x|%d/%m/%Y}<br>custo ' + cf + '<extra></extra>' },
    ], baseLayout(t, {
      height: H_HALF(),
      yaxis: { title: { text: uni() + ' acumulado' }, zeroline: true },
      legend: { orientation: 'h' }, hovermode: 'x unified',
    }), CFG);
  }

  function tabContratos() {
    const C = TA.por_contrato;
    const t = theme();
    Plotly.newPlot(el('figContratos'), [
      /* ⚠️ segue a regua, como todo grafico de RESULTADO */
      { x: C.map(rotCurto),
        y: C.map((r) => (emBps() ? r.total_bps : r.total_brl)),
        type: 'bar', marker: { color: C.map((r) => (r.total_brl < 0 ? NEG() : P()[0])) },
        text: C.map((r) => r.n + ' trades'), textposition: 'auto',
        /* ⚠️ o nome INTEIRO vai no hover — o eixo so tem o curto */
        customdata: C.map((r) => [(emBps() ? r.total_brl : r.total_bps),
                                  rotHover(r), r.book]),
        hovertemplate: '<b>%{customdata[1]}</b><br>'
                     + (emBps() ? '%{y:.1f} bps<br>R$ %{customdata[0]:,.0f}'
                                : 'R$ %{y:,.0f}<br>%{customdata[0]:.1f} bps')
                     + '<extra></extra>' },
    ], baseLayout(t, {
      height: H_FULL(), yaxis: { title: { text: uni() }, zeroline: true },
      showlegend: false,
      /* ⚠️ margem inferior maior + ticks inclinados: 22 categorias nao cabem na
         horizontal nem com o rotulo curto. */
      /* ⚠️ -45 graus e fonte menor: a -38 com 22 categorias ainda restavam 3
         sobreposicoes medidas no DOM. `automargin` sozinho nao resolve — ele
         cresce a margem, nao afasta os rotulos entre si.
         ⚠️ **Fonte 9, nao 10** (01/09/2026): quando a digital passou a mostrar
         o NOME (`No Cut jun/26`) em vez do codigo (`CPMMV84`) o rotulo cresceu,
         e o PAlves — 17 vertices — voltou a ter 1 colisao a 1280px. Aqui basta
         a fonte porque o card e de largura CHEIA; no `figCurva`, que e metade,
         o mesmo problema exigiu -90 (ver la o porque). */
      xaxis: { tickangle: -45, automargin: true, tickfont: { size: 9 } },
      margin: { b: 104 },
    }), CFG);

    table(el('tblContratos'), [
      /* ⚠️ `vencimento` e nao `ativo`: no papel o `ativo` e o ISIN
         (`BRSTNCNTB4X0 Govt`), que nao diz nada — o vertice diz (`B Ago28`).
         O ISIN vai no title, para quem precisar conferir. */
      /* ⭐ O NOME LIDERA (01/09/2026, pedido do usuario). Era
         `CPMMV84 (Digital Copom No Cut 260618)` — o codigo primeiro e o nome
         entre parenteses, quando e o nome que se le. Hoje a celula diz
         `Digital Copom No Cut 18/06/26` e o codigo fica no `title`.
         ⚠️ No DI e no papel nada muda: ali o rotulo ja era o VERTICE
         (`Jan28`, `B Ago28`) e o `ativo` (ISIN) ja ia para o `title`. */
      { t: 'contrato', tip: 'contrato',
        f: (r) => '<span title="' + _esc(r.ativo) + '">' + rotLongo(r) + '</span>' },
      /* ⛔ `venc.` e `du` SAIRAM (pedido do usuario): `venc.` repetia a coluna
         `contrato`, que ja e o vertice, e `du` nao existe fora do DI — na opcao
         e no papel a celula so podia ficar vazia. */
      { t: 'n', num: 1, f: (r) => nf(r.n, 0) },
      { t: 'daytr.', num: 1, f: (r) => nf(r.n_daytrade, 0), tip: 'daytr' },
      { t: 'acerto', num: 1, f: (r) => pct(r.hit) },
      { t: 'payoff', num: 1, f: (r) => nf(r.payoff, 2) },
      /* ⭐ A OPCAO TEM AS MESMAS PERGUNTAS, EM OUTRAS UNIDADES (pedido do
         usuario, 01/09/2026). Cada coluna cai no equivalente dela em vez de
         mostrar vazio:
           · movimento de TAXA (bps)  ->  PONTOS de preco (percentuais)
           · DV01 (R$/bp)             ->  nao existe: a opcao nao tem delta de
                                          taxa somavel, entao fica "—"
           · #PL (DV01 x 1e4 / NAV)   ->  PREMIO em bps do NAV posto em risco
         ⛔ Cada uma numa unidade diferente na MESMA coluna exige o sufixo: sem
         o `pt`/`bps` o leitor somaria as duas verticalmente. */
      { t: 'movimento<br><i>bps de taxa · pt na opção</i>', num: 1,
        tip: 'mov_contrato',
        f: (r) => (r.book === 'opcao'
                   ? (r.result_pts_mediano == null ? '—'
                      : terno(r.result_pts_medio, r.result_pts_mediano,
                              r.result_pts_ponderado, (v) => nf(v, 1) + ' pt'))
                   : terno(r.bps_taxa_medio, r.bps_taxa_mediano, r.bps_taxa_ponderado)) },
      { t: 'DV01<br><i>média / mediana</i>', num: 1,
        f: (r) => (r.book === 'opcao' ? '—'
                   : par(r.dv01_medio, r.dv01_mediano, (v) => nf(v, 0))) },
      { t: 'tamanho<br><i>#PL · prêmio bps na opção</i>', num: 1, tip: 'tam_contrato',
        f: (r) => (r.book === 'opcao'
                   ? (r.premio_bps_mediano == null ? '—'
                      : nf(r.premio_bps_mediano, 1) + ' bps')
                   : par(r.pl_medio, r.pl_mediano)) },
      { t: 'giro', num: 1, f: (r) => nf(r.giro_contratos, 0), tip: 'giro_ct' },
    ].concat(colsResultado()), C);
  }

  /* ══════════════════ COMO É MEDIDO ══════════════════ */
  function tabMetodo() {
    /* ⭐ O NAV veio de "Tamanho & risco" (31/08/2026, pedido do usuario): nao e
       uma conclusao sobre o gestor, e o DENOMINADOR — informacao de contexto, e
       o lugar dela e a aba de metodo. */
    const t = theme();
    const x = D.map((r) => r.data);
    /* O NAV dia a dia — o denominador de TODO #PL e de TODO bps desta análise.
       Existe para o leitor poder ver qual PL está no denominador de cada conta:
       o NAV do PAlves andou de R$ 27,1 MM (dez/25) para R$ 23,8 MM (ago/26),
       14% de amplitude, então o MESMO DV01 vale #PL diferente em janeiro e em
       agosto. A régua é o NAV DAQUELE dia, nunca o de hoje nem a média do ano. */
    const nav0 = D.map((r) => r.nav_brl).filter((v) => v != null && isFinite(v));
    Plotly.newPlot(el('figNav'), [
      { x, y: D.map((r) => r.nav_brl), name: 'NAV do trader (R$)',
        type: 'scatter', mode: 'lines', fill: 'tozeroy',
        line: { color: P()[3] || P()[0], width: 1.6 },
        fillcolor: 'rgba(120,120,120,.10)',
        hovertemplate: '%{x|%d/%m/%Y}<br>NAV R$ %{y:,.0f}<extra></extra>' },
    ], baseLayout(t, {
      height: Math.round(H_HALF() * 0.62),
      yaxis: {
        title: { text: 'R$' },
        /* eixo NÃO ancorado em zero: a variação do ano é 14% e um eixo de 0 a
           27 MM a esconderia numa linha reta — que é justamente o contrário do
           que este gráfico existe para mostrar. */
        range: nav0.length
          ? [Math.min.apply(null, nav0) * 0.96, Math.max.apply(null, nav0) * 1.02]
          : undefined,
      },
      showlegend: false, hovermode: 'x unified',
    }), CFG);

    table(el('tblReguas'), [
      { t: 'régua' }, { t: 'o que é' }, { t: 'para que serve' }, { t: 'du' },
    ].map((c, i) => ({ t: c.t, f: (r) => r[i] })), [
      /* ⚠️ TABELA CORRIGIDA (31/08/2026). O que estava errado:
         · `bps_nav` dizia "NAV do trader NO PERÍODO do trade" — é o NAV DO DIA,
           somado dia a dia, desde que o denominador virou o do momento;
         · faltava a régua que hoje MANDA no DI — o ajuste diário da B3;
         · `#PL` aparecia como uma régua só, e são DUAS (livro no dia × uma
           posição), que foi exatamente a confusão relatada pelo usuário. */
      ['<strong><code>result_b3_brl</code></strong>',
       'soma dos <strong>ajustes diários da B3</strong> do ciclo (no DI); preço + cupom nos demais',
       '<strong>o DINHEIRO</strong> — é ele que vira o resultado da tela', 'real do dia'],
      ['<code>result_brl</code>', 'fluxo de caixa <code>−Σ qtd × PU</code> do ciclo',
       'o movimento de TAXA, sem carrego — mede a leitura da curva, não o caixa', '<strong>congelado</strong>'],
      ['<code>bps_taxa</code>',
       'movimento da taxa entre a VWAP de entrada e a de saída, com o sinal da direção. '
       + '⚠️ no DI o preço JÁ é taxa; na <b>NTN-B</b> é PU, e a taxa sai de um VWAP paralelo '
       + 'sobre a indicativa observada da ANBIMA',
       'o retorno da APOSTA — não depende de quanto ele apostou. ⛔ a opção não entra: o '
       + 'preço dela não é taxa (ver <code>result_pts</code>)', 'congelado'],
      ['<code>bps_nav</code>', '<strong>Σ (resultado do dia ÷ NAV DAQUELE dia)</strong>',
       'a contribuição para o fundo — a mesma conta da curva composta', 'real do dia'],
      ['<strong><code>#PL</code> do dia</strong>', '<code>DV01 do LIVRO × 1e4 ÷ NAV</code>, num pregão',
       'quanto risco ele tinha na mão naquele dia — soma as posições vivas', '<strong>real do dia</strong>'],
      ['<strong><code>#PL</code> por trade</strong>', 'o mesmo, para UMA posição, no dia de pico dela',
       'o tamanho de uma aposta. ⚠️ menor que o do dia, na proporção de posições simultâneas', 'real do dia'],
      /* ⭐ 01/09/2026 — a regua que a tela NAO tinha, e por isso o grafico de
         exposicao desenhava um livro sempre tomado (ver §5.-47 do CLAUDE.md). */
      ['<strong><code>#PL</code> líquido</strong>',
       '<code>(DV01 tomado + DV01 aplicado) × 1e4 ÷ NAV</code> — <strong>com sinal</strong>: '
       + '+ é tomado, − é aplicado',
       'para que LADO ele estava. ☠️ não confundir com o #PL do dia, que é MÓDULO: os dois '
       + 'divergem em <strong>32% dos dias-livro</strong>, e num spread quase perfeito o '
       + 'módulo é cheio com o líquido em zero', '<strong>real do dia</strong>'],
      /* ⭐ as reguas que nasceram em 01/09/2026 — sem elas a aba descrevia um
         motor de tres meses atras */
      ['<strong><code>premio_bps</code></strong>',
       'prêmio de pico ÷ NAV do dia do pico',
       '<strong>o tamanho da OPÇÃO</strong> — o paralelo do #PL para quem não tem DV01. '
       + '⛔ nunca na mesma coluna que ele', 'real do dia'],
      ['<code>risco_max_bps</code>',
       'pior caso: o prêmio se comprado, <code>teto − prêmio</code> se vendido',
       'o prêmio não descreve o risco de quem VENDE — medido, a razão vai de 0,14 a 4,56. '
       + '“não determinado” quando o payoff é ilimitado de um lado', 'real do dia'],
      ['<strong><code>result_pts</code></strong>',
       'pontos de preço capturados, com o sinal da direção',
       'a régua NATURAL da opção: cada ponto é um ponto percentual — de probabilidade na '
       + 'digital, de payoff na estrutura de IDI (teto 100)', '—'],
      ['<code>giro_pl</code>', 'Σ (giro de DV01 do dia ÷ NAV daquele dia)',
       'o giro na régua de bps. ⚠️ NÃO é <code>giro_dv01 ÷ NAV médio</code>', 'real do dia'],
      ['<code>tam_relativo</code>', '#PL de pico ÷ #PL <strong>MEDIANO</strong> do livro dele',
       'tamanho contra o habitual — imune a mudança de alocação. ⛔ só DI e papel', 'real do dia'],
      ['<strong><code>tam_norm</code></strong>',
       'tamanho do ciclo ÷ tamanho <strong>MÉDIO</strong> da <strong>régua dele</strong> '
       + '(#PL no DI e no papel, prêmio em bps do NAV na opção)',
       '<strong>a régua COMUM de tamanho</strong> — é ela que põe books de exposição '
       + 'diferente no mesmo eixo, sem somar #PL com prêmio: o que se compara é a razão, '
       + 'que é adimensional. <code>1,00×</code> = típico do tipo dele. '
       + '☠️ não confundir com <code>tam_relativo</code>: aquele divide pela MEDIANA, é só '
       + 'do DI, e responde “grande PARA ELE”', 'real do dia'],
      ['<strong><code>bps_eq</code></strong>',
       '<code>bps_nav_liq ÷ tam_norm</code>',
       'o resultado que o ciclo teria <strong>no tamanho típico</strong> do tipo dele. '
       + '<code>Σ bps_eq</code> É o contrafactual de sizing, e é o eixo y do gráfico — '
       + 'os dois passaram a somar o mesmo número. ⚠️ normalizado de propósito: contra o '
       + 'resultado cru a correlação com tamanho seria mecânica', 'real do dia'],
      ['<code>bps_por_dv01</code>', 'resultado ÷ DV01 de pico',
       'conferência: bate com <code>bps_taxa</code> se o tamanho não mudou no meio', 'misto'],
    ]);

    const F = TA.fonte;
    table(el('tblFontes'), [
      { t: 'o que' }, { t: 'de onde' },
    ].map((c, i) => ({ t: c.t, f: (r) => r[i] })), [
      /* ⚠️ Faltavam 4 fontes que hoje entram no número: o custo, o carrego, o
         preço de marcação e o DV01 da NTN-B. E a linha da posição de abertura
         trazia o ano CRAVADO em 2026, quando o ano é parâmetro da tela. */
      ['Posição, exposição, fronteira do ciclo e resultado', '<code>' + F.posicao_resultado + '</code>'],
      ['Taxa e PU de ajuste diários (risco e marcação do DI)', '<code>' + F.ajuste_diario + '</code>'],
      ['Preço de fechamento dos demais ativos',
       '<code>' + (F.preco_marcacao || 'SOPHIS.HISTORIQUE ⋈ SOPHIS.TITRES') + '</code>'],
      ['DV01 da NTN-B (duração calculada por nós)',
       '<code>' + (F.dv01_titulo || 'ODS.RISK_GOVBONDS') + '</code>'],
      ['R$ por ponto da opção',
       'derivado do <code>amount</code> da própria boleta — a digital de COPOM valia '
       + '<b>R$ 100,00/ponto até 26/05/2025</b> e R$ 1,00 depois'],
      ['Custo de transação', '<code>' + (F.custos || '3 taxas da própria boleta') + '</code>'],
      ['Carrego do caixa', '<code>' + (F.carrego || 'CDI over') + '</code>'],
      ['Calendário de pregão', '<code>UP2DATA.SETTLEMENTPRICE.RPTDT</code> — dia em que a B3 publicou ajuste'],
      ['Dias úteis (du/252)', '<code>fixed-income-br/shared/calendar_br.py</code> (ANBIMA)'],
      ['Posição de abertura do ano',
       'boletas <code>pnl_eoy_open_*' + (TA.ano || '') + '*</code> de 31/12, em <code>infosbackoffice</code>'],
      ['NAV do trader (denominador)', '<code>' + F.nav + '</code>'],
      ['<strong>Regra de ouro</strong>', '<strong>' + F.regra + '</strong>'],
    ]);
  }

  /* ── roteador de abas ─────────────────────────────────────────────── */
  const TABS = {
    visao: tabVisao, portfolio: tabPortfolio, habilidade: tabHabilidade,
    custo: tabCusto, contratos: tabContratos, metodo: tabMetodo,
  };
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

  /* ── ponto de entrada: o arquivo do par chama isto ─────────────────────── */
  window.__taData = function (dados) {
    TA = dados;
    R = TA.resumo; D = TA.diario; TR = TA.trades;
    cabecalho();
    VAZIO = false;
    if (TA.vazio || !TR || !TR.length) { telaVazia(); return; }
    Object.keys(drawn).forEach((k) => delete drawn[k]);
    const ativo = document.querySelector('.tabbtn.on');
    render(ativo ? ativo.getAttribute('data-tab') : 'visao');
  };

  /* ── o interruptor da quebra bruto × custo ───────────────────────────────
     Default DESMARCADO: a tela mostra só o resultado LÍQUIDO. É o número que o
     gestor levou, e é ele que deve ser lido sem esforço — a versão com as três
     colunas (bruto − custo = líquido) em todo lugar é informativa, mas dobra a
     largura das tabelas e faz o leitor caçar qual coluna importa.
     ⚠️ Ele muda a PÁGINA INTEIRA, então mora na tabbar (visível em toda aba) e
     invalida `drawn` — sem isso a aba já desenhada continuaria na régua antiga.
     ⚠️ `localStorage` em `file://` pode estourar (origem opaca), daí o try. */
  const chk = el('chkDetalhe');
  if (chk) {
    try { chk.checked = localStorage.getItem('ta_detalhe') === '1'; } catch (e) { /* file:// */ }
    DETALHE = chk.checked;
    document.body.classList.toggle('detalhe', DETALHE);
    chk.addEventListener('change', function () {
      DETALHE = chk.checked;
      try { localStorage.setItem('ta_detalhe', DETALHE ? '1' : '0'); } catch (e) { /* file:// */ }
      document.body.classList.toggle('detalhe', DETALHE);
      Object.keys(drawn).forEach((k) => delete drawn[k]);
      const ativo = document.querySelector('.tabbtn.on');
      render(ativo ? ativo.getAttribute('data-tab') : 'visao');
      /* ⚠️ volta ao topo, como a troca de aba. Sem isso o leitor ficava numa
         posição que deixou de existir: ligar/desligar a quebra muda a ALTURA de
         toda a página (as tabelas ganham/perdem uma linha por célula). E tem de
         ser `instant` — o CSS tem `scroll-behavior:smooth`, e a animação de
         ~300ms corre junto com o Plotly redesenhando, terminando no lugar
         errado (é a mesma armadilha da troca de aba). */
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    });
  }
  /* ⭐ O SELETOR DE REGUA (bps × reais) — o pedido do usuario: "as analises
     fazem mais sentido em bps de forma geral. pode fazer com uma opcao de
     converter a visualizacao para financeiro."
     ⚠️ Mesmo mecanismo do `chkDetalhe`, e pelo mesmo motivo: ele muda a PAGINA
     INTEIRA, entao mora na tabbar (visivel em toda aba), invalida `drawn` — sem
     isso a aba ja desenhada continuaria na regua antiga — e volta ao topo,
     porque trocar a unidade muda a largura das celulas e a altura da pagina.
     ⚠️ `behavior:'instant'` obrigatorio: o CSS tem `scroll-behavior:smooth` e a
     animacao de ~300ms corre junto com o Plotly redesenhando.
     ⚠️ `localStorage` em `file://` pode estourar (origem opaca), daí o try. */
  const selR = el('selRegua');
  if (selR) {
    try {
      const sv = localStorage.getItem('ta_regua');
      if (sv === 'bps' || sv === 'brl') REGUA = sv;
    } catch (e) { /* file:// */ }
    selR.value = REGUA;
    selR.addEventListener('change', function () {
      REGUA = selR.value === 'brl' ? 'brl' : 'bps';
      try { localStorage.setItem('ta_regua', REGUA); } catch (e) { /* file:// */ }
      Object.keys(drawn).forEach((k) => delete drawn[k]);
      const ativo = document.querySelector('.tabbtn.on');
      render(ativo ? ativo.getAttribute('data-tab') : 'visao');
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    });
  }

  /* ⚠️ SEM `render()` aqui. Quem dispara e `__taData`, quando o arquivo do par
     terminar de carregar. Se o script dos dados ja tiver rodado antes deste
     (ordem nao garantida com injecao), o `window.TA` ja esta la e a chamada
     abaixo cobre o caso. */
  if (window.TA) window.__taData(window.TA);
})();
