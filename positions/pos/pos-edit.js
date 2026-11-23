function _swapOvrMap(field) {
  return field === 'opening' ? swapOpeningOverrides
       : field === 'traded'  ? swapTradedOverrides
       : swapDv01Overrides;                         // 'dv01'
}
function swapStartEdit(td, field, key, currentVal) {
  const map = _swapOvrMap(field);
  const input = document.createElement('input');
  input.type = 'text';
  input.style.cssText = 'width:90px;font:inherit;text-align:right;background:var(--bg);border:1px solid var(--accent);color:var(--text)';
  input.value = currentVal != null
    ? currentVal.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
    : '';
  td.innerHTML = '';
  td.appendChild(input);
  input.focus();
  input.select();
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  input.blur();
    if (e.key === 'Escape') { map.delete(key); _markTabsDirtyAndRerender(); }
  });
  input.addEventListener('blur', () => swapApplyEdit(input, field, key));
  input.addEventListener('click', e => e.stopPropagation());
}

function swapApplyEdit(input, field, key) {
  const map = _swapOvrMap(field);
  const val = parseFloat(String(input.value).replace(/\./g, '').replace(',', '.'));
  if (!isNaN(val)) map.set(key, val);
  else map.delete(key);
  // abertura/operada/dv01: TODOS alteram a qtd (DV01) e o RESULTADO do swap no PnL
  // (estoque = DV01_abertura × Δtaxa; final = abertura + operada) → re-render Posição E PnL.
  _markTabsDirtyAndRerender();
}

/* ── #PL manual override ─────────────────────────────────────────────────── */
function posPlStartEdit(td) {
  if (td.querySelector('input')) return;
  const key = td.dataset.rowkey;
  const cur = plOverrides.has(key) ? (plOverrides.get(key) * 100) : '';
  const input = document.createElement('input');
  input.type = 'text';
  input.style.cssText = 'width:5em;font:inherit;text-align:right;background:var(--bg);border:1px solid var(--accent);color:var(--text)';
  input.value = cur !== '' ? String(cur).replace('.', ',') : '';
  td.innerHTML = '';
  td.appendChild(input);
  input.focus();
  input.select();
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  input.blur();
    if (e.key === 'Escape') { plOverrides.delete(key); rerenderTables(); }
  });
  input.addEventListener('blur',  () => posPlApplyEdit(input, key));
  input.addEventListener('click', e => e.stopPropagation());
}

function posPlApplyEdit(input, key) {
  const val = parseFloat(String(input.value).replace(/\./g, '').replace(',', '.'));
  if (!isNaN(val)) plOverrides.set(key, val / 100);
  else plOverrides.delete(key);
  rerenderTables();
}

/* ☠️ **CDS: a coluna de preço MOSTRA e ACEITA spread em bp, mas o que se grava é o UPFRONT**
   (23/11/2026). A mesa pediu o spread na tela — é o número que ela negocia — e o cálculo
   continua no upfront % do nocional, que é o que multiplica pelo nocional e vira financeiro.
   Sem converter nos dois sentidos, a marreta leria `180` como **180 % de upfront**: numa
   posição de 6 MM, US$ 10,8 milhões em vez de 0,18. É o mesmo mecanismo que já existia para
   a opção de FX (exibe %, guarda fração), só que aqui a régua não é 100 — é a **anuidade**.
   ⭐ A reta é ancorada no par que o BACKEND mandou (`spread_bp`, `price`), não numa 2ª
   derivação do preço do CDS: `preço = p0 + (S − S0)/1e4 × anuidade × 100`. Assim o JS sabe
   só "o preço anda `anuidade` por bp" — que é o DV01 que a própria linha publica ao lado.
   ⚠️ Devolve `null` quando a linha não é CDS **ou** quando a curva não respondeu: aí a célula
   volta a ser preço cru, como era antes, em vez de converter com meia régua. */
function _cdsEditConv(td) {
  if (td.dataset.iscds !== '1') return null;
  const ann = parseFloat(td.dataset.cdsann);
  const s0  = parseFloat(td.dataset.cdss0);
  const p0  = parseFloat(td.dataset.cdsp0);
  if (!isFinite(ann) || !ann || !isFinite(s0) || !isFinite(p0)) return null;
  const passo = ann * 100 / 1e4;                       // p.p. de upfront por bp de spread
  return {
    toPrice:  s  => p0 + (s - s0) * passo,
    toSpread: px => Math.round((s0 + (px - p0) / passo) * 100) / 100,
  };
}

function posPriceStartEdit(td) {
  if (td.querySelector('input')) return;
  const ik    = td.dataset.instkey;            // preço é por INSTRUMENTO (compartilhado entre abas)
  const key   = td.dataset.rowkey;             // #PL é por posição (trader)
  const isFx  = td.dataset.isfx === '1';
  const cds   = _cdsEditConv(td);   // CDS: a célula mostra e aceita SPREAD (bp) — ver abaixo
  const cur   = priceOverrides.has(ik) ? priceOverrides.get(ik) : null;
  const input = document.createElement('input');
  input.type  = 'text';
  input.style.cssText = 'width:6em;font:inherit;text-align:right;background:var(--bg);border:1px solid var(--accent);color:var(--text)';
  input.value = cur !== null
    ? String(cds ? cds.toSpread(cur) : (isFx ? cur * 100 : cur)).replace('.', ',')
    : '';
  td.innerHTML = '';
  td.appendChild(input);
  input.focus();
  input.select();
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  input.blur();
    if (e.key === 'Escape') {
      priceOverrides.delete(ik);
      plOverrides.delete(key);
      _markTabsDirtyAndRerender();
    }
  });
  input.addEventListener('blur',  () => posPriceApplyEdit(input, td));
  input.addEventListener('click', e => e.stopPropagation());
}

function posPriceApplyEdit(input, td) {
  const ik   = td.dataset.instkey;
  const key  = td.dataset.rowkey;
  const isFx = td.dataset.isfx === '1';
  const cds  = _cdsEditConv(td);
  const raw  = parseFloat(String(input.value).replace(/\./g, '').replace(',', '.'));
  if (isNaN(raw)) {
    priceOverrides.delete(ik);
    plOverrides.delete(key);
  } else {
    const price = cds ? cds.toPrice(raw) : (isFx ? raw / 100 : raw);
    priceOverrides.set(ik, price);
    // Recalcula pl para instrumentos cuja exposição deriva do preço (pl_type='pct', não opção)
    const cf  = parseFloat(td.dataset.cf);
    const nav = parseFloat(td.dataset.nav);
    const fq  = parseFloat(td.dataset.fq);
    const plt = td.dataset.plt;
    const isOpt = td.dataset.isopt === '1';
    if (plt === 'pct' && !isOpt && !isNaN(cf) && !isNaN(nav) && nav !== 0 && !isNaN(fq))
      plOverrides.set(key, fq * cf * price / nav);
    else
      plOverrides.delete(key);
  }
  _markTabsDirtyAndRerender();
}

/* ── Allocation check helpers ────────────────────────────────────────────── */
