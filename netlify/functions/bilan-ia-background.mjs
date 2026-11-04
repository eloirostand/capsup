// CapSup — génération du brouillon de bilan (fonction d'arrière-plan, 15 min max).
// 1. Lit le catalogue réel dans le bundle publié du site.
// 2. Étape 1 (IA) : choisit 8 à 14 fiches adaptées au profil, à partir d'un index court.
// 3. Étape 2 (IA) : rédige le bilan à partir de ces seules fiches.
// 4. Contrôle : chaque formation existe ; chaque chiffre figure dans sa fiche ou dans les réponses.
// 5. Envoie le résultat au script Google Apps Script, qui crée un BROUILLON Gmail adressé à l'élève
//    (rien n'est envoyé à l'élève sans relecture) et prévient CapSup.
import { createHash } from "node:crypto";

const MODELE = "claude-sonnet-5-5";
const DEMO = ["assas-eco-gestion", "assas-double-licence-droit-eco", "janson-ecg", "dauphine-bachelor-intl",
  "sorbonne-droit-europe", "but-info-cloud-paris", "montaigne-ecg"];

// ---------- Catalogue ----------
async function chargerCatalogue(base) {
  const html = await (await fetch(base + "/")).text();
  const js = (html.match(/\/assets\/index-[^"']+\.js/) || [])[0];
  if (!js) throw new Error("bundle introuvable");
  const src = await (await fetch(base + js)).text();
  const debut = src.indexOf("oe=[{id:`");
  const fin = src.indexOf("].filter(e2=>![`assas-eco");
  if (debut < 0 || fin < 0) throw new Error("catalogue introuvable dans le bundle");
  const arr = new Function("return (" + src.slice(debut + 3, fin + 1) + ")")();
  return arr.filter(e => !DEMO.includes(e.id));
}

function ligneIndex(e) {
  return [e.id, e.name, e.university, e.city, e.region, e.categoryLabel, e.domain,
    e.selectivityRate != null ? e.selectivityRate + " %" : "?", e.feesDisplay || "?", e.durationLabel || ""].join(" | ");
}

function ficheCompacte(e) {
  const L = e.legacy || {};
  const F = L.fiabilite || {};
  return {
    id: e.id, nom: e.name, etablissement: e.university, ville: e.city, region: e.region,
    type: e.categoryLabel, domaine: e.domain, duree: e.durationLabel,
    places: e.capacity, candidats: e.applicantsCount,
    selectivite_pct: e.selectivityRate, selectivite_libelle: e.selectivityLabel,
    selectivite_detail: L.taux_acces, selectivite_source: F.taux_acces,
    frais: e.feesDisplay, frais_detail: L.frais_scolarite, frais_source: F.frais_scolarite, cout_total: L.cout_total_estime,
    parcoursup: L.parcoursup, selection: L.selection,
    procedure: L.procedure_admission, conditions: L.conditions_admission,
    specialites_recommandees: e.recommendedSpecialties, profil_attendu: e.profileRequirements,
    alternance: L.alternance, international: L.international,
    et_apres: { poursuite: L.poursuite_etudes, masters: L.masters, admissions_paralleles: L.admissions_paralleles,
      insertion: L.insertion, salaire: L.salaire, trajectoires: e.trajectories },
    debouches: L.debouches,
    url_fiche: "https://capsup.org/formations/" + (e.slug || e.id) + "/",
  };
}

// ---------- Profil (sans coordonnées : rien d'identifiant n'est envoyé à l'IA) ----------
const LIBELLES = {
  moyenne: { lt10: "moins de 10", "10_12": "10 – 12", "12_14": "12 – 14", "14_16": "14 – 16", gt16: "plus de 16" },
  budget: { public: "frais ≤ 500 €/an (public)", moderate: "frais ≤ 4 000 €/an", any: "sans limite de budget" },
  mobilite: { idf: "Paris / Île-de-France uniquement", france: "France entière", europe: "Europe & international" },
  international: { oui: "important", non: "peu important" },
  alternance: { oui: "indispensable", bonus: "un plus", non: "pas nécessaire" },
  selectivite: { haute: "prêt(e) à viser très sélectif", moyenne: "sélectivité modérée", faible: "peu sélectif" },
};
function profilDepuis(data) {
  const exclus = ["nom", "email", "telephone", "bot-field", "form-name", "pistes_affichees"];
  const p = {};
  for (const [k, v] of Object.entries(data || {})) {
    if (exclus.includes(k) || v == null || String(v).trim() === "") continue;
    p[k] = (LIBELLES[k] && LIBELLES[k][v]) || String(v).slice(0, 1500);
  }
  return p;
}

// ---------- API Claude ----------
async function claude(system, user, maxTokens) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODELE, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
  });
  if (!r.ok) throw new Error("API " + r.status + " " + (await r.text()).slice(0, 300));
  const j = await r.json();
  const txt = (j.content || []).filter(c => c.type === "text").map(c => c.text).join("");
  const m = txt.match(/\{[\s\S]*\}/);
  const info = "(arrêt : " + j.stop_reason + ", " + txt.length + " caractères, début : " + JSON.stringify(txt.slice(0, 120)) + ")";
  if (!m) throw new Error("réponse sans JSON " + info);
  try { return JSON.parse(m[0]); } catch (e) { throw new Error("JSON illisible " + info); }
}

