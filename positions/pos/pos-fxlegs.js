/* ── Câmbio com as DUAS pernas do par (aba do PAbinader) ──────────────────────────────
   UMA tabela ("Posição por moeda", `renderFxCcyTable`) + o painel de conferência, e nada
   mais. **MM e MM Prev entram somados** (pedido da mesa): a leitura é de exposição do livro,
   e quebrar por grupo dobrava toda linha.

   Dois modos, pelo chip "⤵ Por vencimento" (default: resumido):
     • **resumido** — uma linha por moeda (abertura · operada · final + equiv. USD + % NAV),
       com a coluna "Origem" separando linear × opção quando há opção aberta;
     • **por vértice** — uma linha por (moeda, vencimento, CONTRATO), com **preço marcado de
       D-1 do JRS**, **taxa live** e **resultado do dia**. O contrato entra na chave porque
       taxa é do contrato: uma linha (moeda, vencimento) pode juntar dois pares.

   ⚰️ **A 2ª tabela ("Câmbio — pernas do par") foi REMOVIDA em set/2026.** Ela mostrava o par
   × vencimento com as duas pernas na mesma linha e a taxa contratada. Morreu porque na foto
   real do livro **23 das 28 linhas eram `caixa`** (resíduo de rolagem: a rolagem liquida uma
   perna do par exatamente e deixa o resultado na outra) — dois pares inteiros, USD/CHF e
   USD/MXN, não tinham UMA linha de contrato. O que ela tinha de único (taxa do contrato ×
   taxa de mercado, e o resultado por linha) está hoje no modo por vértice desta tabela.
   Se voltar a fazer falta, o `fx_kind`/`leg_rate`/`fx_mtm_usd` do payload continuam lá.

   ☠️ **A FONTE delas é a 2ª ONDA (`fxDealsByTab`) — NÃO as rows da tabela de Posição.**
   Decisão da mesa (set/2026): a tabela de Posição e o PnL desta aba são iguais aos de
   todos os outros traders (abertura do JRS D-1 × boletas do JDS), e o tratamento pelas
   boletas do Sophis vive SÓ nestas duas. Os dois conjuntos de linhas são diferentes de
   propósito — o do Sophis tem as pernas de CAIXA da rolagem, que o JRS não carrega como
   posição — e o painel de conferência é que declara a diferença.

   O insumo é o `ccy_legs` / `leg_*` que o backend anexa a cada row quando o /reference
   roda com `fx_from_deals=true` (ver positions/fx_sophis.py). Aqui NÃO se reconstrói
   nenhuma perna: a taxa contratada de cada boleta só existe no Sophis, e o cálculo mora
   num lugar só.

   ☠️ **`fx_kind` separa POSIÇÃO de CAIXA, e sem isso a tabela mente.** Rolagem de forward
   liquida uma perna do par exatamente e deixa o resultado na outra: em 10/09/2026 o
   `USD/MXN` de vencimento 09/10 é **+86.824 USD contra 0 MXN**. O JRS carrega essa linha
   como posição de forward — `qty × preço marcado` daria 1,47 MM de MXN que não existe em
   contrato nenhum. Aqui ela aparece como `caixa`, sem taxa (dividir uma perna pela outra
   ali dá número sem sentido: no USD/COP implicava "−103").                              */

/* Escala da marreta, por PROCEDÊNCIA da perna (ver `basis` em fx_sophis.ccy_legs_for_row):
   • `fx`  é contratual — só a marreta de QUANTIDADE a move (preço não muda um contrato);
   • `fut`/`opt` saem do #PL, então seguem o #PL efetivo (marreta de preço e de delta
     incluídas), que é o mesmo número que a coluna #PL imprime.
   Sem isto a tabela por moeda ignoraria as marretas caladamente — e é a tela onde a mesa
   digita delta de opção. */
function _fxLegScale(r, basis) {
  const eff = effectiveRowValues(r);
  if (basis === 'fx') return (eff.qtyOvr && r.final_qty) ? eff.final / r.final_qty : 1;
  const { pl } = effectiveRowPl(r, eff);
  return (r.pl && pl != null && isFinite(pl)) ? pl / r.pl : 1;
}

/* Uma tabela por FAMÍLIA de instrumento, e não uma só com tudo (pedido da mesa, set/2026:
   "retira o futuro dessa análise, cria uma tabela separada para ele, no mesmo modelo").
   O motivo de fundo é o mesmo que separa as colunas: nocional CONTRATADO de forward e
   nocional DERIVADO de futuro não são a mesma afirmação, e somados numa tabela só o leitor
   não sabe qual metade se move com o mercado. */
const _FX_GROUPS = [
  { id: 'fx',  lbl: 'FX linear', tip: 'Forward, NDF e spot: as DUAS pernas de cada contrato, na TAXA CONTRATADA de cada boleta (JDS.VW_SOPHIS_DEALS). Número contratual — não muda com o mercado.' },
  { id: 'fut', lbl: 'Futuro',    tip: 'Futuro de dólar (WDO/UC): nocional do contrato, derivado da coluna #PL. DERIVADO — move com o preço.' },
  { id: 'opt', lbl: 'Opção (Δ)', tip: 'Opção de FX/DOL: nocional × DELTA, avaliado no spot. DERIVADO — move a cada tick e desaparece quando a Bloomberg não devolve delta.' },
];
// A ORIGEM exibida é o próprio `basis` da perna — ver `_FX_GROUPS`. (Houve uma versão em que
// `fx` e `fut` eram um grupo só, "FX linear"; caiu quando o futuro ganhou tabela própria.)
const _fxGroupOf = basis => basis;

