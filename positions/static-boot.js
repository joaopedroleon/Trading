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
    // Procedência dos preços (campo `prices`): 'cache' (Oracle fora → payload inteiro do
    // cache), 'bbg-cache' (BBG fora → mercado do último fetch BBG bom + posição/datas
    // frescas), 'd1' (BBG fora e sem cache de mercado → fechamento D-1), 'bbg'/ausente
    // (ao vivo). Fallback: sem `prices` → live===false ⇒ cache.
    const sources = meta.sources || {};
    const priceKind = (s) => s.prices || (s.live === false ? 'cache' : 'bbg');
    const cached = TRADERS
      .filter(([id]) => sources[id] && priceKind(sources[id]) === 'cache')
      .map(([id, label]) => label + (sources[id].captured_at ? ` (${sources[id].captured_at})` : ''));
    if (cached.length) parts.push('⚠ preços em cache: ' + cached.join(', '));
    // bbg_cache_time é ISO com hora (ex.: 2026-07-15T18:45:03) → mostra DD/MM HH:MM.
    const fmtStampTime = (iso) => {
      if (!iso) return '';
      const s = String(iso);
      const [y, m, d] = s.slice(0, 10).split('-');
      const hm = s.slice(11, 16);
      return `${d}/${m}${hm ? ' ' + hm : ''}`;
    };
    const bbgCache = TRADERS
      .filter(([id]) => sources[id] && priceKind(sources[id]) === 'bbg-cache')
      .map(([id, label]) => label + (sources[id].bbg_cache_time ? ` (${fmtStampTime(sources[id].bbg_cache_time)})` : ''));
    if (bbgCache.length) parts.push('⚠ preços BBG em cache: ' + bbgCache.join(', '));
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
        activePnlTabId = id;               // _pnlTabFilterRows lê esta global p/ achar os filtros da aba
        // MESMOS filtros da tela (por aba: no_hedge_cambial/no_fx_small; PortfolioRF: no_cash),
        // aplicados via a MESMA função do app → o snapshot fica idêntico à tela.
        const rows = payload.rows || [];
        const filtered = (typeof _pnlTabFilterRows === 'function' ? _pnlTabFilterRows(rows) : rows)
          .filter(r => (typeof _isPnlGroup === 'function' ? _isPnlGroup(r.group) : true));
        container.innerHTML = renderPnlSummary(filtered);
        if (!refStamp && payload.ref_date) refStamp = payload.ref_date;
      } catch (err) {
        console.error('render PnL falhou p/', id, err);
        container.innerHTML = '<div style="color:var(--red);padding:8px">Falha ao renderizar ' + label + '.</div>';
      }
    }
    const parts = [];
    if (refStamp)          parts.push('Gerencial de ' + fmtStamp(refStamp));
    if (meta.generated_at) parts.push('Gerado: ' + meta.generated_at);
    // Instrumentos zerados por falta de calc_factor (campo estrutural BBG never-cached no
    // replay): avisa em vez de zerar em silêncio. Com o cache íntegro deve ser 0.
    const zeroed = TRADERS
      .filter(([id]) => sources[id] && sources[id].cf_missing > 0)
      .map(([id, label]) => `${label} (${sources[id].cf_missing})`);
    if (zeroed.length) parts.push('⚠ instrumentos zerados por falta de dado estrutural BBG: ' + zeroed.join(', '));
    // D0 provisório: o run da noite mira o dia corrente (D0), mas o fechamento gerencial
    // oficial do JRS ainda não tinha saído neste horário → marca caiu p/ boleta/D-1. O run
    // das 20:45 e o de 6h refazem com o fechamento oficial e o aviso some.
    const d0pend = TRADERS.some(([id]) => sources[id] && sources[id].d0_pending);
    if (d0pend) parts.push('⚠ D0 PROVISÓRIO — fechamento gerencial de '
      + (refStamp ? fmtStamp(refStamp) : 'hoje')
      + ' ainda não disponível no JRS neste horário (marcado por boleta/D-1); atualiza no próximo run (20:45 / 6h)');
    const el = document.getElementById('snapMetaPnl');
    if (el) {
      el.textContent = parts.join('  |  ');
      el.style.color = d0pend ? 'var(--red)' : '';   // provisório → destaque
    }
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

  // Mostra o horário de geração de CADA aba já na tela de senha (Posições e PnL são
  // pipelines independentes, rodam em horários diferentes) — confirma a versão de cada uma.
  const stamp = document.getElementById('gateStamp');
  if (stamp) {
    const posGen = window.__ENC__     && window.__ENC__.meta     && window.__ENC__.meta.generated_at;
    const pnlGen = window.__ENC_PNL__ && window.__ENC_PNL__.meta && window.__ENC_PNL__.meta.generated_at;
    const lines = [];
    if (posGen) lines.push('Posições: ' + posGen);
    if (pnlGen) lines.push('PnL: ' + pnlGen);
    if (lines.length) stamp.textContent = 'Último snapshot — ' + lines.join('  ·  ');
  }
})();
