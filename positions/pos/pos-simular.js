/* ── Linha SIMULADA na tabela de Posição (➕ Simular linha) ───────────────────
   Adiciona TEMPORARIAMENTE uma posição que não existe na carteira, a partir de um
   ticker Bloomberg digitado: "e se eu tivesse 500 ODF31?", "quanto de DV01 entra
   com 100 TYU6 a mais?".

   A row vem PRONTA do backend (`/api/positions/simulate-row` → positions/simulate.py),
   no mesmo formato do `/reference` — mesmo calc_factor / usd_dv01 / breakdown / #PL.
   Aqui só se guarda a "receita" (spec) e se injeta a row em `posDataByTab[tab].rows`;
   dali em diante ela é uma linha como qualquer outra: entra no render da Posição, no
   PnL, nas marretas de preço (priceOverrides) e de quantidade (swap*Overrides).

   Fonte da verdade = `simSpecs[tabId]` (o que o usuário pediu). As rows montadas
   (`simRowsByTab`) são derivadas e REFEITAS a cada carga da aba — assim "Atualizar" e
   troca de data repreçam a simulação em vez de deixar preço velho na tela. Marretas
   feitas na linha simulada seguem a regra geral: "Atualizar" limpa todas (pos-tabs.js).

   Área/sub-área/estratégia da linha são "SIMULAÇÃO" (vêm do backend), então ela cai
   num bloco próprio e nunca soma dentro de um livro real. */

const simSpecs     = {};   // tabId → [{ticker, group, opening_qty, traded_qty, entry_price}]
const simRowsByTab = {};   // tabId → [row montada pelo backend]  (derivado)

/* ── Helpers ─────────────────────────────────────────────────────────────── */
function _simTabCfg() {
  return TRADER_TABS.find(t => t.id === activeTraderTab) || null;   // null nas abas de dólar/rolagem
}

function _simNum(id) {
  const raw = (document.getElementById(id)?.value ?? '').trim();
  if (!raw) return null;
  const v = parseFloat(raw.replace(/\./g, '').replace(',', '.'));
  return isNaN(v) ? null : v;
}

function _simStatus(msg, color) {
  const el = document.getElementById('simStatus');
  if (!el) return;
  el.innerHTML = msg || '';
  el.style.color = color || 'var(--text-muted)';
}

// Grupos existentes na aba (MM / MM Prev / Todos) — a linha simulada tem de cair numa
// seção que já existe, senão vira um card solto sem NAV.
function _simGroupsFor(tabId) {
  const out = [];
  for (const r of (posDataByTab[tabId]?.rows ?? [])) {
    if (!r.is_simulated && r.group && !out.includes(r.group)) out.push(r.group);
  }
  return out.length ? out : ['MM'];
}

/* ── Caixa (abre no "+" discreto da toolbar) ─────────────────────────────── */
// A ferramenta fica FECHADA por padrão — é uso pontual, não faz parte da leitura da tela.
function toggleSimBox(force) {
  const box = document.getElementById('simTool');
  if (!box) return;
  const open = force !== undefined ? force : box.style.display === 'none';
  box.style.display = open ? '' : 'none';
  const btn = document.getElementById('simToggle');
  if (btn) btn.classList.toggle('on', open);
  if (open) { simSync(); document.getElementById('simTicker')?.focus(); }
  else _simStatus('');
}

/* ── Barra da ferramenta (select de grupo + chip de limpar) ──────────────── */
function simSync() {
  const cfg = _simTabCfg();
  const sel = document.getElementById('simGroup');
  const btn = document.getElementById('simToggle');
  if (btn) {                       // abas de dólar/rolagem: não há tabela de Posição p/ simular
    btn.disabled = !cfg;
    btn.style.opacity = cfg ? '' : '0.4';
  }
  if (!cfg) toggleSimBox(false);
  if (sel) {
    const groups = cfg ? _simGroupsFor(cfg.id) : ['MM'];
    const cur    = sel.value;
    sel.innerHTML = groups.map(g => `<option value="${g}">${g}</option>`).join('');
    if (groups.includes(cur)) sel.value = cur;
  }
  const chip = document.getElementById('simClearChip');
  if (chip) {
    const n = cfg ? (simSpecs[cfg.id]?.length ?? 0) : 0;
    chip.style.display = n ? '' : 'none';
    chip.textContent   = `⚡ ${n} simulada${n === 1 ? '' : 's'} ✕`;
  }
}

