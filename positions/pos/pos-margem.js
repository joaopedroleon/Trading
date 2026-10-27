/* ── Margem B3 dos fundos PESSOA FÍSICA — aba própria "IMPAR / VISTA" ────────
   ⛔ **Nada aqui vem da base da JGP.** A fonte é o e-mail diário do BTG
   (`Margem<MMAA> - <FUNDO>`, ~09:00, pasta JGP Reports/PL Trader), lido pelo
   `positions/margem_b3.py`. São fundos na pessoa física de ECotrim (IMPAR) e EMota (VISTA),
   acompanhados ao lado dos da JGP por conveniência da mesa.

   ⛔ **ABA PRÓPRIA (`#tab-margem`, 3ª da barra), e isso é a decisão.** Nasceu como um card
   dentro da seção "Posição" de cada aba de trader e a mesa mandou tirar de lá (27/10/2026):
   ali, por mais que o título dissesse "fundo pessoa física", o número ficava a um palmo do
   livro da JGP, convidando a somar. Aqui as duas contas vivem juntas e não há com o que
   confundir. ⚠️ Nada disto entra em NAV, #PL, tira NET ou check de aba nenhuma.

   **DUAS TABELAS lado a lado** (pedido da mesa, 27/10/2026), e a divisão é por PERGUNTA:
   - **Posição** — o que eu tenho: abertura de D-1, o que operei hoje, o final e a exposição.
   - **Controle de margem** — o que a B3 exige: margem por ativo e o rodapé com risco,
     garantias e a sobra/chamada.
   As duas falam dos mesmos ativos, mas respondem a coisas diferentes, e misturá-las numa
   tabela só obrigaria a ler margem e exposição na mesma linha como se fossem a mesma régua.

   ⭐ **A "Qtd operada" é DIGITADA** — não há fonte intradiária para estes fundos (não estão
   no JDS). Por isso ela é editável, guardada no servidor por **data de referência da
   posição**, e **expira sozinha quando chega o e-mail do dia seguinte**: a chave muda junto
   com a data. Sem isso a operada de ontem somaria à abertura de hoje, que já a contém.

   ⭐ **Há sempre uma linha em branco no fim da tabela de Posição** para um ativo novo
   operado hoje. O servidor resolve o ticker e a exposição dele igual às demais; a coluna de
   margem fica `—`, porque a margem de uma posição aberta hoje só chega no relatório de
   amanhã.

   ☠️ **#PL tem DUAS unidades e elas NUNCA se somam** (regra do `netByAssetGroup` da tela
   principal): juros sai em `nominal` (% do NAV por 100 bps, sem `%`) e ação/dólar/índice em
   `pct` (fração do NAV, com `%`). Por isso há DOIS totais no rodapé, rotulados, e não um.   */

const _MARGEM_HELP =
  'De onde vem: o e-mail diário do BTG "Margem<MMAA> - <FUNDO>" (pasta JGP Reports/PL Trader), '
  + 'com duas planilhas — o detalhado por ativo e o resumo da conta.\n\n'
  + '⛔ Este fundo é PESSOA FÍSICA do trader. Não vem do JRS, do JDS nem da Bloomberg, e NÃO entra '
  + 'em nenhum número do livro da JGP nesta aba (NAV, #PL, tira NET, checks).\n\n'
  + 'DATA: o relatório é sempre de D-1 — o e-mail de hoje traz a posição do pregão anterior. O '
  + 'card mostra as duas datas, e o D-1 é contado no calendário de pregão (ANBIMA).\n\n'
  + 'DI em VISÃO TAXA: o BTG manda em PU (comprado = aplicado). Aqui o sinal é invertido e o '
  + 'rótulo vira Tomado/Aplicado, que é como o contrato é negociado. O que o arquivo disse fica '
  + 'no hover da quantidade.\n\n'
  + 'Qtd operada: digitada — não há fonte intradiária para estes fundos. Fica guardada até chegar '
  + 'o e-mail do dia seguinte, quando a coluna nasce zerada de novo.\n\n'
  + 'Exposição (#PL): a mesma régua da tela. Juros = DV01 × 100 bps ÷ NAV (sai sem "%", é quanto '
  + 'do NAV se move a cada 100 bps). Ação, dólar e índice = nocional ÷ NAV (sai com "%"). As duas '
  + 'unidades não se somam — por isso há dois totais.\n\n'
  + 'Margem D-0: negativo = a linha CONSOME margem; positivo = garantia depositada. A soma da '
  + 'coluna é a sobra (ou a chamada, se negativa).\n\n'
  + 'Fora da tabela de Posição: LFT (pós-fixada, DV01 zero — é caixa) e a reversa do termo (é a '
  + 'perna de compensação, não posição). As duas seguem na tabela de Controle de margem, onde '
  + 'importam: a LFT é garantia depositada e a reversa é um crédito de margem.\n\n'
  + 'Conferência: o detalhado e o resumo dizem a mesma coisa por caminhos diferentes, e as 4 '
  + 'identidades são checadas a cada leitura — o selo ao lado do título.';

const _mEsc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const _mBRL = v => (v == null || !isFinite(v)) ? '—'
  : v.toLocaleString('pt-BR', { maximumFractionDigits: 0 });

const _mQty = v => (v == null || !isFinite(v)) ? '—'
  : v.toLocaleString('pt-BR', { maximumFractionDigits: Number.isInteger(v) ? 0 : 2 });

const _mDash = tip => `<span style="color:var(--text-muted)"${tip ? ` title="${_mEsc(tip)}"` : ''}>—</span>`;

/* Número digitado pela mesa: aceita vírgula e separador de milhar do pt-BR. */
function _mNum(txt) {
  const s = String(txt ?? '').trim().replace(/\s/g, '');
  if (!s) return 0;
  const n = Number(s.replace(/\./g, '').replace(',', '.'));
  return isFinite(n) ? n : NaN;
}

/* ⚠️ O instrumento de opção vem como um identificador da B3 inteiro
   (`-/400000108188/DOLX26C005000/2026-11-03/5,000.00/LiqIneligible`). Encurtar na célula e
   deixar o original no hover: sem isso UMA linha empurra a tabela para ~90 caracteres.
   ☠️ O pedaço que interessa é a SÉRIE (`DOLX26C005000`), não o 1º campo — que é o código
   interno do contrato e não diz nada. A escolha é pelo FORMATO (o segmento com letras) e não
   por posição: o campo numérico vem antes e um índice fixo pega justamente ele. */
function _mInstr(nome) {
  const s = String(nome ?? '—');
  if (!s.includes('/')) return _mEsc(s);
  const partes = s.split('/').map(x => x.trim()).filter(Boolean);
  const serie = partes.find(x => (x.match(/[A-Za-z]/g) || []).length >= 3);
  if (!serie || serie === s) return _mEsc(s);
  return `<span style="border-bottom:1px dotted var(--text-muted)" title="${_mEsc(
    'Identificador completo no relatório do BTG:\n' + s)}">${_mEsc(serie)}</span>`;
}

/* Copia UM bloco do card como imagem (a tabela de Posição tem o seu botão).
   ⚠️ Não dá para usar o `copyCardImage`: ele sobe até o `.card` e copiaria tudo. Aqui o alvo
   é o elemento pelo id, e o `copyElementAsImage` (pos-misc.js) é o mesmo motor — então ganha
   de graça a rede contra o `color-mix()` que quebra o html2canvas em silêncio. */
async function copiarBlocoMargem(btn, alvoId) {
  const el = document.getElementById(alvoId);
  if (!el) return;
  if (typeof copyElementAsImage !== 'function') { console.warn('copyElementAsImage ausente'); return; }
  /* ⚠️ A linha em branco de "novo ativo" sai do print com `display:none`, NÃO com
     `data-html2canvas-ignore` (mesa, 27/10/2026). O `ignore` impede o DESENHO mas o elemento
     continua ocupando lugar no layout que o html2canvas mede — a linha viraria um buraco
     branco no meio da tabela, entre os dados e o Total. `display:none` colapsa a linha e a
     tabela se refaz sem ela.
     ⚠️ O `finally` repõe sempre: se o html2canvas falhar, a linha de digitar não pode sumir
     da tela junto. */
  const somem = [...el.querySelectorAll('[data-margem-nova]')];
  somem.forEach(tr => { tr.dataset.dispAntes = tr.style.display; tr.style.display = 'none'; });
  try {
    await copyElementAsImage(el, btn);
  } finally {
    somem.forEach(tr => {
      tr.style.display = tr.dataset.dispAntes || '';
      delete tr.dataset.dispAntes;
    });
  }
}
window.copiarBlocoMargem = copiarBlocoMargem;

