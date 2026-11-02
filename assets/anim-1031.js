/* CapSup v34 — apparition des blocs au défilement. Sans effet si l'utilisateur a demandé moins d'animations. */
(function () {
  try {
    if (!('IntersectionObserver' in window) || !('MutationObserver' in window)) return;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var root = document.documentElement;
    root.classList.add('cs-anim-on');
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          e.target.classList.add('cs-in');
          io.unobserve(e.target);
        }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.06 });
    var skip = '[class*="sticky"],[class*="fixed"],.cf-toc';
    function scan() {
      var main = document.querySelector('main');
      if (!main) return;
      var secs = main.querySelectorAll('section');
      for (var i = 0; i < secs.length; i++) {
        var s = secs[i];
        if (s.dataset.csr) continue;
        s.dataset.csr = '1';
        if (i === 0 || s.closest('.cf-hero') || s.matches(skip) || s.querySelector(skip)) continue;
        if (s.parentElement && s.parentElement.closest('.cs-reveal')) continue;
        s.classList.add('cs-reveal');
      }
      var els = main.querySelectorAll('.cs-reveal:not(.cs-in):not([data-csio])');
      for (var j = 0; j < els.length; j++) {
        els[j].setAttribute('data-csio', '1');
        io.observe(els[j]);
      }
    }
    var pending = false;
    new MutationObserver(function () {
      if (pending) return;
      pending = true;
      requestAnimationFrame(function () {
        pending = false;
        scan();
      });
    }).observe(document.getElementById('root') || document.body, { childList: true, subtree: true });
    /* filet de sécurité : rien ne doit rester invisible */
    setInterval(function () {
      var h = window.innerHeight;
      var els = document.querySelectorAll('.cs-reveal:not(.cs-in)');
      for (var k = 0; k < els.length; k++) {
        var r = els[k].getBoundingClientRect();
        if (r.top < h && r.bottom > 0) els[k].classList.add('cs-in');
      }
    }, 1200);
    if (document.readyState !== 'loading') scan();
    else document.addEventListener('DOMContentLoaded', scan);
  } catch (e) {
    document.documentElement.classList.remove('cs-anim-on');
  }
})();
