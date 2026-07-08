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

  // 1) Read-only: no-op nas funções que mexem em estado/servidor (se existirem).
  //    'copyCardImage' NÃO entra aqui: é read-only (só gera imagem da tabela) e
  //    precisa funcionar pra salvar/compartilhar o print no celular.
  const _noop = function () {};
  for (const fn of ['copySummaryTable', 'reloadActiveTab',
                    'prefetchOtherTabs', 'loadPositionsForTab',
                    'posPriceStartEdit', 'posPlStartEdit', 'swapStartEdit',
                    'optEditStart', 'pnlStartEdit', 'pnlStartSummaryEdit',
                    'consolSetDelta', 'dolarSetDelta', 'consolSetTicker',
                    'dolarSetTicker']) {
    try { if (typeof window[fn] === 'function') window[fn] = _noop; } catch (_) {}
  }

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

  async function unlock() {
    const pass = input.value;
    if (!pass) { msg.textContent = 'Digite a senha.'; return; }
    if (!window.__ENC__) { msg.textContent = 'Dados não encontrados (data.js).'; return; }
    btn.disabled = true; msg.style.color = 'var(--text-muted)'; msg.textContent = 'Decriptando…';
    try {
      const payloads = {};
      for (const [id] of TRADERS) {
        if (!window.__ENC__[id]) throw new Error('missing:' + id);
        payloads[id] = await decryptBlob(pass, window.__ENC__[id]);   // lança se senha errada
      }
      // Sucesso: revela as seções (layout necessário p/ alinhamento das tabelas auxiliares)
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
      if (failed.length)      parts.push('⚠ falha ao renderizar: ' + failed.join(', '));
      document.getElementById('snapMeta').textContent = parts.join('  |  ');

      document.body.classList.remove('locked');
      gate.style.display = 'none';

      // Re-alinha as tabelas auxiliares (à direita) DEPOIS que o layout assenta:
      // o gate sumiu e a regra CSS que esconde o MM Prev (:has) já recalculou o
      // fluxo — só então as medições de posição do _alignAuxTables ficam corretas.
      const realign = () => {
        for (const [id] of TRADERS) {
          try { if (typeof _alignAuxTables === 'function') _alignAuxTables(id); } catch (_) {}
        }
      };
      requestAnimationFrame(() => requestAnimationFrame(realign));
      setTimeout(realign, 250);
      window.addEventListener('resize', realign);
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

  // Mostra o horário de geração já na tela de senha (confirma que é a versão nova)
  const stamp = document.getElementById('gateStamp');
  const gen = window.__ENC__ && window.__ENC__.meta && window.__ENC__.meta.generated_at;
  if (stamp && gen) stamp.textContent = 'Snapshot gerado em ' + gen;
})();
