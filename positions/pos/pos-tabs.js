function showTraderTab(tabId) {
  activeTraderTab = tabId;
  for (const tab of TRADER_TABS) {
    const el  = document.getElementById(`tab-${tab.id}`);
    const btn = document.getElementById(`tab-btn-${tab.id}`);
    if (el)  el.style.display  = tab.id === tabId ? '' : 'none';
    if (btn) btn.classList.toggle('active', tab.id === tabId);
  }
  // esconde as abas que não fazem parte de TRADER_TABS (dólar e consolidado dólar)
  const dolarEl = document.getElementById('tab-dolar');
  if (dolarEl) dolarEl.style.display = 'none';
  document.getElementById('tab-btn-dolar')?.classList.remove('active');
  const consolEl = document.getElementById('tab-dolarconsol');
  if (consolEl) consolEl.style.display = 'none';
  document.getElementById('tab-btn-dolarconsol')?.classList.remove('active');
  _hideRolagemTab();
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
  updateBbgBanner();
}

function reloadActiveTab() {
  // "Atualizar" sempre busca preços/deltas ao vivo → limpa as marretas (fonte única, global).
  priceOverrides.clear();
  deltaOverrides.clear();
  if (activeTraderTab === DOLAR_TAB_ID) {
    delete posDataByTab[DOLAR_TAB_ID];
    loadDolarExposure();
    return;
  }
  if (activeTraderTab === DOLAR_CONSOL_TAB_ID) {
    delete dolarConsolData[dolarConsolTrader];
    loadDolarConsol(dolarConsolTrader, { fresh: true });
    return;
  }
  if (activeTraderTab === ROLAGEM_TAB_ID) {
    delete posDataByTab[ROLAGEM_TAB_ID];
    loadRolagem();
    return;
  }
  // limpa o cache de TODAS as abas de trader: evita servir dados de uma data
  // anterior ao trocar de aba após mudar a "Data ref" + Atualizar.
  for (const tab of TRADER_TABS) {
    delete posDataByTab[tab.id];
    delete hiddenRows[tab.id];
    if (typeof resetPnlForTab === 'function') resetPnlForTab(tab.id);
  }
  // também invalida as abas de dólar (Análise de Opções e Check Dólar Exposure):
  // senão, ao abri-las após Atualizar, serviriam dados em cache de uma data anterior.
  for (const t of Object.keys(dolarConsolData)) delete dolarConsolData[t];
  delete posDataByTab[DOLAR_TAB_ID];
  delete posDataByTab[ROLAGEM_TAB_ID];
  swapOpeningOverrides.clear();
  swapTradedOverrides.clear();
  swapDv01Overrides.clear();
  plOverrides.clear();
  loadPositionsForTab(activeTraderTab, { fresh: true });   // botão "Atualizar" → preços ao vivo
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
async function loadPositionsForTab(tabId, opts = {}) {
  const { background = false, fresh = false } = opts;
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
    renderSectionsForTab(tabId, data.rows);
    renderWdoUcToggle(tabId);

    if (typeof resetPnlForTab === 'function') resetPnlForTab(tabId);  // dados novos → re-render do PnL
    if (typeof loadPnlForTab === 'function') loadPnlForTab(tabId);

    // após a aba ativa carregar, prefetch silencioso das demais (troca de aba instantânea)
    if (!background && tabId === activeTraderTab) setTimeout(prefetchOtherTabs, 300);

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