/* ── Cabeçalho das tabelas (título + sub-linha de procedência) ──────────────
   ⭐ As três tabelas ficam lado a lado e os cabeçalhos VERDES têm de começar na mesma
   altura (mesa, 27/10/2026). Antes não começavam: a de Posição tem um botão no título (mais
   alta) e a do meio não tinha sub-linha de data (mais baixa) — bastava isso para as três
   faixas verdes saírem escalonadas.
   ⚠️ A solução é **altura fixa nas duas faixas**, não `align-items` no flex pai: o pai alinha
   o TOPO dos blocos, e o que precisa coincidir é o topo da TABELA, que vem depois de dois
   pedaços de altura variável. Com altura fixa, qualquer título (com ou sem botão) e qualquer
   sub-linha (de uma linha) deixam a tabela no mesmo y.
   ⚠️ E a sub-linha é obrigatória nas três — a do meio ganhou a data dela, que antes não
   aparecia em lugar nenhum. Espaço reservado e vazio seria desperdício; preenchido com a
   procedência, paga o próprio lugar. */
const _MH_TIT = 22;   // px — comporta o botão ⎘ (padding 1px + fonte 11px) sem apertar
const _MH_SUB = 17;   // px — uma linha de 11px com respiro

function _mCab(titulo, sub, botao) {
  return `<div style="height:${_MH_TIT}px;display:flex;align-items:center;gap:10px;margin:0 0 1px 2px">
      <div style="font-size:11px;letter-spacing:.05em;text-transform:uppercase;
                  color:var(--text-muted);font-weight:700">${titulo}</div>${botao || ''}
    </div>
    <div style="height:${_MH_SUB}px;font-size:11px;color:var(--text-muted);margin:0 0 5px 2px;
                white-space:nowrap;overflow:hidden">${sub || ''}</div>`;
}

/* ── Painel de DATAS ──
   ⭐ Mesa, 27/10/2026: "checks fortes que está tudo na última data correta, e sempre exibindo
   qual é a data da informação". Um chip por fonte, porque **não existe "a data do card"** —
   os três e-mails chegam em ritmos diferentes (fatura no próprio pregão, margem em D+1,
   carteira em D+2) e é justamente esse descasamento que a tela precisa tornar visível. Um
   carimbo único o esconderia. */
function _mPainelDatas(m) {
  const P = m?.datas;
  if (!P) return '';
  const ordem = ['margem', 'carteira', 'fatura'];
  const chips = ordem.filter(k => P[k]).map(k => {
    const v = P[k];
    const cor = v.ok ? 'var(--green)' : 'var(--red)';
    const n = v.du_atras;
    const tip = v.ok
      ? `${v.rotulo}: ${fmtDate(v.data)} — é o pregão mais recente que já deveria ter chegado.`
      : `${v.rotulo}: tenho ${v.data ? fmtDate(v.data) : 'NADA'} e já deveria ter `
        + `${fmtDate(v.esperado)}${n ? ` (${n} ${n > 1 ? 'pregões' : 'pregão'} atrás)` : ''}.\n\n`
        + 'Pode ser e-mail que não chegou, regra do Outlook que não pegou, ou feriado de B3 '
        + '(o julgamento não tem calendário de pregão). Clique em ⟳ Atualizar para reler.';
    return `<span style="color:${cor};font-weight:${v.ok ? 400 : 600}" title="${_mEsc(tip)}">`
      + `${v.ok ? '✓' : '⚠'} ${_mEsc(v.rotulo)} ${_mEsc(v.data ? fmtDate(v.data) : '—')}`
      + `${!v.ok && n ? ` <span style="font-weight:400">(−${n})</span>` : ''}</span>`;
  }).join('<span style="color:var(--border)"> · </span>');
  if (!chips) return '';
  return `<div style="font-size:11.5px;margin:2px 0 10px 0;display:flex;flex-wrap:wrap;gap:4px;
              align-items:baseline">
    <span style="color:var(--text-muted);text-transform:uppercase;font-size:10.5px;
                 letter-spacing:.04em;margin-right:4px" title="${_mEsc(
      'A data de cada fonte, e se ela é a mais recente que já deveria ter chegado.\n\n'
      + 'Os três e-mails do BTG chegam em ritmos diferentes: a FATURA no próprio pregão (~21h), '
      + 'a MARGEM no dia seguinte (~09h) e a CARTEIRA dois pregões depois (~07h). Por isso as '
      + 'três datas são legitimamente diferentes entre si — o que o painel acusa é uma delas '
      + 'estar atrás do que já era esperado.')}">Datas</span>
    ${chips}
  </div>`;
}

/* ── #PL de uma linha ──
   `unit` vem do servidor POR UNIDADE justamente para esta conta se refazer no browser a cada
   tecla da coluna "operada". Ver positions/margem_exposicao.py. */
function _mPl(linha, nav) {
  const e = linha?.exp;
  if (!e || e.unit == null || !nav) return null;
  const q = (linha.quantidade ?? 0) + (linha.operada ?? 0);
  return e.modo === 'nominal'
    ? { v: e.unit * q * 10000 / nav, modo: 'nominal' }   // % do NAV por 100 bps
    : { v: e.unit * q / nav, modo: 'pct' };              // fração do NAV
}

/* ⚠️ `nominal` sai SEM "%" — é quanto do NAV se move a cada 100 bps, não uma fração do NAV.
   É a mesma regra do `fmtPL` da tela principal, e é o que impede somar as duas unidades. */
function _mFmtPl(pl) {
  if (!pl || !isFinite(pl.v)) return _mDash();
  const n = pl.modo === 'pct' ? pl.v * 100 : pl.v;
  const s = n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    + (pl.modo === 'pct' ? '%' : '');
  const cor = Math.abs(n) < 0.005 ? 'var(--text-muted)' : (n > 0 ? 'var(--green)' : 'var(--red)');
  return `<span style="color:${cor}">${s}</span>`;
}

/* Selo do dia. ⚠️ Mostra as DUAS datas — a posição é de um dia e o e-mail é de outro, e
   confundi-los é o erro que este selo existe para impedir. */
function _mSelo(m) {
  const d = m?.defasagem ?? {};
  const pos = m?.data_referencia ? fmtDate(m.data_referencia) : null;
  const mail = m?.recebido_em ? fmtDateTime(m.recebido_em) : null;
  if (!pos) return '<span style="font-size:11.5px;color:var(--text-muted)">sem data de posição</span>';
  const tipBase = `Posição de ${pos} (D-1). O e-mail do BTG chegou em ${mail || '—'} — o `
    + 'relatório é sempre do pregão anterior, e o D-1 é contado no calendário de pregão (ANBIMA).';
  if (d.status === 'em_dia') {
    return `<span style="font-size:11.5px;color:var(--green)" title="${_mEsc(tipBase)}">`
      + `✓ posição de <b>${_mEsc(pos)}</b> · e-mail ${_mEsc(mail || '—')}</span>`;
  }
  if (d.status !== 'atrasado') {
    return `<span style="font-size:11.5px;color:var(--text-muted)" title="${_mEsc(tipBase)}">`
      + `posição de <b>${_mEsc(pos)}</b> · e-mail ${_mEsc(mail || '—')}</span>`;
  }
  const n = d.du_atras;
  return `<span style="font-size:11.5px;color:var(--red);font-weight:600" title="${_mEsc(
      tipBase + `\n\nJá deveria existir a posição de ${d.esperado || '—'}. Relatório defasado `
      + 'desenha igualzinho a um atual — por isso o aviso. Pode ser feriado de B3 (não há '
      + 'calendário de pregão no julgamento) ou e-mail que não chegou.')}">`
    + `⚠ DEFASADO — posição de ${_mEsc(pos)}${n ? ` (${n} ${n > 1 ? 'pregões' : 'pregão'} atrás)` : ''}</span>`;
}

