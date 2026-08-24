/* ── Casca de abas unificada (padrão Monitor RF) ──────────────────────────────
   Um ÚNICO controlador delegado no #tabbar troca as 7 abas. _showPanel faz a
   parte comum (toggle .on no botão + no painel, via CSS .tab/.tab.on); cada
   show*Tab mantém só o seu despacho (lazy-load / prefetch / dirty-state).
   No snapshot estático (sem #tabbar nem painéis .tab) _showPanel é inócuo. */
function _showPanel(key) {
  document.querySelectorAll('#tabbar .tabbtn').forEach(b =>
    b.classList.toggle('on', b.dataset.tab === key));
  document.querySelectorAll('.tab').forEach(p =>
    p.classList.toggle('on', p.id === 'tab-' + key));
}

// Roteia data-tab → o despacho específico da aba (preserva lazy-load/prefetch/dirty).
function activateTab(key) {
  switch (key) {
    case 'dolarconsol': showDolarConsolTab(); break;
    case 'dolar':       showDolarTab();       break;
    case 'rolagem':     showRolagemTab();     break;
    default:            showTraderTab(key);   break;   // emota/ecotrim/portfoliorf/other
  }
  if (typeof simSync === 'function') simSync();   // abas de dólar/rolagem: inativa a simulação
}

// Listener delegado único. #tabbar existe (scripts no fim do <body>); ausente no snapshot.
(function initTabbar() {
  const bar = document.getElementById('tabbar');
  if (!bar) return;
  bar.addEventListener('click', e => {
    const btn = e.target.closest('.tabbtn');
    if (btn && bar.contains(btn)) activateTab(btn.dataset.tab);
  });
})();

function showTraderTab(tabId) {
  activeTraderTab = tabId;
  _showPanel(tabId);
  if (!posDataByTab[tabId]) {
    loadPositionsForTab(tabId);
  } else {
    // aba já carregada — re-alinha e aplica marretas pendentes (dirty) a partir do cache, sem refetch
    requestAnimationFrame(() => _alignAuxTables(tabId));
    const wasDirty = _dirtyTabs.delete(tabId);
    if (wasDirty) { renderSectionsForTab(tabId, posDataByTab[tabId].rows); renderWdoUcToggle(tabId); }
    if (typeof loadPnlForTab === 'function') {
      loadPnlForTab(tabId);
      if (wasDirty && typeof rerenderPnlValues === 'function') rerenderPnlValues();
    }
  }
  renderRestoreBtn();
  if (typeof _syncPnlRestoreBtn === 'function') _syncPnlRestoreBtn();
  if (typeof simSync === 'function') simSync();   // grupos/contador da ferramenta de simulação
  updateBbgBanner();
}

/* Invalida o cache de TODAS as abas — SEM disparar request nenhum. Cada aba busca de novo
   quando for aberta. Existe porque a "Data ref"/"Forçar D-1" pode ter mudado no meio: servir
   uma aba com dado de outra data em silêncio é pior que refazer o fetch.
   ⚠️ Antes isto só rodava no ramo das abas de trader — os ramos de dólar/rolagem faziam
   `return` cedo e deixavam as demais abas cacheadas na data ANTIGA. */
function _invalidateAllTabs() {
  for (const tab of TRADER_TABS) _dropTabCache(tab.id);
  for (const t of Object.keys(dolarConsolData)) _dropTabCache(DOLAR_CONSOL_TAB_ID, t);
  _dropTabCache(DOLAR_TAB_ID);
  _dropTabCache(ROLAGEM_TAB_ID);
}

/* Apaga o cache de UMA aba (e o estado de UI derivado dele). `trader` só vale p/ a aba de
   Análise de Opções, cujo cache é por trader (`dolarConsolData`), não por aba. */
function _dropTabCache(key, trader) {
  if (key === DOLAR_CONSOL_TAB_ID) {
    const t = trader ?? dolarConsolTrader;
    delete dolarConsolData[t];
    delete _tabFetchSig[`dc:${t}`];
    _dirtyTabs.delete(DOLAR_CONSOL_TAB_ID);
    return;
  }
  if (key === DOLAR_TAB_ID) {   // as duas tabelas da aba são carregadas juntas
    delete posDataByTab[ENQ_RF_TAB_KEY];
    delete _tabFetchSig[ENQ_RF_TAB_KEY];
  }
  delete posDataByTab[key];
  delete hiddenRows[key];
  delete _tabFetchSig[key];
  _dirtyTabs.delete(key);
  if (typeof resetPnlForTab === 'function') resetPnlForTab(key);
}

