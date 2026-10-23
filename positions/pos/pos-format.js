/* ── Marcas de EDIÇÃO: ficam na TELA, somem do PRINT ──────────────────────────
   A ★ (marreta manual de preço/delta/quantidade/#PL), o ⚡ (linha adicionada à mão, que não
   está na carteira) e o ✕ (excluir/ocultar a linha) são sinalização para QUEM OPERA a tela —
   dizem o que foi mexido e onde clicar. Num print que vai para a mesa ou para o WhatsApp
   eles não dizem nada a quem recebe e sujam a imagem (pedido do JLeon, out/2026).

   ⚠️ O html2canvas **não clona** o nó com `data-html2canvas-ignore` — ele cai fora já no
   `DocumentCloner`, não só na pintura. Ou seja a imagem é RE-MEDIDA sem a marca, e sai mais
   justa: medido num tabelão de teste, a mesma linha com ✕ + ★ + ⚡ dá 574×66 px de canvas e,
   com as três marcas ignoradas, **418×60** — a coluna do ✕ some inteira em vez de virar uma
   lacuna. É o que se quer num print, mas vale saber que a largura das colunas é remedida (o
   alvo é `width: fit-content`): a tela não pisca, porque nada disso toca o DOM vivo.
   Vale para os 4 caminhos de cópia da tela — todos passam pelo `copyElementAsImage`
   (pos-misc.js).

   ⛔ Marca de PROCEDÊNCIA fica: o `*` de "sem mid two-sided na BBG" e o `~` de "vencimento
   lido do nome" qualificam o NÚMERO, não o que o operador ajustou — tirá-los do print
   esconderia de quem recebe que aquele preço não é um mid. */
const IMG_SKIP = 'data-html2canvas-ignore="true"';

const fmtDate = iso => {
  if (!iso) return '—';
  if (!/^\d{4}-/.test(iso)) return iso;  // vértice (ex: "3M", "2Y") → exibe direto
  return iso.slice(0, 10).split('-').reverse().join('/');
};

// ISO com hora (ex.: '2026-07-15T18:45:03') → 'DD/MM HH:MM'
const fmtDateTime = iso => {
  if (!iso) return '';
  const s = String(iso);
  const [y, m, d] = s.slice(0, 10).split('-');
  const hm = s.slice(11, 16);
  return `${d}/${m}${hm ? ' ' + hm : ''}`;
};

/* ── Quantidade: casas decimais POR LINHA ────────────────────────────────────
   O padrão da tela é 0 casa e separador en-US, porque a unidade de quase tudo aqui é o
   CONTRATO e contrato é inteiro.
   ⭐ **CDS é a exceção: 1 casa e VÍRGULA** (pedido da mesa, 22/10/2026). Ali a quantidade é
   fracionária de verdade — em 21/10/2026 o JRS traz `0,5` e `4` no mesmo instrumento —, e com
   0 casa o `toLocaleString` ARREDONDA sem avisar: meio contrato imprimia **1**, o dobro da
   posição, sem erro nenhum e sem nada na tela dizendo que havia decimal.
   ⚠️ Quem casa é o `instrument_type` ("Credit Default Swap…") **ou** o prefixo `CDS_` do nome
   — os mesmos dois do balde `cds` da tira NET (pos-render.js), e pelo mesmo motivo: a
   sub-área mente (o MESMO ref vem em `Fixed Rates Brazil` e em `Corporate Credit`, conforme
   o livro) e o `instrument_type` vem vazio na row que nasce só de boleta. */
const isCdsRow = r =>
     /credit\s*default\s*swap/i.test(r?.instrument_type || '')
  || /^CDS[_\s]/i.test(r?.instrument_name || '');

// Casas decimais da quantidade desta linha. É o único lugar que decide isso.
const qtyDec = r => (isCdsRow(r) ? 1 : 0);

/* `dec > 0` troca o locale junto (pt-BR): o pedido é a VÍRGULA, e separador decimal e de
   milhar vêm do mesmo locale — misturar `en-US` com 1 casa daria `20.0`, que é o oposto. */
