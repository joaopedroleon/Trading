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
 * ⚠️ Os chips saem do DADO, não de lista fixa: trader que nunca apareceu ganha
 * chip sozinho, e trader do conjunto padrão que não boletou no dia simplesmente
 * não tem chip (não há o que somar). O conjunto padrão é o da mesa
 * (BOLETAS_DEFAULT_TRADERS) e a escolha do usuário sobrevive ao ⟳ e à troca de data.
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
      <p class="csub jgp-tbl-note" style="margin:8px 0 0;font-size:11.5px;color:var(--text-muted);line-height:1.5">
        Só boletas do dia (<b>JDS</b> · <code>vw_mm_prev_deals</code>) — não é posição: não entram
        a abertura D-1 nem preço de mercado. <b>Líquido</b> = compras − vendas (negativo entre
        parênteses, na convenção do JRS: positivo = comprado/tomado); <b>Bruto</b> = soma dos
        módulos, então giro que não muda posição aparece aqui. Os preços médios são ponderados
        por quantidade e vêm na unidade de cotação de cada ativo (taxa no DI, pontos no dólar).
        <b>Não há total geral</b>: as unidades não somam entre ativos.
      </p>
    </div>
  </div>`;

  renderBoletasCheck(data, sel);
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
    if (!a) { a = { g, sym, eBuy: 0, eSell: 0, bBuy: 0, bSell: 0, fills: 0, deals: 0 }; K.set(k, a); }
    return a;
  };
  for (const p of pairs) {
    for (const r of tb.rows || []) {
      if (!p.uuids.has(r.uuid)) continue;
      const a = slot(p.nome, r.symbol);
      a.eBuy += r.buy_qty || 0; a.eSell += r.sell_qty || 0; a.fills += r.n_fills || 0;
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

  // Divergência primeiro; dentro de cada par, par e ativo. A tabela existe para achar
  // problema, então o que bate desce.
  all.sort((a, b) => (Number(!!(b.dBuy || b.dSell)) - Number(!!(a.dBuy || a.dSell)))
                  || a.g.localeCompare(b.g) || a.sym.localeCompare(b.sym));

  const dCell = d => d
    ? `<td style="font-weight:700;color:var(--red)">${fmtTradedQty(d)}</td>`
    : `<td style="color:var(--text-muted)">—</td>`;

  // A 1ª coluna só existe quando há MAIS DE UM balde. No modo manual o balde é um só e
  // repetir "Seleção" em toda linha seria ruído; o pareamento já está dito no cabeçalho.
  const body = all.map(a => `<tr>
      ${livre ? '' : `<td class="lbl">${a.g}</td>`}
      <td class="left">${a.sym}</td>
      <td class="sep">${fmtQty(a.eBuy)}</td>
      <td>${fmtQty(a.bBuy)}</td>
      ${dCell(a.dBuy)}
      <td class="sep">${fmtQty(a.eSell)}</td>
      <td>${fmtQty(a.bSell)}</td>
      ${dCell(a.dSell)}
      <td style="text-align:center">${(a.dBuy || a.dSell) ? '⚠' : '✓'}</td>
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
  if (ml.length)
    extras.push(`Fora da conferência por serem <b>estruturas multi-leg</b> (um símbolo na fonte, duas
       boletas no JDS — a rolagem casada de WDO é o caso comum):
       ${ml.map(r => `${r.symbol} (${!livre && r.grupo ? r.grupo : r.quem})`).join(', ')}.`);

  el.innerHTML = `<div class="card">
    <div class="section-title" style="padding:8px 0 10px 0;display:flex;align-items:center;gap:16px">
      <span>Boleta × execução em ${fmtDate(data.ref_date)}
        <span style="font-weight:400;color:var(--text-muted);font-size:13px">— ${all.length} ativo(s) ·
          ${all.length - nBad} batem · <b style="color:${nBad ? 'var(--red)' : 'inherit'}">${nBad} com diferença</b>${
          livre ? ` · <b>manual</b>: ${pairs[0].uuids.size} executor(es) × ${pairs[0].livros.size} livro(s)` : ''}</span>
      </span>
      <button class="btn btn-secondary" data-html2canvas-ignore="true"
              style="padding:3px 12px;font-size:12px;margin-left:auto" onclick="copyCardImage(this)">⎘ Copiar</button>
    </div>
    ${ctrls}
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
            <th>&nbsp;</th>
          </tr></thead>
          <tbody>${body || `<tr><td colspan="${livre ? 8 : 9}" style="color:var(--text-muted)">Nada a conferir nesta data.</td></tr>`}</tbody>
        </table>
      </div>
      <p class="csub jgp-tbl-note" style="margin:8px 0 0;font-size:11.5px;color:var(--text-muted);line-height:1.5">
        <b>Exec.</b> = fills do tradebook da Bloomberg (<code>jds.blp_fix_deals</code>, a fonte);
        <b>bol.</b> = boletas do JDS (<code>vw_mm_prev_deals</code>), a mesma base da tabela acima.
        <b>&Delta; = boletado &minus; executado</b>, em quantidade. Só entram futuros e opções listadas —
        ação, câmbio à vista, swap e compromissada não passam pelo tradebook.
        ⚠️ Nem toda execução passa por lá (voz, corretora, outro EMS) e transferência entre livros não
        tem execução nenhuma: <b>boletado sem execução não é erro por si só</b>; o que costuma apontar
        problema é executado sem boleta.
        ${extras.map(x => '<br>' + x).join('')}
      </p>
    </div>
  </div>`;
}
