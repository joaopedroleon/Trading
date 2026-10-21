/* ── Hedge Cambial · Controle ──────────────────────────────────────────────────
   O relatório diário "Cash BRL exposure" (PDF do backoffice) diz o descasamento de
   caixa em BRL de cada trader, por fundo. Esta aba o transforma em boletas JDS:
   primeiro as GERENCIAIS entre os traders da mesa, fundo a fundo, e depois o que
   sobrar — o resíduo — opcionalmente a mercado.

   ⭐ **A visão do relatório é em BRL e o número é POSITIVO quando o trader está
   comprado em real** — ou seja, vendido em dólar: para zerar ele COMPRA dólar
   futuro. A tela fala sempre em "comprar/vender dólar futuro" para que o sinal
   nunca precise ser traduzido de cabeça na hora de boletar.

   ☠️ **O relatório está em DOL CHEIO (US$ 50 mil) e a boleta sai em MINI
   (US$ 10 mil).** A coluna "Pos Eqv Futuro" do próprio relatório é em cheio; a
   quantidade da boleta é `round(kUSD/10)`. Trocar as duas escalas erra o hedge por
   5× e os dois números são plausíveis — por isso a tela imprime as duas colunas
   lado a lado (minis a boletar e o equivalente em cheio do relatório).

   A matemática toda mora no servidor (`positions/hedge_controle.py` +
   `/api/positions/hedge-cambial/*`): aqui só há tela. */

const HEDGE_TAB_ID = 'controle';
// Qual das duas telas do dropdown "Hedge Cambial" está ativa. Persiste para o F5
// não devolver sempre a Rolagem a quem vive na aba de Controle.
const LS_HEDGE_VIEW = 'jgp_pos_hedge_view_v1';

let hedgeRelatorio = null;    // último retorno de POST /relatorio (a matriz lida)
let hedgeContexto = null;     // último retorno de GET /contexto (posição viva + ajuste)
let hedgePlano = null;        // último retorno de POST /plano
let hedgeTraders = null;      // Set de traders no netting (null = ainda não montado)
let hedgeMktSel = {};         // 'trader||fund' → qtd escolhida para ir a mercado
let _hedgeCfgLoaded = false;

// Config das colunas fixas da boleta + preço/corretora do resíduo. Mesmo espírito do
// `rolagemConfig`. ⚠️ `deal_date` NÃO persiste — ver a mesma nota em pos-rolagem.js:
// persistido, ele volta com a data de ontem e a boleta sai datada errada.
const hedgeConfig = {
  deal_date: '', counterparty_gerencial: 'Gerencial', giveup: '', deal_type: '',
  value_date: '', fixing_date: '', fo_remark: '', bo_remark: '',
  obs_reserved: '', ignore_previous: '',
  limiar_kusd: 10, instrument: '', price: '', price_date: '',
  mkt_price: '', mkt_broker: (typeof ROLAGEM_BROKER_DEFAULT === 'string' ? ROLAGEM_BROKER_DEFAULT : 'Ativa CTVC'),
};
const LS_HEDGE_CFG = 'jgp_hedge_cfg_v1';
const _HEDGE_CFG_PERSIST = ['counterparty_gerencial', 'giveup', 'deal_type', 'value_date',
  'fixing_date', 'fo_remark', 'bo_remark', 'obs_reserved', 'ignore_previous',
  'limiar_kusd', 'mkt_broker'];

function saveHedgeConfig() {
  try {
    localStorage.setItem(LS_HEDGE_CFG, JSON.stringify(
      _HEDGE_CFG_PERSIST.reduce((o, k) => (o[k] = hedgeConfig[k], o), {})));
  } catch (_) {}
}
function loadHedgeConfig() {
  if (_hedgeCfgLoaded) return;
  _hedgeCfgLoaded = true;
  try {
    const d = JSON.parse(localStorage.getItem(LS_HEDGE_CFG) || 'null');
    if (d && typeof d === 'object') {
      for (const k of _HEDGE_CFG_PERSIST) if (d[k] !== undefined) hedgeConfig[k] = d[k];
    }
  } catch (_) {}
}

/* ── Troca entre as duas telas do dropdown (Rolagem Dol · Controle Exposição) ── */
// O botão da barra é UM só e se chama "Hedge Cambial": ele NÃO é uma tela, é o rótulo
// do grupo. Clicar nele abre o droplist (o <select> cobre o botão inteiro, ver
// positions-v2.css); quem escolhe a tela é o menu, e é ele que escreve o `data-tab` do
// botão — por onde o `_showPanel` (pos-tabs.js) decide qual painel acende.
const HEDGE_VIEW_LABEL = { [ROLAGEM_TAB_ID]: 'Rolagem Dol', [HEDGE_TAB_ID]: 'Controle Exposição' };