function _mChecks(m) {
  const cs = m?.checks ?? [];
  if (!cs.length) return '';
  const ruins = cs.filter(c => c.ok === false);
  const vazios = cs.filter(c => c.ok === null);
  const detalhe = cs.map(c => `${c.ok === false ? '✕' : c.ok === null ? '·' : '✓'} ${c.nome}`
    + (c.diff == null ? ' — sem o resumo para comparar'
       : `: detalhado ${_mBRL(c.obtido)} × resumo ${_mBRL(c.esperado)} (Δ ${c.diff.toFixed(2)})`)).join('\n');
  if (ruins.length) {
    return `<span style="font-size:11.5px;color:var(--red);font-weight:600" title="${_mEsc(
      'As duas planilhas do e-mail não fecham entre si — leitura suspeita, não use sem abrir o anexo.\n\n'
      + detalhe)}">✕ ${ruins.length} conferência(s) não fecham</span>`;
  }
  if (vazios.length === cs.length) {
    return `<span style="font-size:11.5px;color:var(--text-muted)" title="${_mEsc(
      'Só veio o detalhado — sem a planilha de resumo não há o que conferir.\n\n' + detalhe)}">· sem conferência</span>`;
  }
  return `<span style="font-size:11.5px;color:var(--text-muted)" title="${_mEsc(
    'O detalhado e o resumo dizem a mesma coisa por caminhos diferentes, e fecham:\n\n'
    + detalhe)}">✓ confere</span>`;
}

/* NAV: é o denominador de TODA a coluna de exposição, então a procedência fica onde o
   número aparece — não num ⓘ distante. Editável nos dois casos (a mesa pode marretar o do
   IMPAR também); o do VISTA nasce no valor combinado, porque não há ticker de fundo. */
function _mNav(m) {
  const conta = m?.conta || "";
  const n = m?.nav ?? {};
  const rot = { resumo: 'Resumo de Carteira', bbg: 'Bloomberg', manual: 'digitado',
                padrao: 'combinado com a mesa' }[n.fonte] || '—';
  /* ☠️ **A fonte preferida é o PATRIMÔNIO do Resumo de Carteira, não a Bloomberg**, e a
     medição é o motivo: o `FUND_TOTAL_ASSETS_DT` da BBG está um pregão ADIANTADO em relação
     ao próprio dado. Em 27/10/2026 ela devolveu R$ 18.572.193,23 carimbado como 23/10, e esse
     valor é — ao CENTAVO — o patrimônio que o fundo declara para 22/10 (o de 23/10 é
     18.964.679,90). Quem confia no carimbo usa um NAV um dia mais velho do que pensa. */
  const tip = n.fonte === 'resumo'
    ? 'PATRIMÔNIO do Resumo de Carteira do próprio fundo (BTG)'
      + (n.data ? `, posição de ${fmtDate(n.data)}.` : '.')
      + '\n\nÉ o livro do fundo e vem com a data certa. A Bloomberg também publica um NAV '
      + '(FUND_TOTAL_ASSETS), mas o carimbo dela está um pregão adiantado: o valor que ela diz '
      + 'ser de um dia é, ao centavo, o patrimônio do dia anterior.'
      + '\n\nClique para marretar; apague o campo para voltar ao Resumo.'
    : n.fonte === 'bbg'
    ? `FUND_TOTAL_ASSETS × 1.000.000 de ${n.ticker}, em ${n.moeda || 'BRL'}.`
      + (n.data ? `\n\n⚠️ A Bloomberg carimba este NAV como de ${fmtDate(n.data)}, mas o carimbo `
                  + 'dela está um pregão adiantado (medido) — na prática é o patrimônio do dia '
                  + 'anterior. Sem Resumo de Carteira lido, é o que há.' : '')
      + '\n\nClique para marretar; apague o campo para voltar à Bloomberg.'
    : n.fonte === 'padrao'
      ? (n.nota || '') + '\n\nClique para alterar.'
      : 'Valor digitado nesta tela. Apague o campo para voltar à fonte automática (o Resumo '
        + 'de Carteira, ou a Bloomberg se não houver Resumo).'
        + (n.ticker ? '' : ' Esta conta não tem ticker de fundo na Bloomberg.');
  // Sem borda à direita: desde 27/10/2026 este é o ÚNICO tile do topo (os outros três viraram
  // repetição do rodapé da tabela de margem), e um separador sem nada do outro lado fica solto.
  return `<div style="padding:6px 0">
    <div style="font-size:10.5px;letter-spacing:.04em;color:var(--text-muted);text-transform:uppercase"
         title="${_mEsc(tip)}">NAV do fundo <span style="text-transform:none">(${_mEsc(rot)}${
           n.data ? ' · ' + fmtDate(n.data) : ''})</span></div>
    <input class="ed" type="text" inputmode="decimal" data-margem-nav="${_mEsc(conta)}"
           value="${n.valor == null ? '' : Math.round(n.valor).toLocaleString('pt-BR')}"
           title="${_mEsc(tip)}" placeholder="sem NAV"
           style="font-size:16px;font-weight:600;font-variant-numeric:tabular-nums;width:9.5em;
                  text-align:left;padding:1px 4px;border:1px solid var(--border);border-radius:3px;
                  background:var(--bg-row-alt)">
  </div>`;
}

/* ⛔ **Só o NAV no topo** (pedido da mesa, 27/10/2026). A tira tinha mais três tiles — risco
   sem garantias, garantias depositadas e a sobra/chamada —, e os três já estão no rodapé da
   tabela "Controle de margem", com o mesmo número e o mesmo veredito de cor. Repetir em
   destaque não acrescentava: acrescentava uma 2ª cópia que pode divergir se alguém mexer num
   lado só.
   ⚠️ O NAV FICA porque ele não aparece em tabela nenhuma — é o DENOMINADOR da coluna de
   exposição, e é editável. Sem ele no topo a mesa não teria onde ver nem trocar. */
function _mKpis(m) {
  return `<div style="display:flex;flex-wrap:wrap;align-items:flex-start;margin:2px 0 12px 0">
    ${_mNav(m)}
  </div>`;
}

/* ── Tabela 1: POSIÇÃO ───────────────────────────────────────────────────── */
/* ⛔ **Duas coisas ficam FORA da tabela de Posição** (mesa, 27/10/2026: "deixe somente o que
   tem risco"). Nos dois casos o motivo é o mesmo — a linha existe no relatório da B3 por
   mecânica de margem, não porque é risco de mercado —, mas o EFEITO é oposto, e por isso os
   dois são declarados separadamente na tela:

   **1. LFT** — pós-fixada ao CDI; o `shared/bond_dv01` devolve `dv01 = 0.0` **por
   construção**. Ocupava uma linha por vencimento para imprimir `-0,00`. ⭐ Tirá-la **não muda
   número nenhum**: os dois totais são idênticos com e sem ela, o que é a própria demonstração
   de que é caixa.

   **2. Reversa** (`PETR4 Rev`) — é a perna de compensação do TERMO, não posição. ☠️ E aqui
   tirar **CONSERTA** um número em vez de só limpar a tela: o termo do IMPAR são 1.737 + 83.963
   = **85.700** ações e a reversa é **−85.700**, então com ela dentro o "Total nocional" dava
   **0,00 %** e a posição em PETR4 **sumia do total**. Sem ela dá **23,9 %** ao preço live —
   que casa com as 85.700 ações que o Resumo de Carteira lista como `Ações` (26,5 % do PL ao
   fechamento de 23/10; a diferença é só o preço, 52,93 × 58,68).

   ⚠️ **Só daqui.** As duas continuam na tabela de **Controle de margem** — a LFT é garantia
   depositada de verdade (R$ 1.048.417 no IMPAR) e a reversa é um CRÉDITO de margem de
   R$ 3,2 MM; sem elas a coluna não somaria a chamada. A LFT segue também no **Lastro**, que é
   justamente sobre o papel preso/livre. Esconder nas três faria a mesa procurar uma garantia
   que a tela não mostra.
   ⚠️ **A LFT casa pelo NOME e a reversa pelo TIPO DO ARQUIVO**, e a escolha é por onde está a
   definição: hoje toda LFT chega como `Garantia`, mas se um dia vier como posição continua
   sendo caixa — já "reversa" é a própria classificação que o BTG dá à perna. Casar a reversa
   pelo sufixo `Rev` do nome seria depender de convenção de rótulo.
   ⚠️ **Nenhum dos dois vale para linha DIGITADA** (`extra`): um ativo que o usuário acabou de
   teclar sumir da tela é pior que uma linha a mais. */
