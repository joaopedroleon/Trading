/* ────────────────────────────────────────────────────────────────────────────
 * pos-boletas.js — aba "Boletas do Dia".
 *
 * Resumo do que foi BOLETADO hoje, uma linha por ATIVO, somando os traders
 * marcados no filtro. É a única aba da tela que NÃO é posição: não há abertura
 * D-1 nem Bloomberg aqui — a linha não diz onde o trader está, diz o que ele fez
 * no dia. Por isso a aba não usa o "Forçar D-1" da toolbar; só a "Data ref".
 *
 * O backend (`/api/positions/boletas-resumo`) devolve as linhas granulares por
 * (trader, instrumento) de TODOS os traders que boletaram, e a soma por ativo é
 * feita aqui: o filtro é a interação principal da aba e marcar/desmarcar um chip
 * não pode custar um round-trip ao Oracle.
 *
 * ⛔ Boleta com contraparte GERENCIAL não entra (pedido da mesa, set/2026): é
 * transferência interna entre livros, não negócio — o backend já a filtra
 * (`get_deals_by_trader_instrument`) e manda em `excluidas.gerencial` quantas ficaram
 * de fora, que a nota da tabela declara. Só esta aba; a posição continua com elas.
 *
 * ⚠️ Os chips saem do DADO, não de lista fixa: trader que nunca apareceu ganha
 * chip sozinho, e trader do conjunto padrão que não boletou no dia simplesmente
 * não tem chip (não há o que somar). O conjunto padrão é o da mesa
 * (BOLETAS_DEFAULT_TRADERS) e a escolha do usuário sobrevive ao ⟳ e à troca de data.
 *
 * ⚠️ As notas de baixo das duas tabelas ficam num <details> FECHADO ("ⓘ notas"), a pedido
 * da mesa (set/2026): a tabela fala por si e o texto só abre para quem quer o porquê.
 *
 * ⭐ São DOIS recortes independentes nesta aba, e confundi-los é o erro fácil:
 * este filtro de traders manda na TABELA DE BOLETAS; a conferência boleta × execução
 * (mais abaixo neste arquivo) tem pareamento próprio — por grupo, derivado deste
 * filtro, ou MANUAL, com seus próprios chips de executor e de livro.
 * ──────────────────────────────────────────────────────────────────────────── */

const BOLETAS_TAB_ID = 'boletas';

// Filtro padrão (mesa, set/2026). Quem não boletou no dia não vira chip.
// São os livros que a mesa opera: os 6 do grupo JLeon (`positions/tradebook.py`) + PAlves.
// ⚠️ A lista aqui é só de EXIBIÇÃO. No pareamento POR GRUPO da conferência quem manda são
// os `livros` do grupo, que entram inteiros mesmo desmarcados — a execução do JLeon casa
// 40% das chaves sem o PortfolioRF e 77% com ele, então tirar um chip daqui não pode
// (e não vai) mudar o Δ da seção 01. No pareamento MANUAL o lado JDS é a seleção própria
// da conferência, que também não é esta — só o botão "Como o filtro" copia daqui.
const BOLETAS_DEFAULT_TRADERS = ['EMota', 'ECotrim', 'PortfolioRF', 'PAlves', 'Portfolio', 'PortfolioPrev', 'ARaggio'];

// Ordem das áreas na tabela; o que não estiver aqui vai para o fim, alfabético.
const BOLETAS_AREA_ORDER = ['Rates', 'Currencies', 'Equities', 'Commodities'];

let boletasSel  = null;        // Set<trader> marcados — null = ainda não inicializado
const boletasSeen = new Set();  // traders que já apareceram em algum dia carregado

/* ── Abrir a aba (carga preguiçosa; sem prefetch) ─────────────────────────── */
function showBoletasTab() {
  activeTraderTab = BOLETAS_TAB_ID;
  _showPanel(BOLETAS_TAB_ID);
  if (!posDataByTab[BOLETAS_TAB_ID]) loadBoletas();
  else { _dirtyTabs.delete(BOLETAS_TAB_ID); renderBoletas(); }
}

async function loadBoletas() {
  const refDate   = document.getElementById('refDate').value;
  const status    = document.getElementById('refStatus');
  const srcLabel  = document.getElementById('srcLabel');
  const btn       = document.getElementById('btnLoad');
  const container = document.getElementById('boletasContainer');

  PosBusy.on('boldia');
  status.textContent = 'Buscando boletas...';
  status.style.color = 'var(--text-muted)';
  btn.disabled = true;

  try {
    const params = new URLSearchParams();
    if (refDate) params.set('ref_date', refDate);
    const data = await (await fetch(`${API_BASE}/api/positions/boletas-resumo?${params}`)).json();

    if (data.error) {
      status.textContent = 'Erro: ' + data.error;
      status.style.color = 'var(--red)';
      container.innerHTML = `<div class="card no-data">${data.error}</div>`;
      return;
    }

    posDataByTab[BOLETAS_TAB_ID] = data;
    _noteFetchSig(BOLETAS_TAB_ID);
    status.textContent = '';
    srcLabel.textContent = `Boletas: ${fmtDate(data.ref_date)} (JDS)`;
    renderBoletas();
  } catch (e) {
    status.textContent = 'Erro: ' + e.message;
    status.style.color = 'var(--red)';
    container.innerHTML = `<div class="card no-data">Falha ao buscar: ${e.message}</div>`;
  } finally {
    btn.disabled = false;
    PosBusy.off('boldia');
  }
}

/* ── Seleção de traders ───────────────────────────────────────────────────── */
/* A escolha do usuário manda e sobrevive ao ⟳ e à troca de data. Mas trader que
   NUNCA apareceu ainda não foi escolhido por ninguém: ele entra pela regra padrão.
   ⚠️ Sem essa distinção, abrir a aba num dia em que o PortfolioPrev não boletou e
   depois voltar a um dia em que ele boletou o deixava DESMARCADO em silêncio — o
   conjunto tinha sido congelado na 1ª carga, e a mesa não veria as boletas dele
   sem saber que faltava marcar. */
function _boletasEnsureSel(traders) {
  if (!boletasSel) boletasSel = new Set();
  for (const t of traders) {
    if (boletasSeen.has(t.trader)) continue;
    boletasSeen.add(t.trader);
    if (BOLETAS_DEFAULT_TRADERS.includes(t.trader)) boletasSel.add(t.trader);
  }
  return boletasSel;
}

function toggleBoletaTrader(t) {
  if (!boletasSel) return;
  if (boletasSel.has(t)) boletasSel.delete(t); else boletasSel.add(t);
  renderBoletas();
}

function setBoletaTraders(mode) {
  const data = posDataByTab[BOLETAS_TAB_ID];
  if (!data) return;
  const have = data.traders.map(t => t.trader);
  if (mode === 'all')       boletasSel = new Set(have);
  else if (mode === 'none') boletasSel = new Set();
  else                      boletasSel = new Set(BOLETAS_DEFAULT_TRADERS.filter(t => have.includes(t)));
  renderBoletas();
}

