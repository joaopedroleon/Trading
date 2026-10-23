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
// US$ por contrato MINI (WDO). O relatório vem em MILHARES de USD, então minis × 10 = kUSD
// — é por aí que o resumo do resíduo fecha com a coluna Total do próprio relatório.
const HEDGE_KUSD_POR_MINI = 10;
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
  // ⚠️ **NÃO persiste, de propósito** (mesma família do `deal_date`): desligar o desconto
  // é uma conferência pontual — "o que o relatório pediria se eu não tivesse boletado
  // nada". Persistido, ele voltaria ligado num outro dia e a tela mandaria boletar de novo
  // o que já está feito, que é exatamente o erro que esta camada existe para evitar.
  ignorar_boletas: false,
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
    // Relatório do cache: a tela volta ao estado de antes depois de um F5 em vez de pedir
    // o PDF de novo. ⚠️ Só quando NÃO há um carregado — o que está na tela é sempre o que
    // a mesa acabou de subir, nunca o de disco.
    if (!hedgeRelatorio && data.relatorio_cache?.relatorio) {
      hedgeRelatorio = { ...data.relatorio_cache.relatorio, cache: data.relatorio_cache };
      hedgeMktSel = {};
    }
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

// ⚠️ O fallback existe só para o instante entre abrir a aba e o `/contexto` responder.
// Quem manda na lista é o SERVIDOR (`hedge_controle.TRADERS_PADRAO`): duplicá-la aqui como
// fonte da verdade faria a tela netar um conjunto de traders e o plano, outro.
const HEDGE_TRADERS_FALLBACK = ['ECotrim', 'EMota', 'GBranquinho', 'LAguiar', 'PAbinader',
  'PAlves', 'Portfolio'];

function _hedgeTradersDisponiveis() {
  const doRel = (hedgeRelatorio?.linhas || []).map(l => l.trader);
  const padrao = hedgeContexto?.traders_padrao || HEDGE_TRADERS_FALLBACK;
  return [...new Set([...padrao, ...doRel])];
}

