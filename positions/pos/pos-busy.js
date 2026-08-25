/* ────────────────────────────────────────────────────────────────────────────
 * pos-busy.js — "esta seção está atualizando" + botão ⟳ POR SEÇÃO.
 *
 * ── O problema que isto resolve ──────────────────────────────────────────────
 * Cada loader escrevia `<span class="loading">Carregando…</span>` no innerHTML do
 * SEU container, e só dele. Quem era pintado por OUTRA função a partir dos mesmos
 * dados ficava mostrando o número velho, parado, sem dizer que estava sendo
 * refeito. Medido na tela:
 *   • aba "Análise de Opções": `loadDolarConsol` avisava em #dolarConsolContainer,
 *     mas #optAnalysisContainer (pintado por `renderOptionsAnalysis`) seguia com a
 *     tabela anterior — foi a queixa que originou este arquivo;
 *   • aba "Rolagem Dol": `loadRolagem` avisava em #rolagemContainer, que nasce
 *     `display:none` (é o detalhe colapsado). Ou seja: NADA do que estava à vista
 *     (#rolagemControls, #rolagemSummary, #rolagemBoletaPanel) mudava;
 *   • abas de trader: o prefetch em background (`prefetchOtherTabs`) não mexia em
 *     UI nenhuma — trocar de aba no meio dele dava painel vazio, sem explicação.
 *
 * ── O modelo ────────────────────────────────────────────────────────────────
 * O estado de "atualizando" é do SOURCE (= o request), não do container. Cada
 * SEÇÃO declara de qual source ela vive; ligar o source acende TODAS as seções que
 * dependem dele — inclusive as que nenhum loader rescreve. É por isso que numa aba
 * de trader "Posição" e "PnL" acendem juntas: as duas saem do MESMO
 * `/api/positions/reference`, e refazer uma refaz a outra (não há como pedir só o
 * PnL ao backend). O ⟳ de cada seção diz isso no `title`.
 *
 * Contador por source (não booleano): `on`/`off` aninham, então prefetch e clique
 * simultâneos não apagam o aviso antes do último terminar.
 *
 * ── ⟳ de seção × "Atualizar" da toolbar ─────────────────────────────────────
 * O ⟳ é a ação ESTREITA: refaz o dado daquela seção e PRESERVA as marretas de
 * preço/delta (`priceOverrides`/`deltaOverrides`). O "Atualizar" da toolbar segue
 * global e continua LIMPANDO as marretas (a semântica antiga). A diferença está no
 * `title` dos dois botões, porque é a única que o usuário não adivinha.
 * A guarda de data (`_invalidateStaleTabs`) vale para os dois: um ⟳ nunca deixa
 * cache buscado com outra "Data ref"/"Forçar D-1" de pé.
 *
 * Carregar DEPOIS de pos-state.js (usa TRADER_TABS) e ANTES dos loaders, que
 * chamam `PosBusy.on/off`. As funções de fetch são resolvidas em `window` só na
 * hora do clique, então a ordem dos outros módulos não importa.
 * ──────────────────────────────────────────────────────────────────────────── */
