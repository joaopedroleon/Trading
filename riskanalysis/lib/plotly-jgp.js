/* ============================================================================
   Camada Plotly do padrão JGP — porte de funcoes_graficas_jgp (tema.py/config.py).
   A lib de referência é matplotlib→PNG; o que se transporta é o PADRÃO VISUAL:
   Inter · grid só horizontal · spines pretas · linha do zero cinza · legenda sem
   moldura · números pt-BR (5,2% · 1.234) · cores só das vars --s1..--s4/--d1..--d3.

   Usada nos dashboards de inflação do México e do Chile. Depende de:
     - as vars do dashboard.css (--surface/--ink/--chart-[...], --s1..--d3)
     - plotly.min.js LOCAL (não CDN — o CSP/offline da mesa)

   API:
     card(cont, titulo, {sub, fonte, series})  -> cria a moldura e devolve o div do plot
     lineFig(el, series, opts)                 -> gráfico de linhas padrão
     baseLayout(theme(), extra)                -> layout base p/ qualquer outro tipo (barras etc.)

   `series` = [{name, x[], y[], color, w?, dash?, mode?, noLabel?,
                marker?, customdata?, hovertemplate?, showlegend?, yaxis?, shape?,
                legendgroup?}]
              os 7 últimos são passthrough opt-in p/ Plotly: série de marcadores com
              tamanho por ponto e hover próprio (leilões no monitor-rf.html), eixo
              secundário (yaxis:'y2', fora do yExtent do principal), `shape:'hv'`
              p/ linha em DEGRAU — limite que muda de vigência numa data salta ali,
              em vez de virar rampa — e `legendgroup`, p/ um único item de legenda
              ligar/desligar o par mín+máx de uma banda (bandas do PAF na divida.html)
   `opts`   = {x0, suffix, zero, log, targetBand, h, noLabel, layout}
   ========================================================================== */
const $=(s,r=document)=>r.querySelector(s);
const cssv=n=>getComputedStyle(document.body).getPropertyValue(n).trim();
const FONT_JGP="Inter,'Segoe UI',system-ui,-apple-system,sans-serif";
const CFG={responsive:true,displaylogo:false,scrollZoom:false,
  modeBarButtonsToRemove:['lasso2d','select2d'],toImageButtonOptions:{format:'png',scale:2}};
const nBR=(v,d=2)=>(v==null||isNaN(v))?'—':(+v).toFixed(d).replace('.',',');   // 5.2 -> "5,2"
const PALETTE_JGP=()=>[cssv('--s1'),cssv('--s2'),cssv('--s3'),cssv('--s4'),
                       cssv('--d1'),cssv('--d2'),cssv('--d3')];

/* styleJGP(i) — cor+traço da i-ésima série de um gráfico multi-linha: 7 cores da paleta ×
   3 traços = 21 combinações ÚNICAS, na ordem em que a tela lista as séries. Estável entre
   redesenhos (a linha não troca de cor quando outra é (des)marcada), que é o ponto — sem
   isso a legenda vira loteria a cada clique. Nasceu na tela de DI, onde 3 módulos precisam
   da mesma regra; vive aqui porque é genérico, não porque a primeira tela era aquela.   */
const styleJGP=i=>{const p=PALETTE_JGP();
  return{color:p[i%p.length],dash:['solid','dash','dot'][Math.floor(i/p.length)%3]};};

/* Janelas de tempo de um gráfico de série: as chaves do segmentado + o x0 correspondente.
   `x0FromJGP(last, key, floor)` volta `key.m` meses a partir da ÚLTIMA data da série (não
   de hoje), clampado no `floor` (1ª data da base). O lineFig re-escala o Y ao X visível,
   então mexer no x0 basta — não se corta a série.                                       */
