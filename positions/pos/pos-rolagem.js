const ROLAGEM_TAB_ID = 'rolagem';
const ROLAGEM_FILTER_DIMS = [
  { key: 'fund',     label: 'Fundo'      },
  { key: 'trader',   label: 'Trader'     },
  { key: 'area',     label: 'Área'       },
  { key: 'subarea',  label: 'Sub-área'   },
  { key: 'strategy', label: 'Estratégia' },
  { key: 'asset',    label: 'Ativo'      },
];
// Lista de brokers/counterparties (droplist das execuções e do counterparty gerencial).
const ROLAGEM_BROKERS = [
  'Agora CTVM', 'Ativa CTVC', 'Banco Bradesco S.A.', 'Banco BTG Pactual S.A.',
  'Banco Itau-Unibanco S.A.', 'Banco Santander Brasil', 'C6 CTVM', 'Convencao CVC',
  'Gerencial', 'Link CCTVM', 'Liquidez DTVM', 'Necton Investimentos', 'Renaissance',
  'Terra Inv DTVM', 'XP Investimentos CCTVM',
];
// Broker pré-selecionado numa execução nova. Explícito de propósito: era o 1º item da lista
// acima, e incluir um broker novo em ordem alfabética trocaria o default sem ninguém pedir —
// numa tela que gera boleta, isso sai como boleta com o broker errado.
const ROLAGEM_BROKER_DEFAULT = 'Ativa CTVC';
// Traders desmarcados por default (o resto começa marcado).
const ROLAGEM_TRADER_OFF = new Set(['AMuller', 'EquityHedge', 'FIA', 'CPLiquidos']);
let rolagemMonth = null;                       // 'YYYY-MM' escolhido; null = default (próximo mês)
const rolagemFilters = {};                     // dimKey → Set<valor> (vazio/ausente = tudo)
let rolagemBoletas = null;                     // último retorno do POST /boletas
let rolagemQtyEdit = {};                        // idx da boleta → quantidade ajustada manualmente
let _rolagemPanelMonth = null;                 // vencimento p/ o qual o painel de config foi montado
let _fundDropOpen = false;                     // dropdown de fundos aberto?
// Config de execução/colunas fixas (persiste entre renders). Cada ativo tem uma LISTA de
// execuções (qtd/preço/broker/base) que a ferramenta distribui pelas alocações.
const rolagemConfig = {
  deal_date: '', counterparty_gerencial: 'Gerencial', giveup: '', deal_type: '',
  value_date: '', fixing_date: '', fo_remark: '', bo_remark: '',
  obs_reserved: '', ignore_previous: '',
  mini:  { execs: [] },
  cheio: { execs: [] },
};

// ── Cache local da config + execuções digitadas (qtd/preço/broker/base) ──────
// Persiste em localStorage p/ sobreviver a refresh da página. NÃO salva as boletas
// (rolagemBoletas) — essas são sempre regeradas via "Gerar boletas".
const LS_ROLAGEM_CFG = 'jgp_rolagem_cfg_v1';
let _rolagemCfgLoaded = false;
const _ROLAGEM_CFG_SCALARS = ['deal_date', 'counterparty_gerencial', 'giveup', 'deal_type',
  'value_date', 'fixing_date', 'fo_remark', 'bo_remark', 'obs_reserved', 'ignore_previous'];

function saveRolagemConfig() {
  try {
    localStorage.setItem(LS_ROLAGEM_CFG, JSON.stringify({
      ..._ROLAGEM_CFG_SCALARS.reduce((o, k) => (o[k] = rolagemConfig[k], o), {}),
      mini:  { execs: rolagemConfig.mini.execs },
      cheio: { execs: rolagemConfig.cheio.execs },
    }));
  } catch (_) {}
}
function loadRolagemConfig() {
  if (_rolagemCfgLoaded) return;   // só na 1ª montagem (não sobrescreve edições em memória)
  _rolagemCfgLoaded = true;
  try {
    const raw = localStorage.getItem(LS_ROLAGEM_CFG);
    if (!raw) return;
    const d = JSON.parse(raw);
    if (!d || typeof d !== 'object') return;
    for (const k of _ROLAGEM_CFG_SCALARS) if (typeof d[k] === 'string') rolagemConfig[k] = d[k];
    for (const asset of ['mini', 'cheio']) {
      const execs = d[asset] && Array.isArray(d[asset].execs) ? d[asset].execs : null;
      if (execs) rolagemConfig[asset].execs = execs.map(e => ({
        qty: e.qty ?? '', price: e.price ?? '', broker: e.broker || ROLAGEM_BROKER_DEFAULT, base: e.base ?? '',
      }));
    }
  } catch (_) {}
}

function showRolagemTab() {
  activeTraderTab = ROLAGEM_TAB_ID;
  _showPanel(ROLAGEM_TAB_ID);
  if (!posDataByTab[ROLAGEM_TAB_ID]) loadRolagem();
  else renderRolagem();
}

async function loadRolagem() {
  const refDate   = document.getElementById('refDate').value;
  const status    = document.getElementById('refStatus');
  const srcLabel  = document.getElementById('srcLabel');
  const btn       = document.getElementById('btnLoad');
  const container = document.getElementById('rolagemContainer');

  // Antes o unico aviso era este container — que nasce `display:none` (e o detalhe
  // colapsado). Nada do que estava a vista mudava. Agora as 3 secoes da aba acendem.
  PosBusy.on('rolagem');
  status.textContent = 'Buscando dados...';
  status.style.color = 'var(--text-muted)';
  btn.disabled = true;

  try {
    const params = new URLSearchParams();
    if (refDate) params.set('ref_date', refDate);
    const forceOpening = document.getElementById('forceOpening').value;
    if (forceOpening) params.set('force_opening', forceOpening);
    if (rolagemMonth) params.set('target_month', rolagemMonth);
    const data = await (await fetch(`${API_BASE}/api/positions/rolagem-dolar?${params}`)).json();

    if (data.error) {
      status.textContent = 'Erro: ' + data.error;
      status.style.color = 'var(--red)';
      container.innerHTML = `<div class="card no-data">${data.error}</div>`;
      return;
    }

    posDataByTab[ROLAGEM_TAB_ID] = data;
    _noteFetchSig(ROLAGEM_TAB_ID);
    rolagemMonth = data.target_month;
    rolagemBoletas = null;               // nova base → prévia de boletas anterior fica obsoleta
    // Traders começam marcados por default, exceto os de ROLAGEM_TRADER_OFF; demais dims vazias (=tudo).
    rolagemFilters.trader = new Set(_rolagemDistinct(data.rows || [], 'trader').filter(t => !ROLAGEM_TRADER_OFF.has(t)));
    status.textContent = '';
    srcLabel.textContent =
      `Abertura: ${fmtDate(data.opening_date)}  |  Boletas: ${fmtDate(data.ref_date)}`;
    renderRolagem();
  } catch (e) {
    status.textContent = 'Erro ao conectar: ' + e.message;
    status.style.color = 'var(--red)';
  } finally {
    PosBusy.off('rolagem');
    btn.disabled = false;
  }
}