/* ── Render ───────────────────────────────────────────────────────────────── */
function renderBoletas() {
  const data = posDataByTab[BOLETAS_TAB_ID];
  const elC  = document.getElementById('boletasControls');
  const elT  = document.getElementById('boletasContainer');
  if (!data || !elT) return;

  const sel = _boletasEnsureSel(data.traders);

  // Ordem única de trader na aba — chips E colunas da tabela. Os do conjunto padrão
  // primeiro, na ordem da mesa; o resto por volume de boletas. ⚠️ Não é só estética:
  // ordenar as COLUNAS por nº de boletas faria a tabela trocar de ordem a cada dia,
  // e a mesa lê sempre as mesmas 6 primeiras posições.
  const ordered = [...data.traders].sort((a, b) => {
    const rk = t => { const i = BOLETAS_DEFAULT_TRADERS.indexOf(t.trader); return i >= 0 ? i : 100; };
    return rk(a) - rk(b) || b.n_deals - a.n_deals;
  });

  if (elC) {
    const chips = ordered
      .map(t => `<span class="filter-chip ${sel.has(t.trader) ? 'on' : 'off'}"
                       title="${t.n_deals} boleta(s) em ${t.n_instruments} ativo(s)"
                       onclick="toggleBoletaTrader('${t.trader}')">${t.trader} · ${t.n_deals}</span>`).join('');
    elC.innerHTML = `<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        <span style="font-size:12px;color:var(--text-muted);font-weight:600">Traders:</span>
        ${chips || '<span style="font-size:12px;color:var(--text-muted)">ninguém boletou nesta data</span>'}
        <span class="filter-chip chip-act" onclick="setBoletaTraders('default')" title="Volta ao conjunto padrão da mesa: ${BOLETAS_DEFAULT_TRADERS.join(', ')}">Padrão</span>
        <span class="filter-chip chip-act" onclick="setBoletaTraders('all')">Todos</span>
        <span class="filter-chip chip-act" onclick="setBoletaTraders('none')">Nenhum</span>
      </div>`;
  }

  // Soma por ATIVO sobre os traders marcados. `by_trader` guarda o líquido de cada
  // um para as colunas do meio — é o que mostra quem fez o quê sem virar outra tabela.
  const cols = ordered.map(t => t.trader).filter(t => sel.has(t));
  const byRef = new Map();
  for (const r of data.rows) {
    if (!sel.has(r.trader)) continue;
    const k = r.instrument_reference;
    let a = byRef.get(k);
    if (!a) {
      a = { ref: k, name: r.instrument_name || k, type: r.instrument_type_name || '—',
            ccy: r.currency_name || '', area: r.area || 'Outros',
            net: 0, gross: 0, buy_qty: 0, buy_not: 0, sell_qty: 0, sell_not: 0,
            n: 0, by_trader: {} };
      byRef.set(k, a);
    }
    a.net      += r.traded_quantity  || 0;
    a.gross    += r.gross_traded_qty || 0;
    a.buy_qty  += r.buy_qty          || 0;
    a.buy_not  += r.buy_notional     || 0;
    a.sell_qty += r.sell_qty         || 0;
    a.sell_not += r.sell_notional    || 0;
    a.n        += r.n_deals          || 0;
    a.by_trader[r.trader] = (a.by_trader[r.trader] || 0) + (r.traded_quantity || 0);
  }
  const rows = [...byRef.values()];

  if (!rows.length) {
    elT.innerHTML = `<div class="card no-data">Nenhuma boleta em ${fmtDate(data.ref_date)} para os traders marcados.</div>`;
    renderBoletasCheck(data, sel);
    return;
  }

  // Áreas na ordem da mesa; dentro de cada uma, o ativo mais girado primeiro.
  const areas = [...new Set(rows.map(r => r.area))].sort((a, b) => {
    const ia = BOLETAS_AREA_ORDER.indexOf(a), ib = BOLETAS_AREA_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });

  const nCols = 2 + cols.length + 5;
  const px = (not, qty) => (qty ? fmtOptPx(not / qty) : '<span style="color:var(--text-muted)">—</span>');

  const body = areas.map(area => {
    const grp = `<tr class="grp"><td colspan="${nCols}">${area}</td></tr>`;
    const trs = rows.filter(r => r.area === area)
      .sort((a, b) => b.gross - a.gross)
      .map(r => `<tr>
        <td class="lbl">${r.name}</td>
        <td class="left" style="color:var(--text-muted);font-size:11px">${r.type}${r.ccy ? ' · ' + r.ccy : ''}</td>
        ${cols.map((t, i) => `<td class="${i === 0 ? 'sep' : ''}">${fmtTradedQty(r.by_trader[t] ?? 0)}</td>`).join('')}
        <td class="sep" style="font-weight:700">${fmtTradedQty(r.net)}</td>
        <td>${fmtQty(r.gross)}</td>
        <td class="sep">${px(r.buy_not, r.buy_qty)}</td>
        <td>${px(r.sell_not, r.sell_qty)}</td>
        <td style="color:var(--text-muted)">${r.n}</td>
      </tr>`).join('');
    return grp + trs;
  }).join('');

  const nDeals = rows.reduce((a, r) => a + r.n, 0);
  elT.innerHTML = `<div class="card">
    <div class="section-title" style="padding:8px 0 10px 0;display:flex;align-items:center;gap:16px">
      <span>Boletado em ${fmtDate(data.ref_date)}
        <span style="font-weight:400;color:var(--text-muted);font-size:13px">— ${rows.length} ativo(s) · ${nDeals} boleta(s) · ${cols.length} trader(es)</span>
      </span>
      <button class="btn btn-secondary" data-html2canvas-ignore="true"
              style="padding:3px 12px;font-size:12px;margin-left:auto" onclick="copyCardImage(this)">⎘ Copiar</button>
    </div>
    <div class="section-copy-target" style="max-width:100%">
      <div style="overflow-x:auto">
        <table class="jgp-tbl">
          <thead><tr>
            <th class="left">Ativo</th>
            <th class="left">Tipo</th>
            ${cols.map((t, i) => `<th class="${i === 0 ? 'sep' : ''}">${t}</th>`).join('')}
            <th class="sep">Líquido</th>
            <th>Bruto</th>
            <th class="sep">Px méd. compra</th>
            <th>Px méd. venda</th>
            <th>Bol.</th>
          </tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>
      <details class="jgp-tbl-note" style="margin:6px 0 0;font-size:11.5px;color:var(--text-muted);line-height:1.5">
        <summary style="cursor:pointer;user-select:none">ⓘ notas</summary>
        Só boletas do dia (<b>JDS</b> · <code>vw_mm_prev_deals</code>) — não é posição: não entram
        a abertura D-1 nem preço de mercado. <b>Líquido</b> = compras − vendas (negativo entre
        parênteses, na convenção do JRS: positivo = comprado/tomado); <b>Bruto</b> = soma dos
        módulos, então giro que não muda posição aparece aqui. Os preços médios são ponderados
        por quantidade e vêm na unidade de cotação de cada ativo (taxa no DI, pontos no dólar).
        <b>Não há total geral</b>: as unidades não somam entre ativos.
        ${_boletasGerencialNote(data)}
      </details>
    </div>
  </div>`;

  renderBoletasCheck(data, sel);
}

/* Nota da exclusão das boletas com contraparte Gerencial (transferência interna entre
 * livros). Diz quantas ficaram de fora e de quem — e, se a contagem falhou no servidor,
 * diz que o número está faltando, em vez de fingir que não havia nenhuma. */
function _boletasGerencialNote(data) {
  const g = (data.excluidas || {}).gerencial;
  if (!g) return '';
  if (g.error)
    return `<br>⛔ Boletas com contraparte <b>Gerencial</b> (transferência interna entre livros)
      <b>não entram</b> nesta aba — e a contagem das excluídas falhou no servidor, então não
      dá para dizer quantas foram.`;
  if (!g.n_deals)
    return `<br>⛔ Boletas com contraparte <b>Gerencial</b> (transferência interna entre livros)
      <b>não entram</b> nesta aba. Nenhuma nesta data.`;
  const quem = (g.por_trader || [])
    .map(t => `${t.trader} ${t.n_deals}`).join(' · ');
  return `<br>⛔ <b>${g.n_deals} boleta(s)</b> com contraparte <b>Gerencial</b> (transferência
    interna entre livros, não negócio) <b>ficaram de fora</b> desta aba e dos chips acima:
    ${quem}. A posição das abas de trader continua com elas.`;
}


/* ── Conferência com a fonte (tradebook da Bloomberg) ──────────────────────────
 *
 * Cross-check básico: o que saiu EXECUTADO no tradebook (`jds.blp_fix_deals`) tem
 * de reaparecer BOLETADO no JDS. Compara compra e venda por ativo, na quantidade.
 *
 * ☠️ No modo PADRÃO a unidade de comparação é o GRUPO DE EXECUÇÃO, não o trader — a
 * fonte não tem coluna de trader (quem executou é o UUID do terminal) e a regra da mesa
 * é executor = trader MENOS na mesa de juros, onde JLeon e PAlves executam
 * indistintamente os 7 livros do grupo. Por isso marcar um desses chips soma o grupo
 * inteiro do lado JDS: conferir a execução toda contra um livro só acusaria diferença
 * que não existe — em 11/09/2026 o ODF31 aparecia como +4.333 num executor e −3.333 no
 * outro, sendo a MESMA operação. O mapa mora em `positions/tradebook.py`; a tela DECLARA
 * a expansão em vez de fazê-la calada.
 *
 * ⭐ **Modo MANUAL (set/2026):** a mesa escolhe a dedo os executores de um lado e os
 * livros do outro, e os dois conjuntos viram UM balde. Serve para investigar ("esta
 * execução caiu em qual livro?") e para arranjo que o mapa ainda não tem — inclusive
 * UUID sem grupo nenhum, que por isso deixou de ser descartado no backend. O pareamento
 * é a ÚNICA coisa que muda: a matemática, o corte por tipo (futuro/opção listada) e a
 * régua de símbolo são os mesmos dos dois lados.
 * ⚠️ E aqui NÃO há expansão automática para os livros inteiros do grupo — é o ponto do
 * modo. Quem tira um livro da seleção assume a divergência que isso cria (o PortfolioRF
 * sozinho move o casamento do grupo do JLeon de 77% para 40%); a tela avisa por escrito.
 *
 * ⚠️ Nem tudo passa pelo tradebook (voz, corretora, outro EMS) e transferência entre
 * livros não tem execução nenhuma: boletado sem execução NÃO é erro por si só — quem
 * costuma apontar problema é o contrário.
 *
 * ⭐ "Boletado fora do par" (set/2026): quando o par executou MAIS do que os seus livros
 * boletaram, o mesmo ativo é procurado nos livros que NÃO são do par e a tela aponta quem
 * — caso recorrente da rolagem de WDO/DOL que o JLeon executa e cai no AJakurski —,
 * DESCONTADO o que o dono daquele livro executou por conta própria (senão o Branquinho
 * aparecia no ODF29 com os 700 que ele mesmo executou). E o
 * spread da B3 (`WDOV6X6`/`UCV6UCX6`) entra como linha comparável sob o ref de spread do
 * JDS (`WD1V6X6`/`DR1V6X6`, via `tradebook.b3_spread_ref`), em vez de ficar na nota de
 * multi-leg. Detalhe e aferição em `positions/tradebook.py`.
 * ──────────────────────────────────────────────────────────────────────────── */

// Pareamento: 'grupo' = mapa da mesa (`tradebook.py`), 'livre' = escolha manual.
// ⚠️ Estado de MÓDULO, como o `boletasSel`: sobrevive ao ⟳ e à troca de data, e não
// vai ao localStorage — a escolha é de sessão de investigação, não preferência.
let boletasCheckMode = 'grupo';
let boletasExecSel   = null;   // Set<uuid>   — lado tradebook, só no modo livre
let boletasLivroSel  = null;   // Set<trader> — lado JDS,       só no modo livre