const RANGES_JGP=[{k:'6m',lbl:'6m',m:6},{k:'1a',lbl:'1a',m:12},{k:'2a',lbl:'2a',m:24},
                  {k:'5a',lbl:'5a',m:60},{k:'10a',lbl:'10a',m:120},{k:'max',lbl:'Máx',m:null}];
function rangeSegJGP(ativa,chaves){
  return (chaves||RANGES_JGP.map(r=>r.k)).map(k=>{const r=RANGES_JGP.find(z=>z.k===k);
    return r?'<button type="button" class="'+(k===ativa?'on':'')+'" data-range="'+k+'">'
      +r.lbl+'</button>':'';}).join('');}
function x0FromJGP(last,key,floor){
  const r=RANGES_JGP.find(z=>z.k===key);
  if(!r||!r.m||!last)return floor;
  const d=new Date(last+'T00:00:00');d.setMonth(d.getMonth()-r.m);
  const iso=d.toISOString().slice(0,10);return iso<floor?floor:iso;}

/* Alturas: escalam com a JANELA. Um dashboard é lido de 1080p a ultrawide; altura fixa de
   360px deixa metade da tela vazia. H_FULL = card de largura inteira; H_HALF = card na .grid2. */
const H_FULL=()=>Math.max(380,Math.min(620,Math.round(window.innerHeight*0.68)));
const H_HALF=()=>Math.max(320,Math.min(500,Math.round(window.innerHeight*0.46)));
const _inGrid2=el=>!!(el&&el.closest&&el.closest('.grid2'));   // altura escolhida sozinha

function theme(){return{surface:cssv('--surface'),ink:cssv('--ink'),muted:cssv('--muted'),
  grid:cssv('--chart-grid'),axis:cssv('--chart-axis'),zero:cssv('--chart-zero'),legend:cssv('--chart-legend')};}
/* Eixo no padrão JGP: linha preta, ticks externos, sem grid (o grid é só no Y). */
const axJGP=t=>({linecolor:t.axis,linewidth:1,tickcolor:t.axis,ticks:'outside',ticklen:3,
  tickfont:{size:11,color:t.ink},showgrid:false,zeroline:false});
function baseLayout(t,extra){
  const e=extra||{};
  const lay=Object.assign({
    /* t:58 e não 46 — a legenda e a MODEBAR do Plotly dividiam a mesma faixa do topo.
       Medido: a modebar ocupa 2..23px do topo do graph div e a legenda (1 linha, 29px de
       altura) fica ancorada ao topo da área de plot, então com t:46 ela começava em 17px
       e as duas se cruzavam. Num card estreito (2 gráficos lado a lado, ~1366px de tela)
       a sobreposição era de 22px e a modebar — que aparece no HOVER — cobria a legenda.
       t:58 põe o topo da legenda em 29px, 6px abaixo da modebar. Ver §7.2 do CLAUDE.md. */
    margin:{l:52,r:56,t:58,b:28},height:H_FULL(),hovermode:'x unified',dragmode:'zoom',
    separators:',.',                       // pt-BR: decimal vírgula, milhar ponto
    showlegend:true,
    legend:{orientation:'h',yanchor:'bottom',y:1.0,xanchor:'left',x:0,
            font:{size:11,color:t.legend},bgcolor:'rgba(0,0,0,0)',borderwidth:0},  // frameon=False
    paper_bgcolor:t.surface,plot_bgcolor:t.surface,
    font:{family:FONT_JGP,color:t.ink,size:11},colorway:PALETTE_JGP(),
    /* namelength:-1 — o Plotly TRUNCA o nome da série em 15 caracteres no hover, com
       reticências. 'Over Linha (bps)' virava 'Over Linha (...' e 'Tx. Indicativa ANBIMA
       (D-1)' virava 'Tx. Indicativa ...': o número aparece sem dizer de quem é. Não é
       caso de borda — ~40 nomes em 18 telas do monorepo passam de 15 chars. */
    hoverlabel:{bgcolor:t.surface,bordercolor:t.axis,namelength:-1,
                font:{size:11,color:t.ink,family:FONT_JGP}}
  },e);
  // merge raso dos eixos: `extra` só sobrescreve as chaves que declara
  lay.xaxis=Object.assign(axJGP(t),e.xaxis||{});
  lay.yaxis=Object.assign(axJGP(t),{showgrid:true,gridcolor:t.grid,gridwidth:1},e.yaxis||{});
  if(e.yaxis2)lay.yaxis2=Object.assign(axJGP(t),e.yaxis2);
  return lay;
}
/* Extensão do Y no X visível (autoscale ao dar pan/zoom-x). */
function yExtent(series,x0,x1,zero,inc,semPad){let lo=Infinity,hi=-Infinity;
  series.forEach(s=>{for(let i=0;i<s.x.length;i++){const v=s.y[i];if(v==null||isNaN(v))continue;
    if(x0!=null){const tt=Date.parse(s.x[i]);if(tt<x0||tt>x1)continue;}
    if(v<lo)lo=v;if(v>hi)hi=v;}});
  if(!isFinite(lo)){lo=0;hi=1;}if(zero){lo=Math.min(lo,0);hi=Math.max(hi,0);}
  if(inc){lo=Math.min(lo,inc[0]);hi=Math.max(hi,inc[1]);}    // garante a banda-meta visível
  /* `semPad` p/ eixo LOG: a folga de 8% é LINEAR e empurraria o mínimo para negativo
     (41 − 8%×(1030−41) = −38), que em log não existe. Quem pede sem folga é o `lineFig`,
     que então pada em espaço logarítmico. */
  const pad=semPad?0:((hi-lo)*0.08||0.5);return[lo-pad,hi+pad];}