const SYS_SELECTION = `Tu présélectionnes des formations du catalogue CapSup pour un lycéen.
Tu reçois son PROFIL et l'INDEX du catalogue (une ligne par formation : id | nom | établissement | ville | région | type | domaine | sélectivité = places ÷ candidats | frais | durée).
Choisis 8 à 14 formations pertinentes : domaine et objectifs de l'élève, contraintes de budget et de mobilité, et un mélange de vœux ambitieux et plus accessibles quand le catalogue le permet. Inclus les établissements que l'élève vise s'ils sont dans l'index. Au plus 3 CPGE ECG, de lycées différents. Évite de choisir plusieurs formations quasi identiques.
Réponds uniquement en JSON : {"ids": ["id1", "id2", …]}`;

const SYS_BILAN = `Tu rédiges le bilan d'orientation d'un lycéen pour CapSup. Tu reçois PROFIL (ses réponses au formulaire) et FICHES (formations présélectionnées du catalogue CapSup, en JSON).
Règles absolues :
- Tu ne recommandes QUE des formations présentes dans FICHES, identifiées par leur id exact.
- Tu n'utilises AUCUN chiffre (places, candidats, sélectivité, frais, pourcentages, dates, années) qui n'apparaît pas dans la fiche de la formation concernée ou dans PROFIL. Pas de chiffre calculé par toi (pas de somme, pas d'arrondi). Chaque chiffre de fiche est accompagné de son année et de sa source telles qu'indiquées dans la fiche.
- Tu n'affirmes aucun fait (lieu, école, procédure, débouché) absent des fiches, même s'il te semble vrai.
- Tu ne donnes jamais de probabilité d'admission chiffrée. Le niveau d'ambition est qualitatif : "Ambitieux", "Cohérent" ou "Sécurité", justifié par la fiche. Si la fiche ne donne pas le niveau des admis, dis-le.
- La sélectivité est « places ÷ candidats ». N'emploie jamais « taux d'accès » et ne parle pas de propositions comme d'un taux d'accès.
- Donnée absente : « Donnée non disponible ». Si le catalogue ne contient pas de formation adaptée à un besoin de l'élève, dis-le explicitement dans "lacunes" au lieu de forcer un substitut.
- Ne favorise aucune voie par principe. Tutoie l'élève, parle au nom de CapSup (« nous », jamais « je »). Une CPGE ECG est en « lycée public ou privé sous contrat ».
- Phrases courtes et concrètes, sans flatterie.
Réponds uniquement en JSON :
{"synthese": "3-4 phrases", "voies": [{"id": "…", "rang": 1, "ambition": "Ambitieux|Cohérent|Sécurité", "pourquoi": "2-3 phrases liées au profil", "points_vigilance": "…", "chiffres": "chiffres de la fiche avec année et source"}], "ordre_voeux": "…", "lacunes": "…", "calendrier": "uniquement des dates présentes dans les fiches, sinon renvoyer au calendrier officiel Parcoursup"}
Entre 5 et 8 voies, classées.`;