/* ── Injeção das rows simuladas no payload da aba ────────────────────────── */
// Idempotente: refaz a lista tirando as simuladas antigas e concatenando as atuais.
function _simInject(tabId) {
  const data = posDataByTab[tabId];
  if (!data?.rows) return;
  data.rows = data.rows.filter(r => !r.is_simulated).concat(simRowsByTab[tabId] ?? []);
}

async function _simFetchRow(tabId, spec) {
  const cfg  = TRADER_TABS.find(t => t.id === tabId);
  const data = posDataByTab[tabId];
  const p = new URLSearchParams({
    ticker:      spec.ticker,
    trader:      cfg.trader,
    group:       spec.group,
    opening_qty: spec.opening_qty ?? 0,
    traded_qty:  spec.traded_qty  ?? 0,
  });
  const refDate = document.getElementById('refDate')?.value;
  if (refDate) p.set('ref_date', refDate);
  const forceOpening = document.getElementById('forceOpening')?.value;
  if (forceOpening) p.set('force_opening', forceOpening);
  // NAV: o MESMO que a aba já exibe (inclusive a soma por fundo do PortfolioRF) — assim o
  // #PL da linha simulada é comparável ao das linhas reais ao lado.
  const nav = data?.traders?.[cfg.trader];
  if (nav) p.set('nav', nav);
  if (spec.entry_price != null) p.set('entry_price', spec.entry_price);

  const res = await fetch(`${API_BASE}/api/positions/simulate-row?${p}`);
  const j   = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error(j.error || `HTTP ${res.status}`);
  return j.row;
}