/* Última data com valor não-nulo, 'MM/YYYY' (tema.py: _formatar_last_data). */
function lastDataOf(series){let best=null;
  (series||[]).forEach(s=>{if(!s||!s.x||!s.y)return;
    for(let i=s.y.length-1;i>=0;i--){if(s.y[i]!=null&&!isNaN(s.y[i])){
      if(best===null||String(s.x[i])>best)best=String(s.x[i]);break;}}});
  const m=best&&/(\d{4})-(\d{2})/.exec(best);return m?m[2]+'/'+m[1]:null;}
/* card(cont, titulo, opts?) — replica aplicar_tema: título 14 bold, subtítulo 11 cinza
   (com "| Last data: MM/YYYY" anexado se `opts.series` vier), caption de fonte 11. */
function card(container,title,opts){opts=opts||{};
  const c=document.createElement('div');c.className='card';
  const h=document.createElement('h3');h.textContent=title;c.appendChild(h);
  let sub=opts.sub||'';
  if(opts.series&&opts.lastDataAuto!==false){const ld=lastDataOf(opts.series);
    if(ld&&sub.indexOf('Last data:')<0)sub=sub?sub+'  |  Last data: '+ld:'Last data: '+ld;}
  if(sub){const s=document.createElement('p');s.className='csub';s.textContent=sub;c.appendChild(s);}
  const p=document.createElement('div');p.className='plot';c.appendChild(p);
  if(opts.fonte){const f=document.createElement('p');f.className='cfonte';f.textContent=opts.fonte;c.appendChild(f);}
  container.appendChild(c);return p;}

/* lineFig — o gráfico de linhas padrão. Traz de graça:
     · rótulo do último valor de cada série, à direita, na cor da série
     · DE-COLISÃO vertical desses rótulos (séries que terminam no mesmo nível se
       empilham em vez de se sobrepor) — sem isso, duas linhas a 4,36% e 4,38%
       imprimem um rótulo por cima do outro
     · banda-meta opcional (targetBand: banco central com meta 3%±1pp)
     · re-autoscale do Y ao X visível em pan/zoom-x
     · o rótulo some quando a série é ocultada pela legenda                        */
