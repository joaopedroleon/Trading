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
 * ──────────────────────────────────────────────────────────────────────────── */

const BOLETAS_TAB_ID = 'boletas';

// Filtro padrão (mesa, set/2026). Quem não boletou no dia não vira chip.
const BOLETAS_DEFAULT_TRADERS = ['EMota', 'PAlves', 'ECotrim', 'PortfolioRF', 'PortfolioPrev'];

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
  // e a mesa lê sempre as mesmas 5 primeiras posições.
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
}