/* Descarta SÓ os caches buscados com OUTRA data — preserva os que continuam válidos.
   É o que permite ao "⚡ Só esta aba" não fazer as abas já carregadas voltarem a
   "Carregando…", sem abrir mão da garantia de nunca servir o dia errado em silêncio. */
function _invalidateStaleTabs() {
  const sig = _currentDateSig();
  for (const tab of TRADER_TABS) {
    if (posDataByTab[tab.id] && _tabFetchSig[tab.id] !== sig) _dropTabCache(tab.id);
  }
  for (const t of Object.keys(dolarConsolData)) {
    if (_tabFetchSig[`dc:${t}`] !== sig) _dropTabCache(DOLAR_CONSOL_TAB_ID, t);
  }
  if (posDataByTab[DOLAR_TAB_ID]   && _tabFetchSig[DOLAR_TAB_ID]   !== sig) _dropTabCache(DOLAR_TAB_ID);
  if (posDataByTab[ROLAGEM_TAB_ID] && _tabFetchSig[ROLAGEM_TAB_ID] !== sig) _dropTabCache(ROLAGEM_TAB_ID);
}

/* "Atualizar" (padrão) × "⚡ Só esta aba" (`{prefetch:false}`).
   Ambos refazem ao vivo a aba ativa e limpam as marretas (que são globais por instrumento).
   A diferença é o que acontece com as OUTRAS abas:
     • Atualizar      → apaga o cache de todas + prefetch das de trader (4 requests).
     • Só esta aba    → PRESERVA quem já estava carregado (1 request). Só descarta o que foi
                        buscado com outra "Data ref"/"Forçar D-1" (`_invalidateStaleTabs`).
   ⚠️ As abas preservadas entram em `_dirtyTabs`: as marretas acabaram de ser limpas, então
   elas precisam RE-RENDERIZAR ao serem abertas — do cache, sem request. Sem isso ficariam
   mostrando o DOM antigo, com valores marretados que já não existem mais. */
function reloadActiveTab(opts = {}) {
  const { prefetch = true } = opts;
  // "Atualizar" sempre busca preços/deltas ao vivo → limpa as marretas (fonte única, global).
  priceOverrides.clear();
  deltaOverrides.clear();
  swapOpeningOverrides.clear();
  swapTradedOverrides.clear();
  swapDv01Overrides.clear();
  plOverrides.clear();
  if (prefetch) {
    _invalidateAllTabs();
  } else {
    _invalidateStaleTabs();
    _dropTabCache(activeTraderTab);          // a ativa é a única que refazemos ao vivo agora
    for (const tab of TRADER_TABS) if (posDataByTab[tab.id]) _dirtyTabs.add(tab.id);
    if (Object.keys(dolarConsolData).length) _dirtyTabs.add(DOLAR_CONSOL_TAB_ID);
  }
  if (activeTraderTab === DOLAR_TAB_ID) {
    loadDolarExposure();
    loadEnquadramentoRF();
    return;
  }
  if (activeTraderTab === DOLAR_CONSOL_TAB_ID) {
    loadDolarConsol(dolarConsolTrader, { fresh: true });
    return;
  }
  if (activeTraderTab === ROLAGEM_TAB_ID) {
    loadRolagem();
    return;
  }
  loadPositionsForTab(activeTraderTab, { fresh: true, prefetch });   // "Atualizar" → preços ao vivo
}

function changeOtherTrader(trader) {
  TRADER_TABS[3].trader = trader;
  const label = document.getElementById('otherTraderLabel');
  if (label) label.textContent = trader;
  delete posDataByTab['other'];
  if (activeTraderTab === 'other') loadPositionsForTab('other');
}