/* Piso para AFIRMAR o check de alocação MM × MM Prev, em USD. Ver `alcRow`: abaixo disso a
   linha é resíduo de rolagem e a proporção não significa nada. Mesmo número do filtro
   "Excluir FX < 200k" (`no_fx_small`, pos-helpers.js) — a régua da casa para "FX pequeno". */
const _ALLOC_MIN_USD = 200_000;

/* Família de uma row, MESMO que ela não tenha produzido perna nenhuma — é o que permite
   cada tabela declarar só as SUAS órfãs (`_fxOrphans`) em vez de listar as da outra. */
function _fxRowBasis(r) {
  if (r.is_fx) return 'fx';
  if (r.option_subtype === 'fx' || r.option_subtype === 'dol') return 'opt';
  if (typeof _dollarKind === 'function' && ['wdo', 'uc'].includes(_dollarKind(r))) return 'fut';
  return null;
}

/* Linhas COM posição que a tabela deveria cobrir e que não produziram perna nenhuma.
   Acontece de verdade, e por motivos diferentes: opção sem delta da Bloomberg, futuro sem
   `PX_LAST` (contrato vencido numa data histórica), moeda sem spot. Um net que ignora linha
   calado é um net errado — então elas vão para o ⚠ do rodapé, nomeadas. */
function _fxOrphans(rows, bases) {
  return rows.filter(r => bases.has(_fxRowBasis(r))
                       && !(r.ccy_legs ?? []).length
                       && Math.abs(effectiveRowValues(r).final ?? 0) > 0)
             .map(r => r.instrument_name ?? '—');
}

/* ── DENOMINADOR do % NAV — MM + MM Prev, não só MM ────────────────────────────────────
   ☠️ **O NAV do trader cobre só o MM.** Estas tabelas somam TODOS os grupos (Offshore-A/F =
   MM e Offshore-H = MM Prev), então dividir pelo NAV cru inflava o % em ~30% no PAbinader —
   a mesa pegou. O equivalente do Prev é o ALVO DE ALOCAÇÃO que a tela já usa no check
   MM×Prev (`ALLOC_TARGETS`, pos-helpers.js): 0,30 p/ o PAbinader ⇒ NAV × **1,30**.
   ⚠️ O fator só entra quando há linha de MM Prev na soma. Filtrar/ocultar o Prev e continuar
   dividindo por 1,30 subestimaria o % — e a tabela declara qual denominador usou.
   ⚠️ É o ALVO, não o rateio realizado: é a mesma régua do check de alocação (e a que a mesa
   pediu). Se o alvo mudar em `ALLOC_TARGETS`, este número acompanha. */
function _fxNavInfo(rows, trader, navSrc) {
  const nav = (navSrc ?? posDataByTab[activeTraderTab] ?? positionsData)?.traders?.[trader]
           ?? rows.find(r => r.nav != null)?.nav ?? null;
  const hasPrev = rows.some(r => r.group === 'MM Prev');
  const target  = (typeof ALLOC_TARGETS !== 'undefined' && ALLOC_TARGETS[trader]) || 0;
  const factor  = (hasPrev && target) ? 1 + target : 1;
  return { nav, factor, den: nav == null ? null : nav * factor, hasPrev, target };
}

/* Painel do ⓘ: REGRA, não caso do dia (pedido da mesa — a nota de 8 linhas embaixo da
   tabela competia com ela). `white-space: pre` no CSS → as quebras são estas. */
const _FX_CCY_HELP =
  'POSIÇÃO POR MOEDA — as duas pernas de cada contrato de câmbio\n' +
  '(comprar USD/MXN é +USD e −MXN), somando MM + MM Prev.\n' +
  '\n' +
  'FONTE       abertura = boletas do Sophis acumuladas (só elas têm a taxa\n' +
  '            contratada de cada negócio); operada = boletas do dia (JDS).\n' +
  '            A tabela de Posição acima segue sendo JRS D-1 × JDS, e o\n' +
  '            painel abaixo confere uma contra a outra.\n' +
  'ESCOPO      forward, NDF, spot e opção de FX. O futuro de dólar tem\n' +
  '            tabela PRÓPRIA: nocional contratado e nocional derivado do\n' +
  '            #PL não são a mesma afirmação.\n' +
  'RESULT.DIA  o P&L é do CONTRATO: entra na moeda que se moveu contra o\n' +
  '            dólar, então a linha do USD fica vazia e a soma da coluna é\n' +
  '            o resultado do dia. Em cross (par sem perna em dólar) vai\n' +
  '            inteiro para a moeda-base.\n' +
  'PREÇOS      só na visão por vencimento — taxa é do contrato, não da\n' +
  '            moeda. A opção fica de fora: prêmio não é taxa.\n' +
  'EQUIV. USD  a perna é CONTRATUAL (taxa da boleta), mas o equivalente em\n' +
  '            dólar é a MERCADO: converte pelo spot de agora. Por isso a\n' +
  '            soma não dá zero — o que sobra é a marcação. NÃO é exposição.\n';

const _FX_FUT_HELP =
  'FUTURO DE DÓLAR — a mesma leitura por moeda, para WDO/UC, somando\n' +
  'MM + MM Prev. Separado do câmbio a pedido da mesa.\n' +
  '\n' +
  'ORIGEM      aqui o nocional é DERIVADO da coluna #PL (contratos ×\n' +
  '            valor do ponto × preço), então move com o mercado — ao\n' +
  '            contrário do forward, cuja perna é contratual.\n' +
  'PERNAS      +USD contra −BRL, pelo nocional do contrato.\n' +
  'RESULT.DIA  vai para o BRL, que é a moeda que se move contra o dólar.\n' +
  '            Mesma função da aba PnL, então segue as marretas de preço.\n';

