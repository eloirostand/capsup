// CapSup — relance manuelle d'un bilan (après un échec de génération).
// Page : https://capsup.org/.netlify/functions/bilan-relance
// Eloi saisit la phrase secrète (BILAN_TOKEN) et l'email de l'élève ; la fonction retrouve sa dernière
// soumission du formulaire « bilan » dans Netlify Forms et relance la génération, exactement comme
// après un envoi normal (email avec lien vers le bilan sur le site).
// Nécessite la variable d'environnement NETLIFY_API_TOKEN (jeton d'accès personnel Netlify).
import { createHash, timingSafeEqual } from "node:crypto";

const page = (msg = "") => ({
  statusCode: 200,
  headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" },
  body: `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Relance bilan</title>
<style>body{font-family:system-ui,sans-serif;background:#f8f5ee;max-width:520px;margin:40px auto;padding:0 16px;color:#1e232a}
label{display:block;margin:14px 0 4px;font-weight:600}input{width:100%;padding:10px;border:1px solid #c9d4f6;border-radius:8px;font-size:16px;box-sizing:border-box}
button{margin-top:18px;background:#2B55E8;color:#fff;border:0;border-radius:10px;padding:12px 20px;font-size:16px;cursor:pointer}
.m{background:#fff;border:1px solid #c9d4f6;border-radius:10px;padding:12px;margin-bottom:16px;white-space:pre-wrap}</style></head><body>
<h1>Relancer un bilan</h1>${msg ? `<div class="m">${msg}</div>` : ""}
<form method="post"><label for="t">Phrase secrète (BILAN_TOKEN)</label><input id="t" name="token" type="password" required autocomplete="current-password">
<label for="e">Email de l'élève</label><input id="e" name="email" type="email" required>
<button type="submit">Relancer le bilan</button></form>
<p style="font-size:13px;color:#5b6476">La dernière soumission de cet élève est reprise telle quelle. L'élève reçoit le bilan dans les minutes qui suivent (ou tu reçois une alerte si la génération échoue encore).</p>
</body></html>`,
});
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const egal = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

async function api(chemin, jeton) {
  const r = await fetch("https://api.netlify.com/api/v1" + chemin, { headers: { authorization: "Bearer " + jeton } });
  if (!r.ok) throw new Error("API Netlify " + r.status + " sur " + chemin);
  return r.json();
}

export const handler = async (event) => {
  if (event.httpMethod !== "POST") return page();
  const { ANTHROPIC_API_KEY, BILAN_TOKEN, NETLIFY_API_TOKEN, SITE_ID, URL } = process.env;
  const f = new URLSearchParams(event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString() : event.body || "");
  if (!BILAN_TOKEN || !egal(f.get("token") || "", BILAN_TOKEN)) { console.log("Relance : refus"); return page("Phrase secrète incorrecte."); }
  if (!NETLIFY_API_TOKEN) return page("Variable NETLIFY_API_TOKEN absente dans Netlify : relance impossible.");
  if (!ANTHROPIC_API_KEY) return page("Variable ANTHROPIC_API_KEY absente.");
  const email = (f.get("email") || "").trim().toLowerCase();
  try {
    const formes = await api(`/sites/${SITE_ID}/forms`, NETLIFY_API_TOKEN);
    const forme = formes.find(x => x.name === "bilan");
    if (!forme) return page("Formulaire « bilan » introuvable.");
    let sub = null;
    for (let p = 1; p <= 10 && !sub; p++) { // soumissions les plus récentes d'abord
      const liste = await api(`/forms/${forme.id}/submissions?per_page=100&page=${p}`, NETLIFY_API_TOKEN);
      sub = liste.find(s => String((s.data && s.data.email) || s.email || "").trim().toLowerCase() === email);
      if (liste.length < 100) break;
    }
    if (!sub) return page("Aucune soumission trouvée pour " + esc(email) + ".");
    const cle = createHash("sha256").update("capsup:" + ANTHROPIC_API_KEY).digest("hex");
    // Nouvel identifiant : le script Apps Script ignore un identifiant déjà traité.
    const id = sub.id + "-relance-" + Date.now();
    const r = await fetch(`${URL}/.netlify/functions/bilan-ia-background`, {
      method: "POST", headers: { "content-type": "application/json", "x-capsup-cle": cle },
      body: JSON.stringify({ id, data: sub.data || {} }),
    });
    console.log("Relance : lancée", r.status, sub.id);
    const quand = new Date(sub.created_at).toLocaleString("fr-FR", { timeZone: "Europe/Paris" });
    return page(r.status === 202 || r.ok
      ? `Bilan relancé pour ${esc((sub.data && sub.data.nom) || "")} &lt;${esc(email)}&gt; (soumission du ${esc(quand)}).\nVérifie dans quelques minutes : Gmail › Envoyés, ou alerte « Bilan à relire » en cas d'échec.`
      : "Échec du lancement (code " + r.status + ").");
  } catch (e) { console.log("Relance : erreur", e.message); return page("Erreur : " + esc(e.message)); }
};
