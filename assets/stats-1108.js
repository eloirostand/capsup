/* CapSup v75 — mesure d'audience Umami : pages vues lors de la navigation par « # » et retrait du contenu des liens de bilan */
(function(){
  var o=location.origin;
  function clean(u){return typeof u==='string'?u.replace(/#bilan\/.*$/,'#bilan'):u;}
  function rel(u){return u&&u.indexOf(o)===0?u.slice(o.length):u;}
  window.csUmamiBeforeSend=function(type,p){
    if(p){if(p.url)p.url=clean(p.url);if(p.referrer)p.referrer=clean(p.referrer);}
    return p;
  };
  var last=location.href;
  window.addEventListener('hashchange',function(){
    var now=location.href,ref=last;
    if(now===ref)return;
    last=now;
    if(location.pathname!=='/')return;
    try{if(window.umami&&typeof window.umami.track==='function')window.umami.track(function(p){p.url=now;p.referrer=rel(ref);return p;});}catch(e){}
  });
})();
