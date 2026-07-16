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

/* ── Check Dólar Exposure (aba por fundo) ────────────────────────────────── */
const DOLAR_TAB_ID        = 'dolar';
let   dolarOptTickers     = {};         // optKey → ticker BBG (cache do backend; cadastro de DOL)

/* ── Hidden rows helpers ─────────────────────────────────────────────────── */
