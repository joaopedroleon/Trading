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
    if (e.key === 'Escape') { map.delete(key); rerenderTables(); }
  });
  input.addEventListener('blur', () => swapApplyEdit(input, field, key));
  input.addEventListener('click', e => e.stopPropagation());
}

function swapApplyEdit(input, field, key) {
  const map = _swapOvrMap(field);
  const val = parseFloat(String(input.value).replace(/\./g, '').replace(',', '.'));
  if (!isNaN(val)) map.set(key, val);
  else map.delete(key);
  rerenderTables();
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

function posPriceStartEdit(td) {
  if (td.querySelector('input')) return;
  const ik    = td.dataset.instkey;            // preço é por INSTRUMENTO (compartilhado entre abas)
  const key   = td.dataset.rowkey;             // #PL é por posição (trader)
  const isFx  = td.dataset.isfx === '1';
  const cur   = priceOverrides.has(ik) ? priceOverrides.get(ik) : null;
  const input = document.createElement('input');
  input.type  = 'text';
  input.style.cssText = 'width:6em;font:inherit;text-align:right;background:var(--bg);border:1px solid var(--accent);color:var(--text)';
  input.value = cur !== null ? String(isFx ? cur * 100 : cur).replace('.', ',') : '';
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
  const raw  = parseFloat(String(input.value).replace(/\./g, '').replace(',', '.'));
  if (isNaN(raw)) {
    priceOverrides.delete(ik);
    plOverrides.delete(key);
  } else {
    const price = isFx ? raw / 100 : raw;
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