function lineFig(el,series,opts){opts=opts||{};const t=theme();
  const suf=opts.suffix!==undefined?opts.suffix:'%';
  const tb=opts.targetBand, HH=opts.h||(_inGrid2(el)?H_HALF():H_FULL());
  let last='2018-01-01';series.forEach(s=>{const lx=s.x[s.x.length-1];if(lx&&lx>last)last=lx;});
  const traces=series.map(s=>{const tr={x:s.x,y:s.y,name:s.name,type:'scatter',mode:s.mode||'lines',
    connectgaps:false,line:{color:s.color,width:s.w||2,dash:s.dash||'solid',shape:'linear'},
    // nome curto da série + valor (em 'x unified' o quadradinho de cor já vem do Plotly)
    hovertemplate:(s.name?'<b>'+s.name+'</b>  ':'')+'%{y:.2f}'+suf+'<extra></extra>'};
    if(s.mode&&s.mode.indexOf('markers')>=0)tr.marker={size:7,color:s.color};  // marker:undefined quebra o Plotly
    /* Passthrough OPT-IN (só age se a série declarar) — permite série de marcadores
       com tamanho por ponto e hover próprio, sem duplicar o lineFig. Quem não
       declara nada continua exatamente como antes.                              */
    if(s.marker)tr.marker=Object.assign({size:7,color:s.color},s.marker);
    if(s.customdata)tr.customdata=s.customdata;
    if(s.hovertemplate)tr.hovertemplate=s.hovertemplate;
    if(s.showlegend!==undefined)tr.showlegend=s.showlegend;
    /* legendgroup: UMA entrada de legenda liga/desliga VÁRIAS séries (par mín+máx de
       uma banda-limite). Sem isso a banda pede 2 cliques e ocupa 2 itens.           */
    if(s.legendgroup)tr.legendgroup=s.legendgroup;
    if(s.yaxis)tr.yaxis=s.yaxis;             // 'y2' = eixo secundário (unidade diferente)
    if(s.shape)tr.line.shape=s.shape;        // 'hv' = DEGRAU (limite que muda de vigência
    // numa data: a banda do PAF salta no mês da revisão, não sobe em rampa entre os dois)
    return tr;});
  const x0v=opts.x0||'2018-01-01';
  /* Série em 'y2' fica FORA do extent do eixo principal — senão uma linha de nível (CDI
     em %) esticaria o eixo de um gráfico em bps e achataria o que interessa. Quem não
     declara `yaxis` continua exatamente como antes. Passar `layout.yaxis2` p/ configurá-lo. */
  const sMain=series.filter(s=>!s.yaxis||s.yaxis==='y');
  /* ── Eixo Y LOGARÍTMICO (`opts.log`) ────────────────────────────────────────
     ⚠️ No Plotly, com `type:'log'` o `range` é o EXPOENTE de 10 — não o valor. O
     `yExtent` devolve o extent linear, e entregá-lo cru fazia um gráfico de 41 a 1030 bps
     pedir o eixo de 10^41 a 10^1030: o eixo ia a 10^288 e as linhas viravam um traço no
     chão. Por isso a conversão tem de acontecer nos DOIS lugares em que o range é
     escrito — no layout inicial e no re-autoscale do `plotly_relayout` — e não só num.
     Serve p/ escada de rating de crédito, onde o CCC roda uma ordem de grandeza acima do
     Aaa e a escala linear achata toda a parte de cima. Sem `opts.log`, nada muda. */
  const isLog=!!opts.log;
  /* Ticks do eixo log com o NÚMERO INTEIRO em cada marca.
     O `dtick:'D2'` do Plotly rotula 1·2·5 de cada década, mas imprime "2" e "5" crus —
     numa escada de crédito o leitor vê "5" onde está 500. Aqui os valores viram texto
     completo (20 · 50 · 100 · 200 · 500 · 1.000), com o sufixo embutido. Recalculado
     também no re-autoscale, senão o zoom deixa os rótulos da faixa antiga. */
  const logTicks=r=>{
    const vals=[],txt=[];
    for(let k=Math.floor(r[0]);k<=Math.ceil(r[1]);k++)
      [1,2,5].forEach(m=>{const v=m*Math.pow(10,k),lv=Math.log10(v);
        if(lv>=r[0]&&lv<=r[1]){vals.push(v);
          txt.push((v>=1?v.toLocaleString('pt-BR'):nBR(v,2))+suf);}});
    return{tickmode:'array',tickvals:vals,ticktext:txt};
  };
  const yRange=e=>{
    if(!isLog)return e;
    const hi=e[1]>0?e[1]:1, lo=e[0]>0?e[0]:hi/1000;   // log não come zero nem negativo
    const a=Math.log10(lo), b=Math.log10(hi), pad=Math.max((b-a)*0.06,0.02);
    return [a-pad,b+pad];
  };
  const y0=yExtent(sMain,Date.parse(x0v),Date.parse(last),opts.zero,tb?[2,4]:null,isLog);
  const shapes=[];
  if(tb){                                  // faixa 2–4% + linha central 3%, fixas no eixo y
    shapes.push({type:'rect',xref:'paper',yref:'y',x0:0,x1:1,y0:2,y1:4,
      fillcolor:cssv('--jgp-green-tint'),line:{width:0},layer:'below'});
    shapes.push({type:'line',xref:'paper',yref:'y',x0:0,x1:1,y0:3,y1:3,
      line:{color:cssv('--green'),width:1,dash:'dot'},layer:'below'});
  }
  const ann=[],annTr=[];                   // annTr[k] = índice da trace a que o rótulo k pertence
  if(!opts.noLabel)series.forEach((s,i)=>{if(s.noLabel)return;
    let li=-1;for(let j=s.y.length-1;j>=0;j--){if(s.y[j]!=null&&!isNaN(s.y[j])){li=j;break;}}
    if(li<0)return;
    ann.push({x:s.x[li],y:s.y[li],xref:'x',yref:'y',xanchor:'left',xshift:6,align:'left',
      text:'<b>'+nBR(s.y[li],2)+suf+'</b>'+(s.endTag?'  '+s.endTag:''),showarrow:false,
      font:{size:11,color:s.color||'#666',family:FONT_JGP}});
    annTr.push(i);});
  if(ann.length>1){                        // de-colisão vertical (em px, via yshift)
    /* Em log, a posição em pixel é função do EXPOENTE, não do valor — usar o valor cru
       empilharia todos os rótulos no mesmo lugar. */
    const yr=yRange(y0), val=v=>isLog?Math.log10(v>0?v:1e-9):v;
    const H=HH-60, rng=(yr[1]-yr[0])||1, pxPer=H/rng, MIN=13;
    const px=a=>(val(a.y)-yr[0])*pxPer;
    const ord=ann.map((a,k)=>({k,p:px(a)})).sort((a,b)=>b.p-a.p);
    for(let i=1;i<ord.length;i++)if(ord[i-1].p-ord[i].p<MIN)ord[i].p=ord[i-1].p-MIN;
    ord.forEach(o=>{ann[o.k].yshift=Math.round(o.p-px(ann[o.k]));});
  }
  if(tb){ann.push({xref:'paper',yref:'y',x:0.008,y:3,xanchor:'left',yanchor:'bottom',
    text:'meta 3%±1pp',showarrow:false,font:{size:9,color:cssv('--muted')}});annTr.push(-1);}
  /* HOVER SEMPRE COM A DATA CHEIA. Os `tickformatstops` abaixo adaptam o TICK ao zoom
     (dia/mês → mês/ano → ano), e o Plotly usava esse mesmo formato no hover: numa janela
     de 2 anos a linha mostrava só "ago/26", sem o dia. Tick e hover têm requisitos
     opostos — o tick precisa caber e não repetir, o hover precisa identificar o ponto.
     Quem passa `tickformat` próprio segue mandando (us.js usa "%d %b %y"), e
     `opts.hoverformat` sobrescreve tudo.                                              */
  const hoverFmt=opts.hoverformat||opts.tickformat||'%d/%m/%Y';
  const layout=baseLayout(t,Object.assign({shapes:shapes,annotations:ann,height:HH,
    xaxis:Object.assign({type:'date',range:[x0v,last],tickangle:0,hoverformat:hoverFmt},
      opts.tickformat
        ? {tickformat:opts.tickformat}
        : {tickformatstops:[{dtickrange:[null,7776000000],value:'%d/%b'},
            {dtickrange:[7776000000,378432000000],value:'%b/%y'},
            {dtickrange:[378432000000,null],value:'%Y'}]}),
    yaxis:Object.assign({range:yRange(y0),ticksuffix:suf,zeroline:!!opts.zero,
      zerolinecolor:t.zero,zerolinewidth:.9},
      /* `dtick:'D2'` = rótulo em 1·2·5 de cada década (20, 50, 100, 200, 500, 1000). O
         default do Plotly em log é 'D1', que rotula TODOS os dígitos e imprime "9 8 7 6…"
         soltos entre as décadas — some o zero e o leitor lê 9 onde está 900. E a margem
         esquerda cresce porque "1000 bps" não cabe nos 52px do padrão. */
      isLog?Object.assign({type:'log'},logTicks(yRange(y0))):{})},
    // margem só quando log — "1000 bps" não cabe nos 52px do padrão. Chave AUSENTE no
    // caso normal: `margin:undefined` sobrescreveria o default do baseLayout.
    isLog?{margin:{l:66,r:56,t:58,b:28}}:{},   // t:58 = mesma folga p/ a modebar (ver baseLayout)
    opts.layout||{}));
  /* Mapa rótulo-de-último-valor -> série, casado por `x|y` (a annotation fica no
     último ponto da série). É o que deixa o shared-web/chart-highlight.js apagar o
     rótulo junto com a linha. Casar por ÍNDICE não serve: série oculta pela legenda
     some do DOM e desalinha. Chave inerte p/ quem não usa. */
  const annKeys=ann.map((a,k)=>({k:String(a.x)+'|'+String(a.y),tr:annTr[k]}));
  Plotly.newPlot(el,traces,layout,CFG).then(gd=>{
    gd._jgpAnnKeys=annKeys;
    gd.on('plotly_relayout',ev=>{          // reajusta Y ao X visível em pan/zoom-x
      if(gd._lock)return;
      const px=k=>ev[k]!==undefined;
      if(px('yaxis.range[0]')||px('yaxis.range')||px('yaxis.autorange'))return;  // box-zoom c/ Y é respeitado
      let a,b;
      if(px('xaxis.range[0]')){a=Date.parse(String(ev['xaxis.range[0]']).replace(' ','T'));
                               b=Date.parse(String(ev['xaxis.range[1]']).replace(' ','T'));}
      else if(px('xaxis.range')){a=Date.parse(String(ev['xaxis.range'][0]).replace(' ','T'));
                                 b=Date.parse(String(ev['xaxis.range'][1]).replace(' ','T'));}
      else return;
      gd._lock=true;
      const nr=yRange(yExtent(sMain,a,b,opts.zero,tb?[2,4]:null,isLog));
      const upd={'yaxis.range':nr};
      if(isLog){const tk=logTicks(nr);
        upd['yaxis.tickvals']=tk.tickvals;upd['yaxis.ticktext']=tk.ticktext;}
      Plotly.relayout(gd,upd).then(()=>{gd._lock=false;});
    });
    if(ann.length)gd.on('plotly_restyle',()=>{   // esconde o rótulo da série ocultada na legenda
      const upd=ann.map((a,k)=>{const v=gd.data[annTr[k]]&&gd.data[annTr[k]].visible;
        return Object.assign({},a,{visible:(v===undefined||v===true)});});
      Plotly.relayout(gd,{annotations:upd});
    });
  });
}