function changeRolagemMonth(v) {
  rolagemMonth = v;
  delete posDataByTab[ROLAGEM_TAB_ID];
  loadRolagem();
}

// Detalhe (tabela por linha) recolhido por default — o foco é o resumo.
function toggleRolagemPos() {
  const c = document.getElementById('rolagemContainer');
  const h = document.getElementById('rolagemPosHeader');
  const hidden = c.style.display === 'none';
  c.style.display = hidden ? '' : 'none';
  if (h) h.textContent = `${hidden ? '▼' : '▶'} Posição de dólar do vencimento a rolar (detalhe)`;
}

/* ── Filtros de múltipla escolha (Set por dimensão; vazio = tudo) ─────────── */
function _rolagemSet(key) {
  if (!rolagemFilters[key]) rolagemFilters[key] = new Set();
  return rolagemFilters[key];
}
function toggleRolagemFilter(key, val) {
  const s = _rolagemSet(key);
  if (s.has(val)) s.delete(val); else s.add(val);
  rolagemBoletas = null;               // filtro mudou → prévia de boletas obsoleta
  renderRolagem();
}
function clearRolagemFilter(key) {
  rolagemFilters[key] = new Set();
  rolagemBoletas = null;
  renderRolagem();
}
function _rolagemDistinct(rows, key) {
  return [...new Set(rows.map(r => r[key]).filter(v => v != null && v !== ''))].sort();
}
// Aplica os filtros ativos (cada dimensão: Set vazio = passa tudo).
function _rolagemFilteredRows(data) {
  let rows = (data.rows || []).slice();
  for (const d of ROLAGEM_FILTER_DIMS) {
    const s = rolagemFilters[d.key];
    if (s && s.size) rows = rows.filter(r => s.has(r[d.key]));
  }
  return rows;
}

function toggleFundDropdown() {
  _fundDropOpen = !_fundDropOpen;
  const p = document.getElementById('rolagemFundPanel');
  if (p) p.style.display = _fundDropOpen ? '' : 'none';
}

