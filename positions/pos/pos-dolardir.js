/* ── Check Enquadramento · seção "Exposição direcional a dólar — look-through do offshore" ──
 *
 * Fonte: GET /api/positions/dolar-direcional (positions/dolar_direcional.py). O backend devolve
 * cada LINHA a 100% do seu veículo (Prev direto · JGP FIM IE-A · Offshore Class H), com o dono
 * (trader) e a exposição em USD; quem soma por fundo é ESTE módulo, com os pesos da cadeia:
 *
 *     peso(Prev p, linha) = 1                      se a linha é do próprio Prev p
 *                         = s_p                    se é do FIM IE      (s_p = cota de p ÷ NAV do FIM IE)
 *                         = s_p × share_H          se é do Class H     (share_H = cota do FIM IE ÷ NAV do H)
 *
 * Somar no frontend é o que faz a marreta de delta das opções de DOL (`deltaOverrides`, a mesma
 * da seção 01) valer aqui também: a linha local é recomputada por `_dolarInstExp`, como lá.
 *
 * Carregar DEPOIS de pos-dolar.js/pos-misc.js (usa _dolarInstExp, _fmtBrl, fmtPct, fmtFinalQty,
 * fmtTradedQty, PosBusy, posDataByTab, _noteFetchSig, noteBbgSource) e ANTES do boot.
 * ──────────────────────────────────────────────────────────────────────────────────────────── */

async function loadDolarDirecional(opts = {}) {
  const { fresh = false } = opts;
  const refDate   = document.getElementById('refDate').value;
  const status    = document.getElementById('refStatus');
  const container = document.getElementById('dolarDirContainer');
  if (!container) return;

  PosBusy.on('dolardir');
  try {
    const params = new URLSearchParams();
    if (refDate) params.set('ref_date', refDate);
    const forceOpening = document.getElementById('forceOpening').value;
    if (forceOpening) params.set('force_opening', forceOpening);
    if (fresh) params.set('fresh', 'true');
    const data = await (await fetch(`${API_BASE}/api/positions/dolar-direcional?${params}`)).json();
    if (data.error) {
      container.innerHTML = `<div class="card no-data">${data.error}</div>`;
      return;
    }
    posDataByTab[DOLAR_DIR_KEY] = data;
    _noteFetchSig(DOLAR_DIR_KEY);
    noteBbgSource(data);
    renderDolarDirecional(data);
  } catch (e) {
    container.innerHTML = `<div class="card no-data">Erro ao conectar: ${e.message}</div>`;
    if (status) { status.textContent = 'Erro ao conectar: ' + e.message; status.style.color = 'var(--red)'; }
  } finally {
    PosBusy.off('dolardir');
  }
}