/* ── Load positions for a tab ────────────────────────────────────────────── */
// opts.background: carga silenciosa (prefetch) — não mexe na UI global (status/botão).
// opts.fresh: ignora o cache de preços Bloomberg no backend (botão "Atualizar").
// opts.prefetch: puxar as OUTRAS abas de trader em background depois desta (padrão true).
//   false = o "⚡ Só esta aba": 1 request em vez de 4.
async function loadPositionsForTab(tabId, opts = {}) {
  const { background = false, fresh = false, prefetch = true } = opts;
  const tab      = TRADER_TABS.find(t => t.id === tabId);
  const refDate  = document.getElementById('refDate').value;
  const status   = document.getElementById('refStatus');
  const srcLabel = document.getElementById('srcLabel');
  const btn      = document.getElementById('btnLoad');
  const container = document.getElementById(`posContainer-${tabId}`);

  if (!background) {
    status.textContent = 'Buscando dados...';
    status.style.color = 'var(--text-muted)';
    btn.disabled = true;
    container.innerHTML = '<div class="card"><span class="loading">Carregando...</span></div>';
    const pnlCont = document.getElementById(`pnlContainer-${tabId}`);
    if (pnlCont) pnlCont.innerHTML = '<div class="card"><span class="loading">Carregando...</span></div>';
  }

  try {
    const params = new URLSearchParams({ trader: tab.trader });
    if (refDate) params.set('ref_date', refDate);
    const forceOpening = document.getElementById('forceOpening').value;
    if (forceOpening) params.set('force_opening', forceOpening);
    if (!tab.useGroups) params.set('use_groups', 'false');
    if (fresh) params.set('fresh', 'true');
    const data = await (await fetch(`${API_BASE}/api/positions/reference?${params}`)).json();

    if (data.error) {
      if (!background) {
        status.textContent = 'Erro: ' + data.error;
        status.style.color = 'var(--red)';
        container.innerHTML = `<div class="card no-data">${data.error}</div>`;
      }
      return;
    }

    posDataByTab[tabId] = data;
    _noteFetchSig(tabId);
    // Linhas simuladas da aba: repreça e reinjeta ANTES do render (ver pos-simular.js).
    if (typeof simAfterLoad === 'function') await simAfterLoad(tabId);
    noteBbgSource(data);   // estado global (BBG viva/cache) — vale p/ toda a página
    if (tabId === activeTraderTab) {
      positionsData = data;
      status.textContent = '';
      srcLabel.textContent =
        `Abertura: ${fmtDate(data.opening_date)}  |  Boletas: ${fmtDate(data.ref_date)}`;
    }

    delete hiddenRows[tabId];
    if (tabId === activeTraderTab) renderRestoreBtn();
    renderBlacklist(data.blacklist);
    renderExcludedAreas(tabId, data.excluded_rules, data.excluded_count);
    renderSectionsForTab(tabId, data.rows);
    renderWdoUcToggle(tabId);
    if (typeof simSync === 'function') simSync();

    if (typeof resetPnlForTab === 'function') resetPnlForTab(tabId);  // dados novos → re-render do PnL
    if (typeof loadPnlForTab === 'function') loadPnlForTab(tabId);

    // após a aba ativa carregar, prefetch silencioso das demais (troca de aba instantânea).
    // O "⚡ Só esta aba" passa prefetch:false — as outras carregam ao serem abertas.
    if (!background && prefetch && tabId === activeTraderTab) setTimeout(prefetchOtherTabs, 300);

  } catch (e) {
    if (!background) {
      status.textContent = 'Erro ao conectar: ' + e.message;
      status.style.color = 'var(--red)';
    }
  } finally {
    if (!background) btn.disabled = false;
  }
}

/* Prefetch silencioso das demais abas de trader (após a ativa carregar) para
   troca de aba instantânea. Sequencial p/ não saturar o backend; usa o cache. */
async function prefetchOtherTabs() {
  for (const tab of TRADER_TABS) {
    if (tab.id === activeTraderTab) continue;
    if (posDataByTab[tab.id]) continue;
    try { await loadPositionsForTab(tab.id, { background: true }); }
    catch { /* prefetch é best-effort */ }
  }
}

