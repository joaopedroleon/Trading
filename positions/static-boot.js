/* ── static-boot.js ───────────────────────────────────────────────────────────
   Carregado por ÚLTIMO (após positions.js, pnl.js e data.js).
   1) Neutraliza as funções de edição/refresh de positions.js (read-only).
   2) Gate de senha → decripta os blobs de window.__ENC__ (AES-GCM/PBKDF2, WebCrypto).
   3) Renderiza as 3 seções (EMota/ECotrim/PortfolioRF) reusando renderSectionsForTab.

   Compartilha o escopo global dos scripts clássicos anteriores: posDataByTab,
   activeTraderTab, positionsData e as funções de render são visíveis aqui.
--------------------------------------------------------------------------------- */
(function () {
  'use strict';

  const TRADERS = [['emota', 'EMota'], ['ecotrim', 'ECotrim'], ['portfoliorf', 'PortfolioRF']];
  const PUBLIC_URL = 'https://joaopedroleon.github.io/Trading/positions/';

  const _tabIdForTrader = (trader) => (TRADERS.find(([, label]) => label === trader) || [])[0];

  // 1) Read-only: no-op nas funções que mexem em estado/servidor (se existirem).
  //    'copyCardImage' NÃO entra aqui: é read-only (só gera imagem da tabela) e
  //    precisa funcionar pra salvar/compartilhar o print no celular.
  const _noop = function () {};
  for (const fn of ['copySummaryTable', 'reloadActiveTab',
                    'prefetchOtherTabs', 'loadPositionsForTab',
                    'posPriceStartEdit', 'posPlStartEdit', 'swapStartEdit',
                    'optEditStart', 'pnlStartEdit', 'pnlStartSummaryEdit',
                    'hidePnlRow', 'restorePnlRows',
                    'consolSetDelta', 'dolarSetDelta', 'consolSetTicker',
                    'dolarSetTicker']) {
    try { if (typeof window[fn] === 'function') window[fn] = _noop; } catch (_) {}
  }

  /* ── Excluir/restaurar linhas (ciente do trader) ──────────────────────────
     positions.js prende hideRow/rerenderTables/renderRestoreBtn à global única
     activeTraderTab. Como o snapshot empilha os 3 traders de uma vez, essa global
     fica travada no último renderizado → o ✕ dos demais não funciona. Aqui
     sobrescrevemos p/ resolver o trader a partir da própria rowKey. */
  function _totalHidden() {
    let n = 0;
    for (const [id] of TRADERS) { try { n += _hiddenForTab(id).size; } catch (_) {} }
    return n;
  }
  function updateRestoreBtn() {
    const btn = document.getElementById('restoreBtn');
    if (!btn) return;
    const n = _totalHidden();
    btn.textContent = `↩ Restaurar ocultas (${n})`;
    btn.style.display = n > 0 ? '' : 'none';
  }
  window.renderRestoreBtn = updateRestoreBtn;  // caso positions.js a chame internamente

  window.hideRow = function (key) {
    const trader = String(key).split('||')[1];
    const id = _tabIdForTrader(trader) || activeTraderTab;
    activeTraderTab = id;                 // aponta o estado global p/ o trader da linha…
    positionsData = posDataByTab[id];     // …antes de ocultar/re-renderizar
    _hiddenForTab(id).add(key);
    rerenderTables(key);                  // re-render só do tbody da seção da linha
    updateRestoreBtn();
  };

  window.restoreHidden = function () {
    for (const [id] of TRADERS) {
      try { delete hiddenRows[id]; } catch (_) {}
      const data = posDataByTab[id];
      if (!data || !data.rows) continue;
      activeTraderTab = id;
      positionsData = data;
      renderSectionsForTab(id, data.rows);
    }
    updateRestoreBtn();
    // re-alinha as auxiliares após o layout assentar (mesmo padrão do unlock)
    const realign = () => {
      for (const [id] of TRADERS) {
        try { if (typeof _alignAuxTables === 'function') _alignAuxTables(id); } catch (_) {}
      }
    };
    requestAnimationFrame(() => requestAnimationFrame(realign));
  };

  /* ── WebCrypto: PBKDF2 → AES-GCM ──────────────────────────────────────────── */
  function b64ToBytes(b64) {
    const bin = atob(b64);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }
  async function deriveKey(pass, salt, iterations) {
    const material = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      material, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  }
  async function decryptBlob(pass, blob) {
    const salt = b64ToBytes(blob.salt);
    const iv   = b64ToBytes(blob.iv);
    const ct   = b64ToBytes(blob.ct);
    const key  = await deriveKey(pass, salt, blob.iterations);
    const pt   = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return JSON.parse(new TextDecoder().decode(pt));
  }

  /* ── Render de um trader (reusa renderSectionsForTab de positions.js) ─────── */
  function renderTrader(id, data) {
    activeTraderTab = id;                 // satisfaz o acoplamento global de positions.js
    posDataByTab[id] = data;
    positionsData = data;
    renderSectionsForTab(id, data.rows);  // Posição + MM/MM Prev + (PortfolioRF) fundos
    try { if (typeof renderWdoUcToggle === 'function') renderWdoUcToggle(id); } catch (_) {}
  }

  function fmtStamp(iso) {
    if (!iso) return '';
    const [y, m, d] = String(iso).slice(0, 10).split('-');
    return `${d}/${m}/${y}`;
  }

  /* ── Desbloqueio ──────────────────────────────────────────────────────────── */
  const gate = document.getElementById('gate');
  const input = document.getElementById('gatePass');
  const btn = document.getElementById('gateBtn');
  const msg = document.getElementById('gateMsg');

  /* ── Aba Posições (data.js / __ENC__) ─────────────────────────────────────── */
  async function _unlockPositions(pass) {
    const payloads = {};
    for (const [id] of TRADERS) {
      if (!window.__ENC__[id]) throw new Error('missing:' + id);
      payloads[id] = await decryptBlob(pass, window.__ENC__[id]);   // lança se senha errada
    }
    for (const [id] of TRADERS) {
      const el = document.getElementById('tab-' + id);
      if (el) el.style.display = '';
    }
    const failed = [];
    for (const [id, label] of TRADERS) {
      try { renderTrader(id, payloads[id]); }
      catch (err) { console.error('render falhou p/', id, err); failed.push(label); }
    }

    const first = payloads[TRADERS[0][0]] || {};
    const meta = window.__ENC__.meta || {};
    const parts = [];
    if (first.opening_date) parts.push('Abertura: ' + fmtStamp(first.opening_date));
    if (first.ref_date)     parts.push('Boletas: ' + fmtStamp(first.ref_date));
    if (meta.generated_at)  parts.push('Gerado: ' + meta.generated_at);
    // Procedência dos preços (campo `prices`): 'cache' (Oracle fora), 'd1' (BBG fora,
    // fechamento D-1), 'bbg'/ausente (ao vivo). Fallback: sem `prices` → live===false ⇒ cache.
    const sources = meta.sources || {};
    const priceKind = (s) => s.prices || (s.live === false ? 'cache' : 'bbg');
    const cached = TRADERS
      .filter(([id]) => sources[id] && priceKind(sources[id]) === 'cache')
      .map(([id, label]) => label + (sources[id].captured_at ? ` (${sources[id].captured_at})` : ''));
    if (cached.length) parts.push('⚠ preços em cache: ' + cached.join(', '));
    const d1 = TRADERS
      .filter(([id]) => sources[id] && priceKind(sources[id]) === 'd1')
      .map(([, label]) => label);
    if (d1.length)     parts.push('⚠ preços de fechamento D-1 (Bloomberg indisponível): ' + d1.join(', '));
    if (failed.length) parts.push('⚠ falha ao renderizar: ' + failed.join(', '));
    document.getElementById('snapMeta').textContent = parts.join('  |  ');

    // Re-alinha as tabelas auxiliares após o layout assentar.
    const realign = () => {
      for (const [id] of TRADERS) {
        try { if (typeof _alignAuxTables === 'function') _alignAuxTables(id); } catch (_) {}
      }
    };
    requestAnimationFrame(() => requestAnimationFrame(realign));
    setTimeout(realign, 250);
    window.addEventListener('resize', realign);
  }

  /* ── Aba PnL gerencial (data_pnl.js / __ENC_PNL__) ────────────────────────────
     Reusa renderPnlSummary de pnl.js: por trader seta os globais pnlData/activePnlTabId
     (mesmo acoplamento sequencial das Posições) e injeta o HTML do resumo. */
  async function _unlockPnl(pass) {
    const meta = window.__ENC_PNL__.meta || {};
    const sources = meta.sources || {};
    let refStamp = null;
    for (const [id, label] of TRADERS) {
      const blob = window.__ENC_PNL__[id];
      const container = document.getElementById('pnlSnapContainer-' + id);
      if (!container) continue;
      if (!blob) { container.innerHTML = '<div style="color:var(--text-muted);padding:8px">Sem dados para ' + label + '.</div>'; continue; }
      let payload;
      try { payload = await decryptBlob(pass, blob); }         // lança se senha errada
      catch (e) { if (id === TRADERS[0][0]) throw e; console.error('decrypt PnL falhou p/', id, e); continue; }
      try {
        pnlData = payload;                 // globais lidos por renderPnlSummary/pnlFor
        activePnlTabId = id;
        container.innerHTML = renderPnlSummary(payload.rows || []);
        if (!refStamp && payload.ref_date) refStamp = payload.ref_date;
      } catch (err) {
        console.error('render PnL falhou p/', id, err);
        container.innerHTML = '<div style="color:var(--red);padding:8px">Falha ao renderizar ' + label + '.</div>';
      }
    }
    const parts = [];
    if (refStamp)          parts.push('Gerencial de ' + fmtStamp(refStamp));
    if (meta.generated_at) parts.push('Gerado: ' + meta.generated_at);
    const el = document.getElementById('snapMetaPnl');
    if (el) el.textContent = parts.join('  |  ');
  }

  /* ── Desbloqueio (decripta as abas presentes; falha só se nenhuma existir) ─── */
  async function unlock() {
    const pass = input.value;
    if (!pass) { msg.textContent = 'Digite a senha.'; return; }
    const hasPos = !!window.__ENC__, hasPnl = !!window.__ENC_PNL__;
    if (!hasPos && !hasPnl) { msg.textContent = 'Dados não encontrados (data.js / data_pnl.js).'; return; }
    btn.disabled = true; msg.style.color = 'var(--text-muted)'; msg.textContent = 'Decriptando…';
    try {
      if (hasPos) await _unlockPositions(pass);
      if (hasPnl) await _unlockPnl(pass);
      document.body.classList.remove('locked');
      gate.style.display = 'none';
    } catch (e) {
      msg.style.color = 'var(--red)';
      msg.textContent = (String(e.message || e).startsWith('missing:'))
        ? 'Snapshot incompleto para ' + String(e.message).split(':')[1] + '.'
        : 'Senha incorreta.';
      btn.disabled = false;
      input.select();
    }
  }

  btn.addEventListener('click', unlock);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') unlock(); });

  /* ── Troca de aba (Posições ↔ PnL) ──────────────────────────────────────────── */
  for (const tab of document.querySelectorAll('.snap-tab')) {
    tab.addEventListener('click', () => {
      const view = tab.dataset.view;
      for (const t of document.querySelectorAll('.snap-tab')) t.classList.toggle('active', t === tab);
      const vp = document.getElementById('view-positions');
      const vn = document.getElementById('view-pnl');
      if (vp) vp.style.display = view === 'positions' ? '' : 'none';
      if (vn) vn.style.display = view === 'pnl' ? '' : 'none';
    });
  }

  // Mostra o horário de geração já na tela de senha (confirma que é a versão nova)
  const stamp = document.getElementById('gateStamp');
  const gen = (window.__ENC__ && window.__ENC__.meta && window.__ENC__.meta.generated_at)
           || (window.__ENC_PNL__ && window.__ENC_PNL__.meta && window.__ENC_PNL__.meta.generated_at);
  if (stamp && gen) stamp.textContent = 'Snapshot gerado em ' + gen;
})();