/* O modo livre NASCE igual ao que está na tela: os grupos em cena, com seus UUIDs e
   seus livros inteiros. Assim trocar de modo não muda número nenhum de saída — o que
   muda é passar a poder editar os dois lados. Partir de vazio faria a tela piscar
   para "nada a conferir" e esconderia o ponto de partida calibrado. */
function _boletasSeedLivre() {
  boletasExecSel = new Set();
  boletasLivroSel = new Set();
  const data = posDataByTab[BOLETAS_TAB_ID];
  const tb = data && data.tradebook;
  if (!tb || tb.error) return;
  const sel = _boletasEnsureSel(data.traders);
  for (const g of tb.grupos || []) {
    if (!g.livros.some(t => sel.has(t))) continue;
    (g.uuids  || []).forEach(u => boletasExecSel.add(u));
    (g.livros || []).forEach(t => boletasLivroSel.add(t));
  }
}

function _rerenderBoletasCheck() {
  const data = posDataByTab[BOLETAS_TAB_ID];
  if (data) renderBoletasCheck(data, _boletasEnsureSel(data.traders));
}

function setBoletasCheckMode(m) {
  if (m === boletasCheckMode) return;
  boletasCheckMode = m;
  if (m === 'livre' && !boletasExecSel) _boletasSeedLivre();
  _rerenderBoletasCheck();
}

function toggleBoletaExec(uuid) {
  if (!boletasExecSel) _boletasSeedLivre();
  const u = Number(uuid);
  if (boletasExecSel.has(u)) boletasExecSel.delete(u); else boletasExecSel.add(u);
  _rerenderBoletasCheck();
}

function toggleBoletaLivro(t) {
  if (!boletasLivroSel) _boletasSeedLivre();
  if (boletasLivroSel.has(t)) boletasLivroSel.delete(t); else boletasLivroSel.add(t);
  _rerenderBoletasCheck();
}

function setBoletaExecs(mode) {
  const data = posDataByTab[BOLETAS_TAB_ID];
  const tb = data && data.tradebook;
  if (!tb || tb.error) return;
  boletasExecSel = mode === 'all'
    ? new Set((tb.executores || []).map(e => e.uuid))
    : new Set();
  _rerenderBoletasCheck();
}

function setBoletaLivros(mode) {
  const data = posDataByTab[BOLETAS_TAB_ID];
  if (!data) return;
  if (mode === 'all')         boletasLivroSel = new Set(data.traders.map(t => t.trader));
  else if (mode === 'filtro') boletasLivroSel = new Set(_boletasEnsureSel(data.traders));
  else                        boletasLivroSel = new Set();
  _rerenderBoletasCheck();
}

/* Carrega um grupo do mapa nos DOIS lados — ponto de partida para editar a partir de
   um arranjo conhecido, em vez de montar tudo do zero. Substitui a seleção. */
function loadBoletaGrupo(nome) {
  const data = posDataByTab[BOLETAS_TAB_ID];
  const tb = data && data.tradebook;
  if (!tb || tb.error) return;
  const g = (tb.grupos || []).find(x => x.nome === nome);
  if (!g) return;
  boletasExecSel  = new Set(g.uuids  || []);
  boletasLivroSel = new Set(g.livros || []);
  _rerenderBoletasCheck();
}

/* Pares (executores × livros) a conferir. É o ÚNICO ponto em que os dois modos
   divergem — daí para baixo a conta é a mesma. */
function _boletasPairs(data, tb, sel) {
  if (boletasCheckMode === 'livre') {
    return [{ nome: 'Seleção',
              uuids:  new Set(boletasExecSel  || []),
              livros: new Set(boletasLivroSel || []) }];
  }
  return (tb.grupos || [])
    .filter(g => g.livros.some(t => sel.has(t)))
    .map(g => ({ nome: g.nome, uuids: new Set(g.uuids), livros: new Set(g.livros) }));
}

/* Faixa de controles da conferência. Fica DENTRO do card do cross-check, e não junto
   dos chips de trader do topo: aquele filtro manda na tabela de boletas e este no
   pareamento — são dois recortes diferentes e misturá-los na mesma faixa esconderia isso. */
function _boletasCheckControls(data, tb) {
  const mBtn = (on, label, call, title) =>
    `<span class="filter-chip ${on ? 'on' : 'chip-act'}" title="${title || ''}"
           onclick="${call}">${label}</span>`;

  const modo = `<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
      <span style="font-size:12px;color:var(--text-muted);font-weight:600;min-width:150px">Pareamento:</span>
      ${mBtn(boletasCheckMode === 'grupo', 'Mapa da mesa', "setBoletasCheckMode('grupo')",
             'Grupos de execução calibrados (positions/tradebook.py): executores e livros que se misturam viram uma linha só')}
      ${mBtn(boletasCheckMode === 'livre', 'Manual', "setBoletasCheckMode('livre')",
             'Escolher a dedo os executores de um lado e os livros do outro')}
    </div>`;

  if (boletasCheckMode !== 'livre') return modo;

  const execs = tb.executores || [];
  const eSel  = boletasExecSel  || new Set();
  const lSel  = boletasLivroSel || new Set();

  const chipsExec = execs.map(e => `<span class="filter-chip ${eSel.has(e.uuid) ? 'on' : 'off'}"
       title="UUID ${e.uuid}${e.grupo ? ' · grupo ' + e.grupo : ' · sem grupo no mapa'} — ${e.n_fills} fill(s) em ${e.n_symbols} símbolo(s)"
       onclick="toggleBoletaExec(${e.uuid})">${e.quem} · ${e.n_fills}</span>`).join('');

  const ordered = [...data.traders].sort((a, b) => {
    const rk = t => { const i = BOLETAS_DEFAULT_TRADERS.indexOf(t.trader); return i >= 0 ? i : 100; };
    return rk(a) - rk(b) || b.n_deals - a.n_deals;
  });
  const chipsLivro = ordered.map(t => `<span class="filter-chip ${lSel.has(t.trader) ? 'on' : 'off'}"
       title="${t.n_deals} boleta(s) em ${t.n_instruments} ativo(s)"
       onclick="toggleBoletaLivro('${t.trader}')">${t.trader} · ${t.n_deals}</span>`).join('');

  // Livro na seleção que NÃO boletou no dia não ganha chip (não há o que somar) — mas
  // continua selecionado, então é dito aqui, senão ele sumiria da tela e voltaria sozinho
  // noutra data sem ninguém ter marcado nada.
  const semChip = [...lSel].filter(t => !data.traders.some(x => x.trader === t));

  const presets = (tb.grupos || []).map(g =>
    `<span class="filter-chip chip-act" title="Carrega ${g.uuids.length} executor(es) × ${g.livros.length} livro(s) do grupo ${g.nome}"
           onclick="loadBoletaGrupo('${g.nome}')">${g.nome}</span>`).join('');

  return `${modo}
    <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:8px">
      <span style="font-size:12px;color:var(--text-muted);font-weight:600;min-width:150px">Executores (tradebook):</span>
      ${chipsExec || '<span style="font-size:12px;color:var(--text-muted)">ninguém executou nesta data</span>'}
      <span style="display:inline-flex;gap:6px;white-space:nowrap">
        <span class="filter-chip chip-act" onclick="setBoletaExecs('all')">Todos</span>
        <span class="filter-chip chip-act" onclick="setBoletaExecs('none')">Nenhum</span>
      </span>
    </div>
    <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:6px">
      <span style="font-size:12px;color:var(--text-muted);font-weight:600;min-width:150px">Livros boletados (JDS):</span>
      ${chipsLivro || '<span style="font-size:12px;color:var(--text-muted)">ninguém boletou nesta data</span>'}
      <span style="display:inline-flex;gap:6px;white-space:nowrap">
        <span class="filter-chip chip-act" onclick="setBoletaLivros('filtro')" title="Copia os traders marcados no filtro da aba">Como o filtro</span>
        <span class="filter-chip chip-act" onclick="setBoletaLivros('all')">Todos</span>
        <span class="filter-chip chip-act" onclick="setBoletaLivros('none')">Nenhum</span>
      </span>
    </div>
    <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:6px">
      <span style="font-size:12px;color:var(--text-muted);font-weight:600;min-width:150px">Carregar grupo do mapa:</span>
      ${presets}
    </div>
    ${semChip.length ? `<div style="font-size:11.5px;color:var(--text-muted);margin-top:6px">
       Na seleção mas sem boleta nesta data (somam zero): ${semChip.join(', ')}.</div>` : ''}`;
}

/* ── Execuções feitas FORA do tradebook (out/2026, pedido do JLeon) ──────────────────
 * Nem toda execução passa pelo FIX — voz, corretora, outro EMS. A boleta existe no JDS, o
 * fill não existe no tradebook, e a conferência acusava Δ positivo todo dia para um negócio
 * sem erro nenhum. Aqui a mesa registra a execução que ficou de fora; ela soma no lado
 * EXECUTADO (o backend a devolve dentro de `tradebook.rows`, marcada `manual`) e o Δ fecha.
 *
 * ⚠️ **É dado digitado, e a tela DECLARA o que veio daqui** — "man." na célula de execução, com a
 * parcela no hover, e uma linha no rodapé. Um Δ zerado por lançamento manual não pode parecer
 * um Δ que fechou sozinho: a conferência existe para achar boleta errada, e esconder a
 * diferença em vez de explicá-la a desligaria em silêncio.
 * ⛔ Não cria nem altera boleta: a boleta do JDS continua sendo a base oficial.
 *
 * Estado de MÓDULO (como o `boletasCheckMode`): o `<details>` é remontado a cada re-render da
 * conferência — um chip clicado no meio do preenchimento apagaria o que foi digitado. */
