const DOLAR_CONSOL_TAB_ID = 'dolarconsol';
const UC_FACE_USD = 50_000;   // face do contrato de dólar cheio (UC)
const DOLAR_CONSOL_TRADERS = ['EMota', 'ECotrim', 'PortfolioRF', 'PAlves', 'GBranquinho', 'LAguiar', 'PAbinader'];
const dolarConsolData = {};   // trader → API response (cache próprio, não conflita com posDataByTab)
let dolarConsolTrader = 'ECotrim';
/* nº de contratos equivalentes (1 casa, verde +, vermelho entre parênteses) */
function fmtUc(v) {
  if (v == null || !isFinite(v)) return '<span style="color:var(--text-muted)">—</span>';
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  if (v > 0) return `<span style="color:var(--green)">+${s}</span>`;
  if (v < 0) return `<span style="color:var(--red)">(${s})</span>`;
  return '<span style="color:var(--text-muted)">—</span>';
}

// Classifica a row como instrumento de dólar; null se não é.
function _dollarKind(r) {
  const ref = (r.instrument_reference || '').toUpperCase();
  const isCurncy = ref.endsWith('CURNCY');
  if (isCurncy && ref.startsWith('UC'))  return 'uc';    // dólar cheio (futuro)
  if (isCurncy && ref.startsWith('WDO')) return 'wdo';   // mini dólar (futuro)
  if (r.is_option && r.option_subtype === 'dol') return 'dolopt';
  if (r.is_option && r.option_subtype === 'fx' && (r.option_undl || '').toUpperCase().includes('BRL')) return 'fxopt';
  if (r.is_fx) {
    const nm = (r.instrument_name || '').toUpperCase().replace(/\s/g, '');
    if (nm.includes('USD') && nm.includes('BRL')) return 'fxfwd';
  }
  return null;
}

const _DOLLAR_KIND_LABEL = {
  uc: 'Futuro cheio (UC)', wdo: 'Futuro mini (WDO)',
  dolopt: 'Opção DOL', fxopt: 'Opção USDBRL', fxfwd: 'Spot/Fwd USD/BRL',
};

function showDolarConsolTab() {
  activeTraderTab = DOLAR_CONSOL_TAB_ID;
  for (const tab of TRADER_TABS) {
    const el = document.getElementById(`tab-${tab.id}`);
    if (el) el.style.display = 'none';
    document.getElementById(`tab-btn-${tab.id}`)?.classList.remove('active');
  }
  const dolarEl = document.getElementById('tab-dolar');
  if (dolarEl) dolarEl.style.display = 'none';
  document.getElementById('tab-btn-dolar')?.classList.remove('active');
  const consolEl = document.getElementById('tab-dolarconsol');
  if (consolEl) consolEl.style.display = '';
  document.getElementById('tab-btn-dolarconsol')?.classList.add('active');
  _hideRolagemTab();

  // popula o seletor de trader uma vez
  const sel = document.getElementById('dolarConsolTraderSelect');
  if (sel && !sel.options.length) {
    sel.innerHTML = DOLAR_CONSOL_TRADERS.map(t => `<option value="${t}">${t}</option>`).join('');
    sel.value = dolarConsolTrader;
  }
  if (dolarConsolData[dolarConsolTrader]) { _dirtyTabs.delete(DOLAR_CONSOL_TAB_ID); renderDolarConsol(dolarConsolTrader); }
  else loadDolarConsol(dolarConsolTrader);
}

function selectDolarConsolTrader(trader) {
  dolarConsolTrader = trader;
  if (dolarConsolData[trader]) renderDolarConsol(trader);
  else loadDolarConsol(trader);
}

async function loadDolarConsol(trader, opts = {}) {
  const { fresh = false } = opts;
  const refDate   = document.getElementById('refDate').value;
  const status    = document.getElementById('refStatus');
  const btn       = document.getElementById('btnLoad');
  const container = document.getElementById('dolarConsolContainer');
  status.textContent = 'Buscando dados...';
  status.style.color = 'var(--text-muted)';
  btn.disabled = true;
  container.innerHTML = '<div class="card"><span class="loading">Carregando...</span></div>';
  try {
    const params = new URLSearchParams({ trader });
    if (refDate) params.set('ref_date', refDate);
    const forceOpening = document.getElementById('forceOpening').value;
    if (forceOpening) params.set('force_opening', forceOpening);
    if (fresh) params.set('fresh', 'true');
    // Só EMota/ECotrim usam grupos MM/MM Prev; demais traders trazem tudo ('Todos').
    if (trader !== 'EMota' && trader !== 'ECotrim') params.set('use_groups', 'false');
    const data = await (await fetch(`${API_BASE}/api/positions/reference?${params}`)).json();
    if (data.error) {
      status.textContent = 'Erro: ' + data.error;
      status.style.color = 'var(--red)';
      container.innerHTML = `<div class="card no-data">${data.error}</div>`;
      return;
    }
    dolarConsolData[trader] = data;
    status.textContent = '';
    document.getElementById('srcLabel').textContent =
      `Abertura: ${fmtDate(data.opening_date)}  |  Boletas: ${fmtDate(data.ref_date)}`;
    // carrega o mapa de tickers cadastrados (compartilhado com a aba Check Dólar Exposure)
    try { dolarOptTickers = await (await fetch(`${API_BASE}/api/positions/dolar-opt-tickers`)).json() || {}; }
    catch { /* mantém o que tiver */ }
    if (dolarConsolTrader === trader) {
      // delta/preço live já vêm do backend (option_delta/price_live, inclusive DOL via ticker)
      renderDolarConsol(trader);
    }
  } catch (e) {
    status.textContent = 'Erro ao conectar: ' + e.message;
    status.style.color = 'var(--red)';
  } finally {
    btn.disabled = false;
  }
}