/* ─────────────────────────────────────────────────────────────────────────────
   Folga do topo: a legenda NUNCA fica embaixo da modebar.

   A legenda da casa é horizontal e ancorada ao TOPO da área de plot (`y:1.0`,
   `yanchor:'bottom'`), então ela cresce PARA CIMA dentro da margem `t`. A modebar do
   Plotly (que aparece no hover) ocupa os primeiros ~23px do graph div. Com margem fixa
   as duas se cruzam sempre que a legenda for alta o bastante — e a altura depende do
   número de séries E da largura do card, ou seja, só se conhece DEPOIS de desenhar.

   `t:58` no baseLayout já dá conta da legenda de 1 linha (o caso comum). Este ajuste
   cobre o resto: mede a legenda renderizada e, se ela ainda invadir a faixa da modebar,
   aumenta `margin.t` no necessário. Medido em ago/2026: 3 gráficos da tela de Dívida e
   os 2 do Open Interest têm legenda de 2 linhas e colidiam — inclusive ANTES do t:58.

   ⚠️ `relayout` (não `restyle`) e só uma vez: depois do ajuste `need == cur` e o guard
   corta o segundo disparo, então não há laço com o próprio `plotly_afterplot`.
   ⚠️ Roda no `afterplot`, nunca no hover — redesenhar a figura por movimento de mouse é
   o que o `chart-highlight.js` documenta como proibido (pisca e mexe nos rótulos). */