const RE_LFT = /^LFT\b/i;

function _mForaDaPosicao(l) {
  if (RE_LFT.test(l.instrumento || '')) return 'LFT (pós-fixada: DV01 zero, é caixa)';
  if (String(l.tipo_arquivo || '').trim().toLowerCase() === 'reversa')
    return 'reversa (perna de compensação do termo, não é posição)';
  return null;
}

function _mTabelaPosicao(m) {
  const nav = m?.nav?.valor ?? null;
  const base = (m.posicao ?? m.linhas ?? []);   // `posicao` junta margem (derivativo) + carteira (título)
  const linhas = [...base.filter(l => !_mForaDaPosicao(l)), ...(m.extras ?? [])];
  let totNom = 0, totPct = 0, semExp = [];

  const corpo = linhas.map(l => {
    const ab = l.quantidade ?? 0;
    const op = l.operada ?? 0;
    const fim = ab + op;
    const pl = _mPl(l, nav);
    if (pl) { if (pl.modo === 'nominal') totNom += pl.v; else totPct += pl.v; }
    else if (l.exp?.erro) semExp.push(`${l.instrumento}: ${l.exp.erro}`);
    const tipQtd = l.visao_taxa
      ? `No relatório do BTG esta linha vem como "${l.tipo_arquivo} ${_mQty(l.quantidade_arquivo)}", `
        + 'em visão PU. Aqui está em visão TAXA (sinal invertido), que é como o contrato é negociado.'
      : l.fonte === 'carteira'
        ? `Posição INTEIRA do papel, do Resumo de Carteira de ${fmtDate(l.data_fonte)}`
          + (l.lotes > 1 ? ` (${l.lotes} lotes somados)` : '') + '.\n\n'
          + `Dos ${_mQty(l.quantidade)}, ${_mQty(l.penhorado)} estão penhorados na B3 — é só esse `
          + 'pedaço que aparece na tabela de Controle de margem ao lado. A posição é o total.'
        : '';
    const tipExp = l.exp?.ticker ? `${l.exp.ticker}${l.exp.preco != null ? ` · ${l.exp.modo === 'nominal'
        ? 'taxa ' + l.exp.preco : 'preço ' + l.exp.preco}` : ''}`
      : (l.exp?.nota || l.exp?.erro || '');
    return `<tr${l.extra ? ' data-margem-extra="1"' : ''}>
      <td style="text-align:left;color:var(--text-muted)">${_mEsc(l.tipo ?? '')}</td>
      <td class="lbl">${_mInstr(l.instrumento)}</td>
      <td class="sep"${tipQtd ? ` title="${_mEsc(tipQtd)}"` : ''}>${l.extra ? _mDash('Ativo aberto hoje: não havia posição em D-1.') : _mQty(ab)}</td>
      <td><input class="ed" type="text" inputmode="decimal" data-margem-op="${_mEsc(l.chave)}"
                 value="${op ? _mQty(op) : ''}" placeholder="0"
                 title="Quantidade operada HOJE, digitada — não há fonte intradiária para este fundo."
                 style="width:6.5em;text-align:right;padding:1px 4px;border:1px solid var(--border);
                        border-radius:3px;background:var(--bg-row-alt);font-size:12.5px;
                        font-variant-numeric:tabular-nums"></td>
      <td style="font-weight:600">${_mQty(fim)}</td>
      <td class="sep"${tipExp ? ` title="${_mEsc(tipExp)}"` : ''}>${_mFmtPl(pl)}</td>
      <td class="sel">${l.extra ? `<button type="button" data-margem-del="${_mEsc(l.chave)}"
            title="Remover esta linha" style="border:none;background:none;cursor:pointer;
            color:var(--text-muted);font-size:13px;line-height:1">✕</button>` : ''}</td>
    </tr>`;
  }).join('');

  // ⭐ Linha em branco SEMPRE presente (pedido da mesa): digitar ativo + quantidade e sair do
  // campo já grava. O servidor resolve o ticker e a exposição como em qualquer outra linha.
  const vazia = `<tr data-margem-nova="1">
      <td style="text-align:left;color:var(--text-muted)">Novo</td>
      <td><input class="ed" type="text" data-margem-novo-inst="1" placeholder="novo ativo…"
                 title="${_mEsc('Ativo operado hoje que não estava na posição de D-1. Use o código da B3: '
                   + 'DI1F33, PETR4, DOLZ26, WINZ26, NTN-B 2030-08-15. A margem dele só chega no '
                   + 'relatório de amanhã.')}"
                 style="width:11em;padding:1px 4px;border:1px solid var(--border);border-radius:3px;
                        background:var(--bg-row-alt);font-size:12.5px"></td>
      <td class="sep">${_mDash('Ativo novo: sem posição de abertura.')}</td>
      <td><input class="ed" type="text" inputmode="decimal" data-margem-novo-qtd="1" placeholder="qtd"
                 style="width:6.5em;text-align:right;padding:1px 4px;border:1px solid var(--border);
                        border-radius:3px;background:var(--bg-row-alt);font-size:12.5px;
                        font-variant-numeric:tabular-nums"></td>
      <td></td><td class="sep"></td><td class="sel"></td>
    </tr>`;

  const totTip = 'Os dois totais NÃO se somam: um é % do NAV por 100 bps de taxa (juros), o outro é '
    + 'fração do NAV (ação, dólar, índice). São réguas diferentes — é a mesma regra da tira NET '
    + 'da tabela de posição da JGP.';

  // ⭐ Botão de cópia PRÓPRIO (mesa, 27/10/2026: "quero botão para printar somente a tabela
  // de posição"). Ele copia este bloco, não o card — o ⎘ do topo continua copiando tudo.
  // ⚠️ A DATA entra no bloco copiado (está no título aqui dentro): print de posição sem data
  // é o mesmo problema que o selo do card existe para evitar.
  const dDeriv = base.find(l => l.fonte === 'margem')?.data_fonte || m.data_referencia;
  const dTit   = base.find(l => l.fonte === 'carteira')?.data_fonte || null;
  const idPos = `margemPos-${_mEsc(m.conta || '')}`;
  const subPos = `<span title="${_mEsc('A tabela junta DUAS fontes, por natureza do ativo:\n\n'
        + '· Derivativo (futuro, opção, termo, reversa) vem do relatório de MARGEM — é lá que ele '
        + 'existe, e é o dado mais fresco (D-1).\n'
        + '· Título público vem do Resumo de CARTEIRA (D-2), com a posição INTEIRA.\n\n'
        + 'O relatório de margem só lista o título que está PENHORADO, e isso não é a posição: o '
        + 'VISTA tem 891 NTN-B e a margem mostra 189. Montar a tabela só com ela subdimensionava a '
        + 'exposição a taxa do fundo em quase 5×.')}">ⓘ ${
          dDeriv ? `Derivativo: margem de ${_mEsc(fmtDate(dDeriv))}` : ''}${
          dDeriv && dTit ? ' · ' : ''}${
          dTit ? `Título: carteira de ${_mEsc(fmtDate(dTit))}` : ''}</span>`;
  const btnPos = `<button class="btn btn-secondary" data-html2canvas-ignore="true"
              style="padding:1px 8px;font-size:11px;line-height:1.2"
              title="Copiar como imagem SÓ esta tabela (com o título e a data)."
              onclick="copiarBlocoMargem(this, '${idPos}')">⎘</button>`;
  return `<div id="${idPos}">
    ${_mCab('Posição', (dDeriv || dTit) ? subPos : '', btnPos)}
    <div style="overflow-x:auto"><table class="jgp-tbl">
      <thead><tr>
        <th class="left" title="Como o relatório classifica a linha. Em DI o rótulo é Tomado/Aplicado, porque aqui a visão é de TAXA.">Tipo</th>
        <th class="left">Instrumento</th>
        <th class="sep" title="${_mEsc('Posição de abertura — a que veio no relatório, do pregão '
          + (m.data_referencia ? fmtDate(m.data_referencia) : 'anterior') + '.\n\n'
          + '⚠️ Em DI o sinal está INVERTIDO em relação ao arquivo: o BTG manda em PU e aqui a visão é '
          + 'de taxa. O número do arquivo fica no hover da célula.')}">Qtd D-1</th>
        <th title="${_mEsc('Quantidade operada HOJE — DIGITADA. Não há fonte intradiária para estes '
          + 'fundos (não estão no JDS).\n\nFica guardada até chegar o e-mail do dia seguinte, quando a '
          + 'coluna nasce zerada: a chave do que você digita inclui a data da posição.')}">Qtd operada</th>
        <th title="Abertura + operada.">Qtd final</th>
        <th class="sep" title="${_mEsc('Exposição na mesma régua da tela de posições (#PL):\n\n'
          + '· JUROS (DI, NTN-B, LFT) → DV01 × 100 bps ÷ NAV. Sai SEM "%": é quanto do NAV se move a '
          + 'cada 100 bps de taxa.\n'
          + '· AÇÃO, DÓLAR, ÍNDICE → nocional ÷ NAV. Sai com "%".\n\n'
          + 'As duas unidades não se somam — por isso há dois totais no rodapé. O hover de cada célula '
          + 'diz o ticker e o preço usados.')}">Exposição</th>
        <th class="sel"></th>
      </tr></thead>
      <tbody>
        ${corpo}${vazia}
        <!-- ⛔ O "Total nocional (% do NAV)" SAIU (mesa, 27/10/2026). Sobra só o total de
             JUROS, que é a soma que a mesa lê. ⚠️ Somar nocional de ação com nocional de
             futuro de dólar dá um número sem leitura — e, agora que a reversa do termo saiu
             da tabela, as pernas que se anulavam também não estão mais as duas aqui, o que
             tornava aquele total ainda menos comparável de um dia para o outro. As linhas
             em % continuam, cada uma na sua. -->
        <tr class="tot">
          <td class="lbl" colspan="5" title="${_mEsc(totTip)}">Total juros (% NAV por 100 bps)</td>
          <td class="sep">${_mFmtPl(totNom ? { v: totNom, modo: 'nominal' } : null)}</td><td class="sel"></td>
        </tr>
      </tbody>
    </table></div>
    <!-- ⚠️ As observações abaixo da tabela saem da imagem (mesa, 27/10/2026: "pro print da
         posição, não precisa copiar as obs"). Elas são avisos de TELA — quem recebe a imagem
         não vai clicar no ⟳ nem ler o hover. O título e a data continuam na imagem, que é o
         que um print de posição não pode perder.
         ☠️ Sem crase aqui: é um comentário DENTRO de um template literal, e uma crase fecha
         a string. Terceira vez nesta sessão — o node --check pega, o olho não. -->
    ${semExp.length ? `<div style="font-size:11px;color:var(--red);margin-top:4px"
        data-html2canvas-ignore="true" title="${_mEsc(
        semExp.join('\n'))}">⚠ ${semExp.length} linha(s) sem exposição (fora dos dois totais)</div>` : ''}
    <!-- ⛔ A nota "N linha(s) fora desta tabela" SAIU (mesa, 27/10/2026). Eu a tinha posto
         pela regra de que filtro invisível faz procurar linha sumida — mas aqui a LFT e a
         reversa estão **à vista, na tabela do lado**, então nada some da tela: a nota só
         repetia o que o olho já vê. A explicação ficou no ⓘ do rodapé do card. -->
    ${nav == null ? '<div style="font-size:11px;color:var(--red);margin-top:4px"'
        + ' data-html2canvas-ignore="true">Sem NAV: a coluna de exposição fica vazia.</div>' : ''}
  </div>`;
}

/* ── Tabela 2: CONTROLE DE MARGEM ────────────────────────────────────────── */
function _mTabelaMargem(m) {
  const linhas = m.linhas ?? [];
  // ⭐ A soma da coluna É a chamada (garantia positiva, posição negativa), então a linha de
  // Total soma na cara do leitor — a invariante da casa.
  const somaCol = linhas.reduce((a, l) => a + (l.margem ?? 0), 0);
  const doArquivo = m.sobra_ou_chamada;
  const dif = (doArquivo == null) ? null : somaCol - doArquivo;
  const totTip = 'Soma da coluna: garantia entra positiva, posição entra negativa, então a soma É a '
    + 'sobra (ou a chamada, se negativa).'
    + (dif != null && Math.abs(dif) >= 0.5
        ? `\n\nO arquivo declara ${_mBRL(doArquivo)}; a diferença de ${dif.toFixed(0)} é o `
          + 'arredondamento do detalhado para inteiro (o resumo vem em centavos).' : '');
  const corTot = somaCol >= 0 ? 'var(--green)' : 'var(--red)';
  const nExtras = (m.extras ?? []).length;

  /* ⚠️ **Esta tabela é o espelho FIEL do relatório do BTG** — por isso a quantidade aqui é a
     `quantidade_arquivo` (visão PU) e não a da tabela de Posição ao lado (visão TAXA). O
     mesmo `DI1F29` sai **+250 · Comprado** aqui e **−250 · Aplicado** ali, e isso é coerente,
     não divergência: rótulo e número mudam JUNTOS, cada tabela na sua visão. Mostrar a
     quantidade invertida ao lado de "Comprado" é que seria contraditório. O cabeçalho diz
     isso, porque lado a lado o leitor repara no sinal antes de reparar na visão. */
  const corpo = linhas.map(l => `<tr>
      <td style="text-align:left;color:var(--text-muted)">${_mEsc(l.tipo_arquivo ?? l.tipo ?? '')}</td>
      <td class="lbl">${_mInstr(l.instrumento)}</td>
      <td class="sep"${l.visao_taxa ? ` title="${_mEsc(
        'Visão PU, como o BTG manda. Na tabela de Posição ao lado esta mesma linha aparece em '
        + 'visão TAXA, com o sinal invertido e o rótulo Tomado/Aplicado.')}"` : ''
        }>${_mQty(l.quantidade_arquivo ?? l.quantidade)}</td>
      <td>${_mBRL(l.margem)}</td>
    </tr>`).join('');

  const rodape = [
    ['Risco sem garantias', m.risco_sem_garantias, 'Soma, com sinal trocado, das linhas que não são Garantia.'],
    ['Recurso de liquidez', m.recurso_liquidez, 'Linha do rodapé do relatório. Zero no dia a dia; quando aparece, é limite usado.'],
    ['Garantias depositadas', m.valor_depositado, 'Soma das linhas de Garantia.'],
  ].map(([lbl, v, tip]) => `<tr class="tot tot-sub">
      <td class="lbl" colspan="2" title="${_mEsc(tip)}">${_mEsc(lbl)}</td>
      <td class="sep"></td><td>${_mBRL(v)}</td></tr>`).join('');

  // ⭐ A sub-linha desta tabela existe para alinhar o cabeçalho verde com as outras duas, e
  // foi preenchida com a DATA — que antes não aparecia em lugar nenhum nesta coluna.
  const subMar = `<span title="${_mEsc('Posição de ' + (m.data_referencia ? fmtDate(m.data_referencia) : '—')
      + ' — é o relatório de margem que chegou hoje por e-mail (sempre D-1). Esta tabela é o '
      + 'espelho fiel dele: tipo e quantidade saem como o BTG manda, em visão PU.')
      }">ⓘ margem de ${_mEsc(m.data_referencia ? fmtDate(m.data_referencia) : '—')}</span>`;
  return `<div>
    ${_mCab('Controle de margem', subMar, '')}
    <div style="overflow-x:auto"><table class="jgp-tbl">
      <thead><tr>
        <th class="left" title="Classificação do relatório do BTG, como ele a manda (em PU).">Tipo</th>
        <th class="left">Instrumento</th>
        <th class="sep" title="${_mEsc('Quantidade D-0 como o BTG manda — VISÃO PU, igual ao rótulo '
          + 'Comprado/Vendido ao lado.\n\n⚠️ No DI, esta mesma linha aparece na tabela de Posição com '
          + 'o SINAL INVERTIDO (visão taxa, Tomado/Aplicado), que é como a mesa trabalha. Não é '
          + 'divergência: cada tabela está na sua visão, e nas duas o rótulo acompanha o número.')
          }">Qtd D-0</th>
        <th title="${_mEsc('Margem em reais, como o arquivo traz. NEGATIVO = a linha '
          + 'CONSOME margem; POSITIVO = garantia depositada.\n\n⚠️ A margem NÃO é invertida junto com '
          + 'a quantidade do DI: ela é requisito, não tem lado, e é a mesma em PU e em taxa.')}">Margem D-0 (R$)</th>
      </tr></thead>
      <tbody>
        ${corpo}${rodape}
        <tr class="tot">
          <td class="lbl" colspan="2" title="${_mEsc(totTip)}">${
            somaCol >= 0 ? 'Sobra de garantia' : 'Chamada de margem'}</td>
          <td class="sep"></td>
          <td style="color:${corTot};font-weight:700">${_mBRL(somaCol)}</td>
        </tr>
      </tbody>
    </table></div>
    ${nExtras ? `<div style="font-size:11px;color:var(--text-muted);margin-top:4px" title="${_mEsc(
        'O BTG só manda a margem da posição de D-1. A margem do que foi aberto hoje chega no '
        + 'relatório de amanhã.')}">${nExtras} ativo(s) novo(s) do dia sem margem aqui</div>` : ''}
  </div>`;
}

/* ── O card ──────────────────────────────────────────────────────────────── */

/* ── Tabela 3: LASTRO — o que está preso e o que está livre ──────────────── */
/* Cruza o Resumo de Carteira (o que o fundo TEM) com o relatório de margem (o que está
   PENHORADO). ☠️ O cruzamento é sempre na ÚLTIMA DATA EM COMUM, que normalmente é 1 pregão
   atrás da margem do card: o Resumo do BTG é D-2 e a margem é D-1, então no mesmo dia eles
   nunca coincidem. A data do cruzamento é dita no título da tabela — sem isso alguém leria
   "livre" de uma data sobre a margem de outra. */
function _mTabelaLastro(m) {
  const L = m?.lastro;
  if (!L) return '';

  if (L.status !== 'ok') {
    return `<div style="max-width:340px">${_mCab('Lastro e margem', '', '')}
      <div class="no-data" style="font-size:11.5px;padding:6px 0;line-height:1.5">${_mEsc(L.motivo || '—')}</div>
    </div>`;
  }

  const papeis = L.papeis || [];
  const livrePapel = papeis.reduce((a, p) => a + (p.valor_livre || 0), 0);
  const corpo = papeis.map(p => {
    const livre = p.livre;
    const cor = livre == null ? 'var(--text-muted)' : (livre > 0.5 ? 'var(--green)' : 'var(--text-muted)');
    const divergePdf = p.qtd_margem_pdf != null && Math.abs((p.qtd_margem_pdf || 0) - p.penhorado) > 0.5;
    return `<tr>
      <td class="lbl">${_mEsc(p.papel)}${p.lotes > 1 ? `<span style="color:var(--text-muted);font-weight:400"
          title="${_mEsc(`O Resumo quebra este papel em ${p.lotes} lotes (datas de compra diferentes); a margem o agrega numa linha só. A tabela soma os lotes antes de comparar.`)}"> ·${p.lotes}</span>` : ''}</td>
      <td class="sep">${_mQty(p.quantidade)}</td>
      <td title="${_mEsc('Quantidade que o relatório de MARGEM lista como Garantia — é o número da própria clearing e é o que produz a chamada.'
        + (divergePdf ? `\n\n⚠️ A coluna "Qtd.Margem" do Resumo diz ${_mQty(p.qtd_margem_pdf)} para este papel. Ela NÃO é a quantidade penhorada (casa em 1 de 4 casos medidos) e nenhuma conta aqui a usa.` : ''))}"
          >${_mQty(p.penhorado)}${divergePdf ? '<span style="color:var(--text-muted)"> *</span>' : ''}</td>
      <td style="color:${cor};font-weight:600">${_mQty(livre)}</td>
      <td class="sep">${p.valor_livre == null ? _mDash() : _mBRL(p.valor_livre)}</td>
    </tr>`;
  }).join('');

  /* ── Fluxo de CAIXA ──
     ☠️ **Caixa é SÓ o fundo de Tesouro Selic** (mesa, 27/10/2026): é nele que o ajuste da B3
     bate. Os outros "Portfólio Investido" (FEEDER, FIDC, SPS…) são investimento e aparecem
     DEPOIS, como informação — tratá-los como caixa inflava a folga em R$ 7,2 MM no VISTA.
     ⭐ E é um FLUXO, não um número: o saldo da última carteira e o a liquidar de cada pregão
     à frente, com saldo corrente. ⚠️ O 1º pregão do fluxo é o **da própria carteira** — o
     saldo dela é do dia dela, e aquele ajuste só liquida no pregão seguinte (na carteira ele
     é a linha `AJUSTE BM&F`, um recebível à parte do caixa). O selo ✓ ao lado confere as
     duas pontas. */
  const K = m?.caixa;
  const temFluxo = K?.status === 'ok';
  const caixaProj = temFluxo ? K.projetado : (L.caixa_total || 0);
  const corProj = caixaProj < 0 ? 'var(--red)' : 'var(--green)';

  const fluxoLinhas = !temFluxo ? '' : `
    <tr class="grp"><td colspan="5" title="${_mEsc(
        'Só o fundo de Tesouro Selic é caixa — é nele que o ajuste da B3 liquida. Os demais '
        + 'fundos do Portfólio Investido vêm abaixo, como informação.')}">Caixa (Tesouro Selic)</td></tr>
    <tr><td class="lbl" colspan="4" style="padding-left:14px;font-weight:400"
        title="${_mEsc('Saldo do fundo de caixa (Tesouro Selic) na data do Resumo de Carteira. '
          + 'O que vem abaixo é o que ainda vai liquidar depois dessa data.')}">Saldo em ${
        _mEsc(fmtDate(K.data_carteira))}</td>
      <td class="sep">${_mBRL(K.caixa_carteira)}</td></tr>
    ${(K.fluxo || []).map(x => `<tr>
      <td class="lbl" colspan="4" style="padding-left:14px;font-weight:400"${x.da_carteira
        ? ` title="${_mEsc('Pregão da própria carteira: o ajuste dele ainda não estava no saldo '
            + 'acima (liquida no pregão seguinte). Na carteira ele é a linha AJUSTE BM&F, um '
            + 'recebível à parte do caixa'
            + (K.confere_ajuste === true ? ' — e as duas pontas conferem.'
               : K.confere_ajuste === false ? ' — ⚠️ e as duas NÃO conferem: fatura '
                   + _mBRL(K.fat_carteira) + ' × carteira ' + _mBRL(K.ajuste_carteira) + '.'
               : '.'))}"` : ''}>ajuste do dia ${_mEsc(fmtDate(x.pregao))} a liquidar dia ${
        _mEsc(fmtDate(x.liquidacao))}${x.da_carteira
        ? (K.confere_ajuste === true ? ' <span style="color:var(--green)">✓</span>'
           : K.confere_ajuste === false ? ' <span style="color:var(--red)">✕</span>' : '') : ''}</td>
      <td class="sep">${_mBRL(x.total)}<span style="color:var(--text-muted)"> → ${_mBRL(x.saldo)}</span></td>
    </tr>`).join('')}
    <tr class="tot tot-sub"><td class="lbl" colspan="4" title="${_mEsc(
        'Saldo do fundo de caixa depois de liquidar tudo o que já se sabe.\n\n⚠️ É PROJEÇÃO, não '
        + 'extrato: entre a data da carteira e hoje o caixa também rendeu, e pode ter havido '
        + 'aplicação ou resgate que nenhum destes e-mails mostra. Serve para dimensionar o que '
        + 'vem.')}">Caixa projetado${K.ultimo_pregao
          ? ` <span style="font-weight:400;color:var(--text-muted)">(até o pregão de ${
              _mEsc(fmtDate(K.ultimo_pregao))})</span>` : ''}</td>
      <td class="sep" style="color:${corProj};font-weight:700">${_mBRL(caixaProj)}</td></tr>`;

  const investidos = (L.investidos || []);
  const invLinhas = !investidos.length ? '' : `
    <!-- ⚠️ O respiro antes deste bloco vai no padding-top da própria linha de grupo, NÃO
         numa tr vazia: o CSS da casa (positions-v2.css, .jgp-tbl tbody tr.grp) avisa que
         linha fantasma de 18px vira buraco na imagem do "Copiar".
         ☠️ E sem crase neste comentário — ele vive DENTRO de um template literal, e uma
         crase fecha a string. Foi exatamente o que aconteceu ao escrevê-lo. -->
    <tr class="grp"><td colspan="5" style="padding-top:22px" title="${_mEsc(
        'Demais fundos do Portfólio Investido. NÃO são caixa e não entram em nenhum total acima: '
        + 'não é de lá que sai o ajuste da B3, e vários não resgatam no mesmo dia. Estão aqui '
        + 'como informação de onde mais há dinheiro, se a chamada apertar.')}">Fundos investidos</td></tr>
    ${investidos.map(f => `<tr>
      <td class="lbl" colspan="4" style="padding-left:14px;font-weight:400">${_mEsc(f.nome || '—')}</td>
      <td class="sep" style="color:var(--text-muted)">${_mBRL(f.financeiro)}</td></tr>`).join('')}
    <tr class="tot tot-sub"><td class="lbl" colspan="4"
        style="color:var(--text-muted)">Fundos investidos</td>
      <td class="sep" style="color:var(--text-muted)">${_mBRL(L.investidos_total)}</td></tr>`;

  return `<div>
    ${_mCab('Lastro e margem', L.datas_diferentes
      ? `<span title="${_mEsc('As duas pontas vêm de datas diferentes DE PROPÓSITO.\n\n'
        + 'O penhor muda todo dia e dele há dado fresco (a margem é D-1, a mesma do card ao lado). '
        + 'A carteira de papel muda pouco — só quando se compra ou vende título — e o Resumo do BTG '
        + 'chega um pregão depois.\n\n'
        + 'Ancorar o penhor na data mais velha, para "casar" as duas, produzia papel livre que não '
        + 'existe: em 27/10/2026 a tela dizia 221 NTN-B livres no IMPAR porque olhava o penhor de '
        + '23/10, quando em 26/10 os 2.869 já estavam todos penhorados.\n\n'
        + 'O risco que sobra é o oposto e é o menor: se o fundo COMPROU papel no dia da margem, o '
        + '"Tem" fica curto e o livre sai subestimado — e se ficar negativo, sai aviso.')
        }">ⓘ Tem: Resumo de ${_mEsc(fmtDate(L.data_resumo))} · Penhorado: margem de ${
          _mEsc(fmtDate(L.data_margem))}</span>`
      : `<span>ⓘ ${_mEsc(fmtDate(L.data_margem || L.data_resumo))}</span>`, '')}
    <div style="overflow-x:auto"><table class="jgp-tbl">
      <thead><tr>
        <th class="left">Papel</th>
        <th class="sep" title="${_mEsc('Quantidade que o fundo detém, somando os lotes do Resumo de '
          + 'Carteira (D-2 — o Resumo chega um pregão depois da margem). Muda pouco: só quando se '
          + 'compra ou vende título.')}">Tem</th>
        <th title="${_mEsc('Depositado como garantia na B3, do relatório de MARGEM mais recente — '
          + 'o mesmo do card ao lado. É o dado fresco (D-1), e é o que muda todo dia.')}">Penhorado</th>
        <th title="${_mEsc('Tem − penhorado. É o papel que está livre para retirar ou para depositar '
          + 'numa chamada nova.')}">Livre</th>
        <th class="sep" title="${_mEsc('O que está livre, avaliado ao P.U. do Resumo.\n\n⚠️ NÃO é o valor '
          + 'que ele vale COMO GARANTIA: a B3 aplica deságio — medido em 23/10, 189 NTN-B valem '
          + 'R$ 911 mil a P.U. e entram como R$ 894 mil de garantia (−1,9 %). Serve para dimensionar, '
          + 'não para prometer.')}">R$ livre (a P.U.)</th>
      </tr></thead>
      <tbody>
        ${corpo}
        <tr class="tot tot-sub"><td class="lbl" colspan="4">Papel livre</td>
          <td class="sep">${_mBRL(livrePapel)}</td></tr>
        ${fluxoLinhas}
        <tr class="tot"><td class="lbl" colspan="4" title="${_mEsc(
            'Caixa projetado + papel livre (a P.U.). É a folga para uma chamada nova.\n\n'
            + '⚠️ O papel entra a P.U., não ao valor de garantia — a B3 deságia.\n'
            + '⚠️ Os fundos investidos abaixo NÃO entram: não é de lá que sai o ajuste e vários '
            + 'não resgatam no mesmo dia.')
          }">Livre para chamada</td>
          <td class="sep" style="font-weight:700;color:${
            (caixaProj + livrePapel) < 0 ? 'var(--red)' : 'var(--green)'}">${
            _mBRL(caixaProj + livrePapel)}</td></tr>
        ${invLinhas}
      </tbody>
    </table></div>
    ${(L.avisos || []).length ? `<div style="font-size:11px;color:var(--red);margin-top:4px"
        title="${_mEsc((L.avisos || []).join('\n'))}">⚠ ${L.avisos.length} aviso(s) no cruzamento</div>` : ''}
  </div>`;
}

