/* ── Init ────────────────────────────────────────────────────────────────── */
const _today = new Date();
document.getElementById('refDate').value = lastBusinessDay(
  new Date(_today.getFullYear(), _today.getMonth(), _today.getDate())
);
renderFilterBars();
initHedgeView();          // rótulo do botão Hedge Cambial = a tela escolhida da última vez
showTraderTab('emota');
prefetchPriorityTabs();   // ECotrim em PARALELO com a EMota (pos-tabs.js), não atrás dela