/* ── Tabela de exposição por moeda ─────────────────────────────────────────────────────
   Serve as DUAS seções da aba — câmbio (`bases` = fx + opt) e futuro de dólar
   (`bases` = fut) —, porque o modelo é o mesmo e duas cópias divergiriam na primeira
   correção. `cfg`: { bases:Set, titulo, chip:bool }. */
function renderFxCcyTable(rows, navInfo, tabId, cfg) {
  const nav   = navInfo?.den ?? null;
  const bases = cfg.bases;
  const byVtx = fxCcyByVertex.has(tabId);   // chip "⤵ Por vencimento" (default: resumido)

  /* Chave: `(moeda, origem)` no resumo; `(moeda, VÉRTICE, CONTRATO)` por vencimento.
     ☠️ **O contrato entra na chave por vértice porque SEM ELE não existe "a taxa".** Uma
     linha `(moeda, vencimento)` pode juntar mais de um par — o EUR de 14/09 vem de EUR/USD
     E de EUR/AUD, com marcações e taxas diferentes —, e as colunas de preço mostrariam a de
     um par como se fosse a dos dois. */
  const acc = new Map();
  const crossPairs = new Set();   // pares sem perna em USD (ver `res_cross`) — vão no rodapé
  let anyLeg = false;
  for (const r of rows) {
    const mat  = byVtx ? (r.maturity ? String(r.maturity).slice(0, 10) : '') : '';
    const inst = byVtx ? (r.instrument_name ?? '') : '';
    for (const l of (r.ccy_legs ?? [])) {
      if (!bases.has(l.basis)) continue;
      anyLeg = true;
      const k   = _fxLegScale(r, l.basis);
      const grp = _fxGroupOf(l.basis);
      const key = `${l.ccy}||${mat}||${byVtx ? inst : grp}`;
      if (!acc.has(key)) acc.set(key, { ccy: l.ccy, mat, grp, inst, basis: l.basis,
        px: r.price, live: (typeof effectivePrice === 'function' ? effectivePrice(r) : r.price_live),
        o: 0, t: 0, f: 0, fMM: 0, fPrev: 0, uo: 0, ut: 0, uf: 0, res: 0, hasRes: false,
        semUsd: [], nSemO: 0 });
      const a = acc.get(key);
      a.o += (l.open   ?? 0) * k;
      a.t += (l.traded ?? 0) * k;
      a.f += (l.final  ?? 0) * k;
      // A perna final QUEBRADA POR GRUPO alimenta o check de alocação ao lado. A tabela
      // principal soma os dois (é exposição do livro); o check é justamente sobre a divisão.
      if (r.group === 'MM Prev') a.fPrev += (l.final ?? 0) * k;
      else if (r.group === 'MM') a.fMM += (l.final ?? 0) * k;
      if (l.open == null || l.traded == null) a.nSemO++;   // fut/opt sem `unit_pl`
      /* RESULTADO do dia: é do CONTRATO (não de cada perna), e entra na perna que o backend
         marca com `is_res` — **a moeda que se moveu contra o dólar** (MXN no USD/MXN, BRL no
         futuro de dólar). A linha do USD fica vazia por construção. Somar nas duas contaria
         o mesmo P&L 2×.
         ⚠️ `pnlFor` (pnl.js), e não o `total_usd` cru: é a MESMA função da aba PnL, então uma
         marreta de preço — inclusive a do "Buscar Settle D0", que troca a taxa live pelo
         FECHAMENTO de D0 — aparece aqui e lá com o mesmo número. */
      if (l.is_res) {
        const tot = (typeof pnlFor === 'function' ? pnlFor(r).total : r.total_usd);
        if (tot != null) {
          a.res += tot * k; a.hasRes = true;
          if (l.res_cross) crossPairs.add(r.instrument_name ?? '—');
        }
      }
      // Perna sem spot da moeda não vira zero: some do equivalente em USD e é NOMEADA.
      // (É o buraco do item 12 do CLAUDE.md — moeda nova entra muda.)
      if (l.usd_final == null) a.semUsd.push(r.instrument_name ?? '—');
      else { a.uo += (l.usd_open ?? 0) * k; a.ut += (l.usd_traded ?? 0) * k; a.uf += l.usd_final * k; }
    }
  }
  if (!anyLeg) return '';

  // Linha que ZEROU nos TRÊS momentos e sem resultado sai (par que se anulou entre contratos
  // — ZAR e COP fazem isso toda semana). ⚠️ O corte exige todos: o que abriu e zerou HOJE é
  // justamente o que a mesa quer ver.
  const _flat = x => Math.abs(x.uf) < 1 && Math.abs(x.uo) < 1 && Math.abs(x.ut) < 1
                  && Math.abs(x.res) < 1 && !x.semUsd.length;

  const byCcy = new Map();
  for (const a of acc.values()) {
    if (_flat(a)) continue;
    if (!byCcy.has(a.ccy)) byCcy.set(a.ccy, { ccy: a.ccy, legs: [], uf: 0, uo: 0, ut: 0, res: 0, nRes: 0,
                                             fMM: 0, fPrev: 0, semUsd: [] });
    const g = byCcy.get(a.ccy);
    g.legs.push(a); g.uf += a.uf; g.uo += a.uo; g.ut += a.ut; g.res += a.res;
    g.fMM += a.fMM; g.fPrev += a.fPrev;
    if (a.hasRes) g.nRes++;
    g.semUsd.push(...a.semUsd);
  }
  const zeroed = [...new Set([...acc.values()].filter(_flat).map(a => a.ccy))]
    .filter(c => !byCcy.has(c));

  const _grank = id => Math.max(0, _FX_GROUPS.findIndex(x => x.id === id));
  for (const g of byCcy.values()) {
    g.legs.sort((x, y) => (x.mat || '').localeCompare(y.mat || '')
                       || _grank(x.grp) - _grank(y.grp)
                       || String(x.inst).localeCompare(String(y.inst)));
  }
  const list = [...byCcy.values()].sort((x, y) => Math.abs(y.uf) - Math.abs(x.uf));
  if (!list.length) return '';
  const totUsd  = list.reduce((s, g) => s + g.uf, 0);
  const totRes  = list.reduce((s, g) => s + g.res, 0);
  const orphans = _fxOrphans(rows, bases);
  const nLegs   = list.reduce((s, g) => s + g.legs.length, 0);
  // "Origem" só no RESUMO e só com mais de um grupo NESTA tabela — por vencimento a coluna
  // "Contrato" já diz o que é cada linha, e com um grupo só ela repetiria o mesmo rótulo.
  const showG = !byVtx && new Set(list.flatMap(g => g.legs.map(a => a.grp))).size > 1;
  const NC    = (byVtx ? 10 : 7) + (showG ? 1 : 0) - (byVtx ? 0 : 1);

  const navTip = 'Equivalente em USD sobre o NAV.\nDenominador: '
    + (navInfo?.den == null ? '—'
       : (navInfo.factor > 1
          ? `USD ${(navInfo.nav / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MM`
            + ` × ${navInfo.factor.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`
            + ` = USD ${(navInfo.den / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MM`
          : `USD ${(navInfo.den / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MM`))
    + (navInfo?.factor > 1
        ? '\n\nA tabela soma MM + MM Prev, e o NAV do trader cobre só o MM — o equivalente'
          + ' do Prev entra pelo alvo de alocação dele (ALLOC_TARGETS), o mesmo do check MM×Prev.'
        : '\n\nSem linha de MM Prev na soma: denominador = NAV do trader, sem ajuste.');

  // Check de alocação ao lado: só com alvo cadastrado p/ o trader E com perna no MM Prev —
  // sem uma das duas a tabela seria uma coluna de traços.
  const target    = (typeof ALLOC_TARGETS !== 'undefined' && ALLOC_TARGETS[cfg.trader]) ?? null;
  const showAlloc = target != null && list.some(g => Math.abs(g.fPrev) > 1e-9);
  // Altura do cabeçalho das DUAS tabelas é a mesma (mesma classe, 1 linha, nowrap), então o
  // alinhamento sai do próprio fluxo; este espaçador é 0 e existe como ponto único de ajuste
  // caso um dia o cabeçalho de uma delas passe a ter duas linhas.
  const AUX_HEAD_GAP = 0;

  const pct   = u => (nav ? fmtPL(u / nav, 'pct') : '<span style="color:var(--text-muted)">—</span>');
  const _dash = t => `<span style="color:var(--text-muted)"${t ? ` title="${_fxEsc(t)}"` : ''}>—</span>`;
  // Preço/taxa só onde a cotação do instrumento É a taxa do par (forward/NDF) ou a cotação
  // do próprio contrato (futuro, nesta tabela sozinho). A OPÇÃO fica de fora: prêmio não é
  // taxa, e pô-lo na mesma coluna de 5,1013 seria trocar a régua no meio da coluna.
  const _NOT_RATE = 'Opção é cotada em PRÊMIO, não na taxa do par — ver a tabela de Posição.';

  const body = list.map(g => {
    const warn = g.semUsd.length
      ? ` <span class="net-warn" title="${_fxEsc(
          `${g.semUsd.length} perna(s) sem câmbio USD${g.ccy} — FORA do equivalente em USD:\n· `
          + g.semUsd.join('\n· '))}">⚠</span>`
      : '';
    const band = byVtx
      ? `<tr class="grp"><td colspan="${NC}">${g.ccy}${warn}
          <span style="font-weight:400;text-transform:none;letter-spacing:0">
            · ${g.legs.length} linha(s)</span></td></tr>`
      : '';
    const trs = g.legs.map(a => {
      const gi = _FX_GROUPS.find(x => x.id === a.grp) ?? { lbl: a.grp, tip: '' };
      // `fut`/`opt` sem `unit_pl` (sem NAV/preço): abertura e operada desconhecidas — traço,
      // não zero. Zero ali diria "não operou", que é outra afirmação.
      const semAb  = a.nSemO > 0;
      const temPx  = a.basis !== 'opt';
      const cells = byVtx ? `
        <td class="lbl" style="font-weight:400;color:var(--text)">${a.mat ? fmtDate(a.mat) : _dash('Linha sem vencimento no JRS/JDS.')}</td>
        <td class="left" style="font-size:11px" title="${_fxEsc(gi.tip)}">${a.inst || '—'}</td>`
        : `
        <td class="lbl">${g.ccy}${warn}</td>
        ${showG ? `<td class="left" style="font-size:11px;color:var(--text-muted)" title="${_fxEsc(gi.tip)}">${gi.lbl}</td>` : ''}`;
      const px = byVtx ? `
        <td class="sep-wide">${temPx ? _fxRate(a.px) : _dash(_NOT_RATE)}</td>
        <td>${temPx ? _fxRate(a.live) : _dash(_NOT_RATE)}</td>
        <td class="sep">${a.hasRes ? fmtMoney(a.res) : _dash(a.ccy === 'USD'
            ? 'Vazio por construção: o resultado vai para a moeda que se moveu CONTRA o dólar, e o dólar não se move contra ele mesmo.'
            : 'O resultado deste contrato está na linha da moeda que se moveu contra o dólar.')}</td>`
        : `
        <td class="sep-wide">${a.hasRes ? fmtMoney(a.res) : _dash(a.ccy === 'USD'
            ? 'Vazio por construção: o resultado vai para a moeda que se moveu CONTRA o dólar, e o dólar não se move contra ele mesmo.'
            : 'Nenhum contrato desta moeda atribuiu resultado a ela.')}</td>`;
      return `<tr>
        ${cells}
        <td class="sep">${semAb ? _dash('Abertura não determinada: sem NAV/preço para a exposição por unidade.') : fmtFinalQty(a.o)}</td>
        <td>${semAb ? _dash('') : fmtTradedQty(a.t)}</td>
        <td class="sep val">${fmtFinalQty(a.f)}</td>
        <td class="sep">${fmtMoney(a.uf)}</td>
        <td>${pct(a.uf)}</td>
        ${px}
      </tr>`;
    }).join('');
    const tot = `<tr class="tot tot-sub">
      <td class="lbl">${g.ccy} · total</td>${byVtx || showG ? '<td></td>' : ''}
      <td class="sep">${fmtFinalQty(g.legs.reduce((s, a) => s + a.o, 0))}</td>
      <td>${fmtTradedQty(g.legs.reduce((s, a) => s + a.t, 0))}</td>
      <td class="sep val">${fmtFinalQty(g.legs.reduce((s, a) => s + a.f, 0))}</td>
      <td class="sep">${fmtMoney(g.uf)}</td>
      <td>${pct(g.uf)}</td>
      ${byVtx ? `<td class="sep-wide"></td><td></td><td class="sep">${g.nRes ? fmtMoney(g.res) : ''}</td>`
              : `<td class="sep-wide">${g.nRes ? fmtMoney(g.res) : ''}</td>`}
    </tr>`;
    return band + trs + (g.legs.length > 1 ? tot : '');
  }).join(byVtx ? `<tr class="gap"><td colspan="${NC}"></td></tr>` : '');

  /* ── Auxiliar: check da alocação MM × MM Prev ────────────────────────────────────
     ☠️ **Espelha linha a linha a tabela principal** — mesma ordem, mesmas faixas, mesmos
     subtotais, mesmo respiro. É o que faz as duas ficarem ALINHADAS lado a lado sem
     JavaScript de medição; é o mesmo contrato que a `renderAllocTable` tem com a tabela de
     Posição. Mexer na estrutura de uma sem mexer na outra desalinha tudo.
     O alvo é o `ALLOC_TARGETS[trader]` (0,30 p/ o PAbinader) e o check é **Prev ÷ MM** — a
     mesma razão do check da tabela de Posição, não Prev ÷ total. */
  /* ⚠️ **O check NÃO é afirmado em linha pequena** — e isso saiu da 1ª medição na tela: as
     moedas cujo net é só RESÍDUO DE ROLAGEM saíam com CHF 21,1%, MXN 13,3% e COP −100%, ao
     lado das posições de verdade todas em 30,3-30,4%. Numa sobra de US$ 54 mil a proporção
     MM×Prev não significa nada, e pintar aquilo de amarelo/vermelho todo dia treina a mesa a
     ignorar a coluna. O piso é o mesmo US$ 200 mil do filtro "Excluir FX < 200k"
     (`no_fx_small`), que é a régua que a casa já usa para "posição de câmbio pequena". */
  const alcRow = (mmQ, prevQ, usdAbs) => {
    const small = !(usdAbs == null || Math.abs(usdAbs) >= _ALLOC_MIN_USD);
    const pctv  = (mmQ && !small) ? prevQ / mmQ : null;
    const cls   = allocClass(pctv != null && target != null ? pctv - target : null);
    const cell  = pctv != null ? fmtPct(pctv)
      : `<span style="color:var(--text-muted)" title="${_fxEsc(small
          ? 'Posição abaixo de US$ 200 mil — resíduo de rolagem. A proporção MM×Prev aqui não '
            + 'diz nada, então o check não é afirmado (mesmo corte do filtro "Excluir FX < 200k").'
          : 'Sem perna no MM para comparar.')}">—</span>`;
    return `<td class="num">${fmtFinalQty(mmQ)}</td>
            <td class="num">${fmtFinalQty(prevQ)}</td>
            <td class="num">${fmtFinalQty(mmQ + prevQ)}</td>
            <td class="num ${cls}">${cell}</td>`;
  };
  const auxBody = !showAlloc ? '' : list.map(g => {
    const band = byVtx ? `<tr class="grp"><td colspan="4">&nbsp;</td></tr>` : '';
    const trs  = g.legs.map(a => `<tr>${alcRow(a.fMM, a.fPrev, a.uf)}</tr>`).join('');
    const tot  = `<tr class="tot tot-sub">${alcRow(
      g.legs.reduce((s2, a) => s2 + a.fMM, 0), g.legs.reduce((s2, a) => s2 + a.fPrev, 0), g.uf)}</tr>`;
    return band + trs + (g.legs.length > 1 ? tot : '');
  }).join(byVtx ? `<tr class="gap"><td colspan="4"></td></tr>` : '');

  const aux = !showAlloc ? '' : `<div data-html2canvas-ignore="true">
    <div style="height:${AUX_HEAD_GAP}px"></div>
    <table class="jgp-tbl">
      <thead><tr>
        <th title="Perna final desta moeda nos fundos do grupo MM.">Qtd MM</th>
        <th title="Perna final desta moeda nos fundos do grupo MM Prev.">Qtd MM Prev</th>
        <th title="MM + MM Prev — o mesmo número da coluna Final da tabela ao lado.">Qtd total</th>
        <th title="${_fxEsc('MM Prev ÷ MM, contra o alvo de alocação do trader (' + fmtPct(target)
          + '). Mesma razão e mesma régua do check da tabela de Posição: verde dentro de '
          + fmtPct(ALLOC_TOL) + ', amarelo até o dobro, vermelho além.\n\n'
          + 'Linha abaixo de US$ 200 mil não é afirmada: ali o net é resíduo de rolagem e a proporção não diz nada.')
          }">Check ${fmtPct(target)}</th>
      </tr></thead>
      <tbody>${auxBody}<tr class="tot"><td colspan="4"></td></tr></tbody>
    </table>
  </div>`;

  const chip = cfg.chip
    ? `<span class="filter-chip ${byVtx ? 'on' : 'off'}" data-html2canvas-ignore="true"
            style="font-weight:400" onclick="toggleFxCcyVertex('${tabId}')"
            title="${byVtx ? 'Voltar ao resumo — uma linha por moeda, sem as colunas de taxa.' : 'Quebrar cada moeda por VENCIMENTO e contrato, acrescentando o preço marcado de D-1 (JRS) e a taxa live de cada um. Vale para as duas tabelas.'}">${byVtx ? '⤵ Por vencimento ✕' : '⤵ Por vencimento'}</span>`
    : '';

  return `<div class="card">
    <div class="section-title" style="padding:8px 0 10px 0;display:flex;align-items:center;gap:16px">
      <span>${cfg.titulo}
        <span style="font-weight:400;color:var(--text-muted);font-size:13px">— ${list.length} moeda(s)${byVtx ? ` · ${nLegs} linha(s)` : ''} · MM + MM Prev</span>
      </span>
      ${chip}
      <button class="btn btn-secondary" data-html2canvas-ignore="true"
              style="padding:3px 12px;font-size:12px;margin-left:auto" onclick="copyCardImage(this)">⎘ Copiar</button>
    </div>
    <div style="display:flex;gap:32px;align-items:flex-start">
    <div class="section-copy-target" style="max-width:100%">
      <div style="overflow-x:auto">
        <table class="jgp-tbl">
          <thead><tr>
            <th class="left">${byVtx ? 'Vencto' : 'Moeda'}</th>
            ${byVtx ? '<th class="left" title="O par (ou o instrumento) de onde vem esta perna. Entra na quebra porque a taxa é do CONTRATO: uma linha (moeda, vencimento) pode juntar dois pares, e aí não existe &quot;a taxa&quot; da moeda.">Contrato</th>' : ''}
            ${showG ? `<th class="left" title="De onde vem o número da linha — e as origens não são a mesma coisa: forward/NDF é nocional CONTRATADO, opção é nocional × delta no spot.">Origem</th>` : ''}
            <th class="sep" title="Nocional da perna na ABERTURA (D-1), na própria moeda.">Abertura</th>
            <th title="Nocional que as boletas de HOJE acrescentaram (ou tiraram) à perna.">Operada</th>
            <th class="sep" title="Abertura + operada, na própria moeda.">Final</th>
            <th class="sep" title="A perna FINAL em dólar, ao spot de agora (USD{moeda} Curncy). A perna é contratual; o equivalente é a mercado.">Equiv. USD</th>
            <th title="${_fxEsc(navTip)}">% NAV${navInfo?.factor > 1 ? ' *' : ''}</th>
            ${byVtx ? `
            <th class="sep-wide" title="Preço MARCADO de D-1 pelo JRS para este contrato (jrs.vw_results). É a base do resultado de estoque do dia.">Preço D-1</th>
            <th title="Preço/taxa a mercado do vencimento. Segue a MARRETA: depois de &quot;Buscar Settle D0&quot; mostra a marcação do FECHAMENTO de D0.">Tx. live</th>` : ''}
            <th class="${byVtx ? 'sep' : 'sep-wide'}" title="${_fxEsc(
              'Resultado do DIA em USD: estoque contra o preço D-1 + as boletas de hoje contra o preço médio.\n\n'
              + 'O P&L é do CONTRATO, não de cada perna — então vai para a moeda que se MOVEU CONTRA O DÓLAR '
              + '(MXN no USD/MXN, BRL no futuro de dólar). A linha do USD fica vazia por construção, e a soma '
              + 'da coluna é o resultado do dia desta tabela.\n\n'
              + 'Mesma função da aba PnL (`pnlFor`), então segue as marretas de preço.')}">Result. dia</th>
          </tr></thead>
          <tbody>
            ${body}
            <tr class="tot">
              <td class="lbl" title="As duas pernas de cada contrato se anulam em dólar, então a soma do Equiv. USD NÃO é exposição — é a marcação a mercado das posições em ser (mais o caixa a liquidar).">Soma</td>
              ${byVtx || showG ? '<td></td>' : ''}<td class="sep"></td><td></td><td class="sep"></td>
              <td class="sep">${fmtMoney(totUsd)}</td>
              <td>${nav ? fmtPL(totUsd / nav, 'pct') : ''}</td>
              ${byVtx ? `<td class="sep-wide"></td><td></td><td class="sep">${fmtMoney(totRes)}</td>`
                      : `<td class="sep-wide">${fmtMoney(totRes)}</td>`}
            </tr>
          </tbody>
        </table>
      </div>
      <p class="csub jgp-tbl-note" style="margin:6px 0 0;font-size:11.5px;color:var(--text-muted);line-height:1.5">
        <span class="jgp-info" data-info="${_fxEsc(cfg.help + navHelpText(navInfo))}">&#9432;</span>
        ${orphans.length ? `<span style="color:var(--red);margin-left:10px" title="${_fxEsc(
            'Sem delta da Bloomberg, sem preço ou sem câmbio da moeda:\n· ' + orphans.join('\n· '))
          }">⚠ ${orphans.length} linha(s) fora da soma</span>` : ''}
        ${zeroed.length ? `<span style="margin-left:10px" title="${_fxEsc(
            'Nada em abertura, operada, final nem resultado — as pernas se anularam entre contratos.')
          }">${zeroed.length} moeda(s) zerada(s) fora da tabela: ${zeroed.join(' · ')}</span>` : ''}
        ${crossPairs.size ? `<span style="margin-left:10px" title="${_fxEsc(
            'Par sem perna em dólar: o resultado inteiro foi para a moeda-BASE. Separá-lo entre as duas '
            + 'exigiria o movimento de cada uma contra o dólar, que não está neste cálculo.')
          }">cross: ${[...crossPairs].join(' · ')}</span>` : ''}
      </p>
    </div>
    ${aux}
    </div>
  </div>`;
}

/* Cauda dinâmica do painel do ⓘ: a regra do denominador só vale a linha quando ele é
   ajustado pelo Prev. O número do dia fica no `title` da própria coluna. */
function navHelpText(navInfo) {
  return navInfo?.factor > 1
    ? '% NAV       denominador = NAV do trader × (1 + alvo de alocação do Prev),\n'
      + '            porque a tabela soma MM + MM Prev e o NAV cobre só o MM. O\n'
      + '            número do dia está no title da própria coluna.\n'
    : '';
}

/* Chip "⤵ Por vencimento". Estado por ABA (`fxCcyByVertex`, pos-state.js) e não global: é
   escolha de exibição daquela tela, e sobrevive ao re-render porque os cards são remontados
   a partir do Set. Default RESUMIDO — a mesa pediu a leitura de relance primeiro.
   ⚠️ O chip é UM só (mora na tabela de câmbio) e vale para as DUAS tabelas: são a mesma
   pergunta feita a duas famílias de instrumento, e dois chips fora de sincronia seriam pior
   que um. */
function toggleFxCcyVertex(tabId) {
  fxCcyByVertex.has(tabId) ? fxCcyByVertex.delete(tabId) : fxCcyByVertex.add(tabId);
  renderFxSectionsForTab(tabId);
}

const _fxEsc = t => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// Taxa de câmbio: 4 casas servem de 1,1666 (EURUSD) a 3.099,6038 (COP) sem trocar de régua.
const _fxRate = v => (v == null || !isFinite(v))
  ? '<span style="color:var(--text-muted)">—</span>'
  : v.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });

/* ── Painel de conferência (tie-out das boletas × JRS) ─────────────────────────────
   A reconstrução foi aferida em 6 datas com 0 divergências, mas isso é medição de um dia:
   posição de câmbio que passa a divergir CALADA é o pior resultado possível. O backend
   refaz o tie-out a cada request (positions/fx_sophis.tieout_vs_jrs) e este painel o
   declara — verde quando fecha, vermelho quando não.
   ⚠️ `extra_in_deals` NÃO é divergência: são as pernas de caixa e as de `Hedge_Cambial`
   (broker "Trava Patrimonial") que o JRS não carrega como posição de Forex. */
function renderFxTieout(d) {
  const t = d?.fx_deals;
  if (!t) return '';
  // Sem PNLEOD na data de abertura não há com o que conferir — e dizer "✓ confere" com
  // "0 de 0 linhas" seria pior que não dizer nada (é o caso de forçar um D-1 antigo).
  if (!t.n_jrs) {
    return `<div class="card" style="border-left:3px solid var(--yellow)">
      <div style="font-size:12px;line-height:1.6">
        <b style="color:var(--yellow)">⚠ Câmbio: sem conferência</b>
        <span style="color:var(--text-muted)"> — a posição de câmbio veio das boletas
        (<code>${_fxEsc(t.source ?? '—')}</code>, ${fmtQty(t.n_boletas ?? 0)} boleta(s)), mas o
        JRS não tem posição de Forex na data de abertura para comparar. Números não aferidos
        nesta data.</span>
      </div></div>`;
  }
  const bad = (t.n_mismatch ?? 0) + (t.missing_in_deals ?? 0);
  const cor = bad ? 'var(--red)' : 'var(--green)';
  const detail = bad && t.worst?.length
    ? `<div style="margin-top:6px;font-size:11px;color:var(--text-muted)">
         ${t.worst.slice(0, 6).map(w =>
           `<div><code>${_fxEsc(w.key)}</code> — JRS ${w.jrs == null ? '—' : fmtQty(w.jrs)}
            · boletas ${w.deals == null ? '—' : fmtQty(w.deals)}
            · dif <b style="color:var(--red)">${fmtQty(w.dif)}</b></div>`).join('')}
       </div>` : '';
  return `<div class="card" style="border-left:3px solid ${cor}">
    <div style="font-size:12px;line-height:1.6">
      <b style="color:${cor}">${bad ? '⚠ Câmbio: a posição das boletas NÃO reproduz o JRS'
                                    : '✓ Câmbio: posição das boletas confere com o JRS'}</b>
      <span style="color:var(--text-muted)"> — abertura de <code>${_fxEsc(t.source ?? '—')}</code>
      (${fmtQty(t.n_boletas ?? 0)} boleta(s) acumuladas)${t.source_traded
        ? ` · operada do dia de <code>${_fxEsc(t.source_traded)}</code>
            <span title="A view do Sophis é carregada no batch da NOITE (aferido: MAX(trade_date) = D-1). A perna do dia vem das boletas do JDS — as mesmas que a coluna &quot;Qtd Operada&quot; da tabela de Posição usa.">ⓘ</span>` : ''},
      ${t.n_match ?? 0} de ${t.n_jrs ?? 0} linha(s) do JRS
      idênticas${t.n_mismatch ? ` · <b style="color:var(--red)">${t.n_mismatch} com quantidade diferente
      (máx. ${fmtQty(t.max_abs_mismatch)})</b>` : ''}${t.missing_in_deals
        ? ` · <b style="color:var(--red)">${t.missing_in_deals} do JRS sem boleta</b>` : ''}
      <span title="Linhas que as boletas têm e o JRS não carrega como posição de Forex: pernas de caixa da rolagem e USD/BRL de Hedge Cambial (broker &quot;Trava Patrimonial&quot;). Esperado — o filtro &quot;Excluir Hedge Cambial&quot; tira a maior parte.">
      · ${t.extra_in_deals ?? 0} só nas boletas (caixa/trava)</span></span>
      ${detail}
    </div>
  </div>`;
}

/* Ponto de entrada único da aba: desenha a tabela de câmbio + a conferência.
   Chamado pelo `renderSectionsForTab` (carga) e pelo `rerenderTables` (filtro/marreta/
   ocultar linha).

   ☠️ **A fonte destas 3 peças é a 2ª ONDA (`fxDealsByTab`), NÃO as rows da tabela de
   Posição** (decisão da mesa, set/2026). A tabela de Posição desta aba é igual à de todos
   os outros traders — abertura do JRS D-1 × boletas do JDS —, e o tratamento pelas boletas
   do Sophis vive SÓ aqui. São dois conjuntos de linhas diferentes de propósito: o do Sophis
   tem as pernas de CAIXA da rolagem, que o JRS não carrega como posição (33 a 48 por dia).
   O painel de conferência logo abaixo é que declara a diferença.

   ⚠️ Mesmo com fonte própria, o que a mesa DESLIGA na aba continua valendo aqui: os chips
   de filtro e o ✕ de linha são aplicados às rows da 2ª onda (predicados puros sobre a row),
   e as marretas de preço/delta entram pelo `_fxLegScale`. Uma tabela que ignorasse o chip
   ao lado dela leria como erro de conta.
   ⚠️ A agregação WDO+UC NÃO é aplicada: é escolha de exibição da tabela de Posição, e o net
   por moeda tem de ficar igual quando ela é ligada/desligada. */
function renderFxSectionsForTab(tabId) {
  const elC = document.getElementById(`fxCcyContainer-${tabId}`);
  const elF = document.getElementById(`fxFutContainer-${tabId}`);
  const elT = document.getElementById(`fxTieout-${tabId}`);
  if (!elC && !elF && !elT) return;                 // aba sem as seções → nada a fazer

  const data = fxDealsByTab[tabId];
  // ⚠️ 2ª onda ainda em voo: NÃO se toca nos containers. Escrever '' aqui APAGAVA o
  // esqueleto de "Carregando…" que o PosBusy acabou de pôr, deixando as duas seções em
  // branco até o dado chegar (2,7s medidos). Vale também p/ um re-render disparado por
  // filtro/marreta antes de ela chegar.
  if (!data?.rows) return;

  const tab        = TRADER_TABS.find(t => t.id === tabId);
  const tabFilters = FILTERS.filter(f => (tab?.filters ?? []).includes(f.id) && activeFilters.has(f.id));
  const hid        = _hiddenForTab(tabId);
  const rows = data.rows.filter(r => tabFilters.every(f => f.fn(r)) && !hid.has(rowKey(r)));

  // NAV: sai da 1ª onda (é o NAV do trader, idêntico nas duas) — a 2ª pode não ter chegado
  // ainda quando o usuário mexe num filtro, e `traders` é o mesmo dicionário.
  const navSrc = posDataByTab[tabId] ?? data;
  const navInfo = _fxNavInfo(rows, tab?.trader, navSrc);
  if (elC) elC.innerHTML = renderFxCcyTable(rows, navInfo, tabId,
    { bases: new Set(['fx', 'opt']), titulo: 'Posição por moeda', chip: true,
      help: _FX_CCY_HELP, trader: tab?.trader });
  if (elF) elF.innerHTML = renderFxCcyTable(rows, navInfo, tabId,
    { bases: new Set(['fut']), titulo: 'Futuro de dólar', chip: false,
      help: _FX_FUT_HELP, trader: tab?.trader });
  if (elT) elT.innerHTML = renderFxTieout(data);
}