function renderSectionsForTab(tabId, allRows) {
  const tab        = TRADER_TABS.find(t => t.id === tabId);
  const tabFilters = FILTERS.filter(f => (tab?.filters ?? []).includes(f.id) && activeFilters.has(f.id));
  const filterRows = rows => rows.filter(r => tabFilters.every(f => f.fn(r)));
  const data       = posDataByTab[tabId];
  const displayRows = wdoUcAggregated.has(tabId) ? applyWdoUcAggregation(allRows) : allRows;
  const sections   = getSections(displayRows);
  const container  = document.getElementById(`posContainer-${tabId}`);
  const navMap     = data?.traders ?? {};

  const hasFundBreak  = tabId === 'portfoliorf' && !!(data?.fund_rows?.length);
  const navDate       = data?.nav_date;
  const pnlNavDate    = data?.portfoliorf_nav_date ?? navDate;
  const openingDate   = data?.opening_date;

  container.style.display       = 'inline-flex';
  container.style.flexDirection = 'column';

  if (!sections.length) {
    container.innerHTML = '<div class="card no-data">Não há posição para este trader.</div>';
    return;
  }

  container.innerHTML = sections.map((s, _i) => {
    const nav      = navMap[s.trader];
    const effDate  = tabId === 'portfoliorf' ? pnlNavDate : navDate;
    const navStr   = fmtNav(nav, effDate, openingDate);
    const isMmPrev = s.group === 'MM Prev';
    const hasAlloc = s.group === 'MM' && displayRows.some(r => r.group === 'MM Prev' && r.trader === s.trader);
    const titleId  = hasAlloc ? `id="sec_title_${s.trader.replace(/[^a-zA-Z0-9]/g,'_')}_MM"` : '';
    const bodyWrapId = `mmPrev_wrap_${s.trader.replace(/[^a-zA-Z0-9]/g,'_')}`;
    const hasFund  = hasFundBreak && s.group === 'Todos';

    if (isMmPrev) {
      return `
      <div class="card">
        <div style="cursor:pointer;user-select:none" onclick="(function(btn,wrap){
          var open=wrap.style.display!=='none';
          wrap.style.display=open?'none':'';
          btn.textContent=open?'▶':'▼';
        })(this.querySelector('.mmPrevArrow'),document.getElementById('${bodyWrapId}'))">
          <div class="section-title" style="padding:8px 0 8px 0;display:flex;align-items:baseline;gap:16px">
            <span>MM Prev <span style="font-weight:400;color:var(--text-muted);font-size:13px">— ${s.trader}</span></span>
            ${navStr ? `<span style="font-weight:400;color:var(--text-muted);font-size:12px">${navStr}</span>` : ''}
            <span class="mmPrevArrow" style="margin-left:auto;font-size:13px;color:var(--text-muted)">▶</span>
          </div>
        </div>
        <div id="${bodyWrapId}" style="display:none">
          <table class="data-table" style="white-space:nowrap;width:auto">
            ${thead()}
            <tbody id="${sectionBodyId(s)}"></tbody>
          </table>
        </div>
      </div>`;
    }

    return `
    <div class="card">
      <div style="display:flex;gap:40px;align-items:flex-start">
        <div class="section-copy-target">
          <div class="section-title" ${titleId} style="padding:8px 0 10px 0;display:flex;align-items:baseline;gap:16px">
            <span>${s.group} <span style="font-weight:400;color:var(--text-muted);font-size:13px">— ${s.trader}</span></span>
            ${navStr ? `<span style="font-weight:400;color:var(--text-muted);font-size:12px">${navStr}</span>` : ''}
            <button class="btn btn-secondary" data-html2canvas-ignore="true" style="margin-left:auto;padding:2px 10px;font-size:12px" onclick="copyCardImage(this)">⎘ Copiar</button>
          </div>
          <table class="data-table" style="white-space:nowrap;width:auto">
            ${thead()}
            <tbody id="${sectionBodyId(s)}"></tbody>
          </table>
        </div>
        ${hasAlloc ? `<div id="alloc_outer_${s.trader.replace(/[^a-zA-Z0-9]/g,'_')}" data-html2canvas-ignore="true">
          <div id="alloc_spacer_${s.trader.replace(/[^a-zA-Z0-9]/g,'_')}"></div>
          <div id="${allocCheckId(s.trader)}"></div>
        </div>` : ''}
        ${hasFund ? `<div id="fund_break_outer_portfoliorf" data-html2canvas-ignore="true">
          <div id="fund_break_spacer_portfoliorf"></div>
          <div id="fund_break_portfoliorf"></div>
        </div>` : ''}
      </div>
    </div>`;
  }).join('');

  for (const s of sections) {
    const rows = filterRows(sortRows(
      displayRows.filter(r => r.group === s.group && r.trader === s.trader)
    ));
    renderTable(rows, sectionBodyId(s));
    if (s.group === 'MM' && displayRows.some(r => r.group === 'MM Prev' && r.trader === s.trader)) {
      const el = document.getElementById(allocCheckId(s.trader));
      if (el) el.innerHTML = renderAllocTable(displayRows, s.trader, filterRows);
    }
    if (hasFundBreak && s.group === 'Todos') {
      const el = document.getElementById('fund_break_portfoliorf');
      if (el) el.innerHTML = renderFundBreakTable(
        filterRows(sortRows(displayRows.filter(r => r.group === s.group && r.trader === s.trader))),
        data.fund_rows, data.fund_navs, filterRows
      );
    }
  }

  // defer alignment: if tab is hidden (background load), getBoundingClientRect returns 0
  if (tabId === activeTraderTab) requestAnimationFrame(() => _alignAuxTables(tabId));
}

/* ── Re-render tables in place (filter toggle / row hide) ────────────────── */
// onlyKey (opcional): rowKey da linha afetada → só re-renderiza o tbody da seção dela.
// Linhas de outras seções (group/trader) não mudam ao ocultar uma linha, então
// pular o rebuild do innerHTML delas é seguro. Alloc/fund-break/opções têm
// dependência cross-section e são sempre atualizados (são tabelas pequenas).