let boletasManuaisOpen = false;
let _execManualDraft = {};

function _emDraft(k, v) { _execManualDraft[k] = v; }
function _emEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function salvarExecManual(btn) {
  const g    = id => document.getElementById(id);
  const msg  = g('emMsg');
  const data = posDataByTab[BOLETAS_TAB_ID];
  if (!data) return;
  const body = {
    data:     data.ref_date,
    symbol:   g('emSym').value,
    uuid:     g('emUuid').value,
    buy_qty:  g('emBuy').value,
    sell_qty: g('emSell').value,
    obs:      g('emObs').value,
  };
  btn.disabled = true;
  msg.textContent = 'Gravando...'; msg.style.color = 'var(--text-muted)';
  try {
    const res = await fetch(`${API_BASE}/api/positions/execucoes-manuais`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const out = await res.json();
    if (!res.ok || out.error) {   // 422 = motivo legível (data, ativo, executor, quantidade)
      msg.textContent = out.error || 'Falha ao gravar.'; msg.style.color = 'var(--red)';
      return;
    }
    _execManualDraft = {};
    boletasManuaisOpen = true;
    await loadBoletas();   // a entrada só soma no lado executado depois de voltar do backend
  } catch (e) {
    msg.textContent = 'Erro: ' + e.message; msg.style.color = 'var(--red)';
  } finally {
    btn.disabled = false;
  }
}

async function excluirExecManual(id, rotulo) {
  if (!confirm(`Remover a execução manual ${rotulo}?`)) return;
  try {
    const res = await fetch(`${API_BASE}/api/positions/execucoes-manuais/${encodeURIComponent(id)}`,
                            { method: 'DELETE' });
    const out = await res.json();
    if (!res.ok || out.error) { alert(out.error || 'Falha ao excluir.'); return; }
    boletasManuaisOpen = true;
    await loadBoletas();
  } catch (e) {
    alert('Erro: ' + e.message);
  }
}

/* ── Ferramenta "de onde vem esta divergência?" (out/2026, pedido do JLeon) ──────────────
 * A conferência diz QUANTO falta de execução num ativo. Esta ferramenta casa boleta × fill
 * **no PREÇO** e lista **só os blocos que não batem**, quebrados por preço × corretora ×
 * livro, para a mesa ticar o que foi na voz/corretora e não passou pelo tradebook.
 *
 * ⭐ **O preço casa — medido, não suposto** (02/10/2026, `ODF31`): as compras de 14,040 somam
 * 1.326 (EMota) + 76 (ECotrim) = **1.402** na boleta e **1.402** no fill, e os 19 preços do
 * grupo JLeon+PAlves batem um a um. Os três do **Banco Itaú** (14,060 / 14,065 / 14,105, livro
 * `Portfolio`) não têm fill nenhum — são exatamente o Δ de +1.333. Resultado: de **36 blocos**
 * a tela passa a mostrar **3**.
 *
 * ⚠️ **O filtro é ATALHO, não verdade** — por isso o botão "mostrar todos os blocos". Boleta
 * lançada a preço MÉDIO de vários fills não casa por preço e apareceria como divergente; e se
 * a ponta do tradebook falhar (`fills_ok: false`) a tela cai sozinha para a lista cheia, em vez
 * de afirmar que "não bate" o que ela não conseguiu conferir.
 *
 * ⚠️ **A ferramenta NÃO adivinha o bloco culpado.** Ela filtra, soma o que foi ticado contra o
 * Δ e deixa a decisão com quem operou — marcar sozinha "o que fecha a conta" acertaria no caso
 * fácil e fecharia Δ errado em silêncio no dia em que dois problemas somassem por acaso.
 *
 * Estado de MÓDULO: o painel é remontado a cada re-render da conferência (um chip clicado no
 * meio da escolha apagaria o que foi ticado), e a quebra custa um round-trip ao Oracle. */
let _quebra = null;   // {sym, par, dBuy, dSell, rows, fills, fillsOk, sel:Set, uuid, livro, todos, msg}

function _qbPx(v) {
  return v == null ? '—'
    : Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 5 });
}
const _qbKey = (lado, px) => `${lado}|${Number(px).toFixed(8)}`;

/* Boletado × executado POR (lado, preço), restrito ao par em cena — é o que decide o que
   aparece. Livro fora do par não entra no boletado (o Δ não é dele) e executor fora do par não
   entra no executado, senão o fill de outro grupo "explicaria" uma boleta que não é dele.

   ☠️ **O que JÁ FOI CADASTRADO conta como executado — e isso não é detalhe** (out/2026,
   reportado pelo JLeon). O lançamento manual vive em `tradebook.rows` (fecha o Δ da
   conferência), mas NÃO vem na quebra por preço, que sai do FIX cru. Sem somá-lo aqui, o dia
   em que aparecesse uma divergência NOVA no mesmo ativo reabria a quebra listando de novo os
   blocos já resolvidos — a mesa teria de reconhecer, entre eles, qual era o novo. Agora o
   bloco cadastrado sai da lista (e no "mostrar todos" aparece marcado `·cadastrado`).
   ⚠️ Casa por **(lado, preço)**: entrada criada PELA quebra sempre carrega o preço do bloco.
   A do formulário livre pode não ter — essas entram em `semPreco` e a tela declara, em vez de
   serem ignoradas em silêncio ou abatidas de um preço que não é o delas. */
function _qbPorPreco(q, data) {
  const pares = _boletasPairs(data, data.tradebook, _boletasEnsureSel(data.traders));
  const par   = pares.find(p => p.nome === q.par) || { livros: new Set(), uuids: new Set() };
  const bol = new Map(), exe = new Map(), cad = new Map();
  const add = (m, k, v) => m.set(k, (m.get(k) || 0) + v);
  for (const r of q.rows || []) {
    if (!par.livros.has(r.trader)) continue;
    if (r.buy_qty)  add(bol, _qbKey('C', r.price), r.buy_qty);
    if (r.sell_qty) add(bol, _qbKey('V', r.price), r.sell_qty);
  }
  for (const f of q.fills || []) {
    if (!par.uuids.has(f.uuid)) continue;
    add(exe, _qbKey(f.side === '1' ? 'C' : 'V', f.price), f.qty || 0);
  }
  let semPreco = 0;
  for (const m of data.manuais || []) {
    if ((m.symbol || '') !== q.sym || !par.uuids.has(m.uuid)) continue;
    const qt = m.buy_qty || m.sell_qty || 0;
    if (!qt) continue;
    if (m.price == null) { semPreco += qt; continue; }
    const k = _qbKey(m.buy_qty ? 'C' : 'V', m.price);
    add(exe, k, qt);    // já cadastrado = já executado, para efeito deste casamento
    add(cad, k, qt);
  }
  return { par, bol, exe, cad, semPreco };
}

/* Uma linha por (bloco, LADO): o mesmo preço/corretora/livro pode ter compra e venda, e o Δ é
   por lado. A chave entra no Set de ticados e sobrevive ao re-render. */
function _qbLinhas(rows) {
  const out = [];
  for (const r of rows || []) {
    for (const [lado, q] of [['C', r.buy_qty], ['V', r.sell_qty]]) {
      if (!q) continue;
      out.push({
        k: `${r.instrument_reference}|${r.trader}|${r.broker || ''}|${r.price}|${lado}`,
        ref: r.instrument_reference, symbol: r.symbol, trader: r.trader,
        broker: r.broker || '—', giveup: r.giveup, price: r.price,
        lado, qty: q, n: r.n_deals,
      });
    }
  }
  // Maior primeiro: o bloco que explica um Δ grande costuma ser um só.
  out.sort((a, b) => b.qty - a.qty || String(a.broker).localeCompare(String(b.broker)));
  return out;
}

async function abrirQuebra(sym, parNome, dBuy, dSell) {
  const data = posDataByTab[BOLETAS_TAB_ID];
  if (!data) return;
  const alvo = data.rows.filter(r => r.symbol === sym && r.comparable);
  const refs = [...new Set(alvo.map(r => r.instrument_reference).filter(Boolean))];
  // Nomes do lado BBG: o símbolo da conferência + o do pai multi-leg, quando houver (no
  // spread da B3 os dois lados têm nome diferente — `WDOV6X6` × `WD1V6X6`).
  const syms = new Set([sym]);
  for (const r of (data.tradebook && data.tradebook.rows) || [])
    if (r.symbol === sym && r.symbol_src) syms.add(r.symbol_src);
  let uuid = '';
  if (boletasCheckMode === 'livre') uuid = [...(boletasExecSel || [])][0] || '';
  else {
    const g = ((data.tradebook && data.tradebook.grupos) || []).find(x => x.nome === parNome);
    uuid = (g && g.uuids && g.uuids[0]) || '';
  }
  _quebra = { sym, par: parNome, dBuy, dSell, rows: null, fills: [], fillsOk: true,
              sel: new Set(), uuid: String(uuid || ''), livro: '', todos: false,
              msg: 'Conferindo boleta × execução por preço…' };
  boletasManuaisOpen = true;
  _rerenderBoletasCheck();
  try {
    const p = new URLSearchParams({ refs: refs.join(','), symbols: [...syms].join(',') });
    if (data.ref_date) p.set('ref_date', data.ref_date);
    const out = await (await fetch(`${API_BASE}/api/positions/boletas-quebra?${p}`)).json();
    if (!_quebra || _quebra.sym !== sym) return;   // o usuário já abriu outro ativo
    if (out.error) _quebra.msg = 'Erro: ' + out.error;
    else {
      _quebra.rows = out.rows || [];
      _quebra.fills = out.fills || [];
      _quebra.fillsOk = out.fills_ok !== false;
      _quebra.todos = !_quebra.fillsOk;   // sem a ponta do tradebook não dá para filtrar
      _quebra.msg = '';
    }
  } catch (e) {
    if (_quebra) _quebra.msg = 'Erro: ' + e.message;
  }
  _rerenderBoletasCheck();
}

