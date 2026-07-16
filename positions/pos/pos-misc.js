function _copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text).catch(() => _copyTextFallback(text));
  }
  _copyTextFallback(text);            // file:// / contexto não-seguro → execCommand
  return Promise.resolve();
}
function _copyTextFallback(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
  document.body.appendChild(ta);
  ta.focus(); ta.select();
  try { document.execCommand('copy'); } catch (_) { /* melhor esforço */ }
  document.body.removeChild(ta);
}
function copyRowRef(tr) {
  const ref = tr?.dataset?.ref || '';
  if (!ref) return;
  _copyText(ref);
  tr.classList.add('row-copied');    // feedback visual rápido (flash na linha)
  setTimeout(() => tr.classList.remove('row-copied'), 700);
}


/* ── Copy element as image (WhatsApp-compatible) ─────────────────────────── */
// html2canvas é pesado e só serve ao botão "Copiar" → carrega sob demanda (1º clique).
let _h2cPromise = null;
function _ensureHtml2Canvas() {
  if (typeof html2canvas !== 'undefined') return Promise.resolve();
  if (_h2cPromise) return _h2cPromise;
  _h2cPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
  return _h2cPromise;
}

// Celular (Android/iOS, incl. iPadOS que se disfarça de Macintosh com touch).
function _isMobileDevice() {
  const ua = navigator.userAgent || '';
  return /Android|iPhone|iPad|iPod/i.test(ua)
      || (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua));
}

// Entrega o print: celular → folha de compartilhamento (salvar em Fotos/WhatsApp);
// desktop → clipboard (colar no WhatsApp Web); fallback universal → download do PNG.
async function _deliverImageBlob(blob, btn, origText) {
  const done = label => {
    if (btn) { btn.textContent = label; setTimeout(() => { btn.textContent = origText; btn.disabled = false; }, 1800); }
  };
  const reset = () => { if (btn) { btn.textContent = origText; btn.disabled = false; } };

  const file = new File([blob], 'posicoes.png', { type: 'image/png' });

  // 1) Celular: compartilhar/salvar via folha nativa.
  if (_isMobileDevice() && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); done('✓'); return; }
    catch (err) { if (err && err.name === 'AbortError') { reset(); return; } /* senão cai pro fallback */ }
  }

  // 2) Desktop: copiar pro clipboard (comportamento original).
  if (navigator.clipboard && window.ClipboardItem) {
    try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); done('✓ Copiado'); return; }
    catch { /* cai pro download */ }
  }

  // 3) Fallback universal: baixar o arquivo.
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'posicoes.png';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    done('✓ Salvo');
  } catch { reset(); }
}

async function copyElementAsImage(el, btn) {
  if (!el) return;
  const origText = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    await _ensureHtml2Canvas();
    const canvas = await html2canvas(el, {
      scale: 2,
      useCORS: true,
      logging: false,
      backgroundColor: null,
    });
    canvas.toBlob(blob => { _deliverImageBlob(blob, btn, origText); }, 'image/png');
  } catch {
    if (btn) { btn.textContent = origText; btn.disabled = false; }
  }
}

function copyCardImage(btn) {
  const card = btn.closest('.card');
  const target = card.querySelector('.section-copy-target') ?? card;
  copyElementAsImage(target, btn);
}

/* ── Calendar helpers ────────────────────────────────────────────────────── */
function _easter(y) {
  const a=y%19, b=Math.floor(y/100), c=y%100, d=Math.floor(b/4), e=b%4;
  const f=Math.floor((b+8)/25), g=Math.floor((b-f+1)/3);
  const h=(19*a+b-d-g+15)%30, i=Math.floor(c/4), k=c%4;
  const l=(32+2*e+2*i-h-k)%7, m=Math.floor((a+11*h+22*l)/451);
  const mo=Math.floor((h+l-7*m+114)/31), dy=((h+l-7*m+114)%31)+1;
  return new Date(y, mo-1, dy);
}
function _isHoliday(d) {
  const m=d.getMonth()+1, day=d.getDate();
  if (m===1  && day===1)  return true;
  if (m===12 && day===25) return true;
  const gf = _easter(d.getFullYear()); gf.setDate(gf.getDate()-2);
  return m===gf.getMonth()+1 && day===gf.getDate();
}
function lastBusinessDay(d) {
  const dt = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  while (dt.getDay()===0 || dt.getDay()===6 || _isHoliday(dt))
    dt.setDate(dt.getDate()-1);
  return dt.toISOString().slice(0,10);
}

