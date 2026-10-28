/* ── Init ────────────────────────────────────────────────────────────────── */
const _today = new Date();
document.getElementById('refDate').value = lastBusinessDay(
  new Date(_today.getFullYear(), _today.getMonth(), _today.getDate())
);
renderFilterBars();
/* ⚠️ GUARDA porque o SNAPSHOT carrega um SUBCONJUNTO dos módulos. O viewer publicado
   (`snapshot/viewer/index.html`) lista 11 dos 19 `pos/*.js` e **não** traz o `pos-hedge.js`
   — a aba Hedge Cambial não existe lá. Sem a guarda isto virava `ReferenceError` na página
   pública, e como é um script clássico o erro ABORTA O ARQUIVO: as duas linhas abaixo nunca
   rodavam. Não quebrava a tela só porque o `static-boot.js` renderiza por conta própria
   depois — ou seja, um erro de verdade escondido atrás de uma coincidência.
   ⛔ A saída NÃO é publicar mais um módulo: a lista do viewer é a allowlist que impede o
   vazamento de 27/10 (ver `snapshot/pipeline.py`). Quem não está na página não vai para o ar. */
if (typeof initHedgeView === 'function') {
  initHedgeView();        // rótulo do botão Hedge Cambial = a tela escolhida da última vez
}
showTraderTab('emota');
prefetchPriorityTabs();   // ECotrim em PARALELO com a EMota (pos-tabs.js), não atrás dela