function renderDolarConsol(trader) {
  const container = document.getElementById('dolarConsolContainer');
  if (!container) return;
  const data = dolarConsolData[trader];
  const navTrader = data?.traders?.[trader];

  // MM apenas; exclui Hedge_Cambial (igual ao filtro padrão da aba de posições); só dólar
  const rows = (data?.rows ?? [])
    .filter(r => r.group !== 'MM Prev' && r.subarea !== 'Hedge_Cambial')
    .map(r => ({ r, kind: _dollarKind(r) }))
    .filter(x => x.kind);

  if (!rows.length) {
    container.innerHTML = `<div class="card no-data">Nenhuma posição de dólar (UC/WDO, opção DOL/USDBRL, USD/BRL) para ${trader} no book MM.</div>`;
    return;
  }

  // métrica por linha (respeita delta manual e delta/preço live via ticker BBG p/ DOL)
  const metric = ({ r, kind }) => {
    const ref   = r.instrument_reference || '';
    const nav   = r.nav ?? navTrader;
    const isOpt = !!r.is_option;
    // delta efetivo: override manual → live BBG (ticker) → backend.
    // Normaliza pelo TIPO (CALL = +|δ|, PUT = −|δ|): o sinal cru da BBG reflete a
    // direção da posição cadastrada, e a direção já vem da qtd → evita inverter 2×.
    const ik = instKey(r);
    // delta: marreta → backend (live p/ DOL via ticker) → normalizado CALL/PUT (helper único)
    const delta = isOpt ? effectiveDelta(r) : 1;
    // preço efetivo (mesma fonte única das outras abas); sempre positivo.
    let price = effectivePrice(r);
    if (price != null) price = Math.abs(price);
    // exposição NOMINAL em USD (delta-independente)
    let nominalUsd;
    if (kind === 'dolopt')     nominalUsd = (r.final_qty != null) ? r.final_qty * UC_FACE_USD : null;          // face US$50k/contrato
    else if (kind === 'fxopt') nominalUsd = (r.option_nominal_exp != null && nav) ? r.option_nominal_exp * nav : null;
    else                       nominalUsd = (r.pl != null && nav) ? r.pl * nav : null;                          // futuros/FX (delta=1)
    const expUsd = isOpt ? (nominalUsd != null && delta != null ? nominalUsd * delta : null) : nominalUsd;
    const expPct = (expUsd != null && nav) ? expUsd / nav : null;
    // UC-equivalente: futuros por contagem de contrato (razão fixa); opção DOL = qtd×delta;
    // USDBRL/spot = nocional ÷ face.
    let ucEq;
    if (kind === 'uc')          ucEq = r.final_qty != null ? r.final_qty : null;          // dólar cheio 1:1
    else if (kind === 'wdo')    ucEq = r.final_qty != null ? r.final_qty / 5 : null;      // mini ÷ 5
    else if (kind === 'dolopt') ucEq = (r.final_qty != null && delta != null) ? r.final_qty * delta : null;
    else                        ucEq = expUsd != null ? expUsd / UC_FACE_USD : null;       // fxopt, fxfwd
    const premium = (isOpt && r.final_qty != null && price != null && r.calc_factor != null)
                    ? r.final_qty * price * r.calc_factor : null;
    return { ref, ik, nav, isOpt, kind, delta, price, expUsd, expPct, ucEq, premium };
  };

  const optRows = rows.filter(x => x.kind === 'dolopt' || x.kind === 'fxopt');
  const futRows = rows.filter(x => x.kind === 'uc' || x.kind === 'wdo' || x.kind === 'fxfwd');

  // cabeçalho em UMA linha (azul escuro); % NAV + UC-equiv delimitados pelas bordas do bloco
  const head = `<thead><tr>
    <th class="col-final">Instrumento</th>
    <th>Tipo</th>
    <th>Vencto</th>
    <th class="col-right num">Qtd Final</th>
    <th class="num">Delta</th>
    <th>Ticker BBG (DOL)</th>
    <th class="num">Preço Live</th>
    <th class="col-pnl num">Prêmio USD</th>
    <th class="num">% NAV</th>
    <th class="num">UC-equiv</th>
  </tr></thead>`;

  let gPrem = 0, gUsd = 0, gPct = 0, gUc = 0;

  const deltaCell = (m) => {
    if (!m.isOpt) return `<td class="num" style="color:var(--text-muted)">1.00</td>`;
    const ek = m.ik.replace(/'/g, "\\'");
    const hasOv = deltaOverrides.has(m.ik);
    const bord = hasOv ? 'var(--green)' : 'var(--border)';
    const val = m.delta != null ? Number(m.delta.toFixed(4)) : '';
    return `<td class="num"><input type="number" step="0.01" value="${val}"
      style="width:64px;text-align:right;background:var(--bg);color:var(--text);border:1px solid ${bord};border-radius:4px;padding:2px 4px"
      onchange="consolSetDelta('${ek}', this.value)"></td>`;
  };
  const tickerCell = (r, kind) => {
    if (kind !== 'dolopt') return `<td style="color:var(--text-muted)">—</td>`;
    const ek = (r.instrument_reference || '').replace(/'/g, "\\'");
    const tk = (dolarOptTickers[r.instrument_reference] || '').replace(/"/g, '&quot;');
    return `<td><input type="text" value="${tk}" placeholder="ticker BBG"
      style="width:150px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:2px 6px"
      onchange="consolSetTicker('${ek}', this.value)"></td>`;
  };

  const renderBlock = (title, blockRows) => {
    if (!blockRows.length) return '';
    let sUsd = 0, sPct = 0, sUc = 0, sPrem = 0;
    const trs = sortRows(blockRows.map(x => x.r)).map(r => {
      const x = blockRows.find(b => b.r === r);
      const m = metric(x);
      if (m.expUsd != null) { sUsd += m.expUsd; gUsd += m.expUsd; }
      if (m.expPct != null) { sPct += m.expPct; gPct += m.expPct; }
      if (m.ucEq   != null) { sUc  += m.ucEq;   gUc  += m.ucEq; }
      if (m.premium!= null) { sPrem+= m.premium; gPrem+= m.premium; }
      const priceFmt = (m.kind === 'fxopt') ? fmtPricePct(m.price) : fmtPrice(m.price);
      return `<tr>
        <td class="col-final">${r.instrument_name ?? '—'}</td>
        <td style="color:var(--text-muted);font-size:11px">${_DOLLAR_KIND_LABEL[x.kind]}</td>
        <td>${fmtDate(r.maturity)}</td>
        <td class="col-right num">${fmtFinalQty(r.final_qty)}</td>
        ${deltaCell(m)}
        ${tickerCell(r, x.kind)}
        <td class="num">${priceFmt}</td>
        <td class="col-pnl num">${fmtMoney(m.premium)}</td>
        <td class="num">${fmtPL(m.expPct, 'pct')}</td>
        <td class="num dc-uc">${fmtUc(m.ucEq)}</td>
      </tr>`;
    }).join('');
    const sub = `<tr class="dc-sub">
      <td colspan="7">Subtotal · ${title}</td>
      <td class="col-pnl num">${fmtMoney(sPrem)}</td>
      <td class="num">${fmtPL(sPct, 'pct')}</td>
      <td class="num dc-uc">${fmtUc(sUc)}</td>
    </tr>`;
    const header = `<tr class="dc-block"><td colspan="10">${title}</td></tr>`;
    return header + trs + sub;
  };

  // linha espaçadora transparente (respiro entre blocos e antes do total, sem desenhar linha)
  const spacer = `<tr><td colspan="10" style="height:14px;padding:0;border:none;background:transparent"></td></tr>`;
  const body = [
    renderBlock('Opções (DOL / USDBRL)', optRows),
    renderBlock('Futuros e Spot (UC / WDO / USD/BRL)', futRows),
  ].filter(Boolean).join(spacer);

  const grand = `<tr class="dc-total">
    <td colspan="7">TOTAL DÓLAR — ${trader}</td>
    <td class="col-pnl num">${fmtMoney(gPrem)}</td>
    <td class="num">${fmtPL(gPct, 'pct')}</td>
    <td class="num dc-uc">${fmtUc(gUc)}</td>
  </tr>`;

  const navStr = navTrader ? `NAV: USD ${navTrader.toLocaleString('en-US',{maximumFractionDigits:0})}` : '';
  const netLabel = gUc >= 0 ? 'comprado' : 'vendido';
  const netColor = gUc >= 0 ? 'var(--green)' : 'var(--red)';
  container.innerHTML = `<div class="card">
    <div class="section-title" style="padding:8px 0 10px 0;display:flex;align-items:center;gap:16px;flex-wrap:wrap">
      <span>Consolidado Dólar <span style="font-weight:400;color:var(--text-muted);font-size:13px">— ${trader} (MM)</span></span>
      ${navStr ? `<span style="font-weight:400;color:var(--text-muted);font-size:12px">${navStr}</span>` : ''}
      <button class="btn btn-secondary" data-html2canvas-ignore="true" style="padding:3px 12px;font-size:12px;margin-left:auto" onclick="copyCardImage(this)">⎘ Copiar</button>
    </div>
    <div style="font-size:14px;margin-bottom:10px;padding:8px 12px;background:var(--bg-row-alt);border-left:3px solid var(--border);border-radius:4px">
      Posição líquida em dólar: <b style="color:${netColor};font-size:16px">${fmtUc(gUc)}</b> contratos equiv. de dólar cheio (UC) — <b>${netLabel}</b>
      <span style="color:var(--text-muted);font-size:11px">(face US$ ${UC_FACE_USD.toLocaleString('en-US')} · exposição ${fmtMoney(gUsd)})</span>
    </div>
    <div class="section-copy-target">
      <table class="data-table dc-table" style="white-space:nowrap;width:auto">
        ${head}
        <tbody>${body}${spacer}${grand}</tbody>
      </table>
    </div>
  </div>`;

  renderOptionsAnalysis();   // segunda tabela (todas as opções MM) logo abaixo, mesmos dados
}

/* edição manual de delta (marreta global por instrumento) */
function consolSetDelta(ik, value) {
  const v = parseFloat(value);
  if (value === '' || isNaN(v)) deltaOverrides.delete(ik);
  else deltaOverrides.set(ik, v);
  _markTabsDirtyAndRerender();
}

/* salva o ticker BBG da opção de DOL (cache compartilhado); não re-renderiza p/ não perder o foco */
async function consolSetTicker(ref, ticker) {
  ticker = (ticker || '').trim();
  if (ticker) dolarOptTickers[ref] = ticker;
  else delete dolarOptTickers[ref];
  const status = document.getElementById('refStatus');
  try {
    await fetch(`${API_BASE}/api/positions/dolar-opt-tickers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [ref]: ticker }),
    });
    if (status) { status.textContent = 'Ticker salvo'; status.style.color = 'var(--text-muted)'; }
  } catch (e) {
    if (status) { status.textContent = 'Erro ao salvar ticker: ' + e.message; status.style.color = 'var(--red)'; }
  }
}

async function loadDolarExposure() {
  const refDate   = document.getElementById('refDate').value;
  const status    = document.getElementById('refStatus');
  const srcLabel  = document.getElementById('srcLabel');
  const btn       = document.getElementById('btnLoad');
  const container = document.getElementById('dolarContainer');

  status.textContent = 'Buscando dados...';
  status.style.color = 'var(--text-muted)';
  btn.disabled = true;
  container.innerHTML = '<div class="card"><span class="loading">Carregando...</span></div>';

  try {
    const params = new URLSearchParams();
    if (refDate) params.set('ref_date', refDate);
    const forceOpening = document.getElementById('forceOpening').value;
    if (forceOpening) params.set('force_opening', forceOpening);
    const data = await (await fetch(`${API_BASE}/api/positions/dolar-exposure?${params}`)).json();

    if (data.error) {
      status.textContent = 'Erro: ' + data.error;
      status.style.color = 'var(--red)';
      container.innerHTML = `<div class="card no-data">${data.error}</div>`;
      return;
    }

    posDataByTab[DOLAR_TAB_ID] = data;
    noteBbgSource(data);   // estado global (BBG viva/cache)
    status.textContent = '';
    srcLabel.textContent =
      `Abertura: ${fmtDate(data.opening_date)}  |  Boletas: ${fmtDate(data.ref_date)}`;
    try { dolarOptTickers = await (await fetch(`${API_BASE}/api/positions/dolar-opt-tickers`)).json() || {}; }
    catch { dolarOptTickers = {}; }
    // delta live das opções de DOL já vem do backend (option via ticker cadastrado)
    renderDolarTable(data);
  } catch (e) {
    status.textContent = 'Erro ao conectar: ' + e.message;
    status.style.color = 'var(--red)';
  } finally {
    btn.disabled = false;
  }
}

function renderDolarTable(data) {
  const container = document.getElementById('dolarContainer');
  if (!container) return;

  const navDateStr = data.nav_date ? fmtDate(data.nav_date) : '—';
  const usdbrlStr  = data.usdbrl != null
    ? data.usdbrl.toLocaleString('pt-BR', { minimumFractionDigits: 4, maximumFractionDigits: 4 }) : '—';
  const navMismatch = data.nav_date && data.opening_date && data.nav_date !== data.opening_date;
  const navInfo = `<span style="font-weight:400;color:${navMismatch ? 'var(--yellow)' : 'var(--text-muted)'};font-size:12px">
    ${navMismatch ? '⚠ ' : ''}NAV: ${navDateStr} &nbsp;·&nbsp; USDBRL (interno): ${usdbrlStr}</span>`;

  // Valor BRL de 1 contrato (mini=10, cheio=50) × preço do dólar (UCA PX_LAST)
  const miniVal = data.uca_px ? 10 * data.uca_px : null;
  const fullVal = data.uca_px ? 50 * data.uca_px : null;

  // ── Tabela única: 1 linha por fundo ──────────────────────────────────────
  // *.e = exposição BRL; *.q = qtd de contratos (para tooltip)
  const gz = () => ({ eo:0, et:0, ef:0, qo:0, qt:0, qf:0 });
  const grandTotal = { mini: gz(), cheio: gz(), option: gz(), fimie: 0, to:0, tt:0, tf:0, nav:0 };

  // NET (default): operações somam com sinal e netam contra o FIM IE.
  // GROSS (Sulamerica): |operações líquidas| + |FIM IE| — nunca netam.
  const _effExp = (opsNet, fimie, isSula) =>
    isSula ? Math.abs(opsNet) + Math.abs(fimie || 0) : opsNet + (fimie || 0);

  const bodyRows = data.funds.map(fund => {
    const nav = fund.nav;
    const isSula = /sulamerica/i.test(fund.fund_label);
    const sums = {};
    for (const c of _DOLAR_CATS) sums[c.key] = gz();
    for (const inst of fund.instruments) {
      const e = _dolarInstExp(inst);
      const s = sums[inst.category]; if (!s) continue;
      s.eo += e.opening || 0; s.et += e.trade || 0; s.ef += e.final || 0;
      s.qo += inst.opening_qty || 0; s.qt += inst.traded_qty || 0; s.qf += inst.final_qty || 0;
    }
    const fimie = fund.fim_ie_exp;

    // operações líquidas (mini+cheio+opções), com sinal
    const opsO = sums.mini.eo + sums.cheio.eo + sums.option.eo;
    const opsT = sums.mini.et + sums.cheio.et + sums.option.et;
    const opsF = sums.mini.ef + sums.cheio.ef + sums.option.ef;
    // FIM IE é posição estática: entra na abertura e na final, não nos trades
    const totO = _effExp(opsO, fimie, isSula);
    const totT = isSula ? Math.abs(opsT) : opsT;
    const totF = _effExp(opsF, fimie, isSula);

    for (const k of ['mini','cheio','option']) {
      grandTotal[k].eo += sums[k].eo; grandTotal[k].et += sums[k].et; grandTotal[k].ef += sums[k].ef;
      grandTotal[k].qo += sums[k].qo; grandTotal[k].qt += sums[k].qt; grandTotal[k].qf += sums[k].qf;
    }
    grandTotal.fimie += fimie || 0;
    grandTotal.to += totO; grandTotal.tt += totT; grandTotal.tf += totF;
    grandTotal.nav += nav || 0;

    const navStr = nav != null
      ? `BRL ${nav.toLocaleString('pt-BR', { maximumFractionDigits: 0 })}`
      : '<span style="color:var(--red)">—</span>';
    const regimeTag = `<span style="font-size:10px;color:var(--text-muted)">${isSula ? 'GROSS' : 'NET'}</span>`;

    const fimieCell = `<td class="num" style="border-left:1px solid var(--border)" title="Rateio proporcional do FIM IE">${_fmtBrl(fimie)}<br><span style="font-size:11px;color:var(--text-muted)">${(fimie != null && nav) ? fmtPct(fimie / nav) : '—'}</span></td>`;

    return `<tr>
      <td>${fund.fund_label} ${regimeTag}</td>
      <td class="num">${navStr}</td>
      ${_expCell(sums.mini.eo, nav, sums.mini.qo, true)}${_expCell(sums.mini.et, nav, sums.mini.qt)}${_expCell(sums.mini.ef, nav, sums.mini.qf)}
      ${_expCell(sums.cheio.eo, nav, sums.cheio.qo, true)}${_expCell(sums.cheio.et, nav, sums.cheio.qt)}${_expCell(sums.cheio.ef, nav, sums.cheio.qf)}
      ${_expCell(sums.option.eo, nav, sums.option.qo, true)}${_expCell(sums.option.et, nav, sums.option.qt)}${_expCell(sums.option.ef, nav, sums.option.qf)}
      ${fimieCell}
      ${_expCell(totO, nav, null, true)}${_expCell(totT, nav, null)}${_totalFinalCell(totF, nav ? totF / nav : null)}
      ${_reframeCell(totF, opsF, nav, isSula, miniVal, fullVal)}
    </tr>`;
  }).join('');

  const gnav = grandTotal.nav || null;
  const totalRow = `<tr class="area-divider" style="font-weight:600">
    <td>Total (BRL)</td>
    <td class="num">${gnav ? 'BRL ' + gnav.toLocaleString('pt-BR', { maximumFractionDigits: 0 }) : '—'}</td>
    ${_expCell(grandTotal.mini.eo, gnav, grandTotal.mini.qo, true)}${_expCell(grandTotal.mini.et, gnav, grandTotal.mini.qt)}${_expCell(grandTotal.mini.ef, gnav, grandTotal.mini.qf)}
    ${_expCell(grandTotal.cheio.eo, gnav, grandTotal.cheio.qo, true)}${_expCell(grandTotal.cheio.et, gnav, grandTotal.cheio.qt)}${_expCell(grandTotal.cheio.ef, gnav, grandTotal.cheio.qf)}
    ${_expCell(grandTotal.option.eo, gnav, grandTotal.option.qo, true)}${_expCell(grandTotal.option.et, gnav, grandTotal.option.qt)}${_expCell(grandTotal.option.ef, gnav, grandTotal.option.qf)}
    ${_expCell(grandTotal.fimie, gnav, null, true)}
    ${_expCell(grandTotal.to, gnav, null, true)}${_expCell(grandTotal.tt, gnav, null)}<td class="num" style="border-left:2px solid var(--border);border-right:2px solid var(--border)">${_brlPlain(grandTotal.tf)}<br><span style="font-size:12px">${gnav ? fmtPct(grandTotal.tf / gnav) : '—'}</span></td>
    <td class="num" style="${_SEP_TD};color:var(--text-muted)">—</td>
  </tr>`;

  const grp = lbl => `<th colspan="3" class="num" style="border-left:1px solid var(--border);text-align:center">${lbl}</th>`;
  const sub = lb => `<th class="num"${lb ? ' style="border-left:1px solid var(--border)"' : ''}>Abert.</th><th class="num">Trades</th><th class="num">Final</th>`;
  const subTotal = `<th class="num" style="border-left:2px solid var(--border)">Abert.</th><th class="num">Trades</th><th class="num" style="border-left:2px solid var(--border);border-right:2px solid var(--border)">Final</th>`;

  const legend = `<div style="margin-top:8px;font-size:11px;color:var(--text-muted)">
    Limite 20%. <b>NET</b> (geral): operações de dólar netam contra o FIM IE. <b>GROSS</b> (Sulamerica): |operações| + |FIM IE|.
    &nbsp;Cor: <span style="color:var(--green)">&lt;15%</span> ·
    <span style="color:var(--alert-1)">15–17%</span> ·
    <span style="color:var(--alert-2)">17–19%</span> ·
    <span style="color:#fff;background:var(--alert-3);padding:0 4px">19–20%</span> ·
    <span style="color:#fff;background:var(--alert-4);padding:0 4px">&gt;20%</span></div>`;

  const mainTable = `
    <div class="card">
      <div class="section-title" style="padding:8px 0 10px 0;display:flex;align-items:baseline;gap:16px">
        <span>Exposição por fundo (BRL)</span>${navInfo}
      </div>
      <table class="data-table" style="white-space:nowrap;width:auto">
        <thead>
          <tr>
            <th rowspan="2">Fundo</th>
            <th rowspan="2" class="num">NAV</th>
            ${grp('Mini Dólar (WDO)')}${grp('Dólar Cheio (UC)')}${grp('Opções DOL')}
            <th rowspan="2" class="num" style="border-left:1px solid var(--border)">FIM IE</th>
            <th colspan="3" class="num" style="border-left:2px solid var(--border);border-right:2px solid var(--border);text-align:center">Total vs NAV — limite 20%</th>
            <th rowspan="2" class="num" style="${_SEP_TD};text-align:center">Reenquadramento<br><span style="font-weight:400;font-size:10px">(contratos p/ o limite)</span></th>
          </tr>
          <tr>${sub(true)}${sub(true)}${sub(true)}${subTotal}</tr>
        </thead>
        <tbody>${bodyRows}${totalRow}</tbody>
      </table>
      ${legend}
    </div>`;

  // ── Resumo de opções de DOL: delta editável (global, afeta todos os fundos) ─
  const optMap = new Map();   // key → { name, key, delta, px_last, mult, o, t, f }
  for (const fund of data.funds) {
    for (const inst of fund.instruments) {
      if (inst.category !== 'option') continue;
      const key = _dolarOptKey(inst);
      let agg = optMap.get(key);
      if (!agg) {
        agg = { name: inst.instrument_name || inst.instrument_reference, key,
                instrument_reference: inst.instrument_reference, instrument_name: inst.instrument_name,
                maturity: inst.maturity,
                delta: inst.delta, px_last: inst.px_last, mult: inst.mult, o:0, t:0, f:0, donos:{} };
        optMap.set(key, agg);
      }
      agg.o += inst.opening_qty || 0; agg.t += inst.traded_qty || 0; agg.f += inst.final_qty || 0;
      for (const td of inst.traders || []) {   // soma o final por trader entre os fundos
        agg.donos[td.trader] = (agg.donos[td.trader] || 0) + (td.final_qty || 0);
      }
    }
  }

  let optSumO = 0, optSumT = 0, optSumF = 0, optSumExp = 0, optAnyExp = false;
  const optRows = [...optMap.values()].map(a => {
    const ik  = instKey(a);
    const dl  = _effOptDelta(ik, a.delta, a.name);   // delta usado (normalizado por tipo)
    const ok  = dl != null && a.px_last != null;
    const exp = ok ? a.f * dl * a.mult * a.px_last : null;
    const ov  = deltaOverrides.has(ik);
    const sign = _optTypeSign(a.name);
    const defNorm = a.delta != null ? (sign != null ? sign * Math.abs(a.delta) : a.delta) : null;
    const kind = sign === 1 ? 'CALL' : sign === -1 ? 'PUT' : '';
    optSumO += a.o; optSumT += a.t; optSumF += a.f;
    if (exp != null) { optSumExp += exp; optAnyExp = true; }
    const ek  = a.key.replace(/'/g, "\\'");          // chave do ticker (instrument_reference)
    const ekd = ik.replace(/'/g, "\\'");             // chave da marreta de delta (instKey)
    const tk  = dolarOptTickers[a.key] || '';
    return `<tr>
      <td>${a.name} ${kind ? `<span style="font-size:10px;color:var(--text-muted)">${kind}</span>` : ''}</td>
      <td class="num">${fmtFinalQty(a.o)}</td>
      <td class="num">${fmtTradedQty(a.t)}</td>
      <td class="num">${fmtFinalQty(a.f)}</td>
      <td style="font-size:11px;color:var(--text-muted)">${_dolarDonos(a.donos) || '—'}</td>
      <td><input type="text" value="${tk.replace(/"/g, '&quot;')}" placeholder="ticker BBG"
        style="width:140px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:2px 6px"
        onchange="dolarSetTicker('${ek}', this.value)"></td>
      <td class="num">${defNorm != null ? defNorm.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}) : '—'}</td>
      <td class="num"><input type="number" step="0.01" value="${dl != null ? Number(dl.toFixed(4)) : ''}"
        style="width:64px;text-align:right;background:var(--bg);color:var(--text);border:1px solid ${ov ? 'var(--green)' : 'var(--border)'};border-radius:4px;padding:2px 4px"
        onchange="dolarSetDelta('${ekd}', this.value)"></td>
      <td class="num">${_fmtBrl(exp)}</td>
    </tr>`;
  }).join('');

  const optTotalRow = `<tr class="area-divider" style="font-weight:600">
    <td>Total</td>
    <td class="num">${fmtFinalQty(optSumO)}</td>
    <td class="num">${fmtTradedQty(optSumT)}</td>
    <td class="num">${fmtFinalQty(optSumF)}</td>
    <td></td><td></td><td class="num">—</td><td class="num">—</td>
    <td class="num">${optAnyExp ? _fmtBrl(optSumExp) : '<span style="color:var(--text-muted)">—</span>'}</td>
  </tr>`;

  const optTable = optMap.size ? `
    <div class="card">
      <div class="section-title" style="padding:8px 0 10px 0">
        <span>Opções de DOL — delta (altera todos os fundos)</span>
      </div>
      <table class="data-table" style="white-space:nowrap;width:auto">
        <thead><tr>
          <th>Opção</th><th class="num">Abertura</th><th class="num">Trades</th><th class="num">Final</th>
          <th>Donos</th><th>Ticker BBG</th><th class="num">Delta default</th><th class="num">Delta usado</th><th class="num">Exp. final (BRL)</th>
        </tr></thead>
        <tbody>${optRows}${optTotalRow}</tbody>
      </table>
    </div>` : '';

  container.innerHTML = mainTable + optTable + _renderFimIeTable(data);
}

// Gradação de cor para o limite de 100% do FIM IE.
function _fimLimitStyle(pct) {
  if (pct == null) return 'color:var(--text-muted)';
  const a = Math.abs(pct);
  if (a < 0.75) return 'color:var(--green)';
  if (a < 0.90) return 'color:var(--alert-1)';
  if (a < 1.00) return 'color:var(--alert-2)';
  if (a <= 1.01) return 'color:#fff;background:var(--alert-3);font-weight:700';
  return 'color:#fff;background:var(--alert-4);font-weight:700';
}

const _CAT_LABEL = { mini: 'Mini (WDO)', cheio: 'Cheio (UC)', option: 'Opção DOL' };

// Coluna "Donos": final por trader (não-zero), maior |qtd| primeiro. Aceita lista
// [{trader, final_qty}] (FIM IE) ou objeto {trader: final} (agregado de opções).
function _dolarDonos(traders) {
  if (!traders) return '';
  const arr = Array.isArray(traders)
    ? traders.map(t => [t.trader, t.final_qty])
    : Object.entries(traders);
  return arr.filter(([, q]) => Math.round(q) !== 0)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .map(([t, q]) => `${t} ${fmtFinalQty(q)}`)
    .join('  /  ');
}

// Check do veículo JGP FIM IE-A: posição de dólar por área-subárea-estratégia (limite 100% do NAV).
function _renderFimIeTable(data) {
  const positions = data.fim_ie_positions || [];
  const nav = data.fim_ie_nav;
  if (!positions.length && nav == null) return '';

  // consolida por subárea (ordena por subárea → instrumento)
  const rows = [...positions].sort((a, b) =>
    (a.subarea || '').localeCompare(b.subarea || '') ||
    (a.instrument_name || '').localeCompare(b.instrument_name || ''));

  let totExp = 0, anyExp = false;
  let lastGrp = null;
  let bodyHtml = '';
  let grpExp = 0;

  const flushGroup = () => {
    if (lastGrp !== null) {
      bodyHtml += `<tr style="font-weight:600;background:rgba(128,128,128,0.06)">
        <td colspan="7" style="text-align:right">Subtotal ${lastGrp}</td>
        <td class="num">${_fmtBrl(grpExp)}</td>
        <td class="num">${nav ? fmtPct(grpExp / nav) : '—'}</td>
      </tr>`;
    }
  };

  for (const p of rows) {
    const grp = p.subarea || '(sem subárea)';
    if (grp !== lastGrp) { flushGroup(); lastGrp = grp; grpExp = 0;
      bodyHtml += `<tr class="area-divider"><td colspan="9" style="font-weight:600;color:var(--text-muted)">${grp}</td></tr>`;
    }
    const e = _dolarInstExp(p);                 // mesma conta dos fundos (delta normalizado p/ opções)
    const ef = e.final;
    if (ef != null) { totExp += ef; anyExp = true; grpExp += ef; }
    const dlStr = p.category === 'option'
      ? (e.delta != null ? e.delta.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}) : '—') : '';
    bodyHtml += `<tr>
      <td style="padding-left:18px">${p.instrument_name || p.instrument_reference}</td>
      <td>${_CAT_LABEL[p.category] || p.category}</td>
      <td class="num" title="${Math.round(p.opening_qty).toLocaleString('pt-BR')} contratos">${fmtFinalQty(p.opening_qty)}</td>
      <td class="num">${fmtTradedQty(p.traded_qty)}</td>
      <td class="num" style="font-weight:600" title="${Math.round(p.final_qty).toLocaleString('pt-BR')} contratos">${fmtFinalQty(p.final_qty)}</td>
      <td style="font-size:11px;color:var(--text-muted)">${_dolarDonos(p.traders) || '—'}</td>
      <td class="num">${dlStr}</td>
      <td class="num">${_fmtBrl(ef)}</td>
      <td class="num">${nav ? fmtPct(ef / nav) : '—'}</td>
    </tr>`;
  }
  flushGroup();

  const pctTot = nav ? totExp / nav : null;
  const navStr = nav != null ? `BRL ${nav.toLocaleString('pt-BR', { maximumFractionDigits: 0 })}` : '—';
  const totalRow = `<tr class="area-divider" style="font-weight:700">
    <td colspan="7" style="text-align:right">TOTAL dólar vs NAV (limite 100%)</td>
    <td class="num">${anyExp ? _fmtBrl(totExp) : '—'}</td>
    <td class="num" style="${_fimLimitStyle(pctTot)};font-size:14px">${pctTot != null ? fmtPct(pctTot) + (Math.abs(pctTot) >= 0.95 ? ' ⚠' : '') : '—'}</td>
  </tr>`;

  const emptyMsg = positions.length ? '' :
    `<tr><td colspan="9" class="no-data" style="color:var(--text-muted)">Sem posição de dólar no FIM IE</td></tr>`;

  return `
    <div class="card">
      <div class="section-title" style="padding:8px 0 10px 0;display:flex;align-items:baseline;gap:16px">
        <span>Check JGP FIM IE — dólar por estratégia</span>
        <span style="font-weight:400;color:var(--text-muted);font-size:12px">NAV: ${navStr} · limite 100%</span>
      </div>
      <table class="data-table" style="white-space:nowrap;width:auto">
        <thead><tr>
          <th>Estratégia / Instrumento</th><th>Tipo</th>
          <th class="num">Abert. (qtd)</th><th class="num">Trades (qtd)</th><th class="num">Final (qtd)</th>
          <th>Donos</th><th class="num">Delta</th><th class="num">Exp. (BRL)</th><th class="num">% NAV</th>
        </tr></thead>
        <tbody>${bodyHtml}${emptyMsg}${totalRow}</tbody>
      </table>
    </div>`;
}

function dolarSetDelta(ik, value) {
  const v = parseFloat(value);
  if (value === '' || isNaN(v)) deltaOverrides.delete(ik);
  else deltaOverrides.set(ik, v);
  _markTabsDirtyAndRerender();
}

// Salva/atualiza o ticker BBG da opção no cache do backend (não re-renderiza p/ não perder o foco).
async function dolarSetTicker(optKey, ticker) {
  ticker = (ticker || '').trim();
  if (ticker) dolarOptTickers[optKey] = ticker;
  else delete dolarOptTickers[optKey];
  const status = document.getElementById('refStatus');
  try {
    await fetch(`${API_BASE}/api/positions/dolar-opt-tickers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [optKey]: ticker }),
    });
    if (status) { status.textContent = 'Ticker salvo'; status.style.color = 'var(--text-muted)'; }
  } catch (e) {
    if (status) { status.textContent = 'Erro ao salvar ticker: ' + e.message; status.style.color = 'var(--red)'; }
  }
}

