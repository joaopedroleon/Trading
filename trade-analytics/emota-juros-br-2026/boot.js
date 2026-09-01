/* ═══════════════════════════════════════════════════════════════════════════
   boot.js — a carga de dados da versão PUBLICADA (substitui o `ta-sel.js`).

   ☠️ **O REPO `Trading` É PÚBLICO.** O GitHub Pages em plano normal não tem
   página privada, então o que sobe fica legível por qualquer um que tenha a
   URL. Por isso o payload NÃO vai em texto puro: o `publicar/pipeline.py`
   cifra com **PBKDF2-HMAC-SHA256 (200.000 iterações) + AES-256-GCM** e este
   arquivo refaz a derivação no navegador com a senha digitada. É a MESMA
   mecânica do snapshot de posições (`positions-pnl-control/snapshot`), de
   propósito: uma senha só para tudo o que a mesa compartilha.

   ⚠️ **WebCrypto exige contexto seguro.** Funciona em HTTPS (GitHub Pages) e em
   `localhost`, e **NÃO** funciona em `file://` — abrir o HTML publicado com
   duplo-clique dá "crypto.subtle is undefined". Para testar local use
   `python -m http.server`. (A versão de disco do estudo continua abrindo por
   `file://` normalmente: ela carrega o `ta-sel.js`, não este arquivo.)

   ⚠️ Senha errada não "retorna vazio": o AES-GCM falha na verificação do tag e
   levanta — é o que distingue senha errada de payload corrompido.

   O contrato com a tela é o mesmo do `ta-sel.js`: definir `window.TA` e chamar
   `window.__taData(TA)`. Nada em `app.js`/`trades.js` sabe que veio cifrado.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var CHAVE = 'ta_pub_pw';          // senha lembrada por sessão (não persiste)

  function b64(s) {
    var raw = atob(s), a = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) a[i] = raw.charCodeAt(i);
    return a;
  }

  async function decifra(blob, senha) {
    var enc = new TextEncoder();
    var base = await crypto.subtle.importKey('raw', enc.encode(senha), 'PBKDF2',
                                             false, ['deriveKey']);
    var key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: b64(blob.salt), iterations: blob.iterations, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    var buf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(blob.iv) },
                                          key, b64(blob.ct));
    return JSON.parse(new TextDecoder().decode(buf));
  }

  /* ── a tela de senha ─────────────────────────────────────────────────────
     ⚠️ Cobre a página inteira e é montada em JS: o HTML publicado é o MESMO
     arquivo do estudo, e pôr o cadeado nele obrigaria a manter duas versões
     do `index.html` em sincronia. */
  function pedeSenha(msg) {
    return new Promise(function (resolve) {
      var d = document.createElement('div');
      d.id = 'ta-lock';
      d.innerHTML =
        '<div class="ta-lock-box">'
        + '<div class="ta-lock-wm">JGP</div>'
        + '<div class="ta-lock-t">Estudo &middot; trades do gestor</div>'
        + '<div class="ta-lock-s" id="ta-lock-s">' + (msg || 'Conteúdo protegido — digite a senha.') + '</div>'
        + '<input type="password" id="ta-lock-i" autocomplete="current-password" placeholder="senha">'
        + '<button id="ta-lock-b">Abrir</button>'
        + '</div>';
      document.body.appendChild(d);
      var i = d.querySelector('#ta-lock-i'), b = d.querySelector('#ta-lock-b');
      function ok() { var v = i.value; if (v) { d.remove(); resolve(v); } }
      b.addEventListener('click', ok);
      i.addEventListener('keydown', function (e) { if (e.key === 'Enter') ok(); });
      i.focus();
    });
  }

  async function carrega() {
    var pkg = window.__TA_ENC__;
    if (!pkg || !pkg.blob) {
      document.body.innerHTML = '<p style="padding:40px;font:15px Inter,sans-serif">'
        + 'Dados não encontrados (<code>data.js</code> ausente).</p>';
      return;
    }
    if (!(window.crypto && crypto.subtle)) {
      document.body.innerHTML = '<p style="padding:40px;font:15px Inter,sans-serif">'
        + 'Esta página precisa de <b>HTTPS</b> (ou <code>localhost</code>) para decifrar os '
        + 'dados — o WebCrypto do navegador não funciona em <code>file://</code>.<br>'
        + 'Abra pelo link do GitHub Pages.</p>';
      return;
    }
    /* ⚠️ `sessionStorage`, não `localStorage`: a senha some ao fechar a aba.
       Numa máquina compartilhada, senha persistida é senha vazada. */
    var lembrada = null;
    try { lembrada = sessionStorage.getItem(CHAVE); } catch (e) { /* modo restrito */ }

    var msg = null;
    for (;;) {
      var senha = lembrada || await pedeSenha(msg);
      lembrada = null;
      try {
        var dados = await decifra(pkg.blob, senha);
        try { sessionStorage.setItem(CHAVE, senha); } catch (e) { /* modo restrito */ }
        window.TA = dados;
        if (window.__taData) window.__taData(dados);
        return;
      } catch (e) {
        try { sessionStorage.removeItem(CHAVE); } catch (e2) { /* modo restrito */ }
        msg = '<b>Senha incorreta.</b> Tente de novo.';
      }
    }
  }

  /* ⚠️ Os <select> de trader/ativo/ano existem no HTML e são preenchidos pelo
     `ta-sel.js`, que aqui NÃO carrega — ficariam vazios e sugeririam que dá
     para trocar de análise. Cada publicação é UMA análise: a tira vira um
     rótulo fixo, dizendo qual. */
  function rotulaSelecao() {
    var w = document.querySelector('.selwrap');
    if (!w || !pkgMeta()) return;
    var m = pkgMeta();
    w.innerHTML = '<span class="ta-pub-sel">' + m.trader + ' &middot; '
      + m.grupo_rotulo + ' &middot; ' + m.ano + '</span>';
  }
  function pkgMeta() { return (window.__TA_ENC__ || {}).meta; }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', rotulaSelecao);
  } else { rotulaSelecao(); }
  carrega();
})();