/* ── Check Dólar Exposure ─────────────────────────────────────────────────── */
const _DOLAR_CATS = [
  { key: 'mini',   label: 'Mini Dólar (WDO)' },
  { key: 'cheio',  label: 'Dólar Cheio (UC)' },
  { key: 'option', label: 'Opções de DOL' },
];

// Chave do CACHE de ticker BBG da opção (compartilhada com o backend) = instrument_reference.
function _dolarOptKey(inst) { return inst.instrument_reference || inst.instrument_name || ''; }

// Delta efetivo, |delta| com sinal pelo tipo. Prioridade: marreta global → default do backend (já live p/ DOL).
// Independe do sinal cru da BBG (que reflete a direção da posição cadastrada). `instk` = instKey(inst).
function _effOptDelta(instk, defaultDelta, name) {
  const ov = deltaOverrides.get(instk);      // marreta global por instrumento (prioridade)
  let dl = ov != null ? ov : defaultDelta;   // defaultDelta = delta do backend (live DOL via ticker / DB)
  if (dl == null) return null;
  const sign = _optTypeSign(name);
  return sign != null ? sign * Math.abs(dl) : dl;
}

function _dolarInstExp(inst) {
  // futuros: exp já calculado pelo backend; opções: recomputa com delta efetivo
  if (inst.category === 'option') {
    const dl   = _effOptDelta(instKey(inst), inst.delta, inst.instrument_name);
    const ok   = dl != null && inst.px_last != null;
    const unit = ok ? dl * inst.mult * inst.px_last : null;
    return {
      delta:   dl,
      opening: ok ? inst.opening_qty * unit : null,
      trade:   ok ? inst.traded_qty  * unit : null,
      final:   ok ? inst.final_qty   * unit : null,
    };
  }
  return { delta: null, opening: inst.opening_exp, trade: inst.trade_exp, final: inst.final_exp };
}

function _fmtBrl(v) {
  if (v == null) return '<span style="color:var(--text-muted)">—</span>';
  const s = Math.abs(v).toLocaleString('pt-BR', { maximumFractionDigits: 0 });
  if (v < 0) return `<span style="color:var(--red)">(${s})</span>`;
  if (v === 0) return `<span style="color:var(--text-muted)">—</span>`;
  return s;
}

function _qtyTip(qty) {
  if (qty == null) return '';
  const n = Math.round(qty);
  return ` title="${n.toLocaleString('pt-BR')} contratos"`;
}

// Célula: BRL em cima, % do NAV embaixo; tooltip com qtd de contratos.
function _expCell(exp, nav, qty, lb = false) {
  const pct   = (exp != null && nav) ? fmtPct(exp / nav) : '—';
  const style = lb ? ' style="border-left:1px solid var(--border)"' : '';
  return `<td class="num"${style}${_qtyTip(qty)}>${_fmtBrl(exp)}<br><span style="font-size:11px;color:var(--text-muted)">${pct}</span></td>`;
}

// Célula só BRL (linha de total geral, onde % do NAV não faz sentido entre fundos).
function _brlCell(exp, lb = false) {
  return `<td class="num"${lb ? ' style="border-left:1px solid var(--border)"' : ''}>${_fmtBrl(exp)}</td>`;
}

// BRL sem coloração própria (para a célula destacada, onde a cor vem do limite).
function _brlPlain(v) {
  if (v == null) return '—';
  const s = Math.abs(Math.round(v)).toLocaleString('pt-BR');
  return v < 0 ? `(${s})` : s;
}