(function(){
  if (typeof MutationObserver === 'undefined') return;
  var GAP = 6;                           // respiro entre a modebar e a legenda

  function ajusta(gd){
    try{
      if (!gd || !gd._fullLayout || typeof Plotly === 'undefined') return;
      var leg = gd.querySelector('.legend');
      var mb  = gd.querySelector('.modebar');
      if (!leg || !mb) return;                 // sem legenda ou sem modebar: nada a resolver
      var r = leg.getBoundingClientRect(), m = mb.getBoundingClientRect();
      if (!r.height || !m.height) return;

      /* ⚠️ Só age quando as duas REALMENTE se cruzam — a correção custa altura do desenho.
         (a) a legenda tem de estar na faixa do TOPO: gráfico com legenda embaixo/à direita
             não tem conflito, e o teste é geométrico (não confia no `layout.legend.y`, que
             a tela pode ter sobrescrito);
         (b) a legenda tem de invadir a faixa HORIZONTAL da modebar. Legenda vertical fica
             estreita e à esquerda — mede 124px de altura na tela de Dívida e nunca encosta
             na modebar, que está à direita. Sem este teste eu reservava 153px de margem ali
             e comia 31% da área de plot à toa. */
      var drag = gd.querySelector('.nsewdrag');
      if (!drag || r.bottom > drag.getBoundingClientRect().top + 2) return;
      if (r.right <= m.left) return;

      var topo = gd.getBoundingClientRect().top;
      var need = Math.ceil(r.height + (m.bottom - topo) + GAP);
      var cur  = (gd._fullLayout.margin && gd._fullLayout.margin.t) || 0;
      if (need > cur + 1) Plotly.relayout(gd, {'margin.t': need});
    }catch(e){ /* ajuste cosmético: nunca pode derrubar a tela */ }
  }

  function liga(gd){
    if (!gd || gd._jgpTopFit) return;
    gd._jgpTopFit = true;
    if (gd.on) gd.on('plotly_afterplot', function(){ ajusta(gd); });
    ajusta(gd);
  }

  function varre(){ document.querySelectorAll('.js-plotly-plot').forEach(liga); }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', varre);
  else varre();
  new MutationObserver(function(){ varre(); })
    .observe(document.documentElement, {childList:true, subtree:true});
})();