function fecharQuebra() { _quebra = null; _rerenderBoletasCheck(); }

function toggleQuebraLinha(k) {
  if (!_quebra) return;
  if (_quebra.sel.has(k)) _quebra.sel.delete(k); else _quebra.sel.add(k);
  _rerenderBoletasCheck();
}
function setQuebraCampo(campo, v) { if (_quebra) _quebra[campo] = v; }
function toggleQuebraTodos() {
  if (!_quebra || !_quebra.fillsOk) return;
  _quebra.todos = !_quebra.todos;
  _rerenderBoletasCheck();
}

/* Grava TODOS os blocos ticados de uma vez (tudo ou nada no backend) e recarrega a aba — é só
   depois de voltar do servidor que a execução soma no lado executado e o Δ fecha. */
async function marcarQuebra(btn) {
  if (!_quebra || !_quebra.sel.size) return;
  const data = posDataByTab[BOLETAS_TAB_ID];
  const linhas = _qbLinhas(_quebra.rows).filter(l => _quebra.sel.has(l.k));
  const itens = linhas.map(l => ({
    data:     data.ref_date,
    symbol:   l.symbol || _quebra.sym,
    uuid:     _quebra.uuid,
    buy_qty:  l.lado === 'C' ? l.qty : 0,
    sell_qty: l.lado === 'V' ? l.qty : 0,
    price:    l.price,
    broker:   l.broker,
    livro:    _quebra.livro || l.trader,
    obs:      `fora do tradebook · ${l.broker} @ ${_qbPx(l.price)}`,
  }));
  btn.disabled = true;
  _quebra.msg = 'Gravando…';
  _rerenderBoletasCheck();
  try {
    const res = await fetch(`${API_BASE}/api/positions/execucoes-manuais`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itens }),
    });
    const out = await res.json();
    if (!res.ok || out.error) {
      _quebra.msg = out.error || 'Falha ao gravar.';
      _rerenderBoletasCheck();
      return;
    }
    _quebra = null;            // fechou: a lista de cadastradas passa a mostrar o que foi gravado
    boletasManuaisOpen = true;
    await loadBoletas();
  } catch (e) {
    if (_quebra) { _quebra.msg = 'Erro: ' + e.message; _rerenderBoletasCheck(); }
  } finally {
    btn.disabled = false;
  }
}

function _boletasQuebraPanel(data) {
  if (!_quebra) return '';
  const q = _quebra;
  const head = `<div style="display:flex;align-items:baseline;gap:10px;margin-bottom:6px">
      <b style="font-size:12px">Divergência de ${_emEsc(q.sym)}${q.par ? ' · ' + _emEsc(q.par) : ''}</b>
      <span style="font-size:11.5px;color:var(--text-muted)">falta execução de ${
        q.dBuy > 0 ? fmtQty(q.dBuy) + ' C' : ''}${q.dBuy > 0 && q.dSell > 0 ? ' / ' : ''}${
        q.dSell > 0 ? fmtQty(q.dSell) + ' V' : ''}</span>
      <span style="margin-left:auto;cursor:pointer;color:var(--text-muted);font-size:12px"
            onclick="fecharQuebra()">✕ fechar</span>
    </div>`;

  if (!q.rows) return `<div style="margin-bottom:10px">${head}
      <div style="font-size:11.5px;color:var(--text-muted)">${_emEsc(q.msg || 'Carregando…')}</div></div>`;

  const { par, bol, exe, cad, semPreco } = _qbPorPreco(q, data);
  const todas = _qbLinhas(q.rows).map(l => {
    const k = _qbKey(l.lado, l.price);
    const noPar = par.livros.has(l.trader);
    return { ...l, noPar,
             bolPx: bol.get(k) || 0,
             exePx: exe.get(k) || 0,
             cadPx: cad.get(k) || 0,
             faltaPx: noPar ? (bol.get(k) || 0) - (exe.get(k) || 0) : 0 };
  });
  // ⭐ O recorte que a mesa pediu: só o que NÃO bate. Bloco de livro fora do par sai junto —
  // o Δ desta linha não é dele, e ticá-lo lançaria execução num balde que não é este.
  const linhas = q.todos ? todas : todas.filter(l => l.noPar && l.faltaPx > 1e-9);
  const nOcultos = todas.length - linhas.length;
  // Dos ocultos, quantos sumiram porque JÁ foram cadastrados como fora do tradebook — a mesa
  // precisa ver que eles continuam cobertos, não que a ferramenta os esqueceu.
  const nCad = todas.filter(l => !linhas.includes(l) && l.cadPx > 0).length;

  const alt = q.fillsOk
    ? `<span class="filter-chip ${q.todos ? 'on' : 'chip-act'}" style="margin-left:8px"
         title="O filtro casa boleta × fill pelo PREÇO. Boleta lançada a preço médio de vários fills não casa e apareceria aqui — este botão mostra tudo."
         onclick="toggleQuebraTodos()">${q.todos ? 'mostrando todos' : `mostrar todos (${todas.length})`}</span>`
    : `<span style="margin-left:8px;font-size:11.5px;color:var(--yellow)">⚠ sem a ponta do tradebook — listando todos os blocos</span>`;

  const notaCad = nCad
    ? ` <span title="Blocos que já têm lançamento manual neste mesmo preço — continuam cobertos; veja a lista &quot;Cadastrado como feito fora do tradebook&quot;">(${nCad} já cadastrado(s) como fora do tradebook)</span>` : '';
  const notaSP = semPreco
    ? `<div style="font-size:11.5px;color:var(--yellow);margin-bottom:6px">⚠ ${fmtQty(semPreco)}
         contrato(s) já lançado(s) <b>sem preço</b> (formulário livre) não entram no casamento por
         preço — eles já abatem o &Delta; da conferência, mas podem deixar um bloco aparecendo aqui.</div>` : '';
  const resumo = `<div style="font-size:11.5px;color:var(--text-muted);margin-bottom:6px">
      ${q.todos
        ? `Todos os blocos de boleta do ativo (${todas.length}).`
        : `<b>${linhas.length}</b> bloco(s) de boleta <b>sem execução no mesmo preço</b>${
            nOcultos ? ` — ${nOcultos} que batem ficaram de fora` : ''}${notaCad}.`}${alt}</div>${notaSP}`;

  if (!linhas.length) return `<div style="margin-bottom:10px">${head}${resumo}
      <div style="font-size:11.5px;color:var(--text-muted)">
        Todo bloco de boleta tem execução no mesmo preço${nCad ? ' (contando os já cadastrados como fora do tradebook)' : ''}
        — a diferença não está no preço. Use "mostrar todos" para olhar bloco a bloco.</div></div>`;

  let tC = 0, tV = 0;
  linhas.forEach(l => { if (q.sel.has(l.k)) { if (l.lado === 'C') tC += l.qty; else tV += l.qty; } });

  const execs = data.executores_cadastraveis || [];
  const optExec = ['<option value="">— quem operou —</option>'].concat(
    execs.map(e => `<option value="${e.uuid}"${String(q.uuid) === String(e.uuid) ? ' selected' : ''}>${
      _emEsc(e.quem)}${e.grupo ? ' · ' + _emEsc(e.grupo) : ''}</option>`)).join('');
  const livros = [...new Set(linhas.map(l => l.trader))].sort();
  const optLivro = ['<option value="">pra quem: o livro de cada bloco</option>'].concat(
    livros.map(t => `<option value="${_emEsc(t)}"${q.livro === t ? ' selected' : ''}>pra ${_emEsc(t)}</option>`)).join('');

  const corpo = linhas.map(l => {
    const on = q.sel.has(l.k);
    return `<tr style="${on ? 'background:var(--bg-row-alt)' : ''}">
      <td style="text-align:center"><input type="checkbox" ${on ? 'checked' : ''}
          onclick="toggleQuebraLinha('${_emEsc(l.k)}')" style="cursor:pointer"></td>
      <td>${l.lado}</td>
      <td>${_qbPx(l.price)}</td>
      <td class="left">${_emEsc(l.broker)}</td>
      <td class="left">${_emEsc(l.trader)}${l.noPar ? '' : ' <span style="color:var(--text-muted)" title="Livro FORA do par em cena — o Δ desta linha não é dele">·fora</span>'}${
        l.cadPx > 0 ? ` <span style="color:var(--green)" title="Já cadastrado como fora do tradebook neste preço (${fmtQty(l.cadPx)})">·cadastrado</span>` : ''}</td>
      <td>${fmtQty(l.qty)}</td>
      <td>${l.n}</td>
      <td class="sep">${l.noPar ? fmtQty(l.bolPx) : '<span style="color:var(--text-muted)">—</span>'}</td>
      <td>${l.noPar ? fmtQty(l.exePx) : '<span style="color:var(--text-muted)">—</span>'}</td>
      <td style="font-weight:700;color:${l.faltaPx > 1e-9 ? 'var(--red)' : 'inherit'}">${
        l.noPar ? fmtQty(l.faltaPx) : '—'}</td>
    </tr>`;
  }).join('');

  const falta = c => Math.abs(c) < 1e-9 ? '<span style="color:var(--green)">0</span>'
                                        : `<span style="color:var(--red)">${fmtQty(Math.abs(c))}</span>`;

  return `<div style="margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid var(--border)">
    ${head}${resumo}
    <div style="overflow-x:auto">
      <table class="jgp-tbl" style="width:auto">
        <thead><tr><th>&nbsp;</th><th>Lado</th><th>Preço</th><th class="left">Corretora</th>
          <th class="left">Livro</th><th>Qtd</th><th>Boletas</th>
          <th class="sep" title="Total boletado NESTE preço, somando os livros do par">Bol. no preço</th>
          <th title="Total executado no tradebook NESTE preço, somando os executores do par">Exec. no preço</th>
          <th title="Bol. − Exec. no mesmo preço: é o que falta de execução ali">Falta</th></tr></thead>
        <tbody>${corpo}</tbody>
      </table>
    </div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px">
      <span style="font-size:11.5px;color:var(--text-muted)">
        Ticado: <b>${fmtQty(tC)} C</b> / <b>${fmtQty(tV)} V</b> &nbsp;·&nbsp;
        falta p/ fechar o Δ: ${falta(q.dBuy - tC)} C / ${falta(q.dSell - tV)} V</span>
      <select style="padding:3px 6px;font-size:12px"
              onchange="setQuebraCampo('uuid', this.value)">${optExec}</select>
      <select style="padding:3px 6px;font-size:12px"
              onchange="setQuebraCampo('livro', this.value)">${optLivro}</select>
      <button class="btn" style="padding:3px 12px;font-size:12px"
              ${q.sel.size ? '' : 'disabled'} onclick="marcarQuebra(this)">
        Marcar ${q.sel.size || ''} bloco(s) como fora do tradebook</button>
      <span style="font-size:11.5px;color:var(--red)">${_emEsc(q.msg || '')}</span>
    </div>
  </div>`;
}

