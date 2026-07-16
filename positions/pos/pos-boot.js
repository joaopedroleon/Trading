/* ── Init ────────────────────────────────────────────────────────────────── */
const _today = new Date();
document.getElementById('refDate').value = lastBusinessDay(
  new Date(_today.getFullYear(), _today.getMonth(), _today.getDate())
);
renderFilterBars();
showTraderTab('emota');
