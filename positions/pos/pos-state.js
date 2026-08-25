/* ── API base URL ─────────────────────────────────────────────────────────── */
const API_BASE = location.protocol === 'file:' ? 'http://localhost:8083' : '';

/* ── Trader tab config ───────────────────────────────────────────────────── */
const TRADER_TABS = [
  { id: 'emota',       trader: 'EMota',      filters: ['no_hedge_cambial','no_fx_small'], useGroups: true  },
  { id: 'ecotrim',     trader: 'ECotrim',    filters: ['no_hedge_cambial','no_fx_small'], useGroups: true  },
  { id: 'portfoliorf', trader: 'PortfolioRF',filters: ['no_cash'],                         useGroups: false },
  { id: 'other',       trader: 'PAlves',     filters: ['no_hedge_cambial'],               useGroups: false },
];

/* ── State ───────────────────────────────────────────────────────────────── */
let positionsData = null;       // active tab data (kept for pnl.js compat)
let detailVisible = false;
let activeTraderTab = 'emota';
const posDataByTab = {};   // tabId → positionsData
const hiddenRows   = {};              // tabId → Set<rowKey>
const swapOpeningOverrides = new Map(); // rowKey → number (override abertura SWAP)
const swapTradedOverrides  = new Map(); // rowKey → number (override trades SWAP)
const swapDv01Overrides    = new Map(); // rowKey → number (override DV01 total do SWAP → #PL segue)
const plOverrides          = new Map(); // rowKey → number (override manual #PL, fração — só posição)
const wdoUcAggregated      = new Set(); // tabIds com agregação WDO+UC ativa

// ── FONTE ÚNICA de marreta de preço/delta, por INSTRUMENTO (instKey), não por aba/trader.
//    Mesmo ticker → mesmo valor em todas as abas. Live vem do backend (price_live/option_delta).
const priceOverrides = new Map();  // instKey → preço manual (marreta)
const deltaOverrides = new Map();  // instKey → delta manual (marreta)
const _dirtyTabs     = new Set();  // abas carregadas que precisam re-render após uma marreta

// ── Assinatura de DATA com que o cache de cada aba foi buscado (`refDate|forceOpening`).
//    Existe para o ⟳ de seção (pos-busy.js; antes o botão "⚡ Só esta aba", que ele
//    substituiu) PRESERVAR as abas já carregadas sem correr o risco de
//    servir dado de outro dia: descarta-se só a aba cuja assinatura difere dos inputs de
//    agora. Sem isto a alternativa era binária — ou apagar tudo (e a próxima aba voltava a
//    "Carregando…", que é o que a mesa reclamou) ou não apagar nada (e a tela mostrava
//    silenciosamente a data anterior ao mexer em "Data ref"/"Forçar D-1").
//    Chave = a MESMA do cache: tabId em `posDataByTab`, e `dc:<trader>` em `dolarConsolData`
//    (prefixado porque lá a chave é nome de trader, não id de aba).
const _tabFetchSig = {};
function _currentDateSig() {
  const d = document.getElementById('refDate');
  const f = document.getElementById('forceOpening');
  return `${d ? d.value : ''}|${f ? f.value : ''}`;
}
function _noteFetchSig(key) { _tabFetchSig[key] = _currentDateSig(); }

// ── Análise de Opções: seleção de linhas p/ o "⎘ Copiar" e p/ os totais ────
//    rowKey → bool. Default (1ª vez que a linha aparece): marcada se AINDA TEM POSIÇÃO
//    (final_qty ≠ 0) E NÃO for DOL BMF / USDBRL — essas têm a tabela "Consolidado Dólar"
//    logo acima na mesma aba (ver `_isDolUsdbrlOpt` em pos-render.js, fonte única do
//    predicado). Depois disso a escolha do usuário manda e persiste entre re-renders.
const optPrintSel = new Map();

/* ── Check Enquadramento (aba id 'dolar': dólar prev + derivativos RF) ────── */
const DOLAR_TAB_ID        = 'dolar';
const ENQ_RF_TAB_KEY      = 'enqrf';    // chave de cache do check de derivativos RF (não é aba nova)
let   dolarOptTickers     = {};         // optKey → ticker BBG (cache do backend; cadastro de DOL)

/* ── Hidden rows helpers ─────────────────────────────────────────────────── */
