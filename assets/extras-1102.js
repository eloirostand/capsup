/* CapSup v54 — retour en haut, lien d'évitement, mémorisation de la source UTM */
(function(){
  try{
    var p=new URLSearchParams(location.search),u=[];
    ['utm_source','utm_medium','utm_campaign'].forEach(function(k){var v=p.get(k);if(v)u.push(k.slice(4)+'='+v.slice(0,60));});
    if(u.length&&!sessionStorage.getItem('cs_utm'))sessionStorage.setItem('cs_utm',u.join(' ; '));
  }catch(e){}
  function init(){
    var s=document.createElement('a');s.href='#root';s.className='cs-skip';s.textContent='Aller au contenu';
    s.addEventListener('click',function(e){e.preventDefault();var m=document.querySelector('main')||document.getElementById('root');if(m){m.setAttribute('tabindex','-1');m.focus();}});
    document.body.insertBefore(s,document.body.firstChild);
    var b=document.createElement('button');b.type='button';b.className='cs-top';b.setAttribute('aria-label','Retour en haut de la page');
    b.innerHTML='<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
    b.addEventListener('click',function(){var r=matchMedia('(prefers-reduced-motion: reduce)').matches;window.scrollTo({top:0,behavior:r?'auto':'smooth'});});
    document.body.appendChild(b);
    var f=function(){b.classList.toggle('on',window.scrollY>700);};
    window.addEventListener('scroll',f,{passive:true});f();
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