/* ── A LISTA do que está cadastrado como feito fora do tradebook ────────────────────────────
 * Bloco PRÓPRIO e sempre visível quando há lançamento na data (pedido do JLeon): o que foi
 * "cadastrado" tem de se ver sem abrir nada. Dentro do `<details>` ele ficava escondido
 * justamente para quem queria conferir o que já tinha dado por resolvido.
 * ⚠️ Vive FORA do `.section-copy-target`, como o resto dos controles — o "⎘ Copiar" da seção
 * leva a tabela da conferência, não o painel de edição. */
function _boletasCadastradasPanel(data) {
  const ms = data.manuais || [];
  if (!ms.length) return '';
  const execs = data.executores_cadastraveis || [];
  const linhas = ms.map(m => {
    const quem = (execs.find(e => e.uuid === m.uuid) || {}).quem || `UUID ${m.uuid}`;
    const lado = m.buy_qty ? 'C' : 'V';
    const qtd  = m.buy_qty || m.sell_qty;
    return `<tr>
      <td class="left">${_emEsc(m.symbol)}</td>
      <td>${lado}</td>
      <td>${fmtQty(qtd)}</td>
      <td>${m.price != null ? _qbPx(m.price) : '<span style="color:var(--text-muted)">—</span>'}</td>
      <td class="left">${_emEsc(m.broker) || '<span style="color:var(--text-muted)">—</span>'}</td>
      <td class="left">${_emEsc(m.livro) || '<span style="color:var(--text-muted)">—</span>'}</td>
      <td class="left">${_emEsc(quem)}</td>
      <td class="left" style="color:var(--text-muted)">${_emEsc(m.obs) || '—'}</td>
      <td style="text-align:center"><span style="cursor:pointer;color:var(--red)"
          title="Remover este lançamento"
          onclick="excluirExecManual('${_emEsc(m.id)}', '${_emEsc(m.symbol + ' · ' + quem)}')">✕</span></td>
    </tr>`;
  }).join('');
  return `<div style="margin-top:10px;border:1px solid var(--border);border-radius:6px;padding:8px 10px">
    <div style="font-size:12px;font-weight:600;margin-bottom:2px">
      Cadastrado como feito fora do tradebook
      <span style="font-weight:400;color:var(--text-muted)">— ${ms.length} lançamento(s) em ${fmtDate(data.ref_date)}</span>
    </div>
    <div style="font-size:11.5px;color:var(--text-muted);margin-bottom:6px">
      Já somados no lado executado da conferência (as células marcadas <b>man.</b>).
      Vale só para esta data — a conferência é do dia.
    </div>
    <div style="overflow-x:auto">
      <table class="jgp-tbl" style="width:auto">
        <thead><tr><th class="left">Ativo</th><th>Lado</th><th>Qtd</th><th>Preço</th>
          <th class="left">Corretora</th><th class="left">Livro</th><th class="left">Executor</th>
          <th class="left">Observação</th><th>&nbsp;</th></tr></thead>
        <tbody>${linhas}</tbody>
      </table>
    </div>
  </div>`;
}

/* O painel: a ferramenta de quebra (quando aberta) + um formulário livre + a lista do dia.
   Fica DENTRO do card da conferência, abaixo dos controles de pareamento — é ali que a
   divergência aparece e é ali que ela se resolve. Fechado por padrão (é ação, não leitura).
   ⚠️ O caminho NORMAL é o `＋` da linha divergente, que abre a quebra por preço × corretora;
   o formulário livre fica para o caso que a quebra não cobre (ativo que não tem boleta na
   data, ajuste de uma entrada anterior). */
function _boletasManuaisPanel(data) {
  const ms    = data.manuais || [];
  const execs = data.executores_cadastraveis || [];
  const d     = _execManualDraft;
  const opts  = ['<option value="">— quem executou —</option>'].concat(
    execs.map(e => `<option value="${e.uuid}"${String(d.uuid) === String(e.uuid) ? ' selected' : ''}>${
      _emEsc(e.quem)}${e.grupo ? ' · ' + _emEsc(e.grupo) : ''}</option>`)).join('');

  const inp = (id, campo, ph, val, w, extra) =>
    `<input id="${id}" ${extra || ''} placeholder="${ph}" value="${_emEsc(val || '')}"
            style="width:${w};padding:3px 6px;font-size:12px"
            oninput="_emDraft('${campo}', this.value)">`;

  return `<details id="execManuaisBox"${boletasManuaisOpen ? ' open' : ''}
      ontoggle="boletasManuaisOpen = this.open"
      style="margin-top:10px;border:1px solid var(--border);border-radius:6px;padding:8px 10px;background:var(--bg-row-alt)">
    <summary style="cursor:pointer;user-select:none;font-size:12px;font-weight:600">
      Execuções fora do tradebook${ms.length ? ` <span style="font-weight:400;color:var(--text-muted)">— ${ms.length} nesta data</span>` : ''}
    </summary>
    <div style="font-size:11.5px;color:var(--text-muted);margin:6px 0 8px">
      Negócio executado na <b>voz</b>, por <b>corretora</b> ou em <b>outro EMS</b> não gera fill no
      tradebook da Bloomberg — a boleta existe no JDS e a conferência acusa &Delta;. Lance aqui a
      execução que ficou de fora: ela <b>soma no lado executado</b> e o &Delta; fecha.
      As células de execução que recebem lançamento manual ficam marcadas com <b>man.</b>
    </div>
    ${_boletasQuebraPanel(data)}
    <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
      ${inp('emSym', 'sym', 'Ativo (ODF31)', d.sym, '130px')}
      <select id="emUuid" style="padding:3px 6px;font-size:12px"
              onchange="_emDraft('uuid', this.value)">${opts}</select>
      ${inp('emBuy',  'buy',  'Compra', d.buy,  '90px', 'type="number" step="any" min="0"')}
      ${inp('emSell', 'sell', 'Venda',  d.sell, '90px', 'type="number" step="any" min="0"')}
      ${inp('emObs',  'obs',  'Observação (ex.: voz — corretora X)', d.obs, '260px')}
      <button class="btn" style="padding:3px 12px;font-size:12px" onclick="salvarExecManual(this)">Adicionar</button>
      <span id="emMsg" style="font-size:11.5px"></span>
    </div>
  </details>
  ${_boletasCadastradasPanel(data)}`;
}