const fmtQty = (v, dec = 0) =>
  v == null ? '—' : v.toLocaleString(dec ? 'pt-BR' : 'en-US',
                                     { minimumFractionDigits: dec, maximumFractionDigits: dec });

const fmtPrice = v =>
  v == null ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fmtPricePct = v =>
  v == null ? '—' : (v * 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%';

// Preço de OPÇÃO na Análise de Opções (mid + BID/ASK): 2 casas de piso, até 4 quando precisa.
// ⚠️ Não é firula: com 2 casas fixas um prêmio de EWZ com bid 0,19 e ask 0,22 mostrava mid
// "0,21" — e o mid É 0,205. A tabela afirma que TODA conta derivada sai do mid; um mid que
// não bate com o meio do próprio bid/ask exibido desmente a afirmação na cara do leitor.
// Preço "grande" (24,6 de opção de futuro) segue lendo 24,60, sem cauda de zeros.
const fmtOptPx = v =>
  v == null ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });

function fmtDv01(v) {
  if (v == null) return '—';
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  if (v < 0) return `<span style="color:var(--red)">(${s})</span>`;
  if (v === 0) return `<span style="color:var(--text-muted)">—</span>`;
  return s;
}

function fmtNav(v, navDate, openingDate) {
  if (v == null) return '';
  const base = `NAV: USD ${v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  if (navDate && openingDate && navDate !== openingDate)
    return `${base} <span style="color:var(--yellow);font-size:11px" title="NAV indisponível para ${fmtDate(openingDate)} — usando ${fmtDate(navDate)}">⚠ ${fmtDate(navDate)}</span>`;
  return base;
}

function fmtPL(v, type, noGreen = false) {
  if (v == null) return '<span style="color:var(--text-muted)">—</span>';
  const abs = Math.abs(v);
  let s;
  if (type === 'pct') {
    s = (abs * 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%';
  } else {
    s = abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  if (v > 0) return noGreen ? `<span>+${s}</span>` : `<span style="color:var(--green)">+${s}</span>`;
  if (v < 0) return `<span style="color:var(--red)">(${s})</span>`;
  return `<span style="color:var(--text-muted)">—</span>`;
}


function fmtTradedQty(v, dec = 0) {
  if (v == null || v === 0) return '<span style="color:var(--text-muted)">—</span>';
  const s = fmtQty(Math.abs(v), dec);
  return v < 0 ? `<span style="color:var(--red)">(${s})</span>` : s;
}

function fmtFinalQty(v, dec = 0) {
  if (v == null) return '—';
  const s = fmtQty(Math.abs(v), dec);
  if (v < 0) return `<span style="color:var(--red)">(${s})</span>`;
  if (v === 0) return `<span style="color:var(--text-muted)">—</span>`;
  return s;
}

/* Vencimento de OPÇÃO já marcando o que veio DERIVADO do nome (ver `optMaturity`).
   O til não é enfeite: é a diferença entre "o JRS disse" e "eu li no nome do papel", e a
   mesa precisa saber qual dos dois está olhando antes de rolar posição por essa data. */
function fmtOptMaturity(r) {
  const { iso, derived } = optMaturity(r);
  if (!iso) return '<span style="color:var(--text-muted)">—</span>';
  if (!derived) return fmtDate(iso);
  return `<span style="border-bottom:1px dotted var(--text-muted)" title="Vencimento lido do NOME do instrumento: o JRS não trouxe maturity para esta linha (opção sem posição de abertura — aberta hoje).">${fmtDate(iso)}<span style="color:var(--text-muted)">~</span></span>`;
}

/* Valor financeiro em USD (verde +, vermelho entre parênteses), 0 casas */
function fmtMoney(v) {
  if (v == null || !isFinite(v)) return '<span style="color:var(--text-muted)">—</span>';
  const s = Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (v > 0) return `<span style="color:var(--green)">+${s}</span>`;
  if (v < 0) return `<span style="color:var(--red)">(${s})</span>`;
  return '<span style="color:var(--text-muted)">—</span>';
}

/* Exposição: financeiro em USD + % do NAV entre parênteses, numa célula só */
function fmtExp(usd, pct) {
  if ((usd == null || !isFinite(usd)) && (pct == null || !isFinite(pct)))
    return '<span style="color:var(--text-muted)">—</span>';
  const money = fmtMoney(usd);
  if (pct == null || !isFinite(pct)) return money;
  const p = (pct * 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%';
  return `${money} <span style="color:var(--text-muted)">(${p})</span>`;
}

function bbgTooltip(bbgData) {
  if (!bbgData) return '';
  return Object.entries(bbgData)
    .map(([k, v]) => `${k}: ${v ?? '—'}`)
    .join('\n');
}

/* ── Sort ────────────────────────────────────────────────────────────────── */
function sortRows(rows) {
  return [...rows].sort((a, b) => {
    const cmp = (x, y, desc = false) => {
      const r = (x ?? '').toString().localeCompare((y ?? '').toString(), 'en-US', { sensitivity: 'base' });
      return desc ? -r : r;
    };
    // Linhas SIMULADAS (pos-simular.js) sempre no FIM, qualquer que seja a área: são
    // acréscimo do usuário, não podem se intercalar na leitura da posição real.
    const sim = (a.is_simulated ? 1 : 0) - (b.is_simulated ? 1 : 0);
    if (sim) return sim;
    /* ⭐ VENCIMENTO entra DENTRO da estratégia, não como 1ª chave (ago/2026, pedido da mesa,
       decidido sobre a medição). Assim opções/contratos de mesmo vencimento ficam juntos e os
       blocos de área/sub-área continuam inteiros — e isso importa porque o `renderTable` desenha
       a **divisória de área** e a **zebra por sub-área** por TRANSIÇÃO DE LINHA CONSECUTIVA:
       ordenar por vencimento primeiro não reordenaria só a tabela, ela ganharia divisória e
       troca de faixa quase linha a linha. Medido no EMota (25 linhas): vencimento como 1ª chave
       leva os 4 blocos de área a 11 e os 9 de sub-área a 14; aqui os dois ficam em 4 e 9.
       Ordena pela `sortMaturityKey` (ISO, com o fallback de nome), NÃO por `fmtDate` — dd/mm/aaaa
       ordenaria por dia do mês. */
    return cmp(a.area,            b.area,            true)  // área: Z→A
        || cmp(a.subarea,         b.subarea)                 // sub-área: A→Z
        || cmp(a.strategy,        b.strategy)                // estratégia: A→Z
        || cmp(sortMaturityKey(a), sortMaturityKey(b))       // vencimento: mais curto primeiro
        || cmp(a.instrument_name, b.instrument_name);        // instrumento: A→Z
  });
}

/* ── Toggle detail cols ──────────────────────────────────────────────────── */
function toggleDetail() {
  detailVisible = !detailVisible;
  document.querySelectorAll('.col-detail').forEach(el => {
    el.style.display = detailVisible ? '' : 'none';
  });
  document.getElementById('toggleBtn').textContent = detailVisible
    ? '▲ Ocultar detalhes'
    : '▼ Área / Sub-área / Estratégia';
}

/* ── Section helpers ─────────────────────────────────────────────────────── */
function getSections(rows) {
  const map = new Map();
  for (const r of rows) {
    const key = `${r.group}||${r.trader}`;
    if (!map.has(key)) map.set(key, { group: r.group, trader: r.trader });
  }
  return [...map.values()].sort((a, b) => {
    const gi = x => { const i = GROUP_ORDER.indexOf(x.group); return i >= 0 ? i : 99; };
    return (gi(a) - gi(b)) || a.trader.localeCompare(b.trader);
  });
}

/* ── Sleeve de RF: a regra de ONDE as linhas dele são desenhadas ─────────────────────
   ☠️ **Fonte ÚNICA de propósito.** A 1ª versão tinha a regra copiada no `renderSectionsForTab`
   (pos-tabs.js) e o `rerenderTables` (pos-render.js) ficou com a antiga — resultado: montava
   certo, mas qualquer filtro, ✕ de linha ou marreta re-renderizava a seção SEM as linhas do
   sleeve, e elas não voltavam (a seção própria delas não existe mais depois da mescla).
   Aferido: ligar/desligar "Excluir FX < 0,10%" apagava os 3 FX do Abinader para sempre.
   Quem precisar da lista de linhas de uma seção chama `sectionRowsFor` — não refaz o filtro. */
/* ⚠️ **Única dona do nome do grupo.** O literal 'RF Offshore' só aparece aqui: ele estava
   repetido em 4 arquivos, cada um com o seu `typeof … !== 'undefined' ? … : 'RF Offshore'` —
   4 lugares para errar a mesma string. O fallback existe para o snapshot estático antigo,
   cujo payload não tem `rf_sleeve`. */
function rfGroupIdFor(data) {
  return data?.rf_sleeve?.group ?? 'RF Offshore';
}

/* Trader da aba que RECEBE as linhas do sleeve na própria tabela, ou null.
   Mescla quando o sleeve é de OUTRO trader; na aba do dono elas seguem em card próprio. */
function rfMergeTraderFor(tabId) {
  const d   = posDataByTab[tabId];
  const cfg = d?.rf_sleeve;
  const tab = (typeof TRADER_TABS !== 'undefined') ? TRADER_TABS.find(t => t.id === tabId) : null;
  return (cfg && tab && !(cfg.traders ?? []).includes(tab.trader)) ? tab.trader : null;
}

/* Seções da aba — a do sleeve some quando mesclada (as linhas entram na do trader da aba). */
function sectionsFor(tabId, rows) {
  const merged = rfMergeTraderFor(tabId);
  const g      = rfGroupIdFor(posDataByTab[tabId]);
  return getSections(rows).filter(s => !(merged && s.group === g));
}

/* Linhas de UMA seção, já com o sleeve dentro quando é ela que recebe a mescla. */
function sectionRowsFor(tabId, s, rows) {
  const merged = rfMergeTraderFor(tabId);
  const g      = rfGroupIdFor(posDataByTab[tabId]);
  return rows.filter(r =>
    (r.group === s.group && r.trader === s.trader) ||
    (merged && s.trader === merged && s.group !== g && r.group === g));
}

function sectionBodyId(s) {
  return `body_${s.group}_${s.trader}`.replace(/[^a-zA-Z0-9]/g, '_');
}

/* Id da tira "net por grupo de ativo" da seção — o PAR do `sectionBodyId`: mesmo sufixo,
   outro prefixo. O `renderTable` (pos-render.js) chega nela por
   `tbodyId.replace(/^body_/, 'netsum_')`, então as duas funções TÊM de sanitizar igual. */
function sectionNetId(s) {
  return `netsum_${s.group}_${s.trader}`.replace(/[^a-zA-Z0-9]/g, '_');
}

// Id do botão "✕ Ocultar zeradas" da seção — mesmo esquema: `hidezero_` + o sufixo do tbody.
function sectionHideZeroId(s) {
  return `hidezero_${s.group}_${s.trader}`.replace(/[^a-zA-Z0-9]/g, '_');
}
// Id do botão "↩ Restaurar ocultas" da seção — idem, `restore_` + o sufixo do tbody.
function sectionRestoreId(s) {
  return `restore_${s.group}_${s.trader}`.replace(/[^a-zA-Z0-9]/g, '_');
}

function thead() {
  const d = detailVisible ? '' : 'style="display:none"';
  return `<thead><tr>
    <th class="col-copy" ${IMG_SKIP} title="Excluir linha"></th>
    <th class="col-detail" ${d}>Área</th>
    <th class="col-detail" ${d}>Sub-área</th>
    <th class="col-detail" ${d}>Estratégia</th>
    <th class="col-detail" ${d}>Preço D-1</th>
    <th class="col-final">Instrumento</th>
    <th>Vencto</th>
    <th class="col-pnl">Qtd Abertura</th>
    <th>Qtd Operada</th>
    <th class="col-right">Qtd Final</th>
    <th>Price Live</th>
    <th>USD DV01</th>
    <th class="col-final">#PL</th>
  </tr></thead>`;
}

/* ── SWAP manual override ────────────────────────────────────────────────── */