/* ── helpers de formato (USD) ─────────────────────────────────────────────── */
const _DD_MUTED = '<span style="color:var(--text-muted)">—</span>';
function _ddUsd(v, dec = 0) {
  if (v == null || !isFinite(v)) return _DD_MUTED;
  if (Math.abs(v) < 0.5) return _DD_MUTED;
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  return v < 0 ? `<span style="color:var(--red)">(${s})</span>` : s;
}
// USD em milhões, 2 casas — a escala das linhas offshore (nocional de 35 MM não se lê em unidades).
function _ddMM(v) {
  if (v == null || !isFinite(v)) return _DD_MUTED;
  if (Math.abs(v) < 5_000) return _DD_MUTED;   // < 0,005 MM
  const s = (Math.abs(v) / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? `<span style="color:var(--red)">(${s})</span>` : s;
}
function _ddPct(v) {
  if (v == null || !isFinite(v)) return '—';
  return (v * 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%';
}
function _ddQty(v) {
  if (v == null) return _DD_MUTED;
  const a = Math.abs(v);
  const s = a >= 1e6 ? (a / 1e6).toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' MM'
          : a >= 1e4 ? (a / 1e3).toLocaleString('en-US', { maximumFractionDigits: 0 }) + ' k'
          : a.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (v < 0) return `<span style="color:var(--red)">(${s})</span>`;
  if (v === 0) return _DD_MUTED;
  return s;
}

// Rótulo de dono: `S/R` é o próprio veículo (cota/caixa), não um trader.
function _ddOwnerName(t) { return t === 'S/R' ? 'veículo' : t; }

// Coluna "Dono": final por trader (não-zero), maior |qtd| primeiro; marca o que foi operado hoje.
// Linha de MtM (kind 'cash') mostra o MtM em USD de cada dono em vez de quantidade.
function _ddDonos(line) {
  const trs = line.traders || [];
  if (line.kind === 'cash') {
    return trs.filter(t => Math.abs(t.mv_usd || 0) >= 1)
      .sort((a, b) => Math.abs(b.mv_usd) - Math.abs(a.mv_usd))
      .map(t => `${_ddOwnerName(t.trader)} ${_ddMM(t.mv_usd)}`).join('  /  ') || '—';
  }
  const parts = trs.filter(t => Math.round(t.final_qty) !== 0 || Math.round(t.traded_qty) !== 0)
    .sort((a, b) => Math.abs(b.final_qty) - Math.abs(a.final_qty))
    .map(t => {
      const d0 = Math.round(t.traded_qty) !== 0
        ? ` <span style="color:var(--text-muted)" title="operado hoje (D0)">[D0 ${_ddQty(t.traded_qty)}]</span>` : '';
      return `${_ddOwnerName(t.trader)} ${_ddQty(t.final_qty)}${d0}`;
    });
  return parts.join('  /  ') || '—';
}

/* ── exposição de UMA linha, a 100% do veículo, em USD {o,t,f} ─────────────
   Local (WDO/UC/opção DOL): recomputa em BRL com `_dolarInstExp` (marreta de delta incluída) e
   converte pelo spot. Demais: o backend já entregou usd_open/usd_trade/usd_final. */
function _ddLineUsd(line, fx) {
  if (line.kind === 'mini' || line.kind === 'cheio' || line.kind === 'option') {
    const e = _dolarInstExp(line);
    const cv = v => (v != null && fx) ? v / fx : null;
    return { o: cv(e.opening), t: cv(e.trade), f: cv(e.final), delta: e.delta };
  }
  return { o: line.usd_open, t: line.usd_trade, f: line.usd_final, delta: line.delta };
}

// Coluna da tabela por fundo em que a linha cai (por veículo × bucket).
function _ddColumn(line) {
  if (line.vehicle === 'prev')  return line.bucket === 'local' ? 'prev_local' : null;
  if (line.vehicle === 'fimie') {
    if (line.bucket === 'local')          return 'fim_local';
    if (line.bucket === 'quota_offshore' || line.bucket === 'usd_cash') return 'fim_stake';
    if (line.bucket === 'fx_usdbrl')      return 'off_usdbrl';
    if (line.bucket === 'fx_brl_cross')   return 'off_cross';
    return null;
  }
  if (line.vehicle === 'offshore') {
    if (line.bucket === 'fx_usdbrl')    return 'off_usdbrl';
    if (line.bucket === 'fx_brl_cross') return 'off_cross';
    if (line.bucket === 'brl_cash')     return 'fim_stake';   // desconta da cota do H: o NAV do H líquido do que é BRL
    return null;
  }
  return null;
}

// Coluna "Final · % NAV": a leitura de relance da seção — fundo tingido e % em destaque, colorida pelo sinal.
const _DD_FINAL_TD = 'border-left:2px solid var(--border);border-right:2px solid var(--border);background:var(--green-tint);padding:6px 14px';
function _ddFinalCell(brl, pct, big = true) {
  const color = pct == null ? 'var(--text-muted)' : pct < 0 ? 'var(--red)' : 'var(--text)';
  return `<td class="num" style="${_DD_FINAL_TD}">
    <span style="font-size:11px;opacity:.8">${_brlPlain(brl)}</span><br>
    <span style="font-size:${big ? 17 : 15}px;font-weight:700;color:${color}">${pct != null ? fmtPct(pct) : '—'}</span></td>`;
}

// Colunas da tabela por fundo, agrupadas pelo VEÍCULO em que a linha vive (cabeçalho de 2 linhas:
// veículo em cima, o que é embaixo). Tudo do FIM IE entra × s_p; tudo do Class H × s_p × share_H.
const _DD_COLS = [
  { key: 'prev_local', group: 'Prev direto', sub: 'WDO · UC · opções DOL' },
  { key: 'fim_local',  group: 'FIM IE',      sub: 'WDO · UC · opções DOL dentro' },
  { key: 'fim_stake',  group: 'FIM IE',      sub: 'cota Class H (ativo em USD)', tip: 'NAV do Class H detido pelo FIM IE, líquido do que está em BRL dentro dele (hoje um CFD sobre ação BR em BRL, ~R$ 0,1 MM). A linha aparece na tabela de linhas.' },
  { key: 'off_usdbrl', group: 'Class H',     sub: 'NDF/fwd + opções USD/BRL (Δ)' },
  { key: 'off_cross',  group: 'Class H',     sub: 'EURBRL etc. via perna BRL (Δ)' },
];
const _DD_GROUP_START = new Set(['prev_local', 'fim_local', 'off_usdbrl']);   // 1ª coluna de cada grupo

/* ── Calculadora de contratos — "X contratos são quantos % do Prev?" ──────────────────────
 * Ferramenta da seção (sem endpoint novo): o lote de contratos de dólar que a mesa vai boletar
 * ⇄ % do NAV, e a FOLGA de cada fundo contra um alvo de exposição (default 20%).
 *
 * ⭐ O lote é UM só e entra RATEADO PRO-RATA DO NAV (out/2026, pedido da mesa) — é como a boleta
 * é distribuída. Não são X contratos em cada fundo: são X no conjunto, repartidos. Por isso o
 * % do NAV sai praticamente IGUAL em todos (a diferença é só o arredondamento) — e é esse o
 * número que a mesa quer ler. O rateio usa MAIOR RESTO para a soma dos inteiros fechar em X
 * exato: `floor` em todos e o resto distribuído pelas maiores frações. Arredondar cada fundo
 * por si deixaria a boleta sobrando ou faltando contrato, sem avisar.
 *
 * ⚠️ O valor do contrato sai do MESMO preço da seção 01: `market.uca_px` (UCA Curncy, cotado em
 * BRL por MIL dólares) → cheio (UC) = 50 × px, mini (WDO) = 10 × px. Sem `uca_px` cai no spot
 * (50.000 / 10.000 × USDBRL), que é APROXIMAÇÃO (o futuro carrega cupom cambial) — por isso a
 * procedência vai escrita no rodapé do card, não implícita no número.
 *
 * ⚠️ O ALVO É EM MÓDULO, como o limite da seção 01 (`_reframeCell`): "20%" quer dizer
 * |exposição| ≤ 20%, não +20%. Os Prev vivem VENDIDOS em dólar (−20,9% em 09/10/2026) — ler o
 * alvo com sinal mandaria comprar 2.000 contratos para sair de −20,9% e chegar a +20%, que não
 * é pergunta que alguém faz. A folga é na direção em que a posição já está.
 *
 * ⚠️ A base é o dólar DIRECIONAL desta seção (cota do Class H como ativo em USD) — a coluna
 * "Final · % NAV" da tabela acima —, não a tabela de enquadramento da seção 01, que conta a cota
 * do FIM IE inteira. O contrato entra com peso 1: boletado DENTRO do Prev. Dentro do FIM IE
 * valeria × s_p, que é outra conta.
 *
 * Estado em módulo (sobrevive ao re-render da seção, como o `enqDiTarget` da seção 03) e o
 * re-render é SÓ da tabela: refazer a seção inteira a cada tecla tiraria o foco do input.
 */
const _DD_CONTRACTS = {
  cheio: { label: 'Cheio (UC)', short: 'cheio', lots: 50, usd: 50_000 },
  mini:  { label: 'Mini (WDO)', short: 'mini',  lots: 10, usd: 10_000 },
};
const _DD_TARGET_DEFAULT = 0.20;                           // limite de exposição a USDBRL dos Prev
let _ddCalc = { qty: 100, kind: 'cheio', target: _DD_TARGET_DEFAULT };   // target em FRAÇÃO
let _ddCalcCtx = null;                                     // {rows, total, uca_px, fx}

// Valor de 1 contrato em BRL + a procedência do preço, que o rodapé declara.
function _ddContractBrl(kind, ctx) {
  const c = _DD_CONTRACTS[kind];
  if (!c || !ctx) return { v: null, src: null };
  if (ctx.uca_px) return { v: c.lots * ctx.uca_px, src: 'fut' };
  if (ctx.fx)     return { v: c.usd * ctx.fx,      src: 'spot' };
  return { v: null, src: null };
}

/* Rateio pro-rata do NAV, em contratos INTEIROS, com Σ = qty exato (maior resto).
   Devolve { n: [inteiros com sinal], exact: [fracionários], navTot }. */
function _ddAllocate(qty, rows) {
  const navTot = rows.reduce((s, r) => s + (r.nav || 0), 0);
  const exact  = rows.map(r => (navTot && r.nav) ? Math.abs(qty) * r.nav / navTot : 0);
  const n      = rows.map(() => 0);
  if (!navTot || !isFinite(qty) || !qty) return { n, exact: exact.map(() => 0), navTot };

  const sign = qty < 0 ? -1 : 1;
  const tot  = Math.round(Math.abs(qty));
  const base = exact.map(v => Math.floor(v));
  let rest   = tot - base.reduce((a, b) => a + b, 0);
  // Maior resto: o que sobra vai para os fundos de maior fração — a soma fecha em `tot`.
  exact.map((v, i) => [v - Math.floor(v), i])
    .sort((a, b) => b[0] - a[0])
    .forEach(([, i]) => { if (rest > 0) { base[i]++; rest--; } });
  return { n: base.map(v => sign * v), exact: exact.map(v => sign * v), navTot };
}

function ddCalcSetQty(v) {
  const n = parseFloat(String(v).replace(',', '.'));
  _ddCalc.qty = isFinite(n) ? n : 0;
  _ddRenderCalc();
}
function ddCalcSetKind(v) { if (_DD_CONTRACTS[v]) { _ddCalc.kind = v; _ddRenderCalc(); } }
function ddCalcSetTarget(v) {
  const s = String(v).trim().replace(',', '.');
  const n = parseFloat(s);
  // Digita em % (20 = 20% do NAV, em módulo); guarda em fração. Vazio = sem coluna de folga.
  _ddCalc.target = (s === '' || !isFinite(n)) ? null : Math.abs(n) / 100;
  _ddRenderCalc();
}

/* Folga contra o alvo, em MÓDULO e na direção em que a posição já está (mesma leitura do
   `_reframeCell` da seção 01). `exp` é o direcional final em BRL; `extra` é o que o lote
   rateado soma nesta linha (a folga é medida DEPOIS do lote, que é o ponto de "ajustar"). */
function _ddSlackCell(exp, nav, val, tgt) {
  if (tgt == null) return '<td class="num" style="border-left:1px solid var(--border);color:var(--text-muted)">—</td>';
  if (exp == null || !nav || !val)
    return '<td class="num" style="border-left:1px solid var(--border);color:var(--text-muted)">—</td>';
  const slackBrl = tgt * nav - Math.abs(exp);     // >0 ainda cabe · <0 estourou
  const n = Math.abs(slackBrl) / val;
  const long = exp > 0;                            // direção atual: comprado ou vendido
  const tip = `BRL ${_brlPlain(slackBrl)} · exato ${n.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}`;
  if (slackBrl >= 0) {
    // Folga = quanto ainda cabe AUMENTAR na direção em que o fundo já está.
    const verb = exp === 0 ? 'em qualquer direção' : (long ? 'pode comprar' : 'pode vender');
    return `<td class="num" style="border-left:1px solid var(--border);color:var(--green)" title="${tip}">
      folga ${Math.floor(n).toLocaleString('pt-BR')}<br><span style="font-size:10px;color:var(--text-muted)">${verb}</span></td>`;
  }
  const verb = long ? 'vendendo' : 'comprando';    // reduzir o módulo = operar contra a posição
  return `<td class="num" style="border-left:1px solid var(--border);color:var(--red);font-weight:600" title="${tip}">
    reduzir ${Math.ceil(n).toLocaleString('pt-BR')}<br><span style="font-size:10px;font-weight:400">${verb}, p/ reenquadrar</span></td>`;
}

function _ddCalcRow(r, val, cts, tgt, isTotal) {
  const nav = r.nav, exp = r.exp;
  const lbl = isTotal ? `<b>${r.label}</b>` : r.label;
  if (!nav) return `<tr${isTotal ? ' class="area-divider"' : ''}><td>${lbl}</td>
    <td class="num" colspan="6" style="color:var(--text-muted)">sem NAV</td></tr>`;

  const pctCur = exp != null ? exp / nav : null;
  const addBrl = val != null ? cts * val : null;
  const pctAdd = addBrl != null ? addBrl / nav : null;
  const expNew = (exp != null && addBrl != null) ? exp + addBrl : null;
  const pctNew = expNew != null ? expNew / nav : null;
  // A resultante é lida contra o alvo (módulo): vermelho se o lote estoura o limite.
  const newColor = (pctNew == null || tgt == null) ? 'var(--text)'
                 : Math.abs(pctNew) > tgt ? 'var(--red)' : 'var(--green)';

  return `<tr${isTotal ? ' class="area-divider" style="font-weight:600"' : ''}>
    <td>${lbl}</td>
    <td class="num">${nav.toLocaleString('pt-BR', { maximumFractionDigits: 0 })}</td>
    <td class="num">${_fmtBrl(exp)}<br><span style="font-size:11px;color:var(--text-muted)">${pctCur != null ? fmtPct(pctCur) : '—'}</span></td>
    <td class="num" style="border-left:1px solid var(--border)">${cts != null ? cts.toLocaleString('pt-BR') : '—'}<br>
      <span style="font-size:11px;color:var(--text-muted)">${addBrl != null ? _brlPlain(addBrl) : '—'}</span></td>
    <td class="num" style="background:var(--green-tint);font-weight:700;font-size:15px">${pctAdd != null ? fmtPct(pctAdd) : '—'}</td>
    <td class="num" style="color:${newColor};font-weight:600">${pctNew != null ? fmtPct(pctNew) : '—'}</td>
    ${_ddSlackCell(expNew, nav, val, tgt)}
  </tr>`;
}

function _ddRenderCalc() {
  const host = document.getElementById('ddCalcTable');
  const ctx  = _ddCalcCtx;
  if (!host || !ctx) return;
  const { v: val, src } = _ddContractBrl(_ddCalc.kind, ctx);
  const qty  = _ddCalc.qty || 0;
  const tgt  = _ddCalc.target;
  const kind = _DD_CONTRACTS[_ddCalc.kind];

  const alloc  = _ddAllocate(qty, ctx.rows);
  const sumCts = alloc.n.reduce((a, b) => a + b, 0);
  const qtyStr = sumCts.toLocaleString('pt-BR');
  const tgtHdr = tgt != null ? `alvo ${fmtPct(tgt)}` : 'sem alvo';
  const rows = ctx.rows.map((r, i) => _ddCalcRow(r, val, alloc.n[i], tgt, false)).join('')
             + _ddCalcRow(ctx.total, val, sumCts, tgt, true);

  host.innerHTML = `<table class="data-table" style="white-space:nowrap;width:auto">
    <thead><tr>
      <th>Fundo</th>
      <th class="num">NAV (BRL)</th>
      <th class="num">Final · % NAV<br><span style="font-weight:400;font-size:10px">direcional de hoje</span></th>
      <th class="num" style="border-left:1px solid var(--border)">Rateio do lote<br><span style="font-weight:400;font-size:10px">${kind.short} · BRL</span></th>
      <th class="num">${qtyStr} ${kind.short}<br><span style="font-weight:400;font-size:10px">% NAV</span></th>
      <th class="num">Resultante<br><span style="font-weight:400;font-size:10px">% NAV</span></th>
      <th class="num" style="border-left:1px solid var(--border)">Folga · ${tgtHdr}<br><span style="font-weight:400;font-size:10px">${kind.short}, já com o lote</span></th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div style="margin-top:8px;font-size:11px;color:var(--text-muted);line-height:1.5">
    O lote é <b>um só e entra rateado pro-rata do NAV</b> (como a boleta é distribuída), em contratos inteiros,
    com a soma fechando em <b>${qtyStr}</b> exatos — por isso o % do NAV sai igual em todos os fundos, a menos do arredondamento.
    <b>+</b> compra dólar (vende BRL); lote negativo vende. 1 ${kind.short} = US$ ${(kind.usd / 1000).toLocaleString('pt-BR')} mil =
    <b>BRL ${val != null ? _brlPlain(val) : '—'}</b>${src === 'fut' ? ' (preço do futuro, UCA Curncy)' : src === 'spot' ? ' <span style="color:var(--yellow)">(sem preço do futuro — aproximado pelo spot, sem cupom cambial)</span>' : ''}.
    <b>Alvo em módulo</b> (|exposição| ≤ ${tgt != null ? fmtPct(tgt) : '—'}), como o limite da seção 01: a folga é quanto ainda cabe aumentar na direção em que o fundo já está,
    medida <b>depois</b> do lote; vermelho = estourou e o nº é o que reduzir. A folga do <b>Total</b> é medida no agregado — não é a soma dos
    arredondamentos por fundo. Base: o <b>direcional</b> desta seção (cota do Class H),
    não o % da tabela dos 20% da seção 01. O contrato entra com peso 1 — boletado <b>dentro do Prev</b>.
  </div>`;
}

// Card da calculadora. Os inputs ficam FORA de `#ddCalcTable`: só a tabela se redesenha a cada
// tecla, senão o campo perderia o foco no meio da digitação.
function _ddCalcCard() {
  const css = 'padding:4px 8px;font-size:13px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:4px';
  const opt = k => `<option value="${k}"${_ddCalc.kind === k ? ' selected' : ''}>${_DD_CONTRACTS[k].label}</option>`;
  return `<div class="card">
    <div class="section-title" style="padding:8px 0 10px 0">Calculadora — lote de dólar rateado pelo NAV ⇄ % do NAV do Prev</div>
    <div style="display:flex;gap:18px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
      <label style="font-size:13px;color:var(--text-muted)" title="lote TOTAL a boletar; é repartido entre os fundos pro-rata do NAV">Lote (contratos)
        <input type="number" step="1" value="${_ddCalc.qty}" oninput="ddCalcSetQty(this.value)" style="${css};width:90px;margin-left:6px"></label>
      <label style="font-size:13px;color:var(--text-muted)">Tipo
        <select onchange="ddCalcSetKind(this.value)" style="${css};margin-left:6px">${opt('cheio')}${opt('mini')}</select></label>
      <label style="font-size:13px;color:var(--text-muted)" title="limite de exposição a USD/BRL, em módulo, sobre o Final · % NAV desta seção. Default 20%; vazio tira a coluna de folga">Alvo
        <input type="number" step="0.5" placeholder="—" value="${_ddCalc.target != null ? Math.round(_ddCalc.target * 1000) / 10 : ''}"
          oninput="ddCalcSetTarget(this.value)" style="${css};width:80px;margin-left:6px"> % do NAV (módulo)</label>
    </div>
    <div id="ddCalcTable" style="overflow-x:auto;max-width:100%"></div>
  </div>`;
}

function renderDolarDirecional(data) {
  const container = document.getElementById('dolarDirContainer');
  if (!container) return;
  const fx = data.market?.usdbrl;
  const lines = data.lines || [];
  const veh = data.vehicles || {};
  const shareH = veh.fimie?.share_offshore ?? 0;

  // ── pré-cálculo: exposição USD de cada linha a 100% ───────────────────────
  const usdOf = new Map();
  for (const l of lines) usdOf.set(l, _ddLineUsd(l, fx));

  const weightFor = (fund, l) => {
    if (l.vehicle === 'prev')     return l.fund_label === fund.fund_label ? 1 : 0;
    const s = fund.share_fimie ?? 0;
    if (l.vehicle === 'fimie')    return s;
    if (l.vehicle === 'offshore') return s * shareH;
    return 0;
  };

  // ── 1. Tabela por fundo (BRL) ─────────────────────────────────────────────
  const zero = () => Object.fromEntries(_DD_COLS.map(c => [c.key, 0]));
  const grand = { cols: zero(), o: 0, t: 0, f: 0, nav: 0, anyNav: false };
  const calcRows = [];   // {label, nav, exp} por fundo — insumo da calculadora de contratos
  const fundRows = (data.prev_funds || []).map(fund => {
    const nav = fund.nav_brl;
    const cols = zero();
    let o = 0, t = 0, f = 0;
    for (const l of lines) {
      const w = weightFor(fund, l);
      if (!w) continue;
      const e = usdOf.get(l);
      const col = _ddColumn(l);
      if (col && e.f != null) {
        cols[col] += w * e.f * fx;
        o += w * (e.o || 0) * fx; t += w * (e.t || 0) * fx; f += w * e.f * fx;
      }
    }
    for (const c of _DD_COLS) grand.cols[c.key] += cols[c.key];
    grand.o += o; grand.t += t; grand.f += f;
    if (nav) { grand.nav += nav; grand.anyNav = true; }

    calcRows.push({ label: fund.fund_label, nav, exp: f });
    const cell = (v, lb) => `<td class="num"${lb ? ' style="border-left:1px solid var(--border)"' : ''}>${_fmtBrl(v)}<br><span style="font-size:11px;color:var(--text-muted)">${nav ? fmtPct(v / nav) : '—'}</span></td>`;
    const pctF = nav ? f / nav : null;
    return `<tr>
      <td>${fund.fund_label}</td>
      <td class="num">${nav != null ? 'BRL ' + nav.toLocaleString('pt-BR', { maximumFractionDigits: 0 }) : '<span style="color:var(--red)">—</span>'}</td>
      <td class="num" title="cota do FIM IE: BRL ${(fund.quota_fimie_mv_brl || 0).toLocaleString('pt-BR', { maximumFractionDigits: 0 })}">${fund.share_fimie != null ? _ddPct(fund.share_fimie) : '—'}</td>
      ${_DD_COLS.map(c => cell(cols[c.key], _DD_GROUP_START.has(c.key))).join('')}
      <td class="num" style="border-left:2px solid var(--border)">${_fmtBrl(o)}</td>
      <td class="num">${_fmtBrl(t)}</td>
      ${_ddFinalCell(f, pctF)}
      <td class="num">${_ddMM(fx ? f / fx : null)}</td>
    </tr>`;
  }).join('');

  const gnav = grand.anyNav ? grand.nav : null;
  const gcell = (v, lb) => `<td class="num"${lb ? ' style="border-left:1px solid var(--border)"' : ''}>${_fmtBrl(v)}<br><span style="font-size:11px;color:var(--text-muted)">${gnav ? fmtPct(v / gnav) : '—'}</span></td>`;
  const totalRow = `<tr class="area-divider" style="font-weight:600">
    <td>Total (BRL)</td>
    <td class="num">${gnav ? 'BRL ' + gnav.toLocaleString('pt-BR', { maximumFractionDigits: 0 }) : '—'}</td>
    <td class="num">${veh.fimie?.share_prev_total != null ? _ddPct(veh.fimie.share_prev_total) : '—'}</td>
    ${_DD_COLS.map(c => gcell(grand.cols[c.key], _DD_GROUP_START.has(c.key))).join('')}
    <td class="num" style="border-left:2px solid var(--border)">${_fmtBrl(grand.o)}</td>
    <td class="num">${_fmtBrl(grand.t)}</td>
    ${_ddFinalCell(grand.f, gnav ? grand.f / gnav : null, false)}
    <td class="num">${_ddMM(fx ? grand.f / fx : null)}</td>
  </tr>`;

  const spotSrc = data.market?.usdbrl_src === 'jrs' ? ' <span style="color:var(--yellow)">(dólar interno JRS — sem spot BBG)</span>' : ' (BBG)';
  const navMismatch = data.nav_date && data.opening_date && data.nav_date !== data.opening_date;
  const headInfo = `<span style="font-weight:400;color:${navMismatch ? 'var(--yellow)' : 'var(--text-muted)'};font-size:12px">
    ${navMismatch ? '⚠ ' : ''}NAV: ${fmtDate(data.nav_date)}${typeof _navSourceInline === 'function' ? _navSourceInline(data) : ''} &nbsp;·&nbsp; USDBRL ${fx ? fx.toLocaleString('pt-BR', { minimumFractionDigits: 4, maximumFractionDigits: 4 }) : '—'}${spotSrc}
    &nbsp;·&nbsp; FIM IE detém ${shareH ? _ddPct(shareH) : '—'} do Class H</span>`;

  const groups = [];
  for (const c of _DD_COLS) {
    const g = groups[groups.length - 1];
    if (g && g.name === c.group) g.n++; else groups.push({ name: c.group, n: 1 });
  }
  const groupTh = g => `<th colspan="${g.n}" class="num" style="text-align:center;border-left:1px solid var(--border)">${g.name}<br><span style="font-weight:400;font-size:10px">${g.name === 'Prev direto' ? 'a 100%' : g.name === 'FIM IE' ? '× s<sub>p</sub>' : '× s<sub>p</sub> × share<sub>H</sub>'}</span></th>`;
  const subTh = c => `<th class="num" style="text-align:center;font-weight:400;font-size:10px${_DD_GROUP_START.has(c.key) ? ';border-left:1px solid var(--border)' : ''}"${c.tip ? ` title="${c.tip}"` : ''}>${c.sub}</th>`;
  const fundTable = `
    <div class="card">
      <div class="section-title" style="padding:8px 0 10px 0;display:flex;align-items:baseline;gap:16px">
        <span>Exposição direcional a dólar por fundo (BRL) — com look-through do FIM IE e do Class H</span>${headInfo}
      </div>
      <div style="overflow-x:auto;max-width:100%"><table class="data-table" style="white-space:nowrap;width:auto">
        <thead>
          <tr>
            <th rowspan="2">Fundo</th>
            <th rowspan="2" class="num">NAV</th>
            <th rowspan="2" class="num" title="fatia do fundo no FIM IE = cota (JRS) ÷ NAV do FIM IE">Cota FIM IE<br><span style="font-weight:400;font-size:10px">s<sub>p</sub></span></th>
            ${groups.map(groupTh).join('')}
            <th colspan="4" class="num" style="text-align:center;border-left:2px solid var(--border);border-right:2px solid var(--border)">Total direcional USD/BRL<br><span style="font-weight:400;font-size:10px">final, BRL · % NAV</span></th>
          </tr>
          <tr>
            ${_DD_COLS.map(subTh).join('')}
            <th class="num" style="border-left:2px solid var(--border)">Abert.</th><th class="num">D0</th>
            <th class="num" style="border-left:2px solid var(--border);border-right:2px solid var(--border);font-size:13px">Final · % NAV</th><th class="num">USD MM</th>
          </tr>
        </thead>
        <tbody>${fundRows}${totalRow}</tbody>
      </table></div>
      <div style="margin-top:8px;font-size:11px;color:var(--text-muted);line-height:1.5">
        Sinal: <b>+</b> comprado em dólar (vendido em BRL). Difere da tabela de enquadramento acima, que conta a <b>cota do FIM IE inteira</b> como dólar
        (regra do limite de 20%): aqui o ativo em dólar é a <b>cota do Class H</b> (o FIM IE tem caixa em BRL e hedge de UC dentro), e o que está dentro dos
        veículos entra rateado pela fatia medida de cada fundo. Opção vale pelo delta (BBG, conv. M/PERC; digital de EURBRL usa o delta da BBG, nunca o do JRS).
        Par com BRL entra pela perna não-BRL em USD (EURBRL = long EUR/USD + long USD/BRL: conta a perna BRL). Par sem BRL (USD/MXN, EUR/USD, ação em EUR)
        não muda a exposição a dólar do fundo e fica fora desta seção. A marreta de delta das opções de DOL (seção acima) vale aqui.
      </div>
    </div>`;

  // ── 3. Linhas de ativo e donos ────────────────────────────────────────────
  const kindLabel = l => ({ mini: 'Mini (WDO)', cheio: 'Cheio (UC)', option: 'Opção DOL', quota: 'Cota',
    fxfwd: l.ndf ? 'NDF' : 'Fwd/spot', fxopt: l.is_digital ? 'Opção FX (digital)' : 'Opção FX', cash: 'MtM/valor' })[l.kind] || l.kind;
  const deltaCell = (l, e) => {
    if (l.kind === 'fxopt' || l.kind === 'option') {
      const d = e.delta ?? l.delta;
      if (d == null) return `<span style="color:var(--red)" title="sem delta">—</span>`;
      const src = l.delta_src === 'jrs' ? 'delta do JRS (D-1)' : l.delta_src === 'DELTA_FXOPT' ? 'BBG DELTA (M/PERC)' : 'delta';
      const dig = l.is_digital ? ' · digital: % do payout por 1% de spot — equivalente linear = nocional × delta' : '';
      return `<span title="${src}${dig}">${d.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 3 })}${l.is_digital ? '<sup>d</sup>' : ''}</span>`;
    }
    if (l.kind === 'mini' || l.kind === 'cheio') return l.px_last != null ? `<span title="preço do futuro (BBG)">${l.px_last.toLocaleString('en-US', { maximumFractionDigits: 1 })}</span>` : '—';
    if (l.kind === 'fxfwd') return l.price != null ? `<span title="taxa (JRS D-1)">${l.price.toLocaleString('en-US', { maximumFractionDigits: 4 })}</span>` : '—';
    return '';
  };
  const matTip = l => (l.maturities || []).length > 1 ? `vencimentos: ${l.maturities.map(fmtDate).join(', ')}` : (l.maturity ? `vencimento ${fmtDate(l.maturity)}` : '');
  const lineRow = (l, e, opts = {}) => {
    const nameNote = l.kind === 'fxfwd' && (l.maturities || []).length > 1 ? ` <span style="font-size:10px;color:var(--text-muted)">${l.maturities.length} venc.</span>` : '';
    const usdF = opts.usdF !== undefined ? opts.usdF : e.f;
    return `<tr>
      <td style="padding-left:18px" title="${matTip(l)}">${opts.name || l.instrument_name || l.instrument_reference}${nameNote}</td>
      <td style="font-size:11px;color:var(--text-muted)">${kindLabel(l)}</td>
      <td class="num">${l.kind === 'cash' ? _DD_MUTED : _ddQty(l.opening_qty)}</td>
      <td class="num">${l.kind === 'cash' ? _DD_MUTED : _ddQty(l.traded_qty)}</td>
      <td class="num" style="font-weight:600">${l.kind === 'cash' ? _ddMM(l.mv_usd) : _ddQty(l.final_qty)}</td>
      <td class="num">${deltaCell(l, e)}</td>
      <td class="num" style="font-weight:600">${_ddMM(usdF)}</td>
      <td class="num">${(usdF != null && fx) ? _fmtBrl(usdF * fx) : _DD_MUTED}</td>
      <td style="font-size:11px">${_ddDonos(l)}</td>
    </tr>`;
  };
  const blockHead = (title, note) => `<tr class="area-divider"><td colspan="9" style="font-weight:600;color:var(--text-muted)">${title}${note ? ` <span style="font-weight:400;font-size:11px">— ${note}</span>` : ''}</td></tr>`;
  const subtotal = (label, usd) => `<tr style="font-weight:600;background:rgba(128,128,128,0.06)">
    <td colspan="6" style="text-align:right">${label}</td><td class="num">${_ddMM(usd)}</td><td class="num">${(usd != null && fx) ? _fmtBrl(usd * fx) : _DD_MUTED}</td><td></td></tr>`;

  let body = '';
  // A) Prev direto — soma dos 7 fundos por instrumento (a quebra por fundo está na tabela 1)
  const prevAgg = new Map();
  for (const l of lines) {
    if (l.vehicle !== 'prev' || l.bucket !== 'local') continue;
    const k = l.instrument_reference || l.instrument_name;
    let a = prevAgg.get(k);
    if (!a) { a = { ...l, opening_qty: 0, traded_qty: 0, final_qty: 0, traders: [], _tr: {}, _usd: { o: 0, t: 0, f: 0, any: false } }; prevAgg.set(k, a); }
    a.opening_qty += l.opening_qty || 0; a.traded_qty += l.traded_qty || 0; a.final_qty += l.final_qty || 0;
    const e = usdOf.get(l);
    if (e.f != null) { a._usd.o += e.o || 0; a._usd.t += e.t || 0; a._usd.f += e.f; a._usd.any = true; }
    for (const t of l.traders || []) {
      const s = a._tr[t.trader] || (a._tr[t.trader] = { trader: t.trader, opening_qty: 0, traded_qty: 0, final_qty: 0, mv_usd: 0 });
      s.opening_qty += t.opening_qty || 0; s.traded_qty += t.traded_qty || 0; s.final_qty += t.final_qty || 0;
    }
  }
  let sumPrev = 0;
  body += blockHead('Fundos Prev — posição direta', 'soma dos 7 fundos; a quebra por fundo está na tabela acima');
  if (!prevAgg.size) body += `<tr><td colspan="9" class="no-data" style="color:var(--text-muted)">sem dólar local nos Prev</td></tr>`;
  for (const a of prevAgg.values()) {
    a.traders = Object.values(a._tr);
    const e = a._usd.any ? { o: a._usd.o, t: a._usd.t, f: a._usd.f, delta: usdOf.get(lines.find(l => l.vehicle === 'prev' && (l.instrument_reference || l.instrument_name) === (a.instrument_reference || a.instrument_name)))?.delta } : { f: null };
    if (e.f != null) sumPrev += e.f;
    body += lineRow(a, e);
  }
  body += subtotal('Subtotal Prev direto (100%)', sumPrev);

  // B) FIM IE
  const fimLines = lines.filter(l => l.vehicle === 'fimie');
  let sumFim = 0;
  body += blockHead(`${veh.fimie?.fund_label || 'JGP FIM IE-A'} — a 100% do veículo`, `cada Prev carrega s<sub>p</sub>; Σ s<sub>p</sub> = ${veh.fimie?.share_prev_total != null ? _ddPct(veh.fimie.share_prev_total) : '—'}`);
  if (!fimLines.length) body += `<tr><td colspan="9" class="no-data" style="color:var(--text-muted)">sem linhas</td></tr>`;
  for (const l of fimLines) {
    const e = usdOf.get(l);
    if (l.bucket === 'quota_offshore') {
      body += lineRow(l, e, { name: `${l.instrument_name} <span style="font-size:10px;color:var(--text-muted)">cota do veículo offshore = ativo em USD</span>` });
    } else body += lineRow(l, e);
    if (e.f != null && _ddColumn(l)) sumFim += e.f;
  }
  body += subtotal('Subtotal FIM IE, sem o look-through do H (100%)', sumFim);

  // C) Class H — dólar
  const offDol = lines.filter(l => l.vehicle === 'offshore' && _ddColumn(l));
  let sumOff = 0;
  body += blockHead(`${veh.offshore?.fund_label || 'Offshore Class H'} — dólar (USD/BRL e perna BRL), a 100%`, `NAV do veículo (${_ddMM(veh.offshore?.nav_usd)} MM USD) é o ativo em dólar; abaixo, o que soma/desconta dentro dele`);
  if (!offDol.length) body += `<tr><td colspan="9" class="no-data" style="color:var(--text-muted)">sem derivativo com BRL no offshore</td></tr>`;
  for (const l of offDol) { const e = usdOf.get(l); if (e.f != null) sumOff += e.f; body += lineRow(l, e); }
  body += subtotal('Subtotal derivativos/ativos com BRL dentro do H (100%)', sumOff);

  const linesTable = `
    <div class="card">
      <div class="section-title" style="padding:8px 0 10px 0">Linhas de ativo — e quem é o dono (trader). Exposição a 100% do veículo em que a linha vive.</div>
      <div style="overflow-x:auto;max-width:100%"><table class="data-table" style="white-space:nowrap;width:auto">
        <thead><tr>
          <th>Veículo / Instrumento</th><th>Tipo</th>
          <th class="num">Abert.</th><th class="num">D0</th><th class="num">Final</th>
          <th class="num">Δ / preço</th><th class="num">Exp. USD MM</th><th class="num">Exp. BRL</th><th>Dono (qtd final · [D0])</th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table></div>
      <div style="margin-top:8px;font-size:11px;color:var(--text-muted)">
        Quantidade em unidades do instrumento: contratos (WDO/UC/DOL), nocional na moeda-base (fwd/NDF/opção FX), cotas. Linha de MtM mostra o valor em USD.
        <sup>d</sup> digital: delta da BBG (M/PERC) em % do payout por 1% do spot; o equivalente linear é nocional × delta. "veículo" = linha do próprio fundo (S/R), sem trader.
      </div>
    </div>`;

  const warn = (data.warnings || []).length
    ? `<div class="card" style="border-left:3px solid var(--yellow)"><div style="font-size:12px;color:var(--text-muted);font-weight:600;margin-bottom:4px">⚠ Avisos (${data.warnings.length})</div>
       <ul style="margin:0;padding-left:18px;font-size:12px">${data.warnings.map(w => `<li>${w}</li>`).join('')}</ul></div>` : '';

  // Calculadora de contratos: mesma base da tabela por fundo (NAV + direcional final em BRL).
  _ddCalcCtx = { rows: calcRows, total: { label: 'Total Prev', nav: gnav, exp: grand.f },
                 uca_px: data.market?.uca_px || null, fx };

  container.innerHTML = fundTable + _ddCalcCard() + linesTable + warn;
  _ddRenderCalc();
}