function renderBoletasCheck(data, sel) {
  const el = document.getElementById('boletasCheck');
  if (!el) return;
  const tb = data.tradebook;

  if (!tb || tb.error) {
    el.innerHTML = `<div class="card no-data">Fonte indisponível${tb && tb.error ? ': ' + tb.error : ''}
      — a aba segue mostrando as boletas do JDS, sem conferência.</div>`;
    return;
  }

  const livre = boletasCheckMode === 'livre';
  const pairs = _boletasPairs(data, tb, sel);
  const ctrls = _boletasCheckControls(data, tb);
  const livroPar = new Map();   // livro → nome do par que o consome
  pairs.forEach(p => p.livros.forEach(t => livroPar.set(t, p.nome)));

  const vazio = msg => { el.innerHTML = `<div class="card">
      <div class="section-title" style="padding:8px 0 10px 0">Boleta × execução em ${fmtDate(data.ref_date)}</div>
      ${ctrls}
      ${_boletasManuaisPanel(data)}
      <div class="no-data" style="margin-top:10px">${msg}</div></div>`; };

  if (!pairs.length) {
    vazio('Nenhum trader marcado tem grupo de execução mapeado no tradebook. Use o pareamento <b>Manual</b> para conferi-los mesmo assim.');
    return;
  }
  if (livre && !pairs[0].uuids.size && !pairs[0].livros.size) {
    vazio('Escolha ao menos um executor ou um livro acima.');
    return;
  }

  // Um balde por (par, ativo), com as duas pontas lado a lado.
  const K = new Map();
  const slot = (g, sym) => {
    const k = g + '|' + sym;
    let a = K.get(k);
    if (!a) { a = { g, sym, eBuy: 0, eSell: 0, bBuy: 0, bSell: 0, fills: 0, deals: 0, src: new Set(), fora: [],
                    mBuy: 0, mSell: 0, nMan: 0 }; K.set(k, a); }
    return a;
  };
  // Refs comparáveis boletados no dia, em QUALQUER livro. Serve a dois usos: decidir se
  // o spread da B3 abre balde (ver abaixo) e achar boleta FORA do par.
  const jdsSyms = new Set(data.rows.filter(r => r.comparable).map(r => r.symbol));
  const semSpread = [];   // pai de spread da B3 sem boleta de spread em livro nenhum
  for (const p of pairs) {
    for (const r of tb.rows || []) {
      if (!p.uuids.has(r.uuid)) continue;
      // ⚠️ Spread da B3 (`WDOV6X6` → `WD1V6X6`): até ago/2026 o JDS boletava a rolagem por
      // PERNA, e aí não existe boleta com o ref de spread — abrir o balde daria Δ vermelho
      // de mentira (as pernas já estão nas linhas de WDOV26/WDOX26). Só abre se o ref
      // foi boletado em algum livro; senão vai para a nota do rodapé.
      if (r.spread_b3 && !jdsSyms.has(r.symbol)) { semSpread.push(r); continue; }
      const a = slot(p.nome, r.symbol);
      a.eBuy += r.buy_qty || 0; a.eSell += r.sell_qty || 0; a.fills += r.n_fills || 0;
      // Parcela DIGITADA (execução fora do tradebook) — guardada à parte só para a tela
      // declarar; na soma ela é execução como qualquer outra, que é o ponto.
      if (r.manual) { a.mBuy += r.buy_qty || 0; a.mSell += r.sell_qty || 0; a.nMan += 1; }
      if (r.symbol_src) a.src.add(r.symbol_src);
    }
    // Lado JDS: só o que o tradebook poderia ter executado — `comparable` = futuro/opção
    // listada. No modo grupo entram os livros INTEIROS do grupo (ver o ☠️ acima); no
    // modo livre, exatamente os que a mesa marcou.
    for (const r of data.rows) {
      if (!r.comparable || !p.livros.has(r.trader)) continue;
      const a = slot(p.nome, r.symbol);
      a.bBuy += r.buy_qty || 0; a.bSell += r.sell_qty || 0; a.deals += r.n_deals || 0;
    }
  }

  const all = [...K.values()].map(a => ({ ...a, dBuy: a.bBuy - a.eBuy, dSell: a.bSell - a.eSell }));
  const nBad = all.filter(a => a.dBuy || a.dSell).length;

  // ⭐ Executado pelo par e boletado FORA dele. Quando o par executou MAIS do que os seus
  // livros boletaram (Δ negativo), o mesmo ativo pode ter caído em livro de outro trader —
  // é o caso recorrente da rolagem de WDO/DOL que o JLeon executa e cai no AJakurski.
  // Só olha o lado (compra/venda) em que falta boleta, e só livros que NÃO são do par;
  // `data.rows` tem TODOS os traders, por isso dá para achar sem round-trip.
  // ☠️ E desconta o que o DONO do livro de fora executou por conta própria: em 29/09 o
  // JLeon executou 880 ODF29 com 760 boletados no par, e o GBranquinho tinha 700 C no
  // livro dele — só que ele MESMO executou esses 700. Listar o livro pelo boletado bruto
  // apontaria o Branquinho como se tivesse boleta do JLeon. O que conta é o EXCEDENTE
  // do livro: boletado − executado pelo grupo daquele livro (mapa do tradebook.py).
  // Livro sem grupo no mapa não tem execução conhecida, então entra pelo bruto.
  const livroGrupo = new Map();
  (tb.grupos || []).forEach(g => g.livros.forEach(t => livroGrupo.set(t, g.nome)));
  const execGrupo = new Map();   // grupo|sym → {buy, sell}
  for (const r of tb.rows || []) {
    if (!r.grupo) continue;
    const k = r.grupo + '|' + r.symbol;
    const e = execGrupo.get(k) || { buy: 0, sell: 0 };
    e.buy += r.buy_qty || 0; e.sell += r.sell_qty || 0;
    execGrupo.set(k, e);
  }
  for (const a of all) {
    if (a.dBuy >= 0 && a.dSell >= 0) continue;
    const p = pairs.find(x => x.nome === a.g);
    const byTrader = new Map();
    for (const r of data.rows) {
      if (!r.comparable || r.symbol !== a.sym || p.livros.has(r.trader)) continue;
      const f = byTrader.get(r.trader) || { trader: r.trader, buy: 0, sell: 0 };
      f.buy += r.buy_qty || 0; f.sell += r.sell_qty || 0;
      byTrader.set(r.trader, f);
    }
    // Excedente por GRUPO de fora (os livros do grupo somam, como no par em cena).
    const grp = new Map();
    for (const f of byTrader.values()) {
      const gname = livroGrupo.get(f.trader) || f.trader;
      const g = grp.get(gname) || { nome: gname, livros: [], buy: 0, sell: 0 };
      g.livros.push(f.trader); g.buy += f.buy; g.sell += f.sell;
      grp.set(gname, g);
    }
    a.fora = [...grp.values()].map(g => {
      const e = execGrupo.get(g.nome + '|' + a.sym) || { buy: 0, sell: 0 };
      return { trader: g.livros.join('+'),
               buy:  a.dBuy  < 0 ? Math.max(0, g.buy  - e.buy)  : 0,
               sell: a.dSell < 0 ? Math.max(0, g.sell - e.sell) : 0 };
    }).filter(f => f.buy || f.sell)
      .sort((x, y) => (y.buy + y.sell) - (x.buy + x.sell));
  }
  const nFora = all.filter(a => a.fora.length).length;

  // Divergência primeiro; dentro de cada par, par e ativo. A tabela existe para achar
  // problema, então o que bate desce.
  all.sort((a, b) => (Number(!!(b.dBuy || b.dSell)) - Number(!!(a.dBuy || a.dSell)))
                  || a.g.localeCompare(b.g) || a.sym.localeCompare(b.sym));

  const dCell = d => d
    ? `<td style="font-weight:700;color:var(--red)">${fmtTradedQty(d)}</td>`
    : `<td style="color:var(--text-muted)">—</td>`;

  // "man." = parte desta execução foi DIGITADA (fora do tradebook). O número já está somado; a
  // marca existe para um Δ fechado por lançamento manual não se confundir com um Δ que
  // fechou sozinho — ver o painel "Execuções fora do tradebook".
  const eCell = (v, man, cls) => man
    ? `<td class="${cls || ''}" title="Inclui ${fmtQty(man)} lançado(s) à mão como execução fora do tradebook">${
        fmtQty(v)} <span style="color:var(--text-muted);font-size:10px">man.</span></td>`
    : `<td class="${cls || ''}">${fmtQty(v)}</td>`;

  // A 1ª coluna só existe quando há MAIS DE UM balde. No modo manual o balde é um só e
  // repetir "Seleção" em toda linha seria ruído; o pareamento já está dito no cabeçalho.
  const foraCell = a => a.fora.length
    ? `<td class="left" style="font-weight:700;color:var(--red);white-space:nowrap">${a.fora.map(f =>
        `${f.trader} ${f.buy ? fmtQty(f.buy) + ' C' : ''}${f.buy && f.sell ? ' / ' : ''}${f.sell ? fmtQty(f.sell) + ' V' : ''}`).join(' · ')}</td>`
    : `<td class="left" style="color:var(--text-muted)">—</td>`;
  // Δ > 0 = boletado SEM execução, que é exatamente o caso do negócio fora do tradebook:
  // o ＋ abre o painel já preenchido com o ativo, o executor do par e a quantidade que falta.
  // Δ < 0 (executado sem boleta) NÃO ganha o botão — ali o que falta é boleta, e lançar
  // execução a mais só esconderia o problema.
  const okCell = a => ((a.dBuy > 0 || a.dSell > 0)
    ? `<td style="text-align:center;white-space:nowrap">⚠ <span style="cursor:pointer"
         title="Quebrar esta divergência por preço e corretora e ticar o bloco que foi fora do tradebook"
         onclick="abrirQuebra('${a.sym}', '${String(a.g).replace(/'/g, "\'")}', ${a.dBuy}, ${a.dSell})">＋</span></td>`
    : `<td style="text-align:center">${(a.dBuy || a.dSell) ? '⚠' : '✓'}</td>`);

  const symCell = a => a.src.size
    ? `${a.sym} <span style="color:var(--text-muted);font-weight:400" title="Símbolo do pai multi-leg no tradebook; o JDS boleta o spread da B3 com o ticker de spread">← ${[...a.src].join(', ')}</span>`
    : a.sym;

  const body = all.map(a => `<tr>
      ${livre ? '' : `<td class="lbl">${a.g}</td>`}
      <td class="left">${symCell(a)}</td>
      ${eCell(a.eBuy, a.mBuy, 'sep')}
      <td>${fmtQty(a.bBuy)}</td>
      ${dCell(a.dBuy)}
      ${eCell(a.eSell, a.mSell, 'sep')}
      <td>${fmtQty(a.bSell)}</td>
      ${dCell(a.dSell)}
      ${foraCell(a)}
      ${okCell(a)}
    </tr>`).join('');

  // Rodapé: o que a conferência NÃO cobre, dito na cara em vez de sumir.
  const uuidsEmCena = new Set();
  pairs.forEach(p => p.uuids.forEach(u => uuidsEmCena.add(u)));
  const ml = (tb.multileg || []).filter(r => uuidsEmCena.has(r.uuid));
  const extras = [];

  if (livre) {
    const quem = [...pairs[0].uuids].map(u =>
      ((tb.executores || []).find(e => e.uuid === u) || {}).quem || `UUID ${u}`);
    extras.push(`<b>Pareamento manual</b>: ${quem.length ? quem.join(', ') : '<i>nenhum executor</i>'}
       <b>×</b> ${pairs[0].livros.size ? [...pairs[0].livros].join(', ') : '<i>nenhum livro</i>'}.
       Vale <b>só para esta conferência</b> — a tabela de boletas abaixo segue o filtro de traders do topo da aba.`);
    extras.push(`⚠️ Neste modo <b>não há expansão automática</b> para os livros inteiros do grupo:
       o lado JDS é exatamente o que está marcado. Uma execução costuma ser bookada em vários livros,
       então livro de fora da seleção vira &Delta; que não é erro de boleta
       (medido: o grupo do JLeon casa 40% das chaves sem o PortfolioRF e 77% com ele).`);
    const execFora = (tb.executores || []).filter(e => !pairs[0].uuids.has(e.uuid));
    if (execFora.length)
      extras.push(`Executaram no dia e estão <b>fora da seleção</b>: ${execFora.map(e => e.quem).join(', ')}.`);
    const livroFora = [...new Set(data.rows.filter(r => r.comparable && !pairs[0].livros.has(r.trader))
                                           .map(r => r.trader))];
    if (livroFora.length)
      extras.push(`Boletaram futuro/opção listada e estão <b>fora da seleção</b>: ${livroFora.join(', ')}.`);
  } else {
    extras.push(`Grupos em cena: ${pairs.map(p => `<b>${p.nome}</b> (${[...p.livros].join(', ')})`).join(' · ')}
       — o lado JDS soma os livros inteiros de cada grupo, <b>inclusive os não marcados no filtro</b>:
       uma execução é bookada em vários livros e conferir contra um só acusaria diferença falsa.
       Para outro corte, use o pareamento <b>Manual</b> acima.`);
    const semGrupo = new Set();
    for (const r of data.rows)
      if (sel.has(r.trader) && r.comparable && !livroPar.has(r.trader)) semGrupo.add(r.trader);
    if (semGrupo.size)
      extras.push(`Sem grupo de execução mapeado, portanto <b>não conferidos</b>: ${[...semGrupo].join(', ')}
         — dá para conferi-los no modo <b>Manual</b>.`);
    const fora = tb.fora || [];
    if (fora.length)
      extras.push(`Executaram no tradebook com UUID fora do mapa: ${[...new Set(fora.map(r => r.quem))].join(', ')}
         — livro fora desta base (a <code>vw_mm_prev_deals</code> é de multimercado/previdência).
         Também selecionáveis no modo <b>Manual</b>.`);
  }
  const comFora = all.filter(a => a.fora.length);
  if (comFora.length)
    extras.push(`⚠️ <b>Executado pelo par e boletado em livro FORA dele</b> — é o que a coluna
       "Boletado fora do par" aponta: ${comFora.map(a =>
         `<b>${a.sym}</b> (${a.g}: ${a.dBuy < 0 ? fmtQty(-a.dBuy) + ' C' : ''}${a.dBuy < 0 && a.dSell < 0 ? ' / ' : ''}${
           a.dSell < 0 ? fmtQty(-a.dSell) + ' V' : ''} executadas a mais do que os livros do par boletaram) → ${
           a.fora.map(f => `${f.trader} ${f.buy ? fmtQty(f.buy) + ' C' : ''}${f.buy && f.sell ? ' / ' : ''}${f.sell ? fmtQty(f.sell) + ' V' : ''}`).join(' · ')}`
       ).join('; ')}. Ou a boleta caiu no livro errado, ou o executor operou para outro trader —
       a conferência não sabe qual; quem sabe é quem executou.`);
  const comMan = all.filter(a => a.nMan);
  if (comMan.length)
    extras.push(`<b>Execuções fora do tradebook</b> (lançadas à mão nesta data) já somadas no lado
       executado: ${comMan.map(a => `<b>${a.sym}</b> (${a.g}: ${
         a.mBuy ? fmtQty(a.mBuy) + ' C' : ''}${a.mBuy && a.mSell ? ' / ' : ''}${
         a.mSell ? fmtQty(a.mSell) + ' V' : ''})`).join('; ')}. São voz/corretora/outro EMS —
       <b>não</b> saem de base nenhuma; o painel acima lista e permite remover.`);
  const ss = semSpread.filter(r => uuidsEmCena.has(r.uuid));
  if (ss.length)
    extras.push(`<b>Spread da B3</b> executado como estrutura, sem boleta de spread em livro nenhum
       nesta data: ${[...new Set(ss.map(r => `${r.symbol_src} → ${r.symbol}`))].join(', ')}.
       Se foi boletado <b>por perna</b> (como até ago/2026), as pernas já estão nas linhas dos
       vencimentos; se não foi boletado, é executado sem boleta.`);
  if (ml.length)
    extras.push(`Fora da conferência por serem <b>estruturas multi-leg de CME</b> (o pai vem com as
       pernas, e são as pernas que casam com as boletas — o pai entraria em dobro):
       ${ml.map(r => `${r.symbol} (${!livre && r.grupo ? r.grupo : r.quem})`).join(', ')}.`);

  el.innerHTML = `<div class="card">
    <div class="section-title" style="padding:8px 0 10px 0;display:flex;align-items:center;gap:16px">
      <span>Boleta × execução em ${fmtDate(data.ref_date)}
        <span style="font-weight:400;color:var(--text-muted);font-size:13px">— ${all.length} ativo(s) ·
          ${all.length - nBad} batem · <b style="color:${nBad ? 'var(--red)' : 'inherit'}">${nBad} com diferença</b>${
          nFora ? ` · <b style="color:var(--red)">${nFora} boletado fora do par</b>` : ''}${
          livre ? ` · <b>manual</b>: ${pairs[0].uuids.size} executor(es) × ${pairs[0].livros.size} livro(s)` : ''}</span>
      </span>
      <button class="btn btn-secondary" data-html2canvas-ignore="true"
              style="padding:3px 12px;font-size:12px;margin-left:auto" onclick="copyCardImage(this)">⎘ Copiar</button>
    </div>
    ${ctrls}
    ${_boletasManuaisPanel(data)}
    <div class="section-copy-target" style="max-width:100%;margin-top:10px">
      <div style="overflow-x:auto">
        <table class="jgp-tbl">
          <thead><tr>
            ${livre ? '' : '<th class="left">Grupo</th>'}
            <th class="left">Ativo</th>
            <th class="sep">Compra exec.</th>
            <th>Compra bol.</th>
            <th>&Delta;</th>
            <th class="sep">Venda exec.</th>
            <th>Venda bol.</th>
            <th>&Delta;</th>
            <th class="left sep" title="Mesmo ativo boletado em livro que NÃO é do par, quando o par executou mais do que boletou — descontado o que o dono daquele livro executou por conta própria">Boletado fora do par</th>
            <th>&nbsp;</th>
          </tr></thead>
          <tbody>${body || `<tr><td colspan="${livre ? 9 : 10}" style="color:var(--text-muted)">Nada a conferir nesta data.</td></tr>`}</tbody>
        </table>
      </div>
      <details class="jgp-tbl-note" style="margin:6px 0 0;font-size:11.5px;color:var(--text-muted);line-height:1.5">
        <summary style="cursor:pointer;user-select:none">ⓘ notas</summary>
        <b>Exec.</b> = fills do tradebook da Bloomberg (<code>jds.blp_fix_deals</code>, a fonte);
        <b>bol.</b> = boletas do JDS (<code>vw_mm_prev_deals</code>), a mesma base da tabela acima.
        <b>&Delta; = boletado &minus; executado</b>, em quantidade. Só entram futuros e opções listadas —
        ação, câmbio à vista, swap e compromissada não passam pelo tradebook.
        ⚠️ Nem toda execução passa por lá (voz, corretora, outro EMS): <b>boletado sem execução não
        é erro por si só</b>; o que costuma apontar problema é executado sem boleta. Transferência
        entre livros (contraparte <b>Gerencial</b>) já está fora das duas tabelas.
        <b>Boletado fora do par</b> = o mesmo ativo em livro que não é do par, descontado o que o
        dono daquele livro executou por conta própria.
        ${extras.map(x => '<br>' + x).join('')}
      </details>
    </div>
  </div>`;
}