/* ── O card de UMA conta ─────────────────────────────────────────────────── */
function renderMargemCard(m) {
  const conta = m?.conta || '';
  const titulo = `Margem B3 · ${_mEsc(m?.rotulo ?? '—')}`;
  const sub = `— fundo pessoa física${conta ? ` · conta ${_mEsc(conta)}` : ''}`
    + (m?.trader ? ` · ${_mEsc(m.trader)}` : '');
  const botoes = `
    <button class="btn btn-secondary" data-html2canvas-ignore="true"
            style="padding:3px 12px;font-size:12px;margin-left:auto"
            title="Ir ao Outlook buscar o e-mail mais recente das duas contas."
            onclick="loadMargem({ fresh: true })">⟳ Atualizar</button>
    <button class="btn btn-secondary" data-html2canvas-ignore="true"
            style="padding:3px 12px;font-size:12px" onclick="copyCardImage(this)">⎘ Copiar</button>`;
  const cabecalho = `<div class="section-title"
      style="padding:8px 0 10px 0;display:flex;align-items:center;gap:16px;flex-wrap:wrap">
      <span>${titulo} <span style="font-weight:400;color:var(--text-muted);font-size:13px">${sub}</span></span>
      ${m?.linhas?.length ? _mSelo(m) + _mChecks(m) : ''}
      ${botoes}
    </div>`;

  // `data-margem-conta` é o que amarra TODO campo editável do card à sua conta: as duas
  // convivem no mesmo container e as chaves de linha (`0|DI1F29`) colidiriam entre elas.
  if (!(m?.linhas ?? []).length) {
    return `<div class="card" data-margem-conta="${_mEsc(conta)}">${cabecalho}
      <div class="no-data" style="padding:4px 0">${_mEsc(m?.erro || 'Sem posição de margem lida.')}</div>
      <p class="csub" style="margin:6px 0 0;font-size:11.5px;color:var(--text-muted)">
        <span class="jgp-info" data-info="${_mEsc(_MARGEM_HELP)}">&#9432;</span></p>
    </div>`;
  }

  return `<div class="card" data-margem-conta="${_mEsc(conta)}">${cabecalho}
    <!-- ⚠️ SEM a classe section-copy-target: assim o copyCardImage cai no .card inteiro e a
         imagem sai COM o título e a DATA da posição. Recortar só as tabelas produziria um
         print de margem sem data, que é o que esta tela existe para não deixar acontecer.
         ☠️ E nada de crase nos comentários daqui: isto vive DENTRO de um template literal, e
         uma crase fecha a string — o arquivo inteiro vira erro de sintaxe. -->
    <div style="max-width:100%">
      ${_mPainelDatas(m)}
      ${_mKpis(m)}
      <div style="display:flex;gap:32px;align-items:flex-start;flex-wrap:wrap">
        ${_mTabelaPosicao(m)}
        ${_mTabelaMargem(m)}
        ${_mTabelaLastro(m)}
      </div>
      <p class="csub jgp-tbl-note" style="margin:8px 0 0;font-size:11.5px;color:var(--text-muted);line-height:1.5">
        <span class="jgp-info" data-info="${_mEsc(_MARGEM_HELP)}">&#9432;</span>
        <span style="margin-left:10px">Fonte: ${_mEsc(m.fonte || 'e-mail do BTG')}${
          m.assunto ? ` · <i>${_mEsc(m.assunto)}</i>` : ''}</span>
        ${m.erro ? `<span style="color:var(--red);margin-left:10px" title="${_mEsc(m.erro)}">⚠ ${_mEsc(m.erro)}</span>` : ''}
      </p>
    </div>
  </div>`;
}

