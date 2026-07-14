/* ── static-shim.js ───────────────────────────────────────────────────────────
   Carregado ANTES de positions.js. Neutraliza a "máquina ao vivo" para que o
   auto-init de positions.js (que ao final chama showTraderTab('emota') →
   loadPositionsForTab → fetch) vire um no-op inofensivo no snapshot estático.

   Estratégia: desligar a rede. positions.js faz `await (await fetch(...)).json()`;
   com fetch rejeitando, cai no catch e não renderiza nada — o static-boot.js
   assume a renderização a partir dos dados decriptados. Os dados NÃO vêm por
   fetch (vêm de data.js), então bloquear tudo é seguro.
--------------------------------------------------------------------------------- */
(function () {
  window.__SNAPSHOT_STATIC__ = true;
  const _blocked = () =>
    Promise.reject(new Error('snapshot estático: rede desabilitada'));
  try { window.fetch = _blocked; } catch (_) { /* ambiente sem fetch gravável */ }

  // Blindagem extra: se o auto-init do positions.js algum dia trocar fetch por outro
  // transporte, o snapshot NÃO pode disparar chamada ao servidor. Neutraliza XHR/
  // WebSocket/EventSource também (os dados vêm de data.js, nunca da rede).
  const _throw = function () { throw new Error('snapshot estático: rede desabilitada'); };
  try { window.XMLHttpRequest = function () { this.open = _throw; this.send = _throw; }; } catch (_) {}
  try { window.WebSocket = _throw; } catch (_) {}
  try { window.EventSource = _throw; } catch (_) {}
  try { if (navigator.sendBeacon) navigator.sendBeacon = function () { return false; }; } catch (_) {}
})();
