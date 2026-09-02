/* ═══════════════════════════════════════════════════════════════════════════
   boot.js — carga de dados da versão PUBLICADA (substitui o `ta-sel.js`).

   Faz três coisas que o `ta-sel.js` não faz:
     1. pede a SENHA e decifra (o repo é público — ver `publicar/pipeline.py`);
     2. monta os seletores a partir do `manifest.json` (só o que está no ar);
     3. acrescenta o seletor **"base até"** — o VINTAGE, a foto daquele ano num
        dia passado.

   ⛔ **A PÁGINA PUBLICADA NÃO SE ATUALIZA SOZINHA** (decisão do usuário,
   02/09/2026: *"eu não quero que a página do github atualize sozinha"*). Ela é
   uma FOTO: o que está no link é o que foi publicado, e ponto. Houve aqui um
   poll do manifest com tarja de "base nova" e recarga automática — saiu, junto
   com a tarefa agendada que republicava. Quem decide publicar é o operador, na
   tela local (ver `report/controle.js`).

   ☠️ **O REPO É PÚBLICO.** O GitHub Pages em plano normal não tem página
   privada. O payload sobe cifrado com **PBKDF2-HMAC-SHA256 (200.000 iterações)
   + AES-256-GCM** e este arquivo refaz a derivação no navegador. É a MESMA
   mecânica (e a mesma senha) do snapshot de posições, de propósito.

   ⚠️ **WebCrypto exige contexto seguro.** Funciona em HTTPS (Pages) e em
   `localhost`, e **NÃO** em `file://` — abrir o HTML publicado com duplo-clique
   dá "crypto.subtle is undefined". A página avisa em vez de quebrar. (A versão
   de disco do estudo segue abrindo por `file://`: ela carrega o `ta-sel.js`.)

   ⛔ **A página NÃO busca dado novo do Oracle** — não pode: os números vêm do
   Sophis, dentro da rede da JGP. O "refresh" é perceber que a tarefa agendada
   PUBLICOU uma base mais nova, e recarregar.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var CHAVE_PW = 'ta_pub_pw';        // senha: sessão, nunca localStorage
  var MAN = null, SEL = null, SENHA = null;

  /* ── util ──────────────────────────────────────────────────────────────── */
  function b64(s) {
    var raw = atob(s), a = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) a[i] = raw.charCodeAt(i);
    return a;
  }
  function qs() {
    var o = {};
    (location.search || '').replace(/^\?/, '').split('&').forEach(function (kv) {
      if (!kv) return;
      var p = kv.split('=');
      o[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || '');
    });
    return o;
  }
  function br(iso) {
    if (!iso) return '—';
    var p = String(iso).split('-');
    return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : iso;
  }
  /* ⚠️ `?t=` no fetch do manifest: o GitHub Pages serve com cache, e um manifest
     velho ofereceria uma análise que já saiu (ou esconderia uma que entrou). O
     payload cifrado é imutável por NOME (tem a data dentro), então esse pode
     cachear à vontade. */
  function pegaManifest() {
    return fetch('manifest.json?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); });
  }

  /* ── cripto ────────────────────────────────────────────────────────────── */
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

  /* ── tela de senha ─────────────────────────────────────────────────────── */
  function pedeSenha(msg) {
    return new Promise(function (resolve) {
      var d = document.createElement('div');
      d.id = 'ta-lock';
      d.innerHTML =
        '<div class="ta-lock-box">'
        + '<div class="ta-lock-wm">JGP</div>'
        + '<div class="ta-lock-t">Estudo &middot; trades do gestor</div>'
        + '<div class="ta-lock-s">' + (msg || 'Conteúdo protegido — digite a senha.') + '</div>'
        + '<input type="password" id="ta-lock-i" autocomplete="current-password" placeholder="senha">'
        + '<button id="ta-lock-b">Abrir</button></div>';
      document.body.appendChild(d);
      var i = d.querySelector('#ta-lock-i'), b = d.querySelector('#ta-lock-b');
      function ok() { if (i.value) { d.remove(); resolve(i.value); } }
      b.addEventListener('click', ok);
      i.addEventListener('keydown', function (e) { if (e.key === 'Enter') ok(); });
      i.focus();
    });
  }

  /* ── seleção ───────────────────────────────────────────────────────────────
     ⚠️ Tudo sai do MANIFEST, nunca de uma lista neste arquivo: a página só pode
     oferecer o que de fato subiu, senão o leitor escolhe um par e leva 404. */
  function analises() { return (MAN && MAN.analises) || {}; }
  function lista(campo, filtro) {
    var v = [], A = analises();
    Object.keys(A).forEach(function (k) {
      var a = A[k];
      if (filtro && !filtro(a)) return;
      if (v.indexOf(a[campo]) < 0) v.push(a[campo]);
    });
    return v;
  }
  function acha(trader, grupo, ano) {
    var A = analises();
    var k = Object.keys(A).filter(function (x) {
      var a = A[x];
      return a.trader === trader && a.grupo === grupo && String(a.ano) === String(ano);
    })[0];
    return k ? { slug: k, a: A[k] } : null;
  }
  function resolveSel() {
    var q = qs(), A = analises(), chaves = Object.keys(A);
    if (!chaves.length) return null;
    /* padrão: o par com a base MAIS RECENTE — "a última data disponível" */
    var melhor = chaves.slice().sort(function (x, y) {
      var dx = (A[x].vintages[0] || {}).d || '', dy = (A[y].vintages[0] || {}).d || '';
      if (dx !== dy) return dx < dy ? 1 : -1;
      return Number(A[y].ano) - Number(A[x].ano);
    })[0];
    var alvo = (q.a && A[q.a]) ? q.a : melhor;
    var a = A[alvo];
    /* `d` = vintage pedido na URL; sem ele, o mais novo (o "refresh automático") */
    var v = a.vintages.filter(function (x) { return x.d === q.d; })[0] || a.vintages[0];
    return { slug: alvo, a: a, v: v, ultimo: v === a.vintages[0] };
  }
  /* ⚠️ Trocar de seleção RECARREGA a página, como no `ta-sel.js` local — e pelo
     mesmo motivo: `app.js`/`trades.js` montam filtros, opções de <select> de
     contrato, caches de aba e handlers a partir dos dados, e refazer isso a
     quente teria mais estado escondido para errar do que valor. ⭐ Aqui o
     recarregar é de graça: a senha está no `sessionStorage`, então não pede de
     novo, e o payload cifrado vem do cache do browser. */
  function vai(slug, d) {
    var u = 'a=' + encodeURIComponent(slug) + (d ? '&d=' + encodeURIComponent(d) : '');
    location.search = '?' + u;
  }

  /* ── os seletores, no lugar dos <select> vazios do HTML ────────────────── */
  function opts(vals, atual, rot) {
    return vals.map(function (v) {
      return '<option value="' + v + '"' + (String(v) === String(atual) ? ' selected' : '')
        + '>' + (rot ? rot(v) : v) + '</option>';
    }).join('');
  }
  function montaSeletores() {
    var w = document.querySelector('.selwrap');
    if (!w || !SEL) return;
    var a = SEL.a;
    var traders = lista('trader').sort();
    var grupos = lista('grupo', function (x) { return x.trader === a.trader; });
    var anos = Object.keys(analises())
      .map(function (k) { return analises()[k]; })
      .filter(function (x) { return x.trader === a.trader && x.grupo === a.grupo; })
      .map(function (x) { return x.ano; })
      .sort(function (x, y) { return Number(y) - Number(x); });
    var GR = (MAN && MAN.grupos) || {};

    w.innerHTML =
      '<label>Trader <select id="pubTrader">' + opts(traders, a.trader) + '</select></label>'
      + '<label>Ativo <select id="pubGrupo">'
      + opts(grupos, a.grupo, function (g) { return GR[g] || g; }) + '</select></label>'
      + '<label>Ano <select id="pubAno">' + opts(anos, a.ano) + '</select></label>'
      /* ⭐ O SELETOR DE VINTAGE — "uma data antiga específica que eu queira ver".
         ☠️ Não é o mesmo que o ano: `2024` é um ano fechado; `2026 base até
         15/08` é o ano corrente como ele era naquele dia. O rótulo diz "base
         até" justamente para não ser lido como ano. */
      + '<label class="pubvint">Base até <select id="pubVint">'
      + a.vintages.map(function (v, i) {
          return '<option value="' + v.d + '"' + (v.d === SEL.v.d ? ' selected' : '') + '>'
            + br(v.d) + (i === 0 ? ' (última)' : '') + '</option>';
        }).join('')
      + '</select></label>';

    /* ⚠️ SELETOR COM UMA OPÇÃO SÓ FICA DESABILITADO E DIZ POR QUÊ (02/09/2026).
       Publicar passou a subir só o ano selecionado na tela local, então o normal
       é o site ter UM estudo — e quatro seletores inertes, de aparência normal,
       leem-se como tela quebrada. É a lição do §5.-57 ao contrário: lá o
       problema era esconder o seletor (o recurso parecia inexistir); aqui é
       deixá-lo clicável sem ter para onde ir. */
    ['pubTrader', 'pubGrupo', 'pubAno', 'pubVint'].forEach(function (id) {
      var e = document.getElementById(id);
      if (!e || e.options.length > 1) return;
      e.disabled = true;
      e.title = 'Só este estudo está publicado — cada publicação sobe o par '
              + 'selecionado na tela de trabalho.';
    });

    function troca(id, fn) {
      var e = document.getElementById(id);
      if (e) e.onchange = function () { fn(e.value); };
    }
    /* ⚠️ ao trocar trader/ativo/ano o VINTAGE não é carregado junto: aquele par
       pode não ter a mesma data de base. Vai sem `d`, e o boot escolhe o mais
       novo daquele par — que é o padrão certo. */
    /* ⚠️ o fallback existe porque o par pode não ter o MESMO ano: trocar para um
       trader que não operou em 2026 tem de cair em algum ano dele, não em nada.
       (Havia aqui um `acha(v, a.grupo, null)` no meio que nunca casava — o
       `acha` compara `String(ano)`, e `String(null)` é `"null"`. Código morto
       que parecia fazer algo.) */
    troca('pubTrader', function (v) {
      var alvo = acha(v, a.grupo, a.ano)
        || { slug: Object.keys(analises()).filter(function (k) {
               return analises()[k].trader === v; })[0] };
      if (alvo && alvo.slug) vai(alvo.slug, null);
    });
    troca('pubGrupo', function (v) {
      var alvo = acha(a.trader, v, a.ano)
        || { slug: Object.keys(analises()).filter(function (k) {
               var x = analises()[k]; return x.trader === a.trader && x.grupo === v; })[0] };
      if (alvo && alvo.slug) vai(alvo.slug, null);
    });
    troca('pubAno', function (v) {
      var alvo = acha(a.trader, a.grupo, v);
      if (alvo) vai(alvo.slug, null);
    });
    troca('pubVint', function (v) {
      /* ⚠️ escolher a MAIS NOVA volta a URL para sem `d`, senão a página ficaria
         presa naquela data e o refresh automático nunca a tiraria de lá. */
      vai(SEL.slug, v === a.vintages[0].d ? null : v);
    });
  }

  /* ⚠️ **OS LINKS ENTRE AS DUAS TELAS PERDIAM A SELEÇÃO.** `estudo.html` e
     `trades.html` linkam um ao outro com href fixo, e o `boot` lê o par do
     `location.search` — então ir do anual para o trade a trade (ou voltar)
     caía no par PADRÃO. Ficava mascarado enquanto o par escolhido era justamente
     o padrão; em qualquer outro (um ano fechado, outro trader) trocava o estudo
     debaixo do leitor, sem avisar.
     ⭐ Aqui os href da casca recebem o `?a=`/`&d=` da seleção corrente. */
  function propagaSelecao() {
    if (!SEL) return;
    var q = 'a=' + encodeURIComponent(SEL.slug)
          + (SEL.ultimo ? '' : '&d=' + encodeURIComponent(SEL.v.d));
    document.querySelectorAll('a.xlink[href]').forEach(function (a) {
      var h = a.getAttribute('href');
      if (!h || h.indexOf('http') === 0 || h.indexOf('?') >= 0) return;
      a.setAttribute('href', h + '?' + q);
    });
  }

  /* ── o aviso de "olhando o passado" ────────────────────────────────────── */
  function avisaVintage() {
    if (!SEL || SEL.ultimo) return;
    var d = document.createElement('div');
    d.className = 'ta-vint-aviso';
    d.innerHTML = '⏱ Você está vendo a foto de <b>' + br(SEL.v.d) + '</b>, não a mais '
      + 'recente. <a href="?a=' + encodeURIComponent(SEL.slug) + '">ver a última</a>';
    var m = document.querySelector('.main-content');
    if (m) m.insertBefore(d, m.firstChild);
  }

  /* ── carga do payload ──────────────────────────────────────────────────── */
  function injeta(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = res;
      s.onerror = function () { rej(new Error('não carregou ' + src)); };
      document.head.appendChild(s);
    });
  }
  function erroFatal(html) {
    document.body.innerHTML = '<div style="padding:44px;max-width:620px;font:15px/1.6 '
      + 'Inter,system-ui,sans-serif">' + html + '</div>';
  }

  async function main() {
    if (!(window.crypto && crypto.subtle)) {
      return erroFatal('Esta página precisa de <b>HTTPS</b> (ou <code>localhost</code>) para '
        + 'decifrar os dados — o WebCrypto do navegador não funciona em <code>file://</code>.'
        + '<br><br>Abra pelo link do GitHub Pages.');
    }
    try { MAN = await pegaManifest(); }
    catch (e) { return erroFatal('Não consegui ler o <code>manifest.json</code>.'); }

    SEL = resolveSel();
    if (!SEL) return erroFatal('Nenhuma análise publicada ainda.');
    montaSeletores();
    propagaSelecao();

    try { await injeta(SEL.v.arq); }
    catch (e) {
      return erroFatal('Os dados desta análise não carregaram (<code>' + SEL.v.arq
        + '</code>).<br><br>Se o link é antigo, tente <a href="./">a última versão</a>.');
    }
    var blob = window.__TA_BLOB__;
    if (!blob) return erroFatal('Arquivo de dados vazio ou corrompido.');

    var lembrada = null;
    try { lembrada = sessionStorage.getItem(CHAVE_PW); } catch (e) { /* modo restrito */ }
    var msg = null;
    for (;;) {
      SENHA = lembrada || await pedeSenha(msg);
      lembrada = null;
      try {
        var dados = await decifra(blob, SENHA);
        try { sessionStorage.setItem(CHAVE_PW, SENHA); } catch (e) { /* modo restrito */ }
        window.TA = dados;
        if (window.__taData) window.__taData(dados);
        avisaVintage();
        return;
      } catch (e) {
        try { sessionStorage.removeItem(CHAVE_PW); } catch (e2) { /* modo restrito */ }
        /* ⚠️ senha errada não "volta vazio": o AES-GCM falha na verificação do
           tag e levanta. É isso que distingue senha errada de dado corrompido. */
        msg = '<b>Senha incorreta.</b> Tente de novo.';
      }
    }
  }

  main();
})();