/* ── A aba inteira: um card por conta ────────────────────────────────────── */
// Ordem fixa, casando com o nome da aba ("IMPAR / VISTA"). Contas que o servidor devolver
// e não estiverem aqui vão depois, por conta — assim uma conta nova nunca some da tela só
// por não ter sido listada.
const MARGEM_ORDEM = ['18887091', '18885137'];

function renderMargem() {
  const el = document.getElementById('margemContainer');
  if (!el) return;
  /* Encolhe no conteúdo, como o #posContainer-* das abas de trader (pos-tabs.js faz o mesmo
     com flex-start). Sem isto cada card ia a 100% da página e ficava uma faixa morta à
     direita das tabelas. `max-width:100%` é a trava documentada lá: sem ela a página rola
     de lado. `gap` separa os dois cards. */
  el.style.display       = 'flex';
  el.style.flexDirection = 'column';
  el.style.alignItems    = 'flex-start';
  el.style.gap           = '14px';
  el.style.maxWidth      = '100%';

  // ⚠️ `null` = ainda não carregou. NÃO tocar no container: escrever '' aqui apagaria o
  // esqueleto que o PosBusy acabou de pôr. Mesmo cuidado do renderFxSectionsForTab.
  if (margemData === null) return;

  const contas = margemData.contas || {};
  const chaves = [...MARGEM_ORDEM.filter(c => contas[c]),
                  ...Object.keys(contas).filter(c => !MARGEM_ORDEM.includes(c)).sort()];
  if (!chaves.length) {
    el.innerHTML = `<div class="card no-data">${_mEsc(margemData.erro
      || 'Nenhuma conta de margem lida — nenhum e-mail do BTG encontrado na pasta JGP Reports/PL Trader.')}
      <button class="btn btn-secondary" style="padding:2px 10px;font-size:12px;margin-left:8px"
              onclick="loadMargem({ fresh: true })">⟳ Tentar de novo</button></div>`;
    return;
  }
  el.innerHTML = chaves.map(c => renderMargemCard({ ...contas[c], fonte: contas[c].fonte || margemData.fonte }))
    .join('');
}