// Dropdown de fundos (multi-select por checkbox; nenhum marcado = todos).
function _rolagemFundDropdown(allRows) {
  const sel = rolagemFilters.fund;
  const funds = _rolagemDistinct(allRows, 'fund');
  const nSel = sel ? sel.size : 0;
  const label = nSel ? `${nSel} fundo(s)` : 'Todos os fundos';
  const boxes = funds.map(v => {
    const on = sel && sel.has(v);
    const safe = String(v).replace(/'/g, "\\'");
    return `<label style="display:flex;gap:6px;align-items:center;font-size:12px;padding:2px 4px;white-space:nowrap;cursor:pointer">
        <input type="checkbox" ${on ? 'checked' : ''} onchange="toggleRolagemFilter('fund','${safe}')"> ${v}
      </label>`;
  }).join('');
  return `<div style="position:relative;display:inline-block">
      <button type="button" onclick="toggleFundDropdown()"
        style="padding:4px 12px;font-size:12px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:4px;cursor:pointer">
        Fundos: <b>${label}</b> ▾</button>
      <div id="rolagemFundPanel" style="display:${_fundDropOpen ? '' : 'none'};position:absolute;z-index:50;margin-top:4px;
        max-height:280px;overflow-y:auto;background:var(--bg-card);border:1px solid var(--border);border-radius:6px;padding:6px 8px;min-width:240px;box-shadow:0 4px 12px rgba(0,0,0,0.25)">
        <div style="display:flex;gap:8px;margin-bottom:4px">
          <span class="filter-chip off" onclick="clearRolagemFilter('fund')">Limpar (todos)</span>
        </div>
        ${boxes || '<span style="font-size:12px;color:var(--text-muted)">—</span>'}
      </div>
    </div>`;
}

function _rolagemRenderControls(data) {
  const allRows = data.rows || [];
  const months = (data.available_months || []).slice();
  if (!months.some(m => m.ym === data.target_month)) {
    months.push({ ym: data.target_month, label: data.target_label });
  }
  months.sort((a, b) => a.ym.localeCompare(b.ym));
  const monthOpts = months.map(m =>
    `<option value="${m.ym}" ${m.ym === rolagemMonth ? 'selected' : ''}>${m.label}</option>`).join('');

  // Trader: chips TODOS selecionados por default (sem "Todos"). Área/Sub-área/Estratégia/Ativo:
  // chips com "Todos" (vazio = tudo). Fundo: dropdown multi-select (acima).
  const chipDim = (d, withTodos) => {
    const sel = rolagemFilters[d.key];
    const allOn = !sel || sel.size === 0;
    const chips = _rolagemDistinct(allRows, d.key).map(v => {
      const on = sel && sel.has(v);
      const safe = String(v).replace(/'/g, "\\'");
      return `<span class="filter-chip ${on ? 'on' : 'off'}" onclick="toggleRolagemFilter('${d.key}','${safe}')">${v}</span>`;
    }).join('');
    const todos = withTodos
      ? `<span class="filter-chip ${allOn ? 'on' : 'off'}" onclick="clearRolagemFilter('${d.key}')">Todos</span>` : '';
    return `<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:2px 0">
        <span style="font-size:12px;color:var(--text-muted);font-weight:600;min-width:74px">${d.label}:</span>
        ${todos}${chips}
      </div>`;
  };

  document.getElementById('rolagemControls').innerHTML = `
    <div class="card" style="display:flex;flex-direction:column;gap:8px">
      <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
        <label style="font-size:13px;color:var(--text-muted)">Vencimento a rolar:
          <select onchange="changeRolagemMonth(this.value)"
            style="padding:5px 10px;font-size:13px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:4px">${monthOpts}</select>
        </label>
        <span style="font-size:12px;color:var(--text-muted);font-weight:600">Fundo:</span>
        ${_rolagemFundDropdown(allRows)}
        <span style="font-size:12px;color:var(--text-muted)">Contrato BBG: <b>${data.target_code}${(data.target_month || '').slice(2, 4)}</b> (mini WDO + cheio UC)</span>
      </div>
      ${chipDim(ROLAGEM_FILTER_DIMS[1], false)}
      ${chipDim(ROLAGEM_FILTER_DIMS[2], true)}
      ${chipDim(ROLAGEM_FILTER_DIMS[3], true)}
      ${chipDim(ROLAGEM_FILTER_DIMS[4], true)}
      ${chipDim(ROLAGEM_FILTER_DIMS[5], true)}
    </div>`;
}

/* ── Resumo: net por fundo (mini/cheio) — o que precisa rolar ─────────────── */
// 1 contrato cheio (UC) = 5 minis (WDO) — mesma razão do DOLLAR_CONTRACTS do backend.
const ROLAGEM_MINIS_POR_CHEIO = 5;
const ROLAGEM_ASSET_SIZE = { mini: 1, cheio: ROLAGEM_MINIS_POR_CHEIO };   // em minis-equivalentes
// Lote de NEGOCIAÇÃO: o cheio só é operado de 5 em 5 (o TOTAL que vai a mercado; a
// alocação por fundo pode ser de 1 em 1). O mini não tem lote.
const ROLAGEM_LOT = { mini: 1, cheio: 5 };
// Modo de conversão: 'off' (cada ativo rola no seu) · 'cheio' (quem neta rola tudo em UC)
// · 'mini' (quem neta rola tudo em WDO). Vale para o resumo E para as boletas.
const LS_ROLAGEM_CONV = 'jgp_rolagem_conv_v1';
let rolagemConvMode = 'off';
try { rolagemConvMode = localStorage.getItem(LS_ROLAGEM_CONV) || 'off'; } catch (_) {}

function setRolagemConvMode(m) {
  rolagemConvMode = m;
  try { localStorage.setItem(LS_ROLAGEM_CONV, m); } catch (_) {}
  rolagemBoletas = null;               // boletas foram geradas noutro modo → obsoletas
  const data = posDataByTab[ROLAGEM_TAB_ID];
  if (data) _rolagemRenderSummary(_rolagemFilteredRows(data));
  _renderBoletaPreview();              // limpa a prévia sem remontar o painel de config
}

/* ── Plano de conversão mini↔cheio — ESPELHO de `_plan_rolagem_conversion` do
   backend (positions/router.py). As duas contas precisam bater: o resumo mostra o
   que vai a mercado e as boletas são geradas com a MESMA regra no servidor.
   Regras (mesa, ago/2026):
     1. converte só quem NETA — fundo com mini e cheio em lados OPOSTOS;
     2. quem converte rola num instrumento só (net_alvo + net_origem ÷5 ou ×5);
     3. o lote de 5 vale só para o TOTAL OPERADO no cheio, não para a alocação;
     4. a sobra do arredondamento cai na MAIOR linha do lado (a que menos sente). */
const _rhAway = x => (x >= 0 ? Math.floor(x + 0.5) : -Math.floor(-x + 0.5));
const _toLot = (x, lot) => (lot <= 1 ? _rhAway(x) : _rhAway(x / lot) * lot);
function _fitToTotal(vals, total) {
  if (!vals.length) return [];
  const ints = vals.map(_rhAway);
  const diff = total - ints.reduce((a, b) => a + b, 0);
  if (diff) {
    let i = 0;
    for (let k = 1; k < vals.length; k++) if (Math.abs(vals[k]) > Math.abs(vals[i])) i = k;
    ints[i] += diff;
  }
  return ints;
}
function _rolagemPlan(nets, mode) {
  const off = { mode: 'off', converting: new Set(), qty: {}, exact: {}, residual: {}, sides: [] };
  if (mode !== 'mini' && mode !== 'cheio') return off;
  const tgt = mode, src = tgt === 'mini' ? 'cheio' : 'mini';
  const lot = ROLAGEM_LOT[tgt];
  const fac = ROLAGEM_ASSET_SIZE[src] / ROLAGEM_ASSET_SIZE[tgt];
  const funds = Object.keys(nets);
  const converting = new Set(funds.filter(f =>
    nets[f][src] && nets[f][tgt] && (nets[f][src] > 0) !== (nets[f][tgt] > 0)));
  const exact = {};
  for (const f of funds) exact[f] = converting.has(f) ? nets[f][tgt] + nets[f][src] * fac : nets[f][tgt];

  const qty = {}, sides = [];
  for (const sgn of [1, -1]) {
    const members = funds.filter(f => exact[f] && (exact[f] > 0) === (sgn > 0)).sort();
    if (!members.length) continue;
    const exactTotal = members.reduce((a, f) => a + Math.abs(exact[f]), 0);
    const hasConv = members.some(f => converting.has(f));
    const targetTotal = hasConv ? _toLot(exactTotal, lot) : _rhAway(exactTotal);
    const mags = _fitToTotal(members.map(f => Math.abs(exact[f])), targetTotal);
    members.forEach((f, i) => { qty[f] = sgn * mags[i]; });
    let big = members[0];
    for (const f of members) if (Math.abs(exact[f]) > Math.abs(exact[big])) big = f;
    sides.push({ asset: tgt, side: sgn > 0 ? 'compra' : 'venda', exact_total: exactTotal,
                 target_total: targetTotal, lot: hasConv ? lot : 1, absorbed_by: big,
                 n_converting: members.filter(f => converting.has(f)).length });
  }
  const residual = {};
  for (const f of funds) {
    const pos = nets[f].mini + nets[f].cheio * ROLAGEM_MINIS_POR_CHEIO;
    let rolled = (qty[f] || 0) * ROLAGEM_ASSET_SIZE[tgt];
    if (!converting.has(f)) rolled += nets[f][src] * ROLAGEM_ASSET_SIZE[src];
    residual[f] = rolled - pos;
  }
  return { mode, src, tgt, lot, converting, qty, exact, residual, sides };
}

// Quantidade de contrato com casas decimais SÓ quando não deu inteiro (o net convertido
// mini→cheio raramente fecha).
function _fmtRolQty(v, { plain = false } = {}) {
  const r = (v == null || !isFinite(v) || Math.abs(v) < 1e-9) ? 0 : v;
  if (r === 0) return plain ? '—' : '<span style="color:var(--text-muted)">—</span>';
  const dec = Math.abs(r - Math.round(r)) < 1e-9 ? 0 : 2;
  const s = Math.abs(r).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  if (plain) return s;
  return r < 0 ? `<span style="color:var(--red)">(${s})</span>` : s;
}

function _rolagemRenderSummary(rows) {
  const el = document.getElementById('rolagemSummary');
  if (!el) return;
  const nets = {};   // fund → {mini, cheio}
  for (const r of rows) {
    if (!nets[r.fund]) nets[r.fund] = { mini: 0, cheio: 0 };
    nets[r.fund][r.asset] += r.final_qty;
  }
  for (const f of Object.keys(nets)) {
    nets[f].mini = Math.round(nets[f].mini);
    nets[f].cheio = Math.round(nets[f].cheio);
  }
  const funds = Object.keys(nets).sort((a, b) => a.localeCompare(b));
  const plan = _rolagemPlan(nets, rolagemConvMode);
  const conv = plan.mode !== 'off';
  const tgt = plan.tgt, src = plan.src;
  const aLabel = { mini: 'mini (WDO)', cheio: 'cheio (UC)' };

  // Quanto cada fundo rola em CADA instrumento depois da conversão.
  const rolls = {};
  for (const f of funds) {
    rolls[f] = conv
      ? { [tgt]: plan.qty[f] || 0, [src]: plan.converting.has(f) ? 0 : nets[f][src] }
      : { mini: nets[f].mini, cheio: nets[f].cheio };
  }
  // Execução por LADO: fundos com net>0 compram o spread; net<0 vendem. Fundos não netam
  // entre si, então a compra total = Σ net>0 e a venda total = Σ|net<0| (por ativo).
  const exec = { mini: { buy: 0, sell: 0 }, cheio: { buy: 0, sell: 0 } };
  for (const f of funds) for (const a of ['mini', 'cheio']) {
    const q = rolls[f][a] || 0;
    if (q > 0) exec[a].buy += q; else exec[a].sell += -q;
  }
  const residTotal = conv ? funds.reduce((a, f) => a + (plan.residual[f] || 0), 0) : 0;

  const body = funds.map(f => {
    const c = conv && plan.converting.has(f);
    const mark = c ? ` <span title="mini e cheio em lados opostos — rola tudo em ${aLabel[tgt]}" style="color:var(--green);font-weight:700">⇄</span>` : '';
    const res = conv ? (plan.residual[f] || 0) : 0;
    return `<tr${c ? ' style="background:var(--bg-row-alt)"' : ''}>
      <td>${f}${mark}</td>
      <td class="num">${fmtFinalQty(nets[f].mini)}</td>
      <td class="num">${fmtFinalQty(nets[f].cheio)}</td>
      ${conv ? `<td class="num" style="font-weight:600">${fmtFinalQty(rolls[f].mini)}</td>
      <td class="num" style="font-weight:600">${fmtFinalQty(rolls[f].cheio)}</td>
      <td class="num" title="rolado − posição, em minis-equivalentes">${res ? `<span style="color:var(--yellow)">${res > 0 ? '+' : ''}${res}</span>` : '<span style="color:var(--text-muted)">—</span>'}</td>` : ''}
    </tr>`;
  }).join('');

  const chip = (m, txt, tip) =>
    `<span class="filter-chip ${rolagemConvMode === m ? 'on' : 'off'}" title="${tip}" onclick="setRolagemConvMode('${m}')">${txt}</span>`;
  const toggle = `<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
      <span style="font-size:12px;color:var(--text-muted);font-weight:600">Conversão:</span>
      ${chip('off',   'Sem conversão', 'Cada ativo rola no seu instrumento (visão padrão)')}
      ${chip('cheio', 'Netar no cheio (UC)', 'Fundo com mini e cheio em lados opostos rola tudo no cheio: mini ÷ 5 entra no cheio')}
      ${chip('mini',  'Netar no mini (WDO)', 'Fundo com mini e cheio em lados opostos rola tudo no mini: cheio × 5 entra no mini')}
      ${conv ? `<span style="font-size:11px;color:var(--text-muted)">${plan.converting.size} fundo(s) netam · as boletas seguem esta escolha</span>` : ''}
    </div>`;

  const execCells = (key, wrap, color) => {
    const cell = a => {
      const v = exec[a][key];
      return `<span style="color:var(${color})">${v ? wrap(fmtQty(v)) : '—'}</span>`;
    };
    return conv
      ? `<td class="num" style="color:var(--text-muted)">—</td><td class="num" style="color:var(--text-muted)">—</td>
         <td class="num">${cell('mini')}</td><td class="num">${cell('cheio')}</td><td></td>`
      : `<td class="num">${cell('mini')}</td><td class="num">${cell('cheio')}</td>`;
  };

  el.innerHTML = `
    <div class="card" style="overflow-x:auto">
      ${toggle}
      <table class="data-table" style="max-width:${conv ? 900 : 680}px">
        <thead><tr>
          <th style="text-align:left">Fundo</th>
          <th class="num" title="Net de WDO (mini) por fundo">Net mini (ctr)</th>
          <th class="num" title="Net de UC (cheio) por fundo">Net cheio (ctr)</th>
          ${conv ? `<th class="num" title="Contratos de MINI que este fundo rola depois da conversão">Rola mini</th>
          <th class="num" title="Contratos de CHEIO que este fundo rola depois da conversão">Rola cheio</th>
          <th class="num" title="Rolado − posição, em minis-equivalentes (efeito do arredondamento)">Resíduo</th>` : ''}
        </tr></thead>
        <tbody>
          ${body || `<tr><td colspan="${conv ? 6 : 3}" class="no-data">—</td></tr>`}
          <tr class="area-divider" style="font-weight:700">
            <td title="Contratos a COMPRAR no mercado = Σ dos net positivos por fundo">A executar — COMPRA</td>
            ${execCells('buy', s => '+' + s, '--green')}
          </tr>
          <tr style="font-weight:700">
            <td title="Contratos a VENDER no mercado = Σ dos |net| negativos por fundo">A executar — VENDA</td>
            ${execCells('sell', s => '(' + s + ')', '--red')}
          </tr>
        </tbody>
      </table>
      ${conv ? `<div style="font-size:11px;color:var(--text-muted);margin-top:6px;line-height:1.6">
        <b>⇄ ${plan.converting.size} fundo(s) netam</b> — mini e cheio em lados opostos, então rolam num instrumento só
        (1 cheio = ${ROLAGEM_MINIS_POR_CHEIO} minis). Quem tem os dois do mesmo lado continua rolando os dois:
        ali converter não pouparia execução.
        ${plan.sides.map(s => s.lot > 1
          ? `<br>· <b>${s.side}</b> em ${aLabel[tgt]}: ${_fmtRolQty(s.exact_total, { plain: true })} exatos → <b>${fmtQty(s.target_total)}</b>
             (múltiplo de ${s.lot}, que é o lote de negociação do cheio); a diferença entrou na maior linha do lado, <b>${s.absorbed_by}</b>.`
          : '').join('')}
        ${residTotal ? `<br>· <span style="color:var(--red)">Resíduo total ${residTotal > 0 ? '+' : ''}${residTotal} minis</span>
             (US$ ${(Math.abs(residTotal) * 10).toLocaleString('en-US')} mil de nocional — 1 mini = US$ 10 mil) — é o arredondamento; a coluna Resíduo diz de quem é.`
          : '<br>· Resíduo zero: a conversão fechou em contratos inteiros.'}
      </div>` : ''}
    </div>`;
}

function renderRolagem() {
  const data = posDataByTab[ROLAGEM_TAB_ID];
  if (!data) return;
  _rolagemRenderControls(data);

  const rows = _rolagemFilteredRows(data);
  _rolagemRenderSummary(rows);

  // ── Tabela principal: Fundo · Trader · Área · Sub-área · Estratégia · Instrument · Qtd
  const container = document.getElementById('rolagemContainer');
  const sorted = rows.slice().sort((a, b) =>
    (a.fund || '').localeCompare(b.fund || '') ||
    (a.area || '').localeCompare(b.area || '') ||
    (a.subarea || '').localeCompare(b.subarea || '') ||
    (a.strategy || '').localeCompare(b.strategy || '') ||
    (a.trader || '').localeCompare(b.trader || ''));

  if (!sorted.length) {
    container.innerHTML = '<div class="card no-data">Sem posição de dólar no vencimento selecionado (com os filtros atuais).</div>';
  } else {
    const body = sorted.map(r => `<tr>
        <td>${r.fund || '—'}</td>
        <td>${r.trader || '—'}</td>
        <td>${r.area || '—'}</td>
        <td>${r.subarea || '—'}</td>
        <td>${r.strategy || '—'}</td>
        <td>${r.instrument_reference || '—'} <span style="font-size:11px;color:var(--text-muted)">(${r.asset})</span></td>
        <td class="num col-final" style="font-weight:600">${fmtFinalQty(r.final_qty)}</td>
      </tr>`).join('');
    container.innerHTML = `
      <div class="card" style="overflow-x:auto">
        <table class="data-table">
          <thead><tr>
            <th style="text-align:left">Fundo</th>
            <th style="text-align:left">Trader</th>
            <th style="text-align:left">Área</th>
            <th style="text-align:left">Sub-área</th>
            <th style="text-align:left">Estratégia</th>
            <th style="text-align:left">Instrument reference</th>
            <th class="num col-final">Quantidade</th>
          </tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>`;
  }

  _rolagemRenderBoletaPanel(data);
}

/* ── Painel de boletas de rolagem (config + gerar + prévia + export) ──────── */
// Colunas do JDS que ficam SEMPRE vazias: escondidas na prévia, mas presentes no
// export (a contagem de colunas importa ao colar no Excel).
const ROLAGEM_EMPTY_COLS = new Set([
  'Giveup Counterparty', 'Deal Type', 'Value date', 'Fixing date',
  'FO Remark', 'BO Remark', '(OBS) Reserved', 'Ignore previous positions',
]);
function _fmtDDMMYYYY(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  return m ? `${m[3]}/${m[2]}/${m[1]}` : (iso || '');
}
function setRolagemCfg(path, val) {
  const parts = path.split('.');
  let o = rolagemConfig;
  while (parts.length > 1) o = o[parts.shift()];
  o[parts[0]] = val;
  saveRolagemConfig();
}

function _cfgInput(label, path, cur, ph = '') {
  const safe = String(cur ?? '').replace(/"/g, '&quot;');
  return `<label style="font-size:12px;color:var(--text-muted);display:flex;flex-direction:column;gap:2px">
      ${label}
      <input type="text" value="${safe}" placeholder="${ph}" oninput="setRolagemCfg('${path}', this.value)"
        style="padding:4px 8px;font-size:12px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:4px;min-width:120px">
    </label>`;
}

// <select> de broker (opções da lista ROLAGEM_BROKERS; sem linha vazia).
function _brokerOptions(cur) {
  return ROLAGEM_BROKERS.map(b => `<option ${b === cur ? 'selected' : ''}>${b}</option>`).join('');
}
function _cfgSelect(label, path, cur, options) {
  return `<label style="font-size:12px;color:var(--text-muted);display:flex;flex-direction:column;gap:2px">
      ${label}
      <select onchange="setRolagemCfg('${path}', this.value)"
        style="padding:4px 8px;font-size:12px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:4px;min-width:120px">${options}</select>
    </label>`;
}

// Ticker do ativo de rolagem (espelha o backend): mini→WD1, cheio→DR1, {front}{Yf}{back}{Yb}.
const _ROLL_FUT_CODES = 'FGHJKMNQUVXZ';
function _rollSpreadTicker(asset, ym) {
  const y = +ym.slice(0, 4), m = +ym.slice(5, 7);
  const bm = m === 12 ? 1 : m + 1, by = m === 12 ? y + 1 : y;
  const pfx = asset === 'mini' ? 'WD1' : 'DR1';
  return `${pfx}${_ROLL_FUT_CODES[m - 1]}${y % 10}${_ROLL_FUT_CODES[bm - 1]}${by % 10}`;
}

/* ── Execuções reais por ativo (lista editável; a tool distribui nas alocações) ─ */
function setExecCell(asset, i, field, val) {
  const e = rolagemConfig[asset].execs[i];
  if (e) e[field] = val;
  saveRolagemConfig();
}
function addExecRow(asset) {
  // broker default = 1º da lista (sem opção vazia no droplist)
  rolagemConfig[asset].execs.push({ qty: '', price: '', broker: ROLAGEM_BROKER_DEFAULT, base: '' });
  saveRolagemConfig();
  _renderExecRows(asset);
}
function removeExecRow(asset, i) {
  rolagemConfig[asset].execs.splice(i, 1);
  saveRolagemConfig();
  _renderExecRows(asset);
}
function _renderExecRows(asset) {
  const el = document.getElementById('rolagemExecs-' + asset);
  if (!el) return;
  const inSty = 'padding:3px 6px;font-size:12px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:4px';
  const rows = rolagemConfig[asset].execs.map((e, i) => `<tr>
      <td><input type="text" inputmode="numeric" value="${String(e.qty ?? '').replace(/"/g, '&quot;')}" placeholder="+compra / −venda"
        oninput="setExecCell('${asset}',${i},'qty',this.value)" style="${inSty};width:110px;text-align:right"></td>
      <td><input type="text" value="${String(e.price ?? '').replace(/"/g, '&quot;')}" placeholder="spread"
        oninput="setExecCell('${asset}',${i},'price',this.value)" style="${inSty};width:90px;text-align:right"></td>
      <td><select onchange="setExecCell('${asset}',${i},'broker',this.value)" style="${inSty};min-width:170px">${_brokerOptions(e.broker)}</select></td>
      <td><input type="text" value="${String(e.base ?? '').replace(/"/g, '&quot;')}" placeholder="preço-base"
        oninput="setExecCell('${asset}',${i},'base',this.value)" style="${inSty};width:100px;text-align:right"></td>
      <td><button class="btn" onclick="removeExecRow('${asset}',${i})" style="padding:2px 8px;font-size:12px;background:var(--red);color:#fff">✕</button></td>
    </tr>`).join('');
  el.innerHTML = `
    <table class="data-table" style="font-size:12px;width:auto">
      <thead><tr>
        <th class="num">Qtd (spread)</th><th class="num">Preço (spread)</th>
        <th style="text-align:left">Broker</th><th class="num">Base (Aux.)</th><th></th>
      </tr></thead>
      <tbody>${rows || '<tr><td colspan="5" style="color:var(--text-muted);font-size:12px">sem execuções — clique “+ execução”</td></tr>'}</tbody>
    </table>
    <button class="btn btn-secondary" onclick="addExecRow('${asset}')" style="margin-top:6px;padding:4px 12px;font-size:12px">+ execução</button>`;
}

function _rolagemRenderBoletaPanel(data) {
  const panel = document.getElementById('rolagemBoletaPanel');
  if (!panel) return;

  loadRolagemConfig();   // restaura config/execuções cacheadas (só na 1ª montagem)

  // (Re)monta a config só quando o vencimento muda (os tickers dependem dele);
  // os valores digitados persistem em rolagemConfig.
  if (_rolagemPanelMonth !== data.target_month) {
    _rolagemPanelMonth = data.target_month;
    if (!rolagemConfig.deal_date) rolagemConfig.deal_date = _fmtDDMMYYYY(data.ref_date || '');
    const assetBlock = (asset, label) => `
      <div style="border:1px solid var(--border);border-radius:6px;padding:8px 10px;display:flex;flex-direction:column;gap:6px;flex:1;min-width:340px">
        <div style="font-weight:600;font-size:12px">${label} — ativo <b>${_rollSpreadTicker(asset, data.target_month)}</b></div>
        <div id="rolagemExecs-${asset}"></div>
      </div>`;

    panel.innerHTML = `
      <div class="card" style="display:flex;flex-direction:column;gap:12px">
        <div style="font-size:12px;color:var(--text-muted)">
          Informe as execuções reais (várias, com qtd/preço/broker/base diferentes). A ferramenta
          distribui por lado (compra/venda) nas alocações e gera as boletas — reais (com broker) +
          gerenciais fictícias (netam zero por fundo, no preço/base médio das execuções).
        </div>
        <div style="display:flex;gap:12px;flex-wrap:wrap">
          ${assetBlock('mini', 'Mini (WDO)')}
          ${assetBlock('cheio', 'Cheio (UC)')}
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          ${_cfgInput('Deal Date (dd/mm/aaaa)', 'deal_date', rolagemConfig.deal_date)}
          ${_cfgSelect('Cpty gerencial', 'counterparty_gerencial', rolagemConfig.counterparty_gerencial, _brokerOptions(rolagemConfig.counterparty_gerencial))}
          <span style="font-size:11px;color:var(--text-muted);align-self:flex-end">As colunas Giveup/Deal Type/Value date/Fixing/Remarks/Ignore ficam vazias (só contam no paste).</span>
        </div>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <button class="btn" onclick="gerarBoletas()" style="padding:6px 18px;font-size:13px">Gerar boletas</button>
          <span style="font-size:12px;color:var(--text-muted)">As boletas refletem os filtros atuais.</span>
        </div>
        <div id="rolagemBoletaPreview"></div>
      </div>`;
    _renderExecRows('mini');
    _renderExecRows('cheio');
  }
  _renderBoletaPreview();
}

async function gerarBoletas() {
  const status = document.getElementById('refStatus');
  const filters = {};
  for (const d of ROLAGEM_FILTER_DIMS) {
    const s = rolagemFilters[d.key];
    if (s && s.size) filters[d.key] = [...s];
  }
  const payload = {
    ref_date: document.getElementById('refDate').value || undefined,
    force_opening: document.getElementById('forceOpening').value || undefined,
    target_month: rolagemMonth,
    filters,
    // O modo de conversão vive fora do rolagemConfig (que é a config de boleta e persiste
    // noutra chave) — vai carona no `config` porque é lá que o backend lê.
    config: { ...rolagemConfig, convert: { mode: rolagemConvMode } },
  };
  PosBusy.on('boletas');
  status.textContent = 'Gerando boletas...';
  status.style.color = 'var(--text-muted)';
  try {
    const resp = await fetch(`${API_BASE}/api/positions/rolagem-dolar/boletas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    if (data.error) {
      status.textContent = 'Erro: ' + data.error;
      status.style.color = 'var(--red)';
      return;
    }
    rolagemBoletas = data;
    rolagemQtyEdit = {};                 // nova geração → limpa ajustes manuais
    status.textContent = '';
    _renderBoletaPreview();
  } catch (e) {
    status.textContent = 'Erro ao gerar boletas: ' + e.message;
    status.style.color = 'var(--red)';
  } finally {
    PosBusy.off('boletas');
  }
}

// Colunas numéricas da prévia — uma fonte só para o alinhamento do cabeçalho E a classe
// da célula, senão os dois saem de sincronia (foi o que desalinhou a tabela).
const _ROLAGEM_NUM_COLS = new Set(['Quantity', 'Price', 'Auxiliary number']);
const _isNumCol = c => _ROLAGEM_NUM_COLS.has(c);

function _renderBoletaPreview() {
  const el = document.getElementById('rolagemBoletaPreview');
  if (!el) return;
  const b = rolagemBoletas;
  if (!b || !b.boletas) {
    el.innerHTML = '<div style="font-size:12px;color:var(--text-muted)">Configure e clique <b>Gerar boletas</b> — a prévia (real + gerencial) aparece aqui.</div>';
    return;
  }
  if (!b.boletas.length) {
    el.innerHTML = '<div class="no-data">Nenhuma boleta gerada (sem posição no filtro atual).</div>';
    return;
  }

  const nReal = b.boletas.filter(x => x._kind === 'real').length;
  const nGer  = b.boletas.length - nReal;

  // ── "Casar" execuções × posição a rolar (usa qtd EFETIVA = com ajustes manuais) ──
  // Por (fundo, ativo): Σ boletas deve = net a rolar. Se você editou uma qtd ou a execução
  // não bateu, aqui acusa a diferença (ajuste manualmente as Quantity até casar).
  // `expected` = Σ que as boletas DEVEM ter naquele (fundo, ativo). Sem conversão é o net
  // cru; com conversão o ativo de origem espera 0 (só gerenciais) e o alvo espera a qtd
  // convertida — comparar com o net cru acusaria erro em tudo que netou.
  const netMap = {};   // 'fund||asset' → Σ esperado nas boletas
  for (const r of (b.reconciliation || [])) {
    netMap[`${r.fund}||${r.asset}`] = (r.expected != null ? r.expected : r.net);
  }
  const sumMap = {};   // 'fund||asset' → Σ qtd efetiva
  b.boletas.forEach((bo, i) => {
    const k = `${bo._fund}||${bo._asset}`;
    sumMap[k] = (sumMap[k] || 0) + _effBoletaQty(i);
  });
  const mism = Object.keys(netMap).map(k => {
    const net = Math.round(netMap[k] || 0), sum = Math.round(sumMap[k] || 0);
    return { k, net, sum, diff: sum - net };
  }).filter(m => m.diff !== 0);
  const matchMsg = mism.length
    ? `<span style="color:var(--red);font-weight:600">⚠ ${mism.length} fundo(s)/ativo com boletas ≠ posição a rolar — ajuste as Quantity</span>`
    : `<span style="color:var(--green);font-weight:600">✓ boletas casam com a posição a rolar</span>`;
  const mismTable = mism.length ? `
    <div style="margin-bottom:8px">
      <table class="data-table" style="font-size:12px;width:auto">
        <thead><tr><th style="text-align:left">Fundo</th><th style="text-align:left">Ativo</th>
          <th class="num">Esperado</th><th class="num">Σ boletas</th><th class="num">Dif.</th></tr></thead>
        <tbody>${mism.map(m => {
          const [fund, asset] = m.k.split('||');
          return `<tr><td>${fund}</td><td>${asset}</td><td class="num">${fmtFinalQty(m.net)}</td>
            <td class="num">${fmtFinalQty(m.sum)}</td><td class="num" style="color:var(--red)">${fmtFinalQty(m.diff)}</td></tr>`;
        }).join('')}</tbody>
      </table>
    </div>` : '';

  // Painel da CONVERSÃO (quando ligada): o que o servidor de fato aplicou. Serve de tie-out
  // do resumo — as duas contas são a mesma regra, uma em JS e outra em Python.
  const cv = b.conversion;
  const convTable = !cv ? '' : (() => {
    const nc = cv.funds.filter(f => f.converted);
    const resid = cv.residual_minis_total || 0;
    const sideTxt = (cv.sides || []).map(s =>
      `${s.side} em ${s.asset}: ${s.exact_total.toFixed(2).replace(/\.00$/, '')} exatos → <b>${fmtQty(s.target_total)}</b>` +
      (s.lot > 1 ? ` (múltiplo de ${s.lot}; sobra na maior linha, <b>${s.absorbed_by}</b>)` : '')).join(' &nbsp;·&nbsp; ');
    return `<div style="margin-bottom:8px;border:1px solid var(--border);border-radius:6px;padding:6px 8px">
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">
        Conversão <b>${cv.mode === 'cheio' ? 'mini → cheio' : 'cheio → mini'}</b> aplicada às boletas —
        ${nc.length} fundo(s) netaram. ${sideTxt}
      </div>
      ${nc.length ? `<table class="data-table" style="font-size:12px;width:auto">
        <thead><tr><th style="text-align:left">Fundo</th><th class="num">Net mini</th><th class="num">Net cheio</th>
          <th class="num">Exato (${cv.tgt})</th><th class="num">Boleta (${cv.tgt})</th><th class="num">Resíduo (minis)</th></tr></thead>
        <tbody>${nc.map(f => `<tr><td>${f.fund}</td>
          <td class="num">${fmtFinalQty(f.net_mini)}</td><td class="num">${fmtFinalQty(f.net_cheio)}</td>
          <td class="num">${_fmtRolQty(f.exact)}</td><td class="num" style="font-weight:600">${fmtFinalQty(f.qty_tgt)}</td>
          <td class="num">${f.residual_minis ? `<span style="color:var(--yellow)">${f.residual_minis > 0 ? '+' : ''}${f.residual_minis}</span>` : '—'}</td>
        </tr>`).join('')}
        ${cv.funds.filter(f => !f.converted && f.residual_minis).map(f => `<tr style="color:var(--text-muted)">
          <td>${f.fund} <span style="font-size:10px">(absorveu o lote)</span></td>
          <td class="num">${fmtFinalQty(f.net_mini)}</td><td class="num">${fmtFinalQty(f.net_cheio)}</td>
          <td class="num">${_fmtRolQty(f.exact)}</td><td class="num" style="font-weight:600">${fmtFinalQty(f.qty_tgt)}</td>
          <td class="num"><span style="color:var(--yellow)">${f.residual_minis > 0 ? '+' : ''}${f.residual_minis}</span></td>
        </tr>`).join('')}</tbody></table>` : ''}
      <div style="font-size:11px;margin-top:4px;color:${resid ? 'var(--red)' : 'var(--text-muted)'}">
        Resíduo total: ${resid > 0 ? '+' : ''}${resid} minis-equivalentes ${resid ? '(a rolagem não fecha exata na posição — é o arredondamento)' : '(fechou exato)'}
      </div>
    </div>`;
  })();

  // Preço das GERENCIAIS: média das execuções do próprio ativo (ou, quando a conversão
  // zerou a execução daquele ativo, a do outro — declarado aqui, não em silêncio).
  const gp = b.ger_price || {};
  const fb = b.price_fallback || {};
  // '5.450' (ponto sozinho, 3 dígitos) é ambíguo: pt-BR lê milhar, o parser lê decimal.
  // Não adivinhamos — avisamos com o valor que de fato foi gravado na boleta.
  const amb = b.ambiguous_nums || [];
  const ambLine = amb.length ? `
    <div style="font-size:11px;color:var(--red);margin-bottom:8px;line-height:1.5">
      ⚠️ ${amb.length} valor(es) digitados com ponto de milhar podem ter sido lidos ao contrário:
      ${amb.map(a => `<b>${a.asset}</b> exec ${a.row} ${a.field}: digitado <b>${a.typed}</b> → gravado <b>${a.read_as}</b>`).join(' &nbsp;·&nbsp; ')}.
      Se quis milhar, escreva sem o ponto (<b>5450</b>) ou com vírgula decimal (<b>5450,00</b>).
    </div>` : '';

  const gerPxLine = (gp.mini || gp.cheio) ? `
    <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px">
      Preço das gerenciais (média das execuções, ponderada por qtd; toda boleta sai com ponto decimal):
      ${['mini', 'cheio'].map(a => `<b>${a}</b> ${gp[a] || '<span style="color:var(--red)">—</span>'}` +
        (fb[a] ? ` <span style="color:var(--yellow)" title="sem execução própria neste ativo — usou a média do ${fb[a]}, que é o mesmo spread de rolagem">(média do ${fb[a]})</span>` : '')).join(' &nbsp;·&nbsp; ')}
    </div>` : '';

  // Cobertura das EXECUÇÕES por ativo/lado (informativo; base nas execuções informadas)
  const execRows = (b.exec_reconciliation || []).map(e => {
    const diff = e.short ? `<span style="color:var(--red)">faltam ${fmtQty(e.short)}</span>`
      : (e.leftover ? `<span style="color:var(--yellow)">sobram ${fmtQty(e.leftover)}</span>`
      : `<span style="color:var(--green)">ok</span>`);
    // `.data-table td` da casa é right por default (só :first-child é left) — coluna de
    // TEXTO precisa de left explícito, senão fica fora do cabeçalho.
    return `<tr><td>${e.asset}</td><td style="text-align:left">${e.side}</td><td class="num">${fmtQty(e.demand)}</td>
        <td class="num">${fmtQty(e.executed)}</td><td style="text-align:left">${diff}</td></tr>`;
  }).join('');
  const execTable = execRows ? `
    <div style="margin-bottom:8px">
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:2px">Cobertura das execuções (demanda × executado)</div>
      <table class="data-table" style="font-size:12px;width:auto">
        <thead><tr><th style="text-align:left">Ativo</th><th style="text-align:left">Lado</th>
          <th class="num">Demanda</th><th class="num">Executado</th><th style="text-align:left">Cobertura</th></tr></thead>
        <tbody>${execRows}</tbody>
      </table>
    </div>` : '';

  // Prévia mostra só as colunas relevantes (esconde as sempre-vazias); o export leva todas.
  const viewCols = b.columns.filter(c => !ROLAGEM_EMPTY_COLS.has(c));
  // Cabeçalho GRUDADO no topo (a tabela rola dentro de um container de 420px) e alinhado
  // à célula. ☠️ O `.data-table` da casa alinha TUDO à direita (só `:first-child` à esquerda)
  // porque nasceu para tabela de número — mas esta é quase toda texto. O cabeçalho tinha
  // `text-align:left` fixo e as células caíam no default à direita: era esse o desalinho.
  // Agora `_isNumCol` decide os DOIS lados, e o alinhamento vai explícito em th e td.
  const align = c => (_isNumCol(c) ? 'right' : 'left');
  const head = viewCols.map(c =>
    `<th style="position:sticky;top:0;z-index:2;white-space:nowrap;text-align:${align(c)}">${c}</th>`).join('');
  const inSty = 'padding:2px 4px;font-size:11px;background:var(--bg);color:inherit;border:1px solid var(--border);border-radius:3px;width:74px;text-align:right';
  const rows = b.boletas.map((bo, i) => {
    const color = bo._uncovered ? 'color:var(--red)' : (bo._kind === 'real' ? '' : 'color:var(--text-muted)');
    const cells = viewCols.map(c => {
      if (c === 'Quantity') {
        return `<td class="num" style="${color};text-align:right"><input type="text" inputmode="numeric" value="${_effBoletaQty(i)}"
          onchange="setBoletaQty(${i}, this.value)" style="${inSty}"></td>`;
      }
      const v = bo[c];
      return `<td class="${_isNumCol(c) ? 'num' : ''}" style="${color};white-space:nowrap;text-align:${align(c)}">${v == null ? '' : v}</td>`;
    }).join('');
    return `<tr>${cells}</tr>`;
  }).join('');

  el.innerHTML = `
    ${convTable}
    ${mismTable}
    ${ambLine}
    ${gerPxLine}
    ${execTable}
    <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
      <button class="btn btn-secondary" onclick="copyBoletasTSV()" style="padding:5px 14px;font-size:12px">Copiar (TSV)</button>
      <button class="btn btn-secondary" onclick="downloadBoletasCSV()" style="padding:5px 14px;font-size:12px">Baixar CSV</button>
      <span style="font-size:12px;color:var(--text-muted)">${b.boletas.length} boletas — ${nReal} reais · ${nGer} gerenciais &nbsp;·&nbsp; ${matchMsg}</span>
    </div>
    <div style="overflow-x:auto;max-height:420px;overflow-y:auto;border:1px solid var(--border);border-radius:6px">
      <table class="data-table" style="font-size:11px">
        <thead><tr>${head}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// Quantidade efetiva de uma boleta (com ajuste manual, se houver).
function _effBoletaQty(i) {
  return (i in rolagemQtyEdit) ? rolagemQtyEdit[i] : rolagemBoletas.boletas[i].Quantity;
}
function setBoletaQty(i, val) {
  const n = parseInt(val, 10);
  if (Number.isFinite(n)) rolagemQtyEdit[i] = n;
  else delete rolagemQtyEdit[i];
  _renderBoletaPreview();
}

// Colunas de data do layout JDS — no paste elas vão em mm/dd/aaaa (a config é digitada
// em dd/mm/aaaa, formato BR). Converte só o que casa exatamente dd/mm/aaaa.
const _ROLAGEM_DATE_COLS = new Set(['Deal Date', 'Value date', 'Fixing date']);
function _ddmm2mmdd(s) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(s).trim());
  return m ? `${m[2]}/${m[1]}/${m[3]}` : s;
}

// Linhas do export, só com as colunas JDS na ordem (usa a qtd EFETIVA). includeHeader
// controla o cabeçalho. Colunas sempre-vazias entram como '' (contam no paste).
function _boletasMatrix(includeHeader) {
  const cols = rolagemBoletas.columns;
  const lines = includeHeader ? [cols.slice()] : [];
  rolagemBoletas.boletas.forEach((bo, i) => {
    lines.push(cols.map(c => {
      if (c === 'Quantity') return _effBoletaQty(i);
      const v = bo[c] == null ? '' : bo[c];
      return _ROLAGEM_DATE_COLS.has(c) ? _ddmm2mmdd(v) : v;   // datas → mm/dd/aaaa no paste
    }));
  });
  return { cols, lines };
}

function copyBoletasTSV() {
  if (!rolagemBoletas || !rolagemBoletas.boletas?.length) return;
  const { lines } = _boletasMatrix(false);   // sem cabeçalho (cola direto na planilha do JDS)
  const tsv = lines.map(row => row.join('\t')).join('\n');
  const status = document.getElementById('refStatus');
  navigator.clipboard.writeText(tsv).then(() => {
    if (status) { status.textContent = 'Boletas copiadas (TSV)'; status.style.color = 'var(--text-muted)'; }
  }).catch(e => {
    if (status) { status.textContent = 'Erro ao copiar: ' + e.message; status.style.color = 'var(--red)'; }
  });
}

function downloadBoletasCSV() {
  if (!rolagemBoletas || !rolagemBoletas.boletas?.length) return;
  const { lines } = _boletasMatrix(true);   // CSV (arquivo) mantém o cabeçalho
  const csv = lines.map(row => row.map(v => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `rolagem_dolar_boletas_${rolagemBoletas.target_month || ''}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

/* ── Consolidado Dólar (por trader) ──────────────────────────────────────── */