// Marca com ✓ a tela ativa no TEXTO das opções. O rótulo do botão não diz qual é
// (é só "Hedge Cambial", por pedido da mesa), então sem isto o droplist não teria
// como mostrar onde você está.
function _hedgeSyncViewOptions(ativa) {
  const sel = document.getElementById('hedgeViewSelect');
  if (!sel) return;
  for (const op of sel.options) {
    if (!op.value) continue;
    op.textContent = (op.value === ativa ? '✓ ' : '  ') + HEDGE_VIEW_LABEL[op.value];
  }
}

function changeHedgeView(view) {
  if (view !== HEDGE_TAB_ID && view !== ROLAGEM_TAB_ID) return;   // placeholder vazio
  const btn = document.getElementById('tab-btn-hedge');
  if (!btn) return;
  btn.dataset.tab = view;
  try { localStorage.setItem(LS_HEDGE_VIEW, view); } catch (_) {}
  _hedgeSyncViewOptions(view);
  activateTab(view);
}

// Restaura a tela escolhida da última vez (sem ativar a aba — o boot decide qual aba
// abre). Chamado pelo boot da página.
function initHedgeView() {
  let v = ROLAGEM_TAB_ID;
  try { v = localStorage.getItem(LS_HEDGE_VIEW) || ROLAGEM_TAB_ID; } catch (_) {}
  if (v !== HEDGE_TAB_ID && v !== ROLAGEM_TAB_ID) v = ROLAGEM_TAB_ID;
  const btn = document.getElementById('tab-btn-hedge');
  if (btn) btn.dataset.tab = v;
  _hedgeSyncViewOptions(v);
}

/* ── Carga ────────────────────────────────────────────────────────────────── */
function showControleTab() {
  activeTraderTab = HEDGE_TAB_ID;
  _showPanel(HEDGE_TAB_ID);
  loadHedgeConfig();
  if (!hedgeContexto) loadHedgeContexto();
  else renderHedge();
}

// opts.fresh: fura o cache de 120s da posição no servidor — é o "↻ Posição e ajuste".
// A carga normal (abrir a aba, trocar o ativo) usa o cache: a posição é a mesma e as
// duas queries custam ~8s.
async function loadHedgeContexto(opts = {}) {
  const status = document.getElementById('refStatus');
  PosBusy.on('hedge');
  if (status) { status.textContent = 'Buscando posição de hedge...'; status.style.color = 'var(--text-muted)'; }
  try {
    const p = new URLSearchParams();
    const rd = document.getElementById('refDate').value;
    const fo = document.getElementById('forceOpening').value;
    if (rd) p.set('ref_date', rd);
    if (fo) p.set('force_opening', fo);
    if (opts.fresh) p.set('fresh', '1');
    if (hedgeConfig.instrument) p.set('instrument', hedgeConfig.instrument);
    if (hedgeConfig.price_date) p.set('price_date', hedgeConfig.price_date);
    const data = await (await fetch(`${API_BASE}/api/positions/hedge-cambial/contexto?${p}`)).json();
    if (data.error) throw new Error(data.error);
    hedgeContexto = data;
    _noteFetchSig(HEDGE_TAB_ID);
    // Só preenche o que o usuário ainda não digitou — um "Atualizar" não pode
    // apagar o ticker ou o preço que a mesa sobrescreveu à mão.
    if (!hedgeConfig.instrument) hedgeConfig.instrument = data.instrument || '';
    if (!hedgeConfig.price_date) hedgeConfig.price_date = data.price_date || '';
    if (hedgeConfig.price === '' && data.price != null) hedgeConfig.price = String(data.price);
    if (!hedgeConfig.deal_date) hedgeConfig.deal_date = _fmtDDMMYYYY(data.ref_date || '');
    if (status) status.textContent = '';
    // ⚠️ Posição e ajuste mudaram ⇒ o plano que está na tela é de outro contrato/preço.
    // Refaz (e já re-renderiza) em vez de deixar os dois discordando em silêncio.
    if (hedgeRelatorio) { await gerarPlanoHedge(); return; }
  } catch (e) {
    if (status) { status.textContent = 'Erro: ' + e.message; status.style.color = 'var(--red)'; }
  } finally {
    PosBusy.off('hedge');
    renderHedge();
  }
}

/* ── Render ───────────────────────────────────────────────────────────────── */
function renderHedge() {
  _hedgeRenderControles();
  _hedgeRenderRelatorio();
  _hedgeRenderPlano();
  _hedgeRenderBoletas();
}