/* ── Abrir a aba ─────────────────────────────────────────────────────────── */
function showMargemTab() {
  activeTraderTab = 'margem';
  _showPanel('margem');
  // Carga preguiçosa, como a aba de Boletas: só vai ao Outlook quando alguém abre a aba.
  // ⚠️ E NUNCA no prefetch — a skill /outlook é explícita em que vários leitores juntos
  // fazem o Outlook reiniciar, e o prefetch abriria dois de uma vez.
  if (margemData === null) loadMargem();
  else renderMargem();
}
window.showMargemTab = showMargemTab;

let _margemInFlight = false;

async function loadMargem({ fresh = false } = {}) {
  if (_margemInFlight) return;
  if (!document.getElementById('margemContainer')) return;
  _margemInFlight = true;
  PosBusy.on('margem');
  try {
    const params = new URLSearchParams();
    if (fresh) params.set('fresh', 'true');
    // ⚠️ Sem `trader`: as DUAS contas vêm no mesmo request. E sem guarda de "Data ref" /
    // "Forçar D-1" da toolbar — este painel não depende delas: é sempre o último e-mail que
    // chegou, e o carimbo dele está em cada card.
    const data = await (await fetch(`${API_BASE}/api/positions/margem-b3?${params}`)).json();
    margemData = data.error ? { contas: {}, erro: data.error } : data;
    renderMargem();
  } catch (e) {
    console.warn('margem B3 não carregou:', e);
    margemData = { contas: {}, erro: 'não consegui falar com o servidor (8083).' };
    renderMargem();
  } finally {
    PosBusy.off('margem');
    _margemInFlight = false;
  }
}
window.loadMargem = loadMargem;

