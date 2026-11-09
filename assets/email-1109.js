// CapSup — vérification de l'adresse email du bilan avant envoi.
// 1. forme de l'adresse ; 2. faute de frappe sur un domaine courant (gmial.com, hotmail.con, gmail.fr…) ;
// 3. le domaine reçoit-il des emails ? (fonction /.netlify/functions/verifier-email, qui ne reçoit que le domaine).
// Ne peut pas savoir si la boîte elle-même existe (ex. prenom.nom@gmail.com mal orthographié).
// En cas de panne ou de délai dépassé, l'adresse est acceptée.
(function () {
  var COURANTS = ["gmail.com", "hotmail.fr", "hotmail.com", "outlook.fr", "outlook.com", "live.fr", "live.com", "yahoo.fr",
    "yahoo.com", "icloud.com", "me.com", "orange.fr", "wanadoo.fr", "free.fr", "sfr.fr", "laposte.net", "msn.com", "neuf.fr",
    "bbox.fr", "aol.com", "protonmail.com", "proton.me", "gmx.fr", "ac-nice.fr"];
  var FAUTES = { "gmail.fr": "gmail.com", "gmai.fr": "gmail.com", "gmail.co": "gmail.com", "hotmail.co": "hotmail.com", "icloud.fr": "icloud.com" };
  function ecart(a, b) {
    var d = [], i, j, p, t;
    for (j = 0; j <= b.length; j++) d[j] = j;
    for (i = 1; i <= a.length; i++) {
      p = d[0]; d[0] = i;
      for (j = 1; j <= b.length; j++) { t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, p + (a[i - 1] === b[j - 1] ? 0 : 1)); p = t; }
    }
    return d[b.length];
  }
  var cache = {}, averti = null;
  window.csVerifEmail = function (adresse, apercu) { // apercu : vérification à la sortie du champ (ne vaut pas confirmation)
    var e = String(adresse || "").trim().toLowerCase();
    if (!/^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(e) || /\.\.|^\.|\.@/.test(e))
      return Promise.resolve({ ok: false, msg: "Adresse email invalide : vérifie qu'elle est bien écrite (ex. prenom.nom@gmail.com)." });
    var local = e.split("@")[0], dom = e.split("@")[1];
    var sugg = FAUTES[dom] || null, tld = function (x) { return x.split(".").pop(); };
    if (!sugg && COURANTS.indexOf(dom) < 0) {
      for (var k = 0; k < COURANTS.length; k++) {
        var n = ecart(dom, COURANTS[k]);
        if (dom.length > 4 && (n === 1 || (n === 2 && tld(dom) === tld(COURANTS[k])))) { sugg = COURANTS[k]; break; }
      }
    }
    // Faute probable signalée une fois : si l'élève renvoie la même adresse sans la changer, elle est acceptée
    if (sugg && averti !== e) {
      if (!apercu) averti = e;
      return Promise.resolve({ ok: false, msg: "Adresse email invalide : voulais-tu écrire " + local + "@" + sugg + " ? (Si ton adresse est bien correcte, renvoie-la telle quelle.)" });
    }
    if (cache[dom] !== undefined) return Promise.resolve(cache[dom]);
    var fini = false;
    return new Promise(function (res) {
      var t = setTimeout(function () { if (!fini) { fini = true; res({ ok: true }); } }, 6000);
      fetch("/.netlify/functions/verifier-email?d=" + encodeURIComponent(dom))
        .then(function (r) { return r.ok ? r.json() : { ok: true }; })
        .then(function (j) {
          var out = j && j.ok === false ? { ok: false, msg: "Adresse email invalide : le domaine « " + dom + " » ne reçoit pas d'emails. Vérifie la partie après le @." } : { ok: true };
          cache[dom] = out;
          if (!fini) { fini = true; clearTimeout(t); res(out); }
        })
        .catch(function () { if (!fini) { fini = true; clearTimeout(t); res({ ok: true }); } });
    });
  };
})();