function _hedgeNum(v, dec = 2) {
  if (v == null || v === '') return '—';
  return Number(v).toLocaleString('pt-BR', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
// Quantidade de contrato: inteiro COM sinal explícito — a leitura é "compra/venda",
// e um `+` ausente num número solto já foi lido como venda nesta mesa.
function _hedgeQty(v) {
  const n = Number(v || 0);
  if (!n) return '0';
  return (n > 0 ? '+' : '') + n.toLocaleString('pt-BR');
}
function _hedgeCor(v) {
  const n = Number(v || 0);
  return n > 0 ? 'color:var(--green)' : (n < 0 ? 'color:var(--red)' : 'color:var(--text-muted)');
}

function _hedgeRenderControles() {
  const el = document.getElementById('hedgeControls');
  if (!el) return;
  const c = hedgeContexto || {};
  const pxNota = hedgeConfig.price !== '' && c.price != null && Number(hedgeConfig.price) !== Number(c.price)
    ? ` <span style="color:var(--amber,#c90)">(editado — ajuste era ${_hedgeNum(c.price, 3)})</span>` : '';
  el.innerHTML = `
    <div class="card" style="display:flex;flex-direction:column;gap:10px">
      <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end">
        ${_hedgeInput('Instrumento (mini)', 'instrument', hedgeConfig.instrument, 'WDOX26 Curncy', 140)}
        ${_hedgeInput('Ajuste de (D-1)', 'price_date', hedgeConfig.price_date, 'aaaa-mm-dd', 110)}
        ${_hedgeInput('Preço (ajuste)', 'price', hedgeConfig.price, '—', 100)}
        ${_hedgeInput('Deal Date', 'deal_date', hedgeConfig.deal_date, 'dd/mm/aaaa', 100)}
        ${_hedgeInput('Limiar (kUSD)', 'limiar_kusd', hedgeConfig.limiar_kusd, '10', 80)}
        <button class="btn btn-secondary" onclick="hedgeContexto=null;loadHedgeContexto({fresh:true})"
                style="padding:5px 14px;font-size:12px"
                title="Rebusca a posição viva de Hedge_Cambial e o ajuste de D-1 no Oracle/Bloomberg (fura o cache de 2 min) e refaz o plano.">↻ Posição e ajuste</button>
      </div>
      <div style="font-size:11px;color:var(--text-muted)">
        Ativo e ajuste vêm da posição viva de <b>Hedge_Cambial</b> e do <code>PX_SETTLE</code> de
        ${c.price_date ? fmtDate(c.price_date) : 'D-1'}${pxNota}.
        ${c.price_error ? `<span style="color:var(--red)"> ${c.price_error}</span>` : ''}
        O vencimento não é calculado do calendário: é aquele onde a posição está hoje.
      </div>
      <div id="hedgeTraderChips" style="display:flex;gap:6px;flex-wrap:wrap;align-items:center"></div>
    </div>`;
  _hedgeRenderChips();
}

function _hedgeInput(label, key, val, ph, w) {
  return `<label style="display:flex;flex-direction:column;gap:2px;font-size:11px;color:var(--text-muted)">
    ${label}
    <input type="text" id="hedgeCfg-${key}" value="${val == null ? '' : String(val).replace(/"/g, '&quot;')}"
           placeholder="${ph}" style="width:${w}px;font-size:12px"
           onchange="setHedgeCfg('${key}', this.value)">
  </label>`;
}
/* ☠️ **Invalidar o plano sem REFAZÊ-LO esvazia a tela.** Era `hedgePlano = null;
   renderHedge()` — e qualquer campo que se mexesse (o preço de mercado, o limiar, um chip
   de trader) apagava as seções 02 e 03 inteiras, sem nada no lugar e sem nenhum request
   em voo: a tela voltava para "Carregue o relatório", com o relatório carregado logo
   acima. Quem invalida tem de disparar o recálculo; sem relatório não há o que refazer,
   e aí só o render mesmo. */
function _hedgeInvalidarPlano() {
  if (hedgeRelatorio) gerarPlanoHedge();   // termina em renderHedge()
  else { hedgePlano = null; renderHedge(); }
}

function setHedgeCfg(key, val) {
  hedgeConfig[key] = val;
  saveHedgeConfig();
  // Trocar ativo ou data do ajuste muda o PREÇO — e um plano com o preço do
  // contrato antigo é boleta errada. Força rebuscar em vez de manter o número velho.
  // ⚠️ `loadHedgeContexto` refaz o plano no fim: sem isso a tela ficaria com o plano
  // ANTIGO (ticker e preço velhos) ao lado da tira de controles já atualizada.
  if (key === 'instrument' || key === 'price_date') {
    hedgeConfig.price = '';
    hedgeContexto = null;
    loadHedgeContexto();
    return;
  }
  _hedgeInvalidarPlano();
}

function _hedgeTradersDisponiveis() {
  const doRel = (hedgeRelatorio?.linhas || []).map(l => l.trader);
  const padrao = hedgeContexto?.traders_padrao || ['ECotrim', 'EMota', 'GBranquinho', 'LAguiar', 'PAbinader'];
  return [...new Set([...padrao, ...doRel])];
}

function _hedgeRenderChips() {
  const el = document.getElementById('hedgeTraderChips');
  if (!el) return;
  if (!hedgeTraders) {
    hedgeTraders = new Set(hedgeContexto?.traders_padrao
      || ['ECotrim', 'EMota', 'GBranquinho', 'LAguiar', 'PAbinader']);
  }
  const chips = _hedgeTradersDisponiveis().map(t => {
    const on = hedgeTraders.has(t);
    return `<button class="btn ${on ? '' : 'btn-secondary'}" onclick="toggleHedgeTrader('${t}')"
      style="padding:3px 10px;font-size:11px;${on ? '' : 'opacity:.55'}">${on ? '✓ ' : ''}${t}</button>`;
  }).join('');
  el.innerHTML = `<span style="font-size:11px;color:var(--text-muted);margin-right:4px">
      Netam entre si:</span>${chips}
    <span style="font-size:11px;color:var(--text-muted);margin-left:6px">
      Quem fica de fora aparece no relatório mas não gera boleta.</span>`;
}
function toggleHedgeTrader(t) {
  if (hedgeTraders.has(t)) hedgeTraders.delete(t); else hedgeTraders.add(t);
  // Tirar/pôr um trader muda o netting do fundo inteiro — tem de refazer, não só apagar.
  _hedgeInvalidarPlano();
}

/* ── Seção 01 — o relatório ───────────────────────────────────────────────── */
function _hedgeRenderRelatorio() {
  const el = document.getElementById('hedgeRelatorio');
  if (!el) return;
  const r = hedgeRelatorio;
  const entrada = `
    <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center">
      <label class="btn" style="padding:6px 16px;font-size:13px;cursor:pointer">
        📄 Carregar PDF
        <input type="file" accept="application/pdf,.pdf" style="display:none"
               onchange="hedgeUploadPdf(this)">
      </label>
      <button class="btn btn-secondary" onclick="toggleHedgeColar()"
              style="padding:6px 14px;font-size:12px">ou colar a tabela</button>
      ${r ? `<span style="font-size:12px;color:var(--text-muted)">
        ${r.filename ? r.filename + ' · ' : ''}${r.as_of ? 'as of <b>' + fmtDate(r.as_of) + '</b>' : 'sem data no título'}
        · ${r.linhas.length} traders · ${r.fundos.length} fundos · lido do ${r.origem}</span>` : ''}
      <span id="hedgeUpStatus" style="font-size:12px;color:var(--text-muted)"></span>
    </div>
    <div id="hedgeColarBox" style="display:none;margin-top:8px">
      <textarea id="hedgeColarTxt" rows="6" placeholder="Cole aqui a tabela copiada do e-mail ou do Excel (Trader + colunas de fundo + Total + Pos Eqv Futuro)"
        style="width:100%;font-family:ui-monospace,monospace;font-size:11px"></textarea>
      <button class="btn" onclick="hedgeColar()" style="padding:5px 14px;font-size:12px;margin-top:4px">Ler texto colado</button>
    </div>`;

  if (!r) {
    el.innerHTML = `<div class="card" style="display:flex;flex-direction:column;gap:8px">
      ${entrada}
      <div style="font-size:12px;color:var(--text-muted)">
        O relatório é o <i>Cash BRL exposure</i> do backoffice, em <b>milhares de USD</b> e na
        visão <b>BRL</b>: célula positiva = trader comprado em real naquele fundo ⇒ precisa
        <b>comprar</b> dólar futuro.
      </div></div>`;
    return;
  }

  // Conferência: as duas identidades do próprio relatório (Σ fundos = Total e
  // Pos Eqv Futuro = −round(Total/50)). É o que separa "li o PDF" de "li o certo".
  const probs = r.conferencia || [];
  const badge = probs.length
    ? `<span style="color:var(--red);font-weight:600">⚠ ${probs.length} linha(s) não fecham com o próprio relatório — confira a leitura antes de boletar</span>`
    : `<span style="color:var(--green);font-weight:600">✓ leitura confere com o relatório (soma dos fundos e Pos Eqv Futuro)</span>`;
  const probTxt = probs.length
    ? `<div style="font-size:11px;color:var(--red)">${probs.map(p =>
        `${p.trader}: ${p.tipo === 'soma' ? 'Σ fundos' : 'Pos Eqv Futuro'} lido ${p.lido}, relatório diz ${p.esperado}`
      ).join(' · ')}</div>` : '';
  const avisos = (r.avisos || []).length
    ? `<div style="font-size:11px;color:var(--amber,#c90)">${r.avisos.join(' · ')}</div>` : '';

  // ⛔ Fundo fora do grupo MM (hoje o Equinox): continua LIDO e dentro da conferência,
  // mas sai do netting — então aparece apagado, com o porquê no hover. Quem manda é o
  // servidor (`fundos_ignorados`): repetir a lista aqui criaria uma 2ª fonte da verdade.
  const ign = new Set(hedgePlano?.fundos_ignorados || []);
  const thIgn = f => ign.has(f)
    ? ' style="opacity:.45" title="Fora do grupo MM — não entra no netting nem gera boleta"' : '';

  const head = `<tr><th>Trader</th>${r.fundos.map(f =>
    `<th class="num"${thIgn(f)}>${f.replace(/^JGP /, '')}</th>`).join('')}<th class="num">Total</th><th class="num">Pos Eqv Fut (cheio)</th></tr>`;
  const body = r.linhas.map(l => {
    const dentro = hedgeTraders && hedgeTraders.has(l.trader);
    return `<tr style="${dentro ? '' : 'opacity:.45'}">
      <td style="font-weight:${dentro ? 600 : 400}">${l.trader}</td>
      ${r.fundos.map(f => `<td class="num" style="${_hedgeCor(l.fundos[f])}${ign.has(f) ? ';opacity:.4' : ''}">${_hedgeNum(l.fundos[f])}</td>`).join('')}
      <td class="num" style="${_hedgeCor(l.total)};font-weight:600">${_hedgeNum(l.total)}</td>
      <td class="num" style="${_hedgeCor(l.pos_eqv)}"
          title="Posição equivalente que o trader JÁ tem, em contratos cheios — é a coluna do próprio relatório. Para zerar, a negociação é o oposto dela.">${_hedgeQty(l.pos_eqv)}</td></tr>`;
  }).join('');

  el.innerHTML = `<div class="card" style="display:flex;flex-direction:column;gap:8px">
    ${entrada}
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">${badge}</div>
    ${probTxt}${avisos}
    <div style="overflow-x:auto"><table class="data-table" style="font-size:11px">
      <thead>${head}</thead><tbody>${body}</tbody></table></div>
    <div style="font-size:11px;color:var(--text-muted)">
      Valores em <b>milhares de USD</b>, visão BRL. A última coluna é a do próprio relatório
      (posição equivalente em <b>cheio</b>); a boleta sai em <b>mini</b> — ver a seção seguinte.
      ${ign.size ? `<br>⛔ <b>${[...ign].map(f => f.replace(/^JGP /, '')).join(' · ')}</b>
        ${ign.size > 1 ? 'ficam' : 'fica'} de fora do netting: fundo fora do grupo MM, onde os
        traders acompanhados aqui não alocam. A coluna continua sendo lida (entra na conferência
        do relatório), só não gera boleta.` : ''}
    </div></div>`;
}

function toggleHedgeColar() {
  const b = document.getElementById('hedgeColarBox');
  if (b) b.style.display = b.style.display === 'none' ? 'block' : 'none';
}

async function hedgeUploadPdf(input) {
  const f = input.files && input.files[0];
  if (!f) return;
  await _hedgeEnviarRelatorio(await f.arrayBuffer(), 'pdf', f.name);
  input.value = '';    // permite recarregar o MESMO arquivo depois de corrigi-lo
}
async function hedgeColar() {
  const txt = (document.getElementById('hedgeColarTxt') || {}).value || '';
  if (!txt.trim()) return;
  await _hedgeEnviarRelatorio(new TextEncoder().encode(txt), 'texto', 'colado');
}

async function _hedgeEnviarRelatorio(body, formato, filename) {
  const st = document.getElementById('hedgeUpStatus');
  if (st) { st.textContent = 'Lendo...'; st.style.color = 'var(--text-muted)'; }
  PosBusy.on('hedge-rel');
  try {
    const q = new URLSearchParams({ formato, filename });
    const resp = await fetch(`${API_BASE}/api/positions/hedge-cambial/relatorio?${q}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body,
    });
    const data = await resp.json();
    if (data.error) throw new Error(data.error);
    hedgeRelatorio = data;
    hedgePlano = null;
    hedgeMktSel = {};
    if (st) st.textContent = '';
    await gerarPlanoHedge();
  } catch (e) {
    if (st) { st.textContent = e.message; st.style.color = 'var(--red)'; }
  } finally {
    PosBusy.off('hedge-rel');
    renderHedge();
  }
}

/* ── Seção 02 — necessidade, netting e resíduo ────────────────────────────── */
async function gerarPlanoHedge() {
  if (!hedgeRelatorio) return;
  const st = document.getElementById('refStatus');
  PosBusy.on('hedge-plano');
  try {
    const linhas = Object.entries(hedgeMktSel)
      .map(([k, q]) => ({ trader: k.split('||')[0], fund: k.split('||')[1], qty: Number(q) || 0 }))
      .filter(x => x.qty);
    const payload = {
      ref_date: document.getElementById('refDate').value || undefined,
      force_opening: document.getElementById('forceOpening').value || undefined,
      relatorio: hedgeRelatorio,
      traders: [...(hedgeTraders || [])],
      limiar_kusd: Number(hedgeConfig.limiar_kusd) || 0,
      instrument: hedgeConfig.instrument || undefined,
      price: hedgeConfig.price === '' ? undefined : hedgeConfig.price,
      price_date: hedgeConfig.price_date || undefined,
      config: hedgeConfig,
      mercado: { linhas, price: hedgeConfig.mkt_price, broker: hedgeConfig.mkt_broker },
    };
    const data = await (await fetch(`${API_BASE}/api/positions/hedge-cambial/plano`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })).json();
    if (data.error) throw new Error(data.error);
    hedgePlano = data;
    // O servidor descartou marcações que deixaram de ser resíduo — tira-as do estado da
    // tela também, senão o checkbox reapareceria marcado numa linha que não existe mais
    // e a próxima geração mandaria tudo de volta. O aviso de que foram descartadas sai
    // nos `checks`, logo acima da tabela.
    for (const m of (data.mercado_ignorado || [])) delete hedgeMktSel[`${m.trader}||${m.fund}`];
  } catch (e) {
    if (st) { st.textContent = 'Erro no plano: ' + e.message; st.style.color = 'var(--red)'; }
  } finally {
    PosBusy.off('hedge-plano');
    renderHedge();
  }
}

function _hedgeRenderPlano() {
  const el = document.getElementById('hedgePlano');
  if (!el) return;
  const p = hedgePlano;
  if (!p) {
    el.innerHTML = `<div class="card no-data">Carregue o relatório — o plano é montado em seguida.</div>`;
    return;
  }
  const fundos = p.fundos, traders = p.traders;
  const cab = f => f.replace(/^JGP /, '');

  // Matriz: necessidade · casado · resíduo, por (trader, fundo).
  const linha = (t) => {
    const cells = fundos.map(f => {
      const need = p.need[t][f] || 0;
      const cas = (p.casado[f] || {})[t] || 0;
      const res = need - cas;
      if (!need && !cas) return `<td class="num" style="color:var(--text-muted)">·</td>`;
      return `<td class="num" title="necessidade ${_hedgeQty(need)} · gerencial ${_hedgeQty(cas)} · resíduo ${_hedgeQty(res)}">
        <span style="${_hedgeCor(need)}">${_hedgeQty(need)}</span>
        <span style="font-size:10px;color:var(--text-muted)"> → ${_hedgeQty(cas)}</span>
        ${res ? `<span style="font-size:10px;${_hedgeCor(res)}"> | ${_hedgeQty(res)}</span>` : ''}
      </td>`;
    }).join('');
    const sn = fundos.reduce((a, f) => a + (p.need[t][f] || 0), 0);
    const sc = fundos.reduce((a, f) => a + ((p.casado[f] || {})[t] || 0), 0);
    return `<tr><td style="font-weight:600">${t}</td>${cells}
      <td class="num" style="${_hedgeCor(sn)};font-weight:600">${_hedgeQty(sn)}</td>
      <td class="num" style="${_hedgeCor(sc)}">${_hedgeQty(sc)}</td>
      <td class="num" style="${_hedgeCor(sn - sc)};font-weight:600">${_hedgeQty(sn - sc)}</td></tr>`;
  };
  // ⚠️ A coluna "Gerencial" soma ZERO por construção — é a invariante do netting, não
  // um total vazio. O resíduo total é, portanto, igual à necessidade total: o que as
  // gerenciais fazem é redistribuir, nunca reduzir o descasamento AGREGADO da mesa.
  const needTot = traders.reduce((a, t) => a + fundos.reduce((b, f) => b + (p.need[t][f] || 0), 0), 0);
  const rodape = `<tr style="font-weight:600;border-top:2px solid var(--border)">
    <td>Total</td>
    ${fundos.map(f => {
      const s = traders.reduce((a, t) => a + (p.need[t][f] || 0), 0);
      const c = (p.resumo.find(x => x.fund === f) || {}).casado || 0;
      return `<td class="num" title="necessidade líquida do fundo ${_hedgeQty(s)} · ${c} mini(s) casados entre os traders">
        <span style="${_hedgeCor(s)}">${_hedgeQty(s)}</span>
        <span style="font-size:10px;color:var(--text-muted)"> · casa ${c}</span></td>`;
    }).join('')}
    <td class="num" style="${_hedgeCor(needTot)}">${_hedgeQty(needTot)}</td>
    <td class="num" title="o netting redistribui, não reduz o descasamento agregado — esta soma é sempre zero">0</td>
    <td class="num" style="${_hedgeCor(needTot)}">${_hedgeQty(needTot)}</td></tr>`;

  const casadoTot = p.resumo.reduce((a, x) => a + x.casado, 0);
  const resTot = p.residuo.reduce((a, x) => a + Math.abs(x.qty), 0);

  el.innerHTML = `
    <div class="card" style="display:flex;flex-direction:column;gap:10px">
      <div style="font-size:12px;color:var(--text-muted)">
        Quantidades em <b>minis (WDO)</b> e com sinal: <b>+ compra</b> dólar futuro,
        <b>− vende</b>. Cada célula traz <b>necessidade → gerencial</b> e, quando sobra,
        <b>| resíduo</b>. Célula com |exposição| abaixo de
        <b>${_hedgeNum(p.limiar_kusd, 0)} kUSD</b> não vira boleta.
      </div>
      <div style="overflow-x:auto"><table class="data-table" style="font-size:11px">
        <thead><tr><th>Trader</th>${fundos.map(f => `<th class="num">${cab(f)}</th>`).join('')}
          <th class="num">Necess.</th><th class="num">Gerencial</th><th class="num">Resíduo</th></tr></thead>
        <tbody>${traders.map(linha).join('')}${rodape}</tbody></table></div>
      <div style="font-size:12px">
        <b>${casadoTot}</b> minis casados entre os traders (${p.n_gerencial} boletas gerenciais) ·
        <b>${resTot}</b> minis de resíduo.
      </div>
      ${_hedgeChecks(p)}
      ${_hedgeResiduoTabela(p)}
    </div>`;
}

function _hedgeChecks(p) {
  const c = p.checks || [];
  if (!c.length) return `<div style="font-size:12px;color:var(--green);font-weight:600">
    ✓ gerenciais somam zero em todos os fundos · todos os fundos e traders casaram com o JDS</div>`;
  return `<div style="font-size:12px;color:var(--red);display:flex;flex-direction:column;gap:2px">
    ${c.map(x => `<div>⚠ ${x.msg}${x.fund ? ` — ${x.fund}` : ''}${x.trader ? ` / ${x.trader}` : ''}</div>`).join('')}</div>`;
}

function _hedgeResiduoTabela(p) {
  if (!p.residuo.length) {
    return `<div style="font-size:12px;color:var(--text-muted)">Sem resíduo — as gerenciais zeram tudo.</div>`;
  }
  const rows = p.residuo.map(r => {
    const k = `${r.trader}||${r.fund}`;
    const sel = hedgeMktSel[k];
    return `<tr>
      <td><input type="checkbox" ${sel ? 'checked' : ''} onchange="toggleHedgeMkt('${k}', ${r.qty}, this.checked)"></td>
      <td>${r.trader}</td><td>${r.fund.replace(/^JGP /, '')}</td>
      <td class="num" style="${_hedgeCor(r.qty)}">${_hedgeQty(r.qty)}</td>
      <td class="num"><input type="text" inputmode="numeric" value="${sel ?? ''}" placeholder="—"
          onchange="setHedgeMkt('${k}', this.value)"
          style="width:70px;text-align:right;font-size:11px"></td>
      <td style="font-size:10px;color:var(--text-muted)">${r.fund_label || '⚠ sem fundo no JDS'}</td></tr>`;
  }).join('');
  const selTot = Object.values(hedgeMktSel).reduce((a, v) => a + Math.abs(Number(v) || 0), 0);
  return `
    <div class="block-header" style="margin-top:4px">Resíduo — o que não casou entre os traders</div>
    <div style="font-size:12px;color:var(--text-muted)">
      Marque o que você vai levar <b>a mercado</b> e informe preço e corretora. O que ficar
      desmarcado segue descasado mesmo — é a decisão da mesa, não um erro da tela.
      ⚠️ A área da boleta de mercado é escolhida sobre a posição <b>já reduzida</b> pelas gerenciais.
    </div>
    <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;margin:6px 0">
      ${_hedgeInput('Preço (mercado)', 'mkt_price', hedgeConfig.mkt_price, 'vazio = ajuste', 110)}
      <label style="display:flex;flex-direction:column;gap:2px;font-size:11px;color:var(--text-muted)">Corretora
        <select onchange="setHedgeCfg('mkt_broker', this.value)" style="font-size:12px">
          ${(typeof ROLAGEM_BROKERS !== 'undefined' ? ROLAGEM_BROKERS : ['Ativa CTVC']).map(b =>
            `<option ${b === hedgeConfig.mkt_broker ? 'selected' : ''}>${b}</option>`).join('')}
        </select></label>
      <button class="btn btn-secondary" onclick="hedgeMarcarTodoResiduo()" style="padding:5px 12px;font-size:12px">Marcar tudo</button>
      <button class="btn btn-secondary" onclick="hedgeMktSel={};gerarPlanoHedge()" style="padding:5px 12px;font-size:12px">Limpar</button>
      <button class="btn" onclick="gerarPlanoHedge()" style="padding:5px 16px;font-size:12px">Recalcular</button>
      <span style="font-size:12px;color:var(--text-muted)">${selTot} mini(s) marcado(s) · ${p.n_mercado} boleta(s) de mercado</span>
    </div>
    <div style="overflow-x:auto;max-height:300px;overflow-y:auto;border:1px solid var(--border);border-radius:6px">
      <table class="data-table" style="font-size:11px">
        <thead><tr><th></th><th>Trader</th><th>Fundo</th><th class="num">Resíduo</th>
          <th class="num">A mercado</th><th>Fundo no JDS</th></tr></thead>
        <tbody>${rows}</tbody></table></div>`;
}

function toggleHedgeMkt(k, qty, on) {
  if (on) hedgeMktSel[k] = qty; else delete hedgeMktSel[k];
  gerarPlanoHedge();
}
function setHedgeMkt(k, v) {
  const n = parseInt(v, 10);
  if (Number.isFinite(n) && n !== 0) hedgeMktSel[k] = n; else delete hedgeMktSel[k];
  gerarPlanoHedge();
}
function hedgeMarcarTodoResiduo() {
  if (!hedgePlano) return;
  hedgeMktSel = {};
  for (const r of hedgePlano.residuo) hedgeMktSel[`${r.trader}||${r.fund}`] = r.qty;
  gerarPlanoHedge();
}

/* ── Seção 03 — boletas ───────────────────────────────────────────────────── */
// Colunas do JDS que ficam sempre vazias: escondidas na prévia, presentes no export
// (o paste no JDS conta coluna). Mesma regra da Rolagem Dólar.
const _HEDGE_HIDE_COLS = new Set(['Giveup Counterparty', 'Deal Type', 'Value date',
  'Fixing date', 'FO Remark', 'BO Remark', '(OBS) Reserved',
  'Ignore previous positions', 'Auxiliary number']);

function _hedgeRenderBoletas() {
  const el = document.getElementById('hedgeBoletas');
  if (!el) return;
  const p = hedgePlano;
  if (!p || !p.boletas.length) {
    el.innerHTML = `<div class="card no-data">Sem boletas — carregue o relatório e confira o plano acima.</div>`;
    return;
  }
  const vis = p.columns.filter(c => !_HEDGE_HIDE_COLS.has(c));
  const head = `<tr><th>Tipo</th>${vis.map(c => `<th${c === 'Quantity' || c === 'Price' ? ' class="num"' : ''}>${c}</th>`).join('')}</tr>`;
  const rows = p.boletas.map(b => {
    const ger = b._kind === 'gerencial';
    return `<tr><td style="font-size:10px;color:${ger ? 'var(--text-muted)' : 'var(--green)'}">${ger ? 'ger' : 'mercado'}</td>
      ${vis.map(c => c === 'Quantity'
        ? `<td class="num" style="${_hedgeCor(b[c])}">${_hedgeQty(b[c])}</td>`
        : `<td${c === 'Price' ? ' class="num"' : ''}>${b[c] == null ? '' : b[c]}</td>`).join('')}</tr>`;
  }).join('');

  el.innerHTML = `<div class="card" style="display:flex;flex-direction:column;gap:10px">
    <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
      <button class="btn btn-secondary" onclick="copyHedgeTSV()" style="padding:5px 14px;font-size:12px">Copiar (TSV)</button>
      <button class="btn btn-secondary" onclick="downloadHedgeCSV()" style="padding:5px 14px;font-size:12px">Baixar CSV</button>
      <span style="font-size:12px;color:var(--text-muted)">
        ${p.boletas.length} boletas — ${p.n_gerencial} gerenciais · ${p.n_mercado} a mercado ·
        ${p.instrument} @ ${_hedgeNum(p.price, 3)} · Deal Date ${p.deal_date}</span>
    </div>
    <div style="overflow-x:auto;max-height:420px;overflow-y:auto;border:1px solid var(--border);border-radius:6px">
      <table class="data-table" style="font-size:11px"><thead>${head}</thead><tbody>${rows}</tbody></table></div>
    <div style="font-size:11px;color:var(--text-muted)">
      As ${_HEDGE_HIDE_COLS.size} colunas sempre-vazias do layout JDS não aparecem aqui, mas
      <b>vão no export</b> — o paste no JDS conta coluna. Datas saem em <b>mm/dd/aaaa</b>.
    </div></div>`;
}

// Mesmo contrato de export da Rolagem: datas em mm/dd/aaaa, todas as colunas na ordem.
function _hedgeMatrix(includeHeader) {
  const cols = hedgePlano.columns;
  const DATE_COLS = new Set(['Deal Date', 'Value date', 'Fixing date']);
  const dd2mm = s => {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(s).trim());
    return m ? `${m[2]}/${m[1]}/${m[3]}` : s;
  };
  const lines = includeHeader ? [cols.slice()] : [];
  hedgePlano.boletas.forEach(b => {
    lines.push(cols.map(c => {
      const v = b[c] == null ? '' : b[c];
      return DATE_COLS.has(c) ? dd2mm(v) : v;
    }));
  });
  return lines;
}
function copyHedgeTSV() {
  if (!hedgePlano?.boletas?.length) return;
  const tsv = _hedgeMatrix(false).map(r => r.join('\t')).join('\n');
  const st = document.getElementById('refStatus');
  navigator.clipboard.writeText(tsv).then(() => {
    if (st) { st.textContent = 'Boletas de hedge copiadas (TSV)'; st.style.color = 'var(--text-muted)'; }
  }).catch(e => { if (st) { st.textContent = 'Erro ao copiar: ' + e.message; st.style.color = 'var(--red)'; } });
}
function downloadHedgeCSV() {
  if (!hedgePlano?.boletas?.length) return;
  const csv = _hedgeMatrix(true).map(r => r.map(v => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `hedge_cambial_boletas_${(hedgePlano.ref_date || '').replace(/-/g, '')}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