/* ── Adicionar ───────────────────────────────────────────────────────────── */
async function addSimulatedRow() {
  const cfg = _simTabCfg();
  if (!cfg) return _simStatus('Simulação só vale nas abas de trader.', 'var(--yellow)');
  if (!posDataByTab[cfg.id]) return _simStatus('Carregue a aba antes de simular.', 'var(--yellow)');

  const ticker = (document.getElementById('simTicker')?.value ?? '').trim();
  if (!ticker) return _simStatus('Informe o ticker Bloomberg (ex.: ODF31 Comdty).', 'var(--yellow)');

  const spec = {
    ticker,
    group:       document.getElementById('simGroup')?.value || _simGroupsFor(cfg.id)[0],
    opening_qty: _simNum('simOpening') ?? 0,
    traded_qty:  _simNum('simTraded')  ?? 0,
    entry_price: _simNum('simPrice'),
  };
  if (!spec.opening_qty && !spec.traded_qty)
    return _simStatus('Informe a quantidade (abertura e/ou operada).', 'var(--yellow)');

  const btn = document.getElementById('simBtn');
  if (btn) btn.disabled = true;
  _simStatus('Buscando na Bloomberg…');
  try {
    const row = await _simFetchRow(cfg.id, spec);
    // Guarda o ticker RESOLVIDO pelo backend ("odf29" → "ODF29 Comdty"): é o que vira o
    // `instrument_reference` da linha e, portanto, o que o ✕ da linha manda p/ removeSimRow.
    spec.ticker = row.instrument_reference || spec.ticker;
    // Mesmo ticker duas vezes = ATUALIZA a simulação (rowKey seria idêntico → linha duplicada).
    const specs = (simSpecs[cfg.id] ??= []);
    const rows  = (simRowsByTab[cfg.id] ??= []);
    const i     = specs.findIndex(s => s.ticker.toLowerCase() === spec.ticker.toLowerCase());
    if (i >= 0) {
      // Re-simular o mesmo ticker SUBSTITUI a receita: a marreta de qtd antiga (mesmo rowKey)
      // mascararia a quantidade nova, então cai junto.
      _simDropRowOverrides(rows[i]);
      specs[i] = spec; rows[i] = row;
    } else { specs.push(spec); rows.push(row); }

    _simInject(cfg.id);
    renderSectionsForTab(cfg.id, posDataByTab[cfg.id].rows);
    renderWdoUcToggle(cfg.id);
    if (typeof resetPnlForTab === 'function') resetPnlForTab(cfg.id);
    if (typeof loadPnlForTab  === 'function') loadPnlForTab(cfg.id);
    simSync();

    const av = row.sim_avisos ?? [];
    _simStatus(`✓ ${row.instrument_name}` + (av.length ? ` — ⚠ ${av.join(' · ')}` : ''),
               av.length ? 'var(--yellow)' : 'var(--green)');
    const tk = document.getElementById('simTicker');
    if (tk) { tk.value = ''; tk.focus(); }
  } catch (e) {
    _simStatus('⚠ ' + e.message, 'var(--red)');
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* ── Remover (✕ da própria linha) / limpar todas ─────────────────────────── */
// Marretas por POSIÇÃO (rowKey) da linha simulada — some junto com ela, senão voltariam
// a valer se o mesmo ticker fosse simulado de novo. As de PREÇO (priceOverrides, por
// instKey) NÃO são apagadas: são do instrumento e podem valer p/ a posição real do mesmo
// contrato em outra aba.
function _simDropRowOverrides(row) {
  if (!row) return;
  const k = rowKey(row);
  swapOpeningOverrides.delete(k);
  swapTradedOverrides.delete(k);
  swapDv01Overrides.delete(k);
  plOverrides.delete(k);
}

function removeSimRow(ticker) {
  const cfg = _simTabCfg();
  if (!cfg) return;
  const specs = simSpecs[cfg.id] ?? [];
  const i = specs.findIndex(s => s.ticker.toLowerCase() === String(ticker).toLowerCase());
  if (i < 0) return;
  specs.splice(i, 1);
  _simDropRowOverrides((simRowsByTab[cfg.id] ?? []).splice(i, 1)[0]);
  _simInject(cfg.id);
  renderSectionsForTab(cfg.id, posDataByTab[cfg.id].rows);
  if (typeof resetPnlForTab === 'function') resetPnlForTab(cfg.id);
  if (typeof loadPnlForTab  === 'function') loadPnlForTab(cfg.id);
  simSync();
  _simStatus('');
}

function clearSimRows() {
  const cfg = _simTabCfg();
  if (!cfg) return;
  for (const r of simRowsByTab[cfg.id] ?? []) _simDropRowOverrides(r);
  delete simSpecs[cfg.id];
  delete simRowsByTab[cfg.id];
  _simInject(cfg.id);
  if (posDataByTab[cfg.id]) {
    renderSectionsForTab(cfg.id, posDataByTab[cfg.id].rows);
    if (typeof resetPnlForTab === 'function') resetPnlForTab(cfg.id);
    if (typeof loadPnlForTab  === 'function') loadPnlForTab(cfg.id);
  }
  simSync();
  _simStatus('');
}

/* ── Hook de carga da aba (pos-tabs.js) ──────────────────────────────────── */
// Chamado DEPOIS de posDataByTab[tabId] receber o payload novo e ANTES do render:
// repreça cada simulação com os preços daquela carga. Falha de uma linha mantém a row
// anterior (não some em silêncio) e avisa.
async function simAfterLoad(tabId) {
  const specs = simSpecs[tabId];
  if (!specs?.length) { delete simRowsByTab[tabId]; return; }
  const prev = simRowsByTab[tabId] ?? [];
  // specs e rows andam por ÍNDICE (removeSimRow dá splice nos dois) → só entra na lista
  // nova o par que sobreviveu; o que falhou sem row anterior sai das duas.
  const keptSpecs = [], keptRows = [], stale = [], lost = [];
  for (let i = 0; i < specs.length; i++) {
    let row = null;
    try { row = await _simFetchRow(tabId, specs[i]); }
    catch { row = prev[i] ?? null; (row ? stale : lost).push(specs[i].ticker); }
    if (row) { keptSpecs.push(specs[i]); keptRows.push(row); }
  }
  simSpecs[tabId]     = keptSpecs;
  simRowsByTab[tabId] = keptRows;
  _simInject(tabId);
  if (tabId === activeTraderTab && (stale.length || lost.length)) {
    const msg = [
      stale.length ? `preço anterior mantido em ${stale.join(', ')}` : '',
      lost.length  ? `removida(s): ${lost.join(', ')}`               : '',
    ].filter(Boolean).join(' · ');
    _simStatus('⚠ Simulação não repreçou — ' + msg, 'var(--yellow)');
  }
}
