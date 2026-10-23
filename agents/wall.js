export function wallHtml() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Walk &amp; Hack: the wall</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root{--ink:#1b1b1b;--muted:#6b6b6b;--line:#d9d4c7;--paper:#faf7f0;--card:#fff;--tw:#f22f46}
  *{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif}
  main{max-width:1200px;margin:0 auto;padding:28px 20px 80px}
  h1{font-size:28px;margin:0}h1 span{color:var(--tw)}
  .sub{color:var(--muted);margin:4px 0 24px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:18px}
  .card{background:var(--card);border:2px solid var(--line);border-radius:14px;overflow:hidden;display:flex;flex-direction:column}
  .card.building{border-color:var(--tw)}
  .frame{position:relative;aspect-ratio:4/3;background:#eee;overflow:hidden}
  .frame iframe{width:200%;height:200%;transform:scale(.5);transform-origin:0 0;border:0;pointer-events:none}
  .frame a{position:absolute;inset:0}
  .meta{padding:12px 14px}
  .meta b{display:block;font-size:17px}
  .meta small{color:var(--muted)}
  .pill{display:inline-block;font-size:11px;background:var(--tw);color:#fff;border-radius:999px;padding:1px 8px;margin-left:6px;vertical-align:2px}
  .empty{color:var(--muted);padding:40px 0}
</style></head>
<body><main>
  <h1>Walk <span>&amp;</span> Hack: the wall</h1>
  <p class="sub">Every app built by phone today. Tap one to open it. Refreshes on its own.</p>
  <div id="grid" class="grid"></div>
  <p id="empty" class="empty" hidden>Nothing built yet. Text the number.</p>
</main>
<script>
async function load(){
  const r=await fetch('/wall.json',{headers:{Accept:'application/json'}});const items=await r.json();
  const g=document.getElementById('grid');document.getElementById('empty').hidden=items.length>0;
  const seen=new Set();
  for(const it of items){
    seen.add(it.link);let c=document.getElementById('c-'+btoa(it.link).replace(/=/g,''));
    if(!c){c=document.createElement('div');c.id='c-'+btoa(it.link).replace(/=/g,'');c.className='card';
      c.innerHTML='<div class="frame"><iframe loading="lazy" sandbox="allow-scripts allow-same-origin"></iframe><a target="_blank" rel="noopener"></a></div><div class="meta"><b></b><small></small></div>';
      c.querySelector('iframe').src=it.link;c.querySelector('a').href=it.link;g.appendChild(c);}
    c.className='card'+(it.building?' building':'');
    c.querySelector('b').innerHTML=esc(it.title)+(it.building?'<span class="pill">building</span>':'');
    c.querySelector('small').textContent=(it.name?'by '+it.name+' · ':'')+it.builds+' build'+(it.builds===1?'':'s');
    g.prepend(c);
  }
  for(const c of [...g.children]) if(!seen.has(c.querySelector('a').getAttribute('href'))) c.remove();
}
function esc(s){return String(s).replace(/[&<>]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[m]))}
load();setInterval(load,30000);
</script></body></html>`;
}