const PosBusy = (() => {

  /* ── Registro: seção → (source, containers que ela pinta) ──────────────────
     A chave é o que vai no `data-sec` do <h2 class="jgp-sec">. Seção sem <h2> na
     página só não ganha botão; o véu dos containers continua valendo. */
  const SECTIONS = {
    'dc:consol': { src: 'dc',       containers: ['dolarConsolContainer'] },
    'dc:opt':    { src: 'dc',       containers: ['optAnalysisContainer'] },
    'dolar:exp': { src: 'dolarexp', containers: ['dolarContainer'] },
    'dolar:enq': { src: 'enqrf',    containers: ['enqRfContainer'] },
    // #rolagemControls entra junto do Resumo: `_rolagemRenderControls` o remonta no
    // mesmo load, e um seletor de vencimento ativo sobre dado em voo convida ao clique.
    'rol:sum':   { src: 'rolagem',  containers: ['rolagemSummary', 'rolagemControls'] },
    'rol:det':   { src: 'rolagem',  containers: ['rolagemContainer'] },
    // O ⟳ desta seção REGERA as boletas (`gerarBoletas`), mas ela também é refeita
    // quando a base muda: `loadRolagem` zera `rolagemBoletas` e a prévia volta ao
    // estado "Configure e clique Gerar boletas". `also` = sources que só a acendem.
    'rol:bol':   { src: 'boletas',  also: ['rolagem'], containers: ['rolagemBoletaPanel'] },
  };
  for (const t of TRADER_TABS) {
    SECTIONS[`pos:${t.id}`] = { src: `ref:${t.id}`, containers: [`posContainer-${t.id}`] };
    SECTIONS[`pnl:${t.id}`] = { src: `ref:${t.id}`, containers: [`pnlContainer-${t.id}`] };
  }

  /* ── Refetch por source. `ref:<tab>` é dinâmico (um por aba de trader). ───── */
  const RUNNERS = {
    dc:       () => window.loadDolarConsol(dolarConsolTrader, { fresh: true }),
    dolarexp: () => window.loadDolarExposure(),
    enqrf:    () => window.loadEnquadramentoRF(),
    rolagem:  () => { _dropTabCache(ROLAGEM_TAB_ID); return window.loadRolagem(); },
    boletas:  () => window.gerarBoletas(),
  };

  // Nome legível do source: vai no title do ⟳ e diz o que mais será refeito junto.
  const SRC_LABEL = {
    dc:       'Consolidado Dólar + Análise de Opções (mesmo request)',
    dolarexp: 'Exposição a dólar local dos fundos prev.',
    enqrf:    'Enquadramento de derivativos dos fundos RF',
    rolagem:  'Resumo + detalhe da rolagem (mesmo request)',
    boletas:  'Prévia de boletas (real + gerencial)',
  };

  const _depth = new Map();   // src → nº de cargas em voo

  // Seções que este source acende: as que VIVEM dele (`src`) + as que só reagem (`also`).
  const _sectionsOf = src =>
    Object.entries(SECTIONS).filter(([, s]) => s.src === src || (s.also ?? []).includes(src));
  // Seções que o ⟳ deste source de fato REFAZ (para dizer no title se são mais de uma).
  const _ownedBy = src => Object.entries(SECTIONS).filter(([, s]) => s.src === src);

  /* Containers que NÃO recebem esqueleto na 1ª carga: não são tabela de dados, então
     um card de barras cinzas ali só pesa. #rolagemControls é a tira de filtros — o
     esqueleto do "Resumo" logo abaixo já carrega o recado. Véu continua valendo. */
  const NO_SKEL = new Set(['rolagemControls']);

  const _SKEL = '<div class="card pos-busy-skel">'
    + '<div class="lbl">Carregando…</div><div class="bar head"></div>'
    + '<div class="bar"></div><div class="bar"></div><div class="bar"></div></div>';

  /* ── Véu do container ──
     Sem overlay e sem pseudo-elemento: #posContainer-* leva `display:inline-flex`
     inline (pos-tabs.js) e um ::before ali viraria FLEX ITEM, empurrando os cards.
     Container vazio (1ª carga) ganha esqueleto — apagar o nada não comunica nada. */
  function _paintContainer(id, busy) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('pos-busy', busy);
    if (busy) {
      if (!el.firstElementChild && !el.textContent.trim() && !NO_SKEL.has(id)) el.innerHTML = _SKEL;
      return;
    }
    // Sobrou só o esqueleto ⇒ o fetch falhou sem escrever nada no container (o catch
    // de `loadPositionsForTab` só mexe no #refStatus). Painel vazio não se explica.
    const skel = el.querySelector(':scope > .pos-busy-skel');
    if (!skel) return;
    if (el.children.length === 1) {
      el.innerHTML = '<div class="card no-data">Sem dados — clique ⟳ no título da seção para tentar de novo.</div>';
    } else {
      skel.remove();
    }
  }

  function _paintHeader(secId, busy) {
    const h = document.querySelector(`h2.jgp-sec[data-sec="${secId}"]`);
    if (!h) return;
    const pill = h.querySelector('.sec-busy');
    const btn  = h.querySelector('.sec-refresh');
    if (pill) pill.hidden = !busy;
    if (btn) { btn.disabled = busy; btn.classList.toggle('spinning', busy); }
  }

  function _paint(src) {
    const busy = (_depth.get(src) || 0) > 0;
    for (const [secId, s] of _sectionsOf(src)) {
      _paintHeader(secId, busy);
      for (const c of s.containers) _paintContainer(c, busy);
    }
  }

  function on(src)  { _depth.set(src, (_depth.get(src) || 0) + 1); _paint(src); }
  function off(src) {
    const n = (_depth.get(src) || 1) - 1;
    if (n > 0) _depth.set(src, n); else _depth.delete(src);
    _paint(src);
  }

  /* Acende seções avulsas (fora do ciclo de um source), p/ ações que redesenham UMA
     seção — hoje o "Buscar PX_SETTLE D0", que só refaz o bloco de PnL da aba ativa. */
  function mark(secIds, busy) {
    for (const id of secIds) {
      _paintHeader(id, busy);
      for (const c of (SECTIONS[id]?.containers ?? [])) _paintContainer(c, busy);
    }
  }

  /* ── Refetch de um source (o clique no ⟳) ─────────────────────────────────
     `ref:<tab>` NÃO passa por `reloadActiveTab`: aquele limpa as marretas (é a
     semântica do "Atualizar" global). O ⟳ preserva-as de propósito. */
  async function refresh(src) {
    if ((_depth.get(src) || 0) > 0) return;          // já em voo → clique duplo é no-op
    if (typeof _invalidateStaleTabs === 'function') _invalidateStaleTabs();
    if (src.startsWith('ref:')) {
      const tabId = src.slice(4);
      _dropTabCache(tabId);
      return window.loadPositionsForTab(tabId, { fresh: true, prefetch: false });
    }
    const run = RUNNERS[src];
    if (run) return run();
  }

  /* ── Decoração dos <h2 class="jgp-sec" data-sec="..."> ────────────────────
     O <h2> vive FORA do container, então a pílula sobrevive ao innerHTML sendo
     rescrito no meio da carga — é por isso que ela, e não o véu, é o aviso principal. */
  function decorate() {
    for (const h of document.querySelectorAll('h2.jgp-sec[data-sec]')) {
      if (h.dataset.secBuilt) continue;
      const sec = SECTIONS[h.dataset.sec];
      if (!sec) continue;
      h.dataset.secBuilt = '1';
      const shared = _ownedBy(sec.src).length > 1;
      const tip = 'Atualizar os dados desta seção ao vivo.'
        + `\nRefaz: ${SRC_LABEL[sec.src] ?? 'a posição e o PnL desta aba (mesmo request)'}.`
        + (shared ? '\nAs seções irmãs saem do mesmo request e são refeitas junto.' : '')
        + '\nPreserva as marretas de preço/delta — o "Atualizar" da toolbar as limpa.';
      const tools = document.createElement('span');
      tools.className = 'sec-tools';
      tools.innerHTML =
        '<span class="sec-busy" role="status" hidden><span class="dot"></span>Atualizando…</span>'
        + `<button type="button" class="sec-refresh" data-sec-src="${sec.src}"`
        + ` aria-label="Atualizar esta seção" title="${tip.replace(/"/g, '&quot;')}"></button>`;
      h.appendChild(tools);
    }
    // Listener delegado único p/ todos os ⟳ (os <h2> são estáticos na página).
    if (!document.body.dataset.secRefreshBound) {
      document.body.dataset.secRefreshBound = '1';
      document.body.addEventListener('click', ev => {
        const btn = ev.target.closest && ev.target.closest('.sec-refresh');
        if (btn) refresh(btn.dataset.secSrc);
      });
    }
  }

  return { on, off, mark, refresh, decorate, SECTIONS };
})();

PosBusy.decorate();