// Gradação de cor do limite de exposição a dólar (limite 20%).
//  < 15% verde · 15–17% amarelo · 17–19% laranja · 19–20% vermelho forte · > 20% estouro
function _dolarLimitStyle(pct) {
  if (pct == null) return 'color:var(--text-muted)';
  const a = Math.abs(pct);
  if (a < 0.15) return 'color:var(--green)';
  if (a < 0.17) return 'color:#f0c040';
  if (a < 0.19) return 'color:#e8853a';
  if (a <= 0.20) return 'color:#fff;background:var(--red);font-weight:700';
  return 'color:#fff;background:#8a0d0d;font-weight:700';
}

// Célula destacada Total/Final: a coluna mais relevante (exposição vs limite).
function _totalFinalCell(brl, pct) {
  const warn = (pct != null && Math.abs(pct) >= 0.19) ? ' ⚠' : '';
  const pctStr = pct != null ? fmtPct(pct) : '—';
  return `<td class="num" style="border-left:2px solid var(--border);border-right:2px solid var(--border);${_dolarLimitStyle(pct)}">
    <span style="font-size:11px;opacity:0.85">${_brlPlain(brl)}</span><br><span style="font-size:14px;font-weight:700">${pctStr}${warn}</span></td>`;
}

const _SEP_TD = 'border-left:3px double var(--border);padding-left:14px';

// Reenquadramento ao limite de 20%: quantos contratos faltam vender/comprar (estouro)
// ou cabem (folga) p/ chegar no limite. totF = exposição final; opsF = operações líquidas.
function _reframeCell(totF, opsF, nav, isSula, miniVal, fullVal) {
  if (nav == null || !miniVal || !fullVal)
    return `<td class="num" style="${_SEP_TD};color:var(--text-muted)">—</td>`;
  const limit = 0.20 * nav;
  const over  = Math.abs(totF) - limit;            // >0 estourou · <0 tem folga
  const nMini = Math.abs(over) / miniVal;
  const nFull = Math.abs(over) / fullVal;
  const fN = n => n.toLocaleString('pt-BR', { maximumFractionDigits: 1 });
  if (over > 0) {
    const refSign = isSula ? Math.sign(opsF) : Math.sign(totF);
    const action  = refSign >= 0 ? 'vender' : 'comprar';
    return `<td class="num" style="${_SEP_TD};color:var(--red);font-weight:600">
      ${action} ${fN(nFull)} cheio<br><span style="font-size:11px;font-weight:400">(ou ${fN(nMini)} mini) p/ reenquadrar</span></td>`;
  }
  return `<td class="num" style="${_SEP_TD};color:var(--green)">
    folga ${fN(nFull)} cheio<br><span style="font-size:11px;color:var(--text-muted)">(ou ${fN(nMini)} mini)</span></td>`;
}

function showDolarTab() {
  activeTraderTab = DOLAR_TAB_ID;
  for (const tab of TRADER_TABS) {
    const el = document.getElementById(`tab-${tab.id}`);
    if (el) el.style.display = 'none';
    document.getElementById(`tab-btn-${tab.id}`)?.classList.remove('active');
  }
  const dolarEl = document.getElementById('tab-dolar');
  if (dolarEl) dolarEl.style.display = '';
  document.getElementById('tab-btn-dolar')?.classList.add('active');
  const consolEl = document.getElementById('tab-dolarconsol');
  if (consolEl) consolEl.style.display = 'none';
  document.getElementById('tab-btn-dolarconsol')?.classList.remove('active');
  _hideRolagemTab();
  if (!posDataByTab[DOLAR_TAB_ID]) loadDolarExposure();
  else { _dirtyTabs.delete(DOLAR_TAB_ID); renderDolarTable(posDataByTab[DOLAR_TAB_ID]); }
}

/* ── Rolagem Dólar (posição do vencimento a rolar + geração de boletas) ───── */
// Carrega só ao abrir (sem prefetch/background). Sem Bloomberg: só JRS+JDS.
// Consolida WDO (mini) + UC (cheio) do vencimento-alvo por FUNDO e permite filtrar
// por fundo/trader/área/subárea/estratégia/ativo (múltipla escolha; vazio = tudo),
// tudo client-side sobre o cache. Depois gera as boletas de rolagem (real+gerencial).