function _hedgeRenderChips() {
  const el = document.getElementById('hedgeTraderChips');
  if (!el) return;
  if (!hedgeTraders) {
    hedgeTraders = new Set(hedgeContexto?.traders_padrao || HEDGE_TRADERS_FALLBACK);
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
      ${_hedgeSeloRelatorio(r)}
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

// Selo de PROCEDÊNCIA do relatório que está na tela: de que dia ele é, quando foi lido,
// e se está atrasado.
//
// ☠️ **Relatório defasado parece atual**: a tabela enche, a conferência do próprio
// relatório fecha, as boletas saem — e estão hedgeando o descasamento de outro dia.
// Medido com os dois exemplares reais: pelo de 20/10 a tela mandaria **vender 23 minis**
// no Strategy Master que, pelo de 22/10 (o certo), não existem — o livro já estava zerado.
// Por isso o atraso é faixa vermelha, não nota de rodapé.
function _hedgeSeloRelatorio(r) {
  if (!r) return '';
  const c = r.cache || {};
  const d = hedgePlano?.defasagem || c.defasagem || null;
  const lido = c.salvo_em
    ? `<span style="font-size:11px;color:var(--text-muted)" title="quando este relatório foi lido e guardado no cache da tela">
         lido ${String(c.salvo_em).replace('T', ' ').slice(0, 16)}</span>` : '';
  if (!d) return lido;
  if (d.status === 'atrasado') {
    return `${lido} <span style="color:var(--red);font-weight:600;font-size:12px"
      title="O esperado é o relatório do dia útil anterior (${d.esperado}). Este é mais velho — as boletas abaixo hedgeiam o descasamento de outro dia.">
      ⚠ DEFASADO — ${d.atrasado_du} pregão(ões) atrás (esperado: as of ${fmtDate(d.esperado)})</span>`;
  }
  if (d.status === 'sem_data' || d.status === 'ilegivel') {
    return `${lido} <span style="color:var(--amber,#c90);font-size:12px">⚠ sem data legível no título — não dá para saber se está atual</span>`;
  }
  return `${lido} <span style="color:var(--green);font-weight:600;font-size:12px"
    title="as of = dia útil anterior a ${d.ref_date}, que é como o relatório chega">✓ em dia</span>`;
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
      ignorar_boletas: !!hedgeConfig.ignorar_boletas,
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

  // Matriz: relatório · já boletado · falta · casado · resíduo, por (trader, fundo).
  // ⭐ As três primeiras camadas vêm SEPARADAS do servidor (`need_bruto` → `boletado` →
  // `need`) e a célula mostra as três: fundidas num número só, não daria para conferir a
  // tela contra a tabela do próprio relatório, logo acima.
  const _br = (t, f) => (p.need_bruto && p.need_bruto[t] ? p.need_bruto[t][f] : 0) || 0;
  const _bo = (t, f) => (p.boletado && p.boletado[t] ? p.boletado[t][f] : 0) || 0;
  const linha = (t) => {
    const cells = fundos.map(f => {
      const need = p.need[t][f] || 0;
      const br = _br(t, f), bo = _bo(t, f);
      const cas = (p.casado[f] || {})[t] || 0;
      const res = need - cas;
      if (!need && !cas && !br && !bo) return `<td class="num" style="color:var(--text-muted)">·</td>`;
      return `<td class="num" title="relatório ${_hedgeQty(br)} · já boletado ${_hedgeQty(bo)} · falta ${_hedgeQty(need)} · gerencial ${_hedgeQty(cas)} · resíduo ${_hedgeQty(res)}">
        <span style="${_hedgeCor(need)}">${_hedgeQty(need)}</span>
        <span style="font-size:10px;color:var(--text-muted)"> → ${_hedgeQty(cas)}</span>
        ${res ? `<span style="font-size:10px;${_hedgeCor(res)}"> | ${_hedgeQty(res)}</span>` : ''}
        ${bo ? `<div style="font-size:9px;color:var(--text-muted);line-height:1.2">rel ${_hedgeQty(br)} · bol ${_hedgeQty(bo)}</div>` : ''}
      </td>`;
    }).join('');
    const sb = fundos.reduce((a, f) => a + _br(t, f), 0);
    const sbo = fundos.reduce((a, f) => a + _bo(t, f), 0);
    const sn = fundos.reduce((a, f) => a + (p.need[t][f] || 0), 0);
    const sc = fundos.reduce((a, f) => a + ((p.casado[f] || {})[t] || 0), 0);
    return `<tr><td style="font-weight:600">${t}</td>${cells}
      <td class="num" style="${_hedgeCor(sb)}">${_hedgeQty(sb)}</td>
      <td class="num" style="${_hedgeCor(sbo)}">${_hedgeQty(sbo)}</td>
      <td class="num" style="${_hedgeCor(sn)};font-weight:600">${_hedgeQty(sn)}</td>
      <td class="num" style="${_hedgeCor(sc)}">${_hedgeQty(sc)}</td>
      <td class="num" style="${_hedgeCor(sn - sc)};font-weight:600">${_hedgeQty(sn - sc)}</td></tr>`;
  };
  // ⚠️ A coluna "Gerencial" soma ZERO por construção — é a invariante do netting, não
  // um total vazio. O resíduo total é, portanto, igual à necessidade total: o que as
  // gerenciais fazem é redistribuir, nunca reduzir o descasamento AGREGADO da mesa.
  const needTot = traders.reduce((a, t) => a + fundos.reduce((b, f) => b + (p.need[t][f] || 0), 0), 0);
  const bruTot = traders.reduce((a, t) => a + fundos.reduce((b, f) => b + _br(t, f), 0), 0);
  const bolTot = traders.reduce((a, t) => a + fundos.reduce((b, f) => b + _bo(t, f), 0), 0);
  const rodape = `<tr style="font-weight:600;border-top:2px solid var(--border)">
    <td>Total</td>
    ${fundos.map(f => {
      const s = traders.reduce((a, t) => a + (p.need[t][f] || 0), 0);
      const bo = traders.reduce((a, t) => a + _bo(t, f), 0);
      const c = (p.resumo.find(x => x.fund === f) || {}).casado || 0;
      return `<td class="num" title="falta líquida do fundo ${_hedgeQty(s)} · ${c} mini(s) casados entre os traders · já boletado ${_hedgeQty(bo)}">
        <span style="${_hedgeCor(s)}">${_hedgeQty(s)}</span>
        <span style="font-size:10px;color:var(--text-muted)"> · casa ${c}</span></td>`;
    }).join('')}
    <td class="num" style="${_hedgeCor(bruTot)}">${_hedgeQty(bruTot)}</td>
    <td class="num" style="${_hedgeCor(bolTot)}">${_hedgeQty(bolTot)}</td>
    <td class="num" style="${_hedgeCor(needTot)}">${_hedgeQty(needTot)}</td>
    <td class="num" title="o netting redistribui, não reduz o descasamento agregado — esta soma é sempre zero">0</td>
    <td class="num" style="${_hedgeCor(needTot)}">${_hedgeQty(needTot)}</td></tr>`;

  const casadoTot = p.resumo.reduce((a, x) => a + x.casado, 0);
  const resTot = p.residuo.reduce((a, x) => a + Math.abs(x.qty), 0);

  el.innerHTML = `
    <div class="card" style="display:flex;flex-direction:column;gap:10px">
      <div style="font-size:12px;color:var(--text-muted)">
        Quantidades em <b>minis (WDO)</b> e com sinal: <b>+ compra</b> dólar futuro,
        <b>− vende</b>. Cada célula traz <b>falta → gerencial</b> e, quando sobra,
        <b>| resíduo</b>; embaixo, <b>rel · bol</b> — o que o relatório pedia e o que já foi
        boletado. Célula com |exposição| abaixo de
        <b>${_hedgeNum(p.limiar_kusd, 0)} kUSD</b> não vira boleta.
      </div>
      ${_hedgeFaixaBoletas(p)}
      <div style="overflow-x:auto"><table class="data-table" style="font-size:11px">
        <thead><tr><th>Trader</th>${fundos.map(f => `<th class="num">${cab(f)}</th>`).join('')}
          <th class="num" title="o que o relatório pedia, em minis">Relatório</th>
          <th class="num" title="o que já foi boletado em Hedge_Cambial depois do relatório">Já boletado</th>
          <th class="num">Falta</th><th class="num">Gerencial</th><th class="num">Resíduo</th></tr></thead>
        <tbody>${traders.map(linha).join('')}${rodape}</tbody></table></div>
      <div style="font-size:12px">
        <b>${casadoTot}</b> minis casados entre os traders (${p.n_gerencial} boletas gerenciais) ·
        <b>${resTot}</b> minis de resíduo.
      </div>
      ${_hedgeChecks(p)}
      ${_hedgeResiduoTabela(p)}
    </div>`;
}

// Faixa que declara a JANELA das boletas já descontadas — e deixa desligar o desconto.
//
// ⭐ **A janela sai do `as of` do próprio relatório, não de "hoje"**: `(as of, ref_date]`.
// Relatório que chegou atrasado tem mais de um dia de boleta pela frente, e cortar em
// "só hoje" deixaria o ajuste de ontem de fora — mandando boletá-lo outra vez.
// ⚠️ O botão de desligar existe para a conferência "o que o relatório pediria se eu não
// tivesse boletado nada", e NÃO persiste entre sessões, de propósito.
function _hedgeFaixaBoletas(p) {
  const j = p.janela_boletas || {};
  // ☠️ **Bruto e líquido não se misturam na mesma frase.** A 1ª versão imprimia o total
  // como Σ|líquido por (trader,fundo)| e o split como Σ|gerencial| e Σ|mercado| — e os
  // números NÃO fechavam (88 contra 82+52), porque um trader com +10 gerencial e −3 de
  // mercado no mesmo fundo conta 7 de um jeito e 13 do outro. Aqui o total é o BRUTO, que
  // é o que "foi boletado" quer dizer, e aí o parêntese soma.
  //
  // ☠️ **E só conta quem está NO NETTING.** A query das boletas é do livro inteiro de
  // `Hedge_Cambial` — ela não sabe quem a tela está netando —, e a faixa somava todo mundo:
  // em 23/10/2026 imprimia **126 minis "descontados"** quando o descontado eram **80**, com
  // os outros 46 sendo do `Treasurer`, que está fora do netting (e cujo líquido era zero:
  // 3 boletas que se cancelam). Número plausível, e dizendo que se descontou o que não se
  // descontou. O que sobra NÃO some: sai na mesma faixa, declarado como não descontado.
  const noNet = new Set(p.traders || []);
  const fundosNet = new Set(Object.values(p.fund_map || {}).filter(Boolean));
  const _soma = (dentro) => {
    let ger = 0, mkt = 0;
    const quem = new Set();
    for (const [lab, porT] of Object.entries(p.boletado_tipo || {})) {
      for (const [t, x] of Object.entries(porT)) {
        if ((noNet.has(t) && fundosNet.has(lab)) !== dentro) continue;
        ger += Math.abs(x.gerencial || 0);
        mkt += Math.abs(x.mercado || 0);
        if (Math.abs(x.gerencial || 0) + Math.abs(x.mercado || 0)) quem.add(t);
      }
    }
    return { ger, mkt, tot: ger + mkt, quem: [...quem].sort() };
  };
  const d = _soma(true), fora = _soma(false);
  const ger = d.ger, mkt = d.mkt, tot = d.tot;
  const foraTxt = fora.tot
    ? ` <span style="color:var(--text-muted)" title="boletas de Hedge_Cambial de quem não está netando aqui (ou em fundo fora do relatório) — ficam de fora da conta, mas existem">
         · <b>${fora.tot}</b> mini(s) fora do netting, não descontados (${fora.quem.join(', ')})</span>`
    : '';
  const off = !!hedgeConfig.ignorar_boletas;
  const janTxt = j.erro
    ? `<span style="color:var(--red)">falhou ao ler as boletas — o plano é o do relatório cru</span>`
    : (!j.inicio
        ? `<span style="color:var(--amber,#c90)">nenhuma boleta descontada${j.motivo === 'as_of_na_data' ? ' (o relatório já é desta data)' : ''}</span>`
        : `boletas de <b>${fmtDate(j.inicio)}</b>${j.fim !== j.inicio ? ' a <b>' + fmtDate(j.fim) + '</b>' : ''}
           — <b>${tot}</b> mini(s) descontados em Hedge_Cambial
           <span style="color:var(--text-muted)" title="bruto, somando os dois sentidos: a gerencial muda o hedge do trader tanto quanto a de mercado, mas soma zero dentro do fundo">(${ger} gerencial · ${mkt} a mercado)</span>${foraTxt}`);
  return `<div style="font-size:12px;display:flex;gap:10px;flex-wrap:wrap;align-items:center;
      padding:6px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface-2,transparent)">
    <span title="O relatório é a foto do fechamento de D-1; tudo o que foi boletado em Hedge_Cambial depois dele já corrigiu parte do descasamento e é descontado aqui.">
      ↩ <b>Já ajustado</b>: ${off ? '<span style="color:var(--amber,#c90)">desconto DESLIGADO — o plano abaixo é o do relatório cru</span>' : janTxt}</span>
    <label style="display:flex;gap:4px;align-items:center;font-size:11px;color:var(--text-muted);cursor:pointer"
           title="Desliga o desconto para ver o que o relatório pediria do zero. Não fica guardado.">
      <input type="checkbox" ${off ? 'checked' : ''} onchange="setHedgeCfg('ignorar_boletas', this.checked)">
      ignorar o que já foi boletado</label>
  </div>`;
}

function _hedgeChecks(p) {
  const c = p.checks || [];
  if (!c.length) return `<div style="font-size:12px;color:var(--green);font-weight:600">
    ✓ gerenciais somam zero em todos os fundos · todos os fundos e traders casaram com o JDS</div>`;
  return `<div style="font-size:12px;color:var(--red);display:flex;flex-direction:column;gap:2px">
    ${c.map(x => `<div>⚠ ${x.msg}${x.fund ? ` — ${x.fund}` : ''}${x.trader ? ` / ${x.trader}` : ''}</div>`).join('')}</div>`;
}

// Σ do resíduo por FUNDO — "quanto de mini dólar falta negociar para zerar a exposição
// daquele fundo". É a pergunta que a mesa faz depois das gerenciais, e a tabela detalhada
// abaixo (uma linha por trader × fundo) não a responde sem somar de cabeça.
//
// ⭐ **Somar por fundo é EXATO, não aproximação.** Dentro de um fundo o netting casa o lado
// MENOR por inteiro (`netear`: `m = min(compras, vendas)`), então o que sobra é todo do
// MESMO sentido — ou só comprador, ou só vendedor, nunca os dois pela metade. Logo a soma
// é a necessidade LÍQUIDA do fundo, e não há compra e venda se cancelando dentro da célula.
// ☠️ Por isso mesmo, resíduo nos DOIS sentidos no mesmo fundo seria **bug do netting**, não
// arredondamento: sai marcado na linha em vez de desaparecer dentro da soma.
//
// ⚠️ **O total entre fundos é líquido e NÃO é o que se executa.** Cada fundo tem a sua
// boleta, então +8 num fundo e −8 em outro são 16 minis de execução, não zero — o rodapé
// imprime os dois lados separados e o líquido só como referência.
function _hedgeResiduoResumo(p) {
  const m = new Map();
  for (const r of p.residuo) {
    let o = m.get(r.fund);
    if (!o) { o = { fund: r.fund, label: r.fund_label, qty: 0, compra: 0, venda: 0, mkt: 0, por_trader: [] }; m.set(r.fund, o); }
    o.qty += r.qty;
    if (r.qty > 0) o.compra += r.qty; else o.venda += r.qty;
    o.mkt += Number(hedgeMktSel[`${r.trader}||${r.fund}`] || 0);
    o.por_trader.push(`${r.trader} ${_hedgeQty(r.qty)}`);
  }
  // Relatório e já-boletado do FUNDO (todos os traders do netting, não só os com resíduo):
  // é a identidade que a mesa confere de olho — `falta = relatório − já boletado`.
  for (const o of m.values()) {
    o.bruto = (p.traders || []).reduce((a, t) => a + ((p.need_bruto && p.need_bruto[t] ? p.need_bruto[t][o.fund] : 0) || 0), 0);
    o.bol = (p.traders || []).reduce((a, t) => a + ((p.boletado && p.boletado[t] ? p.boletado[t][o.fund] : 0) || 0), 0);
  }
  // ⭐ Conferência de graça: o servidor já publica `residuo_compra`/`residuo_venda` por fundo
  // em `resumo` (de `netear`), por um caminho independente desta soma. Os dois têm de dar o
  // mesmo número — se um dia divergirem, é a lista detalhada discordando do netting, e aí
  // esta tabela estaria mandando negociar a quantidade errada. Declara em vez de escolher um.
  for (const o of m.values()) {
    const r = (p.resumo || []).find(x => x.fund === o.fund);
    o.esperado = r ? (r.residuo_compra || 0) - (r.residuo_venda || 0) : null;
  }
  const linhas = [...m.values()].sort((a, b) => Math.abs(b.qty) - Math.abs(a.qty));
  const acao = o => o.qty > 0 ? '<b style="color:var(--green)">COMPRAR</b>'
    : o.qty < 0 ? '<b style="color:var(--red)">VENDER</b>'
    : '<b style="color:var(--amber,#c90)">— nada</b>';
  const rows = linhas.map(o => {
    const falta = o.qty - o.mkt;
    const dois = o.compra && o.venda;
    return `<tr>
      <td>${o.fund.replace(/^JGP /, '')}${o.label ? ''
        : ' <span style="color:var(--red)" title="sem fundo correspondente no JDS — esta linha não vira boleta">⚠</span>'}</td>
      <td class="num" style="${_hedgeCor(o.bruto)};font-size:10px">${_hedgeQty(o.bruto)}</td>
      <td class="num" style="${_hedgeCor(o.bol)};font-size:10px">${o.bol ? _hedgeQty(o.bol) : '—'}</td>
      <td>${acao(o)}${dois ? ' <span style="color:var(--amber,#c90)" title="o netting deveria ter casado estes dois lados dentro do fundo — confira">⚠ dois sentidos</span>' : ''}${
        (o.esperado != null && o.esperado !== o.qty)
          ? ` <span style="color:var(--red)" title="o netting do servidor diz ${_hedgeQty(o.esperado)} neste fundo e a soma das linhas diz ${_hedgeQty(o.qty)} — não boletar sem conferir">⚠ não bate com o netting</span>` : ''}</td>
      <td class="num" style="${_hedgeCor(o.qty)};font-weight:600"
          title="minis de WDO a negociar para zerar o descasamento que sobrou neste fundo">${_hedgeQty(o.qty)}</td>
      <td class="num" style="${_hedgeCor(o.qty)}">${_hedgeNum(o.qty * HEDGE_KUSD_POR_MINI, 0)}</td>
      <td class="num" style="${_hedgeCor(o.mkt)}">${o.mkt ? _hedgeQty(o.mkt) : '—'}</td>
      <td class="num" style="${_hedgeCor(falta)};font-weight:600">${_hedgeQty(falta)}</td>
      <td style="font-size:10px;color:var(--text-muted)">${o.por_trader.join(' · ')}</td></tr>`;
  }).join('');
  const tC = linhas.reduce((a, o) => a + (o.qty > 0 ? o.qty : 0), 0);
  const tV = linhas.reduce((a, o) => a + (o.qty < 0 ? o.qty : 0), 0);
  const tM = linhas.reduce((a, o) => a + o.mkt, 0);
  const liq = tC + tV;
  const tBru = linhas.reduce((a, o) => a + (o.bruto || 0), 0);
  const tBol = linhas.reduce((a, o) => a + (o.bol || 0), 0);
  const rodape = `<tr style="font-weight:600;border-top:2px solid var(--border)">
    <td>Total</td>
    <td class="num" style="${_hedgeCor(tBru)};font-size:10px">${_hedgeQty(tBru)}</td>
    <td class="num" style="${_hedgeCor(tBol)};font-size:10px">${tBol ? _hedgeQty(tBol) : '—'}</td>
    <td style="font-size:10px;color:var(--text-muted)">comprar <span style="color:var(--green)">${tC}</span> ·
      vender <span style="color:var(--red)">${Math.abs(tV)}</span></td>
    <td class="num" style="${_hedgeCor(liq)}"
        title="líquido entre fundos — referência, não ordem: cada fundo tem a sua boleta">${_hedgeQty(liq)}</td>
    <td class="num" style="${_hedgeCor(liq)}">${_hedgeNum(liq * HEDGE_KUSD_POR_MINI, 0)}</td>
    <td class="num" style="${_hedgeCor(tM)}">${tM ? _hedgeQty(tM) : '—'}</td>
    <td class="num" style="${_hedgeCor(liq - tM)}">${_hedgeQty(liq - tM)}</td>
    <td style="font-size:10px;color:var(--text-muted)">${tC + Math.abs(tV)} mini(s) de execução ao todo</td></tr>`;

  return `
    <div style="font-size:12px;color:var(--text-muted);margin-top:2px">
      O que <b>ainda</b> falta negociar de <b>mini dólar (WDO)</b> em cada fundo — já descontado
      o que foi boletado hoje em Hedge_Cambial. <b>+ comprar</b>, <b>− vender</b> dólar futuro.
    </div>
    <div style="overflow-x:auto"><table class="data-table" style="font-size:11px">
      <thead><tr><th>Fundo</th>
        <th class="num" title="o que o relatório pedia neste fundo, somando os traders do netting">Relatório</th>
        <th class="num" title="o que já foi boletado em Hedge_Cambial depois do relatório (gerencial + mercado)">Já boletado</th>
        <th>Ação</th><th class="num">Minis (WDO)</th>
        <th class="num" title="1 mini = US$ 10 mil — é a mesma unidade da coluna Total do relatório">kUSD</th>
        <th class="num">A mercado</th><th class="num">Falta</th><th>Por trader</th></tr></thead>
      <tbody>${rows}${rodape}</tbody></table></div>`;
}

function _hedgeResiduoTabela(p) {
  if (!p.residuo.length) {
    // ⚠️ **Nada a fazer tem DOIS motivos, e dizer o errado manda procurar o que não existe.**
    // Com as boletas do dia descontadas, o caso comum passou a ser "já está tudo boletado" —
    // creditar as gerenciais aí faria a mesa procurar um netting que não aconteceu.
    const bol = (p.traders || []).reduce((a, t) => a + (p.fundos || []).reduce(
      (b, f) => b + Math.abs((p.boletado && p.boletado[t] ? p.boletado[t][f] : 0) || 0), 0), 0);
    const cas = (p.resumo || []).reduce((a, x) => a + (x.casado || 0), 0);
    const pq = bol && !cas ? 'o que o relatório pedia já foi boletado hoje'
      : (bol && cas ? 'entre o que já foi boletado e as gerenciais, não sobra nada'
        : 'as gerenciais zeram tudo');
    return `<div style="font-size:12px;color:var(--green);font-weight:600">
      ✓ Nada a ajustar — ${pq}.</div>`;
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
    ${_hedgeResiduoResumo(p)}
    <div class="block-header" style="margin-top:6px">Detalhe por trader · o que vai a mercado</div>
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