/* ── Gravação do que a mesa digita ───────────────────────────────────────── */
// Repinta com o que o SERVIDOR devolveu — é ele que resolve o ticker e a exposição de um
// ativo novo, então repintar com o estado local deixaria a linha nova sem exposição.
async function _margemSalvar(conta, patch) {
  const m = margemData?.contas?.[conta];
  if (!m?.conta || !m?.data_referencia) return;
  PosBusy.on('margem');
  try {
    const body = { conta: m.conta, data_referencia: m.data_referencia, ...patch };
    const r = await fetch(`${API_BASE}/api/positions/margem-b3/operada`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await r.json();
    if (data.error) { console.warn('margem: gravação falhou', data.error); return; }
    if (data.margem) margemData.contas[conta] = data.margem;
    renderMargem();
  } catch (e) {
    console.warn('margem: gravação falhou', e);
  } finally {
    PosBusy.off('margem');
  }
}

/* Lê o card daquela conta no DOM e devolve o que mandar ao servidor. Ler do DOM (em vez de
   manter um estado paralelo) é o que garante que o gravado é exatamente o que está na tela.
   ⚠️ Escopo no CARD, não no container: as duas contas dividem o mesmo container e as chaves
   de linha colidiriam entre elas. */
function _margemColeta(conta) {
  const card = document.querySelector(`[data-margem-conta="${conta}"]`);
  const m = margemData?.contas?.[conta];
  const linhas = {}, extras = [];
  if (!card || !m) return { linhas, extras };
  for (const inp of card.querySelectorAll('[data-margem-op]')) {
    const chave = inp.dataset.margemOp;
    const v = _mNum(inp.value);
    if (!isFinite(v) || v === 0) continue;
    if (chave.startsWith('x')) {
      // Extra: a quantidade digitada É a operada; o instrumento vem do próprio payload.
      const ex = (m.extras ?? []).find(e => e.chave === chave);
      if (ex) extras.push({ instrumento: ex.instrumento, quantidade: v });
    } else {
      linhas[chave] = v;
    }
  }
  return { linhas, extras };
}

/* Um listener delegado no documento, montado uma vez: os cards são redesenhados a cada
   gravação, então listener por campo seria religado toda vez (e esquecido em algum caminho). */
(function _margemBind() {
  if (document.body?.dataset.margemBound) return;
  if (!document.body) { document.addEventListener('DOMContentLoaded', _margemBind); return; }
  document.body.dataset.margemBound = '1';

  const contaDe = el => el.closest('[data-margem-conta]')?.dataset.margemConta || null;

  document.body.addEventListener('change', ev => {
    const el = ev.target;
    if (!(el instanceof HTMLElement)) return;
    const conta = contaDe(el);
    if (!conta) return;

    if (el.dataset.margemNav !== undefined) {
      const v = el.value.trim() === '' ? null : _mNum(el.value);
      if (v !== null && !isFinite(v)) return;
      _margemSalvar(conta, { nav: v });
      return;
    }
    if (el.dataset.margemOp !== undefined) {
      _margemSalvar(conta, _margemColeta(conta));
      return;
    }
    // Linha nova: só grava quando os DOIS campos estão preenchidos — gravar com um só
    // redesenharia o card e apagaria o que o usuário acabou de digitar no outro.
    if (el.dataset.margemNovoInst !== undefined || el.dataset.margemNovoQtd !== undefined) {
      const card = document.querySelector(`[data-margem-conta="${conta}"]`);
      const inst = card.querySelector('[data-margem-novo-inst]')?.value.trim();
      const qtd = _mNum(card.querySelector('[data-margem-novo-qtd]')?.value);
      if (!inst || !isFinite(qtd) || qtd === 0) return;
      const atual = _margemColeta(conta);
      atual.extras.push({ instrumento: inst, quantidade: qtd });
      _margemSalvar(conta, atual);
    }
  });

  // Enter confirma sem esperar o blur (é como a mesa digita uma sequência de quantidades).
  document.body.addEventListener('keydown', ev => {
    if (ev.key !== 'Enter' || !(ev.target instanceof HTMLInputElement)) return;
    if (!contaDe(ev.target)) return;
    ev.preventDefault();
    ev.target.blur();
  });

  document.body.addEventListener('click', ev => {
    const btn = ev.target.closest?.('[data-margem-del]');
    if (!btn) return;
    const conta = contaDe(btn);
    if (!conta) return;
    const alvo = btn.dataset.margemDel;
    const atual = _margemColeta(conta);
    const ex = (margemData?.contas?.[conta]?.extras ?? []).find(e => e.chave === alvo);
    atual.extras = atual.extras.filter(e => !ex || e.instrumento !== ex.instrumento);
    _margemSalvar(conta, atual);
  });
})();