// ---------- Contrôle ----------
const norm = s => String(s).replace(/[  \s]/g, "").replace(/,/g, ".");
const nombres = t => (String(t || "").match(/\d[\d\s  ]*(?:[.,]\d+)?/g) || []).map(x => norm(x).replace(/\.$/, "")).filter(Boolean);
function controler(bilan, fiches, profil) {
  const parId = Object.fromEntries(fiches.map(f => [f.id, f]));
  const prof = norm(JSON.stringify(profil)), tout = norm(JSON.stringify(fiches));
  const pb = []; let n = 0;
  if (!Array.isArray(bilan.voies) || bilan.voies.length < 3) pb.push("moins de 3 voies");
  for (const v of bilan.voies || []) {
    const f = parId[v.id];
    if (!f) { pb.push(`formation « ${v.id} » absente des fiches`); continue; }
    const src = norm(JSON.stringify(f));
    for (const x of nombres([v.pourquoi, v.points_vigilance, v.chiffres].join(" "))) {
      n++; if (!src.includes(x) && !prof.includes(x)) pb.push(`${v.id} : « ${x} » absent de la fiche`);
    }
  }
  for (const k of ["synthese", "ordre_voeux", "lacunes", "calendrier"])
    for (const x of nombres(bilan[k])) { n++; if (!tout.includes(x) && !prof.includes(x)) pb.push(`${k} : « ${x} » absent des fiches`); }
  return { chiffres: n, problemes: pb };
}

// ---------- Email ----------
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function emailHtml(prenom, bilan, fiches) {
  const parId = Object.fromEntries(fiches.map(f => [f.id, f]));
  const c = "#2B55E8";
  const voies = bilan.voies.filter(v => parId[v.id]).map(v => {
    const f = parId[v.id];
    return `<tr><td style="padding:14px 0;border-top:1px solid #e6dfd2">
<div style="font-size:13px;color:#5b6476">${esc(v.rang)}. ${esc(v.ambition)}</div>
<div style="font-size:16px;font-weight:bold"><a href="${esc(f.url_fiche)}" style="color:${c}">${esc(f.nom)}</a></div>
<div style="font-size:13px;color:#5b6476">${esc(f.etablissement)} · ${esc(f.ville)}</div>
<p style="margin:8px 0 4px">${esc(v.pourquoi)}</p>
<p style="margin:4px 0"><b>Points de vigilance :</b> ${esc(v.points_vigilance)}</p>
<p style="margin:4px 0;font-size:13px;color:#5b6476">${esc(v.chiffres)}</p></td></tr>`;
  }).join("");
  return `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#1d2433;max-width:640px">
<p>Bonjour ${esc(prenom)},</p>
<p>Voici ton bilan d'orientation CapSup, établi à partir de tes réponses et des fiches de notre catalogue.</p>
<h2 style="font-size:18px;color:${c}">En résumé</h2><p>${esc(bilan.synthese)}</p>
<h2 style="font-size:18px;color:${c}">Les voies que nous te proposons</h2><table style="width:100%;border-collapse:collapse">${voies}</table>
<h2 style="font-size:18px;color:${c}">Ordre de tes vœux</h2><p>${esc(bilan.ordre_voeux)}</p>
<h2 style="font-size:18px;color:${c}">Ce que nos données ne permettent pas de dire</h2><p>${esc(bilan.lacunes)}</p>
<h2 style="font-size:18px;color:${c}">Calendrier</h2><p>${esc(bilan.calendrier)}</p>
<p style="font-size:13px;color:#5b6476">La sélectivité indiquée correspond au nombre de places divisé par le nombre de candidats, pour l'année citée. Elle ne mesure pas tes chances personnelles. Les fiches complètes et leurs sources sont sur capsup.org.</p>
<p>Pour toute question, réponds simplement à cet email.</p><p>L'équipe CapSup</p></div>`;
}

// ---------- Point d'entrée ----------
export const handler = async (event) => {
  const { ANTHROPIC_API_KEY, BILAN_SCRIPT_URL, BILAN_TOKEN, URL } = process.env;
  if (!ANTHROPIC_API_KEY || !BILAN_SCRIPT_URL || !BILAN_TOKEN) return;
  const attendu = createHash("sha256").update("capsup:" + ANTHROPIC_API_KEY).digest("hex");
  if ((event.headers || {})["x-capsup-cle"] !== attendu) { console.log("Bilan IA : appel refusé"); return; }

  const { id, data } = JSON.parse(event.body || "{}");
  const email = (data && data.email || "").trim(), prenom = (data && data.nom || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { console.log("Bilan IA : email invalide"); return; }
  const profil = profilDepuis(data);

  // Limite par adresse email : le script répond « deja » si un bilan a été envoyé récemment à cette adresse
  // (il prévient alors l'élève). Toute autre réponse (ou erreur) laisse continuer.
  try {
    const v = await fetch(BILAN_SCRIPT_URL, { method: "POST", redirect: "follow",
      body: JSON.stringify({ action: "verifier", token: BILAN_TOKEN, to: email, prenom }) });
    const t = (await v.text()).trim();
    if (t === "deja") { console.log("Bilan IA : limite par adresse atteinte"); return; }
  } catch (e) { console.log("Bilan IA : vérification de limite impossible", String(e)); }

  let bilan = null, fiches = [], rapport = { chiffres: 0, problemes: [] }, erreur = null;
  try {
    const cat = await chargerCatalogue(URL || "https://capsup.org");
    const sel = await claude(SYS_SELECTION,
      "PROFIL :\n" + JSON.stringify(profil, null, 1) + "\n\nINDEX :\n" + cat.map(ligneIndex).join("\n"), 3000);
    const ids = [...new Set((sel.ids || []).filter(i => cat.some(e => e.id === i)))].slice(0, 14);
    if (ids.length < 3) throw new Error("étape 1 : présélection insuffisante (" + ids.length + ")");
    fiches = ids.map(i => ficheCompacte(cat.find(e => e.id === i)));
    const entree = "PROFIL :\n" + JSON.stringify(profil, null, 1) + "\n\nFICHES :\n" + JSON.stringify(fiches);
    bilan = await claude(SYS_BILAN, entree, 16000);
    rapport = controler(bilan, fiches, profil);
    if (rapport.problemes.length) { // une seule nouvelle tentative, avec la liste des erreurs
      const b2 = await claude(SYS_BILAN, entree + "\n\nUne première version contenait des éléments absents des fiches : "
        + rapport.problemes.join(" ; ") + ". Corrige-les en n'utilisant que les fiches.", 16000);
      const r2 = controler(b2, fiches, profil);
      if (r2.problemes.length <= rapport.problemes.length) { bilan = b2; rapport = r2; }
    }
  } catch (e) { erreur = String(e && e.message || e); console.log("Bilan IA : erreur", erreur); }

  const corps = {
    action: "brouillon", token: BILAN_TOKEN, id: String(id || ""), to: email, prenom,
    sujet: "Ton bilan d'orientation CapSup",
    html: bilan && !erreur ? emailHtml(prenom || "", bilan, fiches) : "",
    envoyer: !!(bilan && !erreur && !rapport.problemes.length), // envoi direct si le contrôle ne trouve rien
    rapport: erreur ? "ÉCHEC de la génération : " + erreur + ". Bilan à faire à la main."
      : (rapport.problemes.length ? "À VÉRIFIER : " + rapport.problemes.join(" ; ")
        : "Contrôle automatique : " + rapport.chiffres + " chiffres vérifiés, tous présents dans les fiches.")
      + " Relire aussi les affirmations sans chiffre (lieux, procédures), que le contrôle ne vérifie pas.",
  };
  const r = await fetch(BILAN_SCRIPT_URL, { method: "POST", body: JSON.stringify(corps), redirect: "follow" });
  console.log("Bilan IA : script", r.status, (await r.text()).slice(0, 100));
};
