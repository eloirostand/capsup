// CapSup — génération du brouillon de bilan (fonction d'arrière-plan, 15 min max).
// 1. Lit le catalogue réel dans le bundle publié du site.
// 2. Étape 1 (IA) : choisit 8 à 14 fiches adaptées au profil, à partir d'un index court.
//    Le code ajoute ensuite au moins 2 formations moins sélectives (domaines et région de l'élève ; pour une licence
//    non sélective : son académie, déduite du code postal de son lycée dans l'annuaire de l'éducation)
//    et, pour un élève de lycée privé en voie générale (moyenne ≥ 12), au moins 2 CPGE.
// 3. Étape 2 (IA) : rédige le bilan à partir de ces fiches, avec recherche web autorisée (sources citées),
//    pour la session Parcoursup calculée à partir de la classe (Première → année suivante).
// 4. Contrôle : chaque formation existe ; chaque chiffre figure dans sa fiche, les réponses, le contexte
//    ou un extrait cité d'une page web ; sources web réellement consultées ; dates de la bonne session.
// 5. Envoie le résultat au script Google Apps Script, qui crée un BROUILLON Gmail adressé à l'élève
//    (rien n'est envoyé à l'élève sans relecture) et prévient CapSup.
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { adresseRefusee } from "./verifier-email.mjs";

const MODELE = "claude-sonnet-5-5";       // rédaction du bilan
const MODELE_TRI = "claude-haiku-5-5";     // étape 1 (présélection), moins chère
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
  return { cat: arr.filter(e => !DEMO.includes(e.id)), calendrier: lireCalendrier(src) };
}

// Calendrier Parcoursup officiel du site (objet CSUP_PS du bundle). null si introuvable.
function lireCalendrier(src) {
  const i = src.indexOf("CSUP_PS={");
  if (i < 0) return null;
  let j = i + 8, prof = 0, tpl = false;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === "`") tpl = !tpl;
    else if (!tpl && c === "{") prof++;
    else if (!tpl && c === "}" && --prof === 0) break;
  }
  try {
    const o = new Function("return (" + src.slice(i + 8, j + 1) + ")")();
    const etapes = [];
    for (const ph of o.phases || []) for (const s of ph.s || []) if (s.d) etapes.push({ d: s.d, e: s.e || null, t: s.t });
    const v = etapes.find(s => /vœux|voeux/i.test(s.t)) || etapes[0];
    return v ? { session: Number(String(v.d).slice(0, 4)), source: o.src, etapes } : null;
  } catch (e) { return null; }
}

// ---------- Académie (secteur des licences non sélectives) ----------
// Départements → académie (Paris, Créteil, Versailles regroupées : secteur francilien des universités d'Île-de-France).
const ACAD_DEP = {};
for (const [a, deps] of Object.entries({
  "Aix-Marseille": "04 05 13 84", "Amiens": "02 60 80", "Besançon": "25 39 70 90", "Bordeaux": "24 33 40 47 64",
  "Clermont-Ferrand": "03 15 43 63", "Corse": "2A 2B", "Île-de-France": "75 77 78 91 92 93 94 95", "Dijon": "21 58 71 89",
  "Grenoble": "07 26 38 73 74", "Lille": "59 62", "Limoges": "19 23 87", "Lyon": "01 42 69", "Montpellier": "11 30 34 48 66",
  "Nancy-Metz": "54 55 57 88", "Nantes": "44 49 53 72 85", "Nice": "06 83", "Normandie": "14 27 50 61 76",
  "Orléans-Tours": "18 28 36 37 41 45", "Poitiers": "16 17 79 86", "Reims": "08 10 51 52", "Rennes": "22 29 35 56",
  "Strasbourg": "67 68", "Toulouse": "09 12 31 32 46 65 81 82", "Guadeloupe": "971", "Martinique": "972", "Guyane": "973",
  "La Réunion": "974", "Mayotte": "976" })) for (const d of deps.split(" ")) ACAD_DEP[d] = a;
// Fiches sans code de département : ville ou nom de département.
const ACAD_LIEU = { paris: "Île-de-France", versailles: "Île-de-France", "neuilly-sur-seine": "Île-de-France", "rueil-malmaison": "Île-de-France",
  bobigny: "Île-de-France", sceaux: "Île-de-France", orsay: "Île-de-France", cergy: "Île-de-France", lyon: "Lyon", toulouse: "Toulouse",
  lille: "Lille", douai: "Lille", bordeaux: "Bordeaux", marseille: "Aix-Marseille", nice: "Nice", "le mans": "Nantes", nantes: "Nantes",
  angers: "Nantes", montpellier: "Montpellier", reims: "Reims", grenoble: "Grenoble",
  "haute-garonne": "Toulouse", "isère": "Grenoble", "loire-atlantique": "Nantes", "hérault": "Montpellier" };
const minus = s => String(s || "").trim().toLowerCase();
function academieFiche(e) {
  const m = String(e.department || "").match(/\((\d{2,3}|2[AB])\)/) || String(e.department || "").match(/^(\d{2,3}|2[AB])$/);
  if (m && ACAD_DEP[m[1]]) return ACAD_DEP[m[1]];
  return ACAD_LIEU[minus(e.city)] || ACAD_LIEU[minus(e.department)] || null;
}
const depDepuisCP = cp => { cp = String(cp || ""); if (!/^\d{5}$/.test(cp)) return null;
  if (cp.startsWith("97")) return cp.slice(0, 3); if (cp.startsWith("20")) return Number(cp) < 20200 ? "2A" : "2B"; return cp.slice(0, 2); };
// Académie de l'élève : code postal de son lycée (annuaire de l'éducation, via /.netlify/functions/lycees).
// Le champ lycee_nom vaut « Nom (Commune) ». null si lycée saisi librement ou introuvable.
async function academieEleve(data, base) {
  const m = String(data.lycee_nom || "").match(/^(.*?)\s*\(([^()]+)\)\s*$/);
  if (!m) return null;
  const nom = minus(m[1]), commune = minus(m[2]);
  try {
    const r = await fetch(base + "/.netlify/functions/lycees");
    if (!r.ok) return null;
    const l = (await r.json()).l || [];
    const memeCommune = l.filter(x => minus(x[1]) === commune);
    const choix = memeCommune.filter(x => minus(x[0]) === nom);
    const deps = new Set((choix.length ? choix : memeCommune).map(x => depDepuisCP(x[2])).filter(Boolean));
    if (deps.size !== 1) return null;
    const dep = [...deps][0];
    return ACAD_DEP[dep] ? { academie: ACAD_DEP[dep], departement: dep } : null;
  } catch (e) { console.log("Bilan IA : académie introuvable", String(e)); return null; }
}

// ---------- Contexte calculé (session visée, priorités) ----------
const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const dateFr = d => { const [a, m, j] = String(d).split("-").map(Number); return (j === 1 ? "1er" : j) + " " + MOIS[m - 1] + " " + a; };
function contexteDepuis(data, calendrier, maintenant = new Date(), cat = [], acad = null) {
  const paris = new Date(maintenant.toLocaleString("en-US", { timeZone: "Europe/Paris" }));
  const finAnnee = paris.getMonth() >= 8 ? paris.getFullYear() + 1 : paris.getFullYear(); // année scolaire en cours : sept. → août
  const classe = String(data.classe || "");
  const session = classe === "premiere" ? finAnnee + 1 : classe === "parent" ? null : finAnnee;
  const officiel = session && calendrier && calendrier.session === session ? calendrier : null;
  const voie = /techno/i.test(data.type_lycee || "") ? "techno" : /pro/i.test(data.type_lycee || "") ? "pro" : "generale";
  const prive = /^prive/.test(String(data.statut_lycee || ""));
  const moyenneFaible = ["lt10", "10_12"].includes(String(data.moyenne || ""));
  const enFrance = !!data.localisation && !/étranger/i.test(String(data.localisation));
  const lignes = [
    "Date du jour : " + dateFr(paris.toISOString().slice(0, 10)) + ".",
    session ? "SESSION VISÉE : Parcoursup " + session + " (rentrée de septembre " + session + ")" + (classe === "premiere" ? " : l'élève est en Première, il candidatera dans plus d'un an." : ".")
      : "SESSION VISÉE : inconnue (formulaire rempli par un parent, classe de l'enfant non précisée).",
  ];
  if (officiel) lignes.push("CALENDRIER OFFICIEL PARCOURSUP " + session + " (source : " + officiel.source + ") : "
    + officiel.etapes.map(s => dateFr(s.d) + (s.e ? " au " + dateFr(s.e) : "") + " : " + s.t).join(" ; ") + ".");
  else lignes.push("Calendrier officiel de cette session : pas encore publié. N'indique que des mois habituels (sans jour ni année), à revérifier.");
  lignes.push("Élève scolarisé en France : " + (enFrance ? "oui" : "non précisé") + ".");
  if (enFrance) {
    const n = cat.filter(e => e.region === data.localisation).length;
    lignes.push("RÉGION DE L'ÉLÈVE : " + data.localisation + (n ? " (" + n + " formations du catalogue dans cette région)."
      : " : aucune formation du catalogue dans cette région. Cherche sur le web (sources officielles) les formations de son académie qui correspondent à ses domaines (en particulier les licences, où il serait prioritaire) et présente-les dans « autres_pistes » comme pistes hors catalogue, avec leur source (sans présenter cela comme un manque)."));
    if (acad) {
      const doms = domainesEleve(data);
      const locales = cat.filter(e => e._acad === acad.academie && (!doms.length || doms.includes(e.domain)));
      lignes.push("ACADÉMIE DE L'ÉLÈVE : " + acad.academie + " (département " + acad.departement + " de son lycée, annuaire de l'éducation). "
        + "C'est son secteur pour les licences non sélectives : chaque formation porte son académie (champ « academie »). "
        + "Une région peut compter plusieurs académies : une licence de sa région mais d'une autre académie est hors secteur pour lui. "
        + (locales.some(e => e.category === "but") ? "" : "Aucun BUT de son académie dans ses domaines parmi nos formations analysées : cherche sur le web (parcoursup.gouv.fr, onisep.fr, sites des IUT) un ou deux BUT de son académie dans ses domaines et propose-les dans « autres_pistes » avec leur page. ")
        + (locales.length ? "" : "Aucune formation de son académie dans ses domaines parmi nos formations analysées : cherche sur le web les licences et BUT de son académie et propose-les dans « autres_pistes » avec leur page."));
    } else lignes.push("ACADÉMIE DE L'ÉLÈVE : non déterminée (lycée saisi librement ou introuvable). Pour une licence non sélective de sa région, signale qu'un plafond de non-résidents peut s'appliquer si la région compte plusieurs académies, et ne la classe « Sécurité » que si la région ne compte qu'une académie.");
  }
  const obj = String(data.objectifs_post_bac || "");
  const voulus = [/\bBUT\b/i.test(obj) && "BUT", /\bBTS\b/i.test(obj) && "BTS", /[ée]tranger/i.test(obj) && "études à l'étranger"].filter(Boolean);
  if (voulus.length) lignes.push("TYPES DE FORMATION COCHÉS PAR L'ÉLÈVE : " + voulus.join(", ") + ". Chacun doit apparaître au moins une fois, dans une voie classée ou dans « autres_pistes » (formation analysée, ou trouvée par ta recherche web avec sa page, de préférence dans son académie)"
    + (voulus.includes("études à l'étranger") && data.mobilite !== "europe" ? " ; pour l'étranger, sa mobilité ne l'autorise pas : dis-le en une phrase au lieu de proposer une formation." : "."));
  const prepa = prive && voie === "generale" && !moyenneFaible;
  if (prepa) lignes.push("PRÉPA PRIORITAIRE : oui (lycée privé, voie générale, moyenne d'au moins 12).");
  return { session, officiel, voie, enFrance, prepa, academie: acad ? acad.academie : null, texte: lignes.join("\n") };
}

// ---------- Compléments imposés à la présélection ----------
const domainesEleve = data => String(data.domaines || "").split(/[,;]\s*/).map(s => s.trim()).filter(Boolean);
const regionEleve = (data, cat) => cat.some(e => e.region === data.localisation) ? data.localisation : null;
const compatible = (e, ctx) => ctx.voie !== "techno" || e.bacTechnoPct !== 0;
const ETRANGER = ["Espagne", "Canada", "Royaume-Uni", "Pays-Bas", "Italie"];
const PLAFOND = { public: 500, moderate: 4000 };
function respecteContraintes(e, data) {
  const plafond = PLAFOND[data.budget];
  if (plafond && !(e.annualFees != null && e.annualFees <= plafond)) return false;
  if (data.mobilite === "idf" && e.region !== "Île-de-France") return false;
  if (data.mobilite === "france" && ETRANGER.includes(e.region)) return false;
  return true;
}
// Au moins 2 formations nettement moins sélectives des domaines et de la région de l'élève.
// « Moins sélective » = licence marquée non sélective (capacité limitée) ou sélectivité (places ÷ candidats) ≥ 5 %.
// Les CPGE sont traitées à part (toutes autour de 1 à 3 % : la sélectivité ne les distingue pas).
const nonSelective = e => /non s[ée]lective/i.test(String(e.selectivityLabel || ""));
function securites(cat, data, ctx, deja) {
  const reg = regionEleve(data, cat), doms = domainesEleve(data);
  // Une licence non sélective n'est une sécurité que dans le secteur de l'élève : son académie (priorité aux résidents,
  // quota de non-résidents ailleurs, y compris dans une autre académie de sa région). Académie inconnue : sa région.
  const secteur = e => ctx.academie ? e._acad === ctx.academie : !!(reg && e.region === reg);
  const pools = doms.map(d => cat.filter(e => e.domain === d && e.category !== "cpge" && (!reg || e.region === reg)
      && compatible(e, ctx) && respecteContraintes(e, data)
      && (nonSelective(e) ? secteur(e) : (e.selectivityRate != null && e.selectivityRate >= 5)))
    .sort((a, b) => (nonSelective(b) - nonSelective(a)) || (secteur(b) - secteur(a))
      // licence non sélective : places ÷ candidats n'a pas de sens (accès de droit pour les résidents du secteur, dans la limite des places) → tri par nombre de places
      || (nonSelective(a) ? (b.capacity || 0) - (a.capacity || 0) : (b.selectivityRate || 0) - (a.selectivityRate || 0))).slice(0, 4));
  const tous = new Set(pools.flat().map(e => e.id));
  const ajout = [];
  let present = [...deja].filter(i => tous.has(i)).length;
  for (let r = 0; r < 3 && present < 2; r++)
    for (const p of pools) { const e = p[r]; if (e && !deja.has(e.id) && !ajout.includes(e.id) && present < 2) { ajout.push(e.id); present++; } }
  return { ajout, pool: [...tous] };
}
// Lycée privé : au moins 2 CPGE des domaines de l'élève (de préférence dans sa région).
function prepas(cat, data, ctx, deja) {
  if (!ctx.prepa) return [];
  const doms = domainesEleve(data); if (doms.includes("tech") && !doms.includes("ingenieur")) doms.push("ingenieur");
  const reg = regionEleve(data, cat);
  const cpge = cat.filter(e => e.category === "cpge" && doms.includes(e.domain));
  const n = [...deja].filter(i => cpge.some(e => e.id === i)).length;
  const tri = cpge.filter(e => !deja.has(e.id))
    .sort((a, b) => (doms.indexOf(a.domain) - doms.indexOf(b.domain)) || ((b.region === reg) - (a.region === reg)) || ((b.selectivityRate || 0) - (a.selectivityRate || 0)));
  return tri.slice(0, Math.max(0, 2 - n)).map(e => e.id);
}

function ligneIndex(e) {
  return [e.id, e.name, e.university, e.city, e.region, "académie " + (e._acad || "?"), e.categoryLabel, e.domain,
    e.selectivityRate != null ? e.selectivityRate + " %" : "?", e.feesDisplay || "?", e.durationLabel || "",
    e.bacTechnoPct != null ? "bac techno admis " + e.bacTechnoPct + " %" : "bac techno admis ?"].join(" | ");
}

const court = t => t; // pas de coupe : textes complets (décision d'Eloi, 04/11)
function ficheCompacte(e) {
  const L = e.legacy || {};
  const F = L.fiabilite || {};
  return {
    id: e.id, nom: e.name, etablissement: e.university, ville: e.city, region: e.region, academie: e._acad || null,
    type: e.categoryLabel, domaine: e.domain, duree: e.durationLabel,
    places: e.capacity, candidats: e.applicantsCount,
    selectivite_pct: e.selectivityRate, selectivite_libelle: e.selectivityLabel,
    selectivite_detail: court(L.taux_acces), selectivite_source: F.taux_acces,
    frais: e.feesDisplay, frais_detail: court(L.frais_scolarite), frais_source: F.frais_scolarite, cout_total: court(L.cout_total_estime),
    parcoursup: L.parcoursup, selection: court(L.selection),
    voeu_parcoursup: { type: L.voeu_type, voeu: L.voeu_groupe, sous_voeu: L.voeu_sous_voeu, decompte_sous_voeux: L.voeu_decompte, explication: L.voeu_parcoursup },
    procedure: court(L.procedure_admission), conditions: court(L.conditions_admission),
    specialites_recommandees: e.recommendedSpecialties, profil_attendu: court(e.profileRequirements),
    part_bacheliers_technologiques_admis_pct: e.bacTechnoPct, part_bacheliers_generaux_admis_pct: e.bacGeneralPct,
    alternance: court(L.alternance), international: court(L.international),
    et_apres: { poursuite: court(L.poursuite_etudes), masters: court(L.masters), admissions_paralleles: court(L.admissions_paralleles),
      insertion: court(L.insertion), salaire: court(L.salaire), trajectoires: e.trajectories },
    debouches: court(L.debouches),
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
  type_lycee: { general: "voie générale", techno: "voie technologique", pro: "voie professionnelle" },
};

// Repères sourcés sur la voie technologique, utilisables dans le bilan (et acceptés par le contrôle des chiffres).
const REPERES_TECHNO = `REPÈRES VOIE TECHNOLOGIQUE (sources officielles, à citer telles quelles) :
- Séries du bac technologique : STMG, STI2D, STL, ST2S, STD2A, STHR, S2TMD, STAV (Onisep, « La voie technologique en première et terminale »).
- BUT : pour chaque spécialité de BUT de chaque IUT, le recteur fixe chaque année un taux minimal de places réservées aux bacheliers technologiques (code de l'éducation, article L612-3, VII). Exemple : arrêté du recteur de la région académique Normandie du 13 avril 2026 (Parcoursup 2026) : 50 % en GEA et en Techniques de commercialisation.
- Prépa ECT : son option technologique est réservée aux bacheliers STMG ; elle prépare aux concours des écoles de commerce (Onisep, « Que faire après le bac STMG ? »).
- Prépas scientifiques pour bacheliers technologiques (Onisep, « Les prépas scientifiques ») : TSI, destinée aux bacheliers STI2D et STL ; TPC, pour les bacheliers STL ; TB, pour les bacheliers STL et STAV.
Ces repères ne désignent aucune formation précise : ne les présente pas comme des formations analysées en détail.`;
function profilDepuis(data) {
  const exclus = ["nom", "email", "telephone", "bot-field", "form-name", "pistes_affichees", "ip", "user_agent", "referrer"];
  const p = {};
  for (const [k, v] of Object.entries(data || {})) {
    if (exclus.includes(k) || v == null || String(v).trim() === "") continue;
    p[k] = (LIBELLES[k] && LIBELLES[k][v]) || String(v).slice(0, 1500);
  }
  return p;
}

// ---------- API Claude ----------
// Les modèles 5.5 « réfléchissent » avant de répondre (réflexion adaptative active par défaut) ;
// cette réflexion consomme le plafond max_tokens. Plafonds larges + une nouvelle tentative si la réponse est vide.
// Recherche web (outil serveur d'Anthropic) : autorisée pour la rédaction. Les extraits cités et les adresses
// des résultats sont renvoyés pour le contrôle.
const RECHERCHE_WEB = { type: "web_search_20250305", name: "web_search", max_uses: 6,
  user_location: { type: "approximate", country: "FR", timezone: "Europe/Paris" } };
const web = { cites: [], urls: new Set() }; // cumul pour un bilan

async function claude(system, user, maxTokens, modele = MODELE, etape = "", outils = null) {
  try { return await appelClaude(system, user, maxTokens, modele, outils); }
  catch (e) {
    const msg = String(e.message);
    if (outils && /^API 400/.test(msg)) { // outil refusé par l'API : on continue sans recherche web
      console.log("Bilan IA : " + etape + "recherche web refusée, rédaction sans recherche", msg);
      return claude(system, user, maxTokens, modele, etape, null);
    }
    if (!/sans JSON|illisible/.test(msg)) throw new Error(etape + msg);
    console.log("Bilan IA : " + etape + "nouvelle tentative après", msg);
    try { return await appelClaude(system, user, Math.min(maxTokens * 2, 120000), modele, outils); }
    catch (e2) { throw new Error(etape + String(e2.message)); }
  }
}
async function appelClaude(system, user, maxTokens, modele, outils) {
  const messages = [{ role: "user", content: user }];
  let blocs = [], j = null;
  for (let tour = 0; tour < 4; tour++) { // « pause_turn » : on renvoie le tour interrompu tel quel pour continuer
    const corps = { model: modele, max_tokens: maxTokens, system, messages };
    if (outils) corps.tools = outils;
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify(corps),
    });
    if (!r.ok) throw new Error("API " + r.status + " " + (await r.text()).slice(0, 300));
    j = await r.json();
    if (j.usage) console.log("Bilan IA : jetons", modele, "entrée", j.usage.input_tokens, "sortie", j.usage.output_tokens,
      "recherches", (j.usage.server_tool_use || {}).web_search_requests || 0);
    blocs = blocs.concat(j.content || []);
    if (j.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: j.content });
  }
  for (const b of blocs) {
    if (b.type === "web_search_tool_result" && Array.isArray(b.content))
      for (const x of b.content) if (x && x.url) web.urls.add(x.url);
    if (b.type === "text" && Array.isArray(b.citations))
      for (const c of b.citations) { if (c.cited_text) web.cites.push(c.cited_text); if (c.url) web.urls.add(c.url); }
  }
  const txt = blocs.filter(c => c.type === "text").map(c => c.text).join("");
  const m = txt.match(/\{[\s\S]*\}/);
  const info = "(arrêt : " + j.stop_reason + ", " + txt.length + " caractères, début : " + JSON.stringify(txt.slice(0, 120)) + ")";
  if (!m) throw new Error("réponse sans JSON " + info);
  try { return JSON.parse(m[0]); } catch (e) { throw new Error("JSON illisible " + info); }
}

const SYS_SELECTION = `Tu présélectionnes des formations du catalogue CapSup pour un lycéen.
Tu reçois son PROFIL et l'INDEX du catalogue (une ligne par formation : id | nom | établissement | ville | région | académie | type | domaine | sélectivité = places ÷ candidats | frais | durée).
Le champ « bac techno admis » indique la part de bacheliers technologiques parmi les admis quand la fiche la renseigne.
Si l'élève est en voie technologique (type_lycee / serie_bac) : privilégie les formations qui admettent des bacheliers technologiques (BUT, BTS, part « bac techno admis » supérieure à 0 %) et en lien avec sa série ; n'inclus une formation à 0 % de bacheliers technologiques admis (CPGE ECG, B/L, scientifiques, CPES… réservées au bac général d'après leurs fiches) que si l'élève la vise explicitement.
Choisis 8 à 10 formations pertinentes : domaine et objectifs de l'élève, contraintes de budget et de mobilité, et un mélange de vœux ambitieux et plus accessibles quand le catalogue le permet. Inclus les établissements que l'élève vise s'ils sont dans l'index. Au plus 3 CPGE ECG, de lycées différents. Évite de choisir plusieurs formations quasi identiques.
Si CONTEXTE donne l'ACADÉMIE DE L'ÉLÈVE, inclus les licences non sélectives et BUT de son académie qui correspondent à ses domaines (il est prioritaire dans les licences de son académie, pas dans celles d'une autre académie de sa région).
Inclus au moins 2 formations nettement moins sélectives (sélectivité plus élevée) dans les domaines et la région de l'élève : une prépa, une licence, une double licence ou un BUT qui mène vers son objectif compte, même si ce n'est pas un diplôme à Bac+5 direct.
Si CONTEXTE indique « PRÉPA PRIORITAIRE : oui », inclus au moins 2 CPGE correspondant à ses domaines (scientifiques pour l'ingénierie ou l'informatique, ECG pour le commerce, B/L ou D2 pour l'économie), de préférence dans sa région et de sélectivités différentes.
Chaque domaine coché par l'élève (PROFIL « domaines ») doit être représenté par au moins une formation dans "ids" ou dans "pistes".
Ajoute dans "pistes" 4 à 8 AUTRES formations de l'index, différentes de "ids", moins prioritaires mais intéressantes pour cet élève (autre domaine qu'il a coché, autre ville, voie différente vers son objectif, option plus accessible).
Réponds uniquement en JSON : {"ids": ["id1", "id2", …], "pistes": ["id", …]}`;

const SYS_BILAN = `Tu es conseiller d'orientation chez CapSup et tu rédiges le bilan d'orientation d'un lycéen. Tu reçois CONTEXTE (date, session Parcoursup visée, calendrier, priorités calculées), PROFIL (ses réponses au formulaire) et FICHES (formations que nous avons analysées et retenues pour lui, en JSON). Ces termes techniques sont pour toi seul.
Ton et vocabulaire (essentiel) :
- Tu écris comme un conseiller d'orientation de CapSup qui parle à l'élève : direct, bienveillant, sûr de son analyse. Ce que contiennent FICHES, c'est « notre analyse » ; tu le présentes comme tel, sans jamais évoquer d'où viennent tes informations en interne.
- N'écris jamais, dans aucun champ : « fiche » (sauf « fiche Parcoursup » d'une formation), « FICHES », « catalogue », « index », « base de données », « nos données », « présélection », « CONTEXTE », « PROFIL », « IA », « intelligence artificielle », « modèle », « automatique ».
- Ne mets jamais en avant des limites de CapSup ou de ce bilan : pas de « nos données ne permettent pas », « nous n'avons pas trouvé », « nous n'avons pas fait de recherche », « absent de notre sélection », « non couvert par CapSup ».
- Information manquante (niveau des admis, nombre de places, tarif…) : cherche-la d'abord sur le web. Si elle reste introuvable, dis qu'elle n'est pas rendue publique (« l'établissement ne publie pas le niveau de ses admis », « ce chiffre n'est pas publié par Parcoursup ») et, si c'est utile, conseille à l'élève de la demander (journées portes ouvertes, salon, service d'admission). N'utilise « Donnée non disponible » que dans "chiffres".
Règles absolues :
- Tu ne recommandes QUE des formations présentes dans FICHES, identifiées par leur id exact.
- Chiffres (places, candidats, sélectivité, frais, pourcentages, dates, années) : uniquement ceux de la fiche concernée, de PROFIL, de CONTEXTE, ou d'une page trouvée par ta recherche web et citée. Pas de chiffre calculé par toi (pas de somme, pas d'arrondi). Chaque chiffre est accompagné de son année et de sa source.
- Recherche web : fais au moins une recherche ciblée (par exemple niveau des admis ou procédure de la session visée pour la formation la plus ambitieuse) ; tu es encouragé à chercher des informations utiles absentes des fiches ou plus récentes (procédures, attendus, dates de la session visée, niveau des admis, débouchés, formations proches). Priorité aux sources officielles (parcoursup.gouv.fr, onisep.fr, sites des établissements, service-public.fr, enseignementsup-recherche.gouv.fr) ; une source secondaire (presse, classements) est signalée comme telle. Toute information hors fiche indique dans le texte sa source (nom du site) et son année, et chaque page utilisée figure dans "sources_web". Si une page contredit une fiche, signale la contradiction et indique ce que tu retiens. N'écris jamais dans une requête de recherche le prénom, l'email, le nom du lycée ou d'autres informations personnelles de l'élève (sa région ou son académie sont permises).
- Sans fiche ni source web citée, n'affirme aucun fait (lieu, école, procédure, débouché), même s'il te semble vrai. Si une fiche marque un chiffre « à confirmer », garde cette mention.
- Tu ne donnes jamais de probabilité d'admission chiffrée. Le niveau d'ambition est qualitatif : "Ambitieux", "Cohérent" ou "Sécurité", justifié par la fiche. Si le niveau des admis n'est pas publié, dis-le (règle « Information manquante »).
- Cohérence des niveaux : une formation « Cohérent » ou « Ambitieux » ne doit pas paraître plus accessible qu'une « Sécurité » sans explication. Pour une licence non sélective de sa région classée « Sécurité », explique que les candidats du secteur y sont prioritaires et que places ÷ candidats sous-estime l'accès (beaucoup de candidats acceptent une autre proposition). Ne qualifie jamais une licence non sélective de « très sélective ».
- Sécurité : classe en « Sécurité » au moins une formation quand FICHES en contient une adaptée (moins sélective, dans ses domaines, accessible avec son profil). Une prépa, une licence, une double licence ou un BUT qui mène à son objectif (par exemple une école d'ingénieurs par concours ou admission parallèle) compte comme voie vers cet objectif, même sans Bac+5 direct. Ne classe pas en « Sécurité » une formation à l'étranger ni une formation dont l'élève ne remplit pas une condition (langue, spécialité).
- Licences non sélectives (« non sélective · capacité limitée ») : les candidats qui résident dans le secteur de la formation (son académie ; l'Île-de-France pour les universités franciliennes) sont prioritaires, et le recteur plafonne la part de candidats non résidents. Le secteur de l'élève est l'ACADÉMIE DE L'ÉLÈVE de CONTEXTE (champ « academie » de chaque fiche), pas sa région : une région peut compter plusieurs académies (Occitanie : Toulouse et Montpellier ; Auvergne-Rhône-Alpes : Lyon, Grenoble et Clermont-Ferrand ; etc.). Si la formation est dans son académie, ne parle pas de ce plafond. Sinon, même dans sa région, signale ce plafond dans "points_vigilance" (chiffre de la fiche, ou d'une source web citée, sinon dis qu'il existe sans chiffre) et ne la classe jamais en « Sécurité » ; un « bassin » ou des départements cités dans les conseils d'une formation ne remplacent pas le secteur officiel (tu peux les citer comme conseil de la formation, sans en conclure qu'il est prioritaire). Hors de son académie, avec un plafond de non-résidents et une sélectivité (places ÷ candidats) inférieure à 10 %, classe-la « Ambitieux ».
- Sécurité de son académie : si FICHES contient une licence non sélective ou un BUT de son académie dans ses domaines, accessible à sa série, classe-la en « Sécurité » plutôt qu'une formation d'une autre académie. Examine toutes les FICHES et AUTRES FORMATIONS avant de conclure qu'il n'y a pas d'option plus accessible ; dans ce cas, conseille concrètement (élargir à d'autres licences ou BUT de son académie, phase complémentaire), sans parler de manque.
- PRÉPA PRIORITAIRE : si CONTEXTE l'indique, place au moins 2 CPGE de FICHES correspondant à ses domaines aux premiers rangs (rangs 1 à 3).
- Session : les dates de candidature concernent uniquement la SESSION VISÉE de CONTEXTE. N'écris aucune date d'une session passée ou d'une autre session, même si elle figure dans une fiche ou sur une page web : une fiche datée d'une autre session ne sert pas pour le calendrier. S'il existe un CALENDRIER OFFICIEL dans CONTEXTE, utilise-le (avec sa source). Sinon, indique seulement les mois habituels (par exemple « vœux de mi-janvier à mi-mars », « réponses à partir de début juin »), sans jour ni année, en précisant qu'ils sont à revérifier quand le calendrier officiel de sa session sera publié. Pour les candidatures hors Parcoursup, même règle. Si l'élève est en Première, dis-le dans la synthèse (il candidatera l'année suivante).
- Niveau d'anglais : utilise de la même façon pour toutes les formations le niveau déclaré dans PROFIL (« langues ») et, à côté, sa note de LVA ; si une formation exige un niveau supérieur, dis-le.
- Domaines : chaque domaine coché dans PROFIL (« domaines ») apparaît au moins une fois, dans une voie classée ou dans "autres_pistes".
- Langues : si l'élève est scolarisé en France, ne mentionne pas les conditions de langue destinées aux candidats étrangers ou non francophones (niveau de français, DELF/DALF, TCF…).
- Vœux Parcoursup : ils ne sont pas classés par ordre de préférence. Dans "ordre_voeux", décris l'équilibre de la liste (part d'ambitieux, de cohérents et de sécurités, formations hors Parcoursup à part) et rappelle explicitement que les vœux ne sont pas classés ; ne dis jamais de placer un vœu « d'abord », « en premier » ou « en tête ».
- La sélectivité est « places ÷ candidats ». N'emploie jamais « taux d'accès » et ne parle pas de propositions comme d'un taux d'accès.
- Si aucune formation analysée ne répond bien à un besoin de l'élève, ne force pas de substitut : propose une piste dans "autres_pistes" (formation de AUTRES FORMATIONS ou trouvée par ta recherche web, avec sa page) ou un conseil concret dans "lacunes", sans présenter cela comme un manque.
- Ne favorise aucune voie par principe. Tutoie l'élève, parle au nom de CapSup (« nous », jamais « je »). Une CPGE ECG est en « lycée public ou privé sous contrat ».
- Voie technologique : si PROFIL indique la voie technologique (type_lycee, serie_bac, spécialités de sa série), vérifie pour chaque formation dans la fiche (conditions, profil attendu, spécialités recommandées, part de bacheliers technologiques admis) qu'elle est accessible à sa série ; si une fiche réserve la formation au bac général, ne la recommande pas, ou seulement si l'élève la vise explicitement, en le signalant dans "points_vigilance". Tu peux t'appuyer sur REPÈRES (voie technologique) pour les généralités (taux minimal de bacheliers technologiques en BUT, prépas ECT, TSI, TPC, TB) en citant leur source ; si une voie pensée pour sa série n'est pas parmi les formations analysées, propose-la en piste (recherche web, page citée) ou conseille-lui de la regarder.
- N'applique pas aux bacheliers technologiques les attentes de spécialités de la voie générale (ex. « spécialité maths ») : compare plutôt avec ses spécialités de série et ses notes.
- Les « félicitations » (comme les « compliments » ou « encouragements ») sont un avis du conseil de classe, pas une mention : n'écris jamais « mention de félicitations ». Les mentions (Assez bien, Bien, Très bien) sont celles du bac.
- Types de formation cochés (CONTEXTE « TYPES DE FORMATION COCHÉS ») : chacun apparaît dans une voie ou dans "autres_pistes".
- Phrases courtes et concrètes, sans flatterie.
"lacunes" (affiché sous le titre « Points à vérifier de ton côté ») : 2 à 4 points concrets que l'élève doit vérifier ou faire (attendus à relire, information non publiée à demander à l'établissement, journées portes ouvertes, élargir ses vœux…). Jamais de remarque sur CapSup ou sur ce bilan.
Réponds uniquement en JSON :
{"synthese": "3-4 phrases", "voies": [{"id": "…", "rang": 1, "ambition": "Ambitieux|Cohérent|Sécurité", "pourquoi": "2-3 phrases liées au profil", "points_vigilance": "…", "chiffres": "chiffres avec année et source"}], "ordre_voeux": "équilibre de la liste (vœux non classés)", "lacunes": "points à vérifier de ton côté", "calendrier": "dates de la session visée uniquement (voir règle Session)", "sources_web": [{"titre": "…", "url": "https://…"}], "autres_pistes": [{"id": "…", "raison": "…"}, {"nom": "…", "etablissement": "…", "url": "https://…", "raison": "…"}]}
"sources_web" : uniquement des pages réellement consultées par ta recherche ; liste vide si aucune.
"autres_pistes" : 3 à 8 pistes intéressantes mais non détaillées, différentes des voies classées, chacune en une phrase liée au profil ("raison"). Formation analysée par CapSup : {"id": "…", "raison": "…"}, avec un id de AUTRES FORMATIONS DU CATALOGUE ou de FICHES. Autre formation (trouvée par ta recherche web, par exemple une formation de son académie) : {"nom": "…", "etablissement": "…", "url": "page consultée", "raison": "…"} ; jamais de formation hors catalogue sans page consultée. Pas de chiffre dans "raison" sauf s'il figure dans la ligne d'index, la fiche ou une page citée.
Entre 5 et 8 voies, classées. Ta réponse finale est uniquement ce JSON.`;

// ---------- Contrôle ----------
const norm = s => String(s).replace(/[  \s]/g, "").replace(/,/g, ".");
const nombres = t => (String(t || "").match(/\d[\d\s  ]*(?:[.,]\d+)?/g) || []).map(x => norm(x).replace(/\.$/, "")).filter(Boolean);
const RE_MOIS = "janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre";

// Identifiant mal recopié par l'IA (ex. « double-licence-droit-eco-assas » pour « double-licence-droit-eco-gestion-assas ») :
// rattaché à l'identifiant existant quand un seul candidat convient (mêmes mots en plus ou en moins, sinon ≤ 3 caractères d'écart).
const motsId = s => String(s || "").toLowerCase().split(/[-_\s]+/).filter(Boolean);
function ecart(a, b) {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let p = d[0]; d[0] = i;
    for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, p + (a[i - 1] === b[j - 1] ? 0 : 1)); p = t; }
  }
  return d[b.length];
}
function idProche(id, ids) {
  if (!id || ids.includes(id)) return id || null;
  const m = motsId(id);
  // mots omis par l'IA (l'id existant contient tous les mots de l'id fautif) ou un seul mot ajouté ; ambigu → écart de caractères
  const inclus = ids.filter(i => { const n = motsId(i); return m.every(x => n.includes(x)) || (n.every(x => m.includes(x)) && m.length - n.length <= 1); });
  if (inclus.length === 1) return inclus[0];
  const proches = (inclus.length ? inclus : ids).map(i => [i, ecart(id, i)]).filter(([, x]) => x <= 3).sort((a, b) => a[1] - b[1]);
  return proches.length && (proches.length === 1 || proches[1][1] > proches[0][1]) ? proches[0][0] : null;
}
// Corrige les id des voies et des autres pistes. Une voie rattachée à une formation du catalogue absente des fiches
// fournies ajoute sa fiche (pour que ses chiffres soient contrôlés et qu'elle s'affiche).
function reparerIds(bilan, cat, fiches, pistes) {
  const corr = [];
  if (!bilan) return corr;
  const idsCat = cat.map(e => e.id);
  for (const v of Array.isArray(bilan.voies) ? bilan.voies : []) {
    if (!v || fiches.some(f => f.id === v.id)) continue;
    const ok = idProche(v.id, fiches.map(f => f.id)) || idProche(v.id, idsCat);
    if (!ok) continue;
    if (!fiches.some(f => f.id === ok)) fiches.push(ficheCompacte(cat.find(e => e.id === ok)));
    corr.push(v.id + " → " + ok); v.id = ok;
  }
  const permis = [...pistes.ids, ...fiches.map(f => f.id)];
  for (const a of Array.isArray(bilan.autres_pistes) ? bilan.autres_pistes : []) {
    if (!a || !a.id || permis.includes(a.id)) continue;
    const ok = idProche(a.id, permis);
    if (ok) { corr.push(a.id + " → " + ok); a.id = ok; }
  }
  return corr;
}
// « Autres pistes » : un chiffre doit figurer dans la ligne d'index, une fiche, le profil, le contexte ou un extrait cité
// d'une page consultée. Sinon il est retiré avant l'envoi (parenthèse qui le contient, sinon la phrase) ;
// une piste dont il ne reste rien est supprimée.
function retirerChiffresNonSources(bilan, fiches, profil, ctx, pistes) {
  const retires = [];
  if (!bilan || !Array.isArray(bilan.autres_pistes)) return retires;
  const prof = norm(JSON.stringify(profil) + REPERES_TECHNO + ctx.texte + web.cites.join(" ")), tout = norm(JSON.stringify(fiches) + pistes.index);
  const source = x => tout.includes(x) || prof.includes(x);
  const douteux = t => nombres(t).filter(x => !source(x));
  bilan.autres_pistes = bilan.autres_pistes.filter(a => {
    if (!a || !String(a.raison || "").trim()) return true; // laissé au contrôle (« autre piste sans raison »)
    const bad = douteux(a.raison);
    if (!bad.length) return true;
    retires.push(...bad);
    let t = String(a.raison).replace(/\s*\([^()]*\)/g, p => douteux(p).length ? "" : p);
    t = t.split(/(?<=[.!?])\s+/).filter(s => !douteux(s).length).join(" ")
      .replace(/\s+([,.])/g, "$1").replace(/,\s*,/g, ",").replace(/\s{2,}/g, " ").trim();
    if (!t || t.length < 20) return false;
    a.raison = t;
    return true;
  });
  return retires;
}

function controleDates(bilan, ctx, pb) {
  if (!ctx.session) return;
  const S = ctx.session;
  for (const k of ["calendrier", "ordre_voeux"]) {
    const t = String(bilan[k] || "");
    for (const m of t.match(/\b20[2-3]\d\b/g) || []) {
      const a = Number(m);
      if (a !== S && a !== S - 1) pb.push(`${k} : année ${a} hors de la session visée (${S})`);
    }
    for (const m of t.matchAll(new RegExp("(" + RE_MOIS + ")\\s+(20[2-3]\\d)", "gi"))) {
      const mois = m[1].toLowerCase(), a = Number(m[2]);
      if (a === S - 1 && !/septembre|octobre|novembre|d[ée]cembre/.test(mois)) pb.push(`${k} : « ${m[0]} » appartient à une session antérieure`);
    }
    if (!ctx.officiel && new RegExp("\\b\\d{1,2}(er)?\\s+(" + RE_MOIS + ")", "i").test(t))
      pb.push(`${k} : date précise alors que le calendrier de la session ${S} n'est pas publié (mois seulement)`);
  }
  if (/(place|mets|classe|range|positionne)[^.]{0,40}(d['’]abord|en premier|en tête)/i.test(String(bilan.ordre_voeux || "")))
    pb.push("ordre_voeux : suggère un classement des vœux (les vœux Parcoursup ne sont pas classés)");
}
// Vocabulaire interne ou autocritique interdit dans le texte affiché à l'élève.
const INTERDITS = [
  [/\bfiches?\b(?!\s+(de\s+(la\s+)?formation\s+)?(sur\s+)?Parcoursup)/i, "« fiche »"],
  [/catalogue/i, "« catalogue »"], [/\bindex\b/i, "« index »"], [/base de donn[ée]es|nos donn[ée]es/i, "« nos données »"],
  [/pr[ée]s[ée]lection/i, "« présélection »"], [/\b(CONTEXTE|PROFIL)\b/, "terme interne"],
  [/\bIA\b|intelligence artificielle|automatiquement/i, "mention de l'IA"],
  [/nous n['’]avons pas (fait|effectu|trouv|pu)|ne permettent pas|non couvert|absente? de notre/i, "autocritique de CapSup"],
  [/mentions?\s+(de\s+|des\s+|avec\s+)?(f[ée]licitations|compliments|encouragements)/i, "« mention de félicitations » (avis du conseil de classe, pas une mention)"],
];
function controleTon(bilan, pb) {
  const champs = [["synthese", bilan.synthese], ["ordre_voeux", bilan.ordre_voeux], ["lacunes", bilan.lacunes], ["calendrier", bilan.calendrier]];
  for (const v of bilan.voies || []) champs.push([v.id, [v.pourquoi, v.points_vigilance].join(" ")]);
  for (const a of Array.isArray(bilan.autres_pistes) ? bilan.autres_pistes : []) if (a) champs.push(["autre piste", a.raison]);
  for (const [k, t] of champs) for (const [re, lib] of INTERDITS) if (re.test(String(t || ""))) pb.push(`${k} : ${lib} (vocabulaire interdit, réécrire comme un conseiller)`);
}
// Secteur : licence non sélective hors de l'académie de l'élève jamais « Sécurité » ; « Ambitieux » si plafond de
// non-résidents et sélectivité < 10 % ; une licence ou un BUT de son académie présent dans les fiches doit porter la sécurité.
const plafonne = f => /non[ -]r[ée]sidents?/i.test(JSON.stringify([f.conditions, f.procedure, f.selectivite_detail]));
const amb = v => String(v.ambition || "").toLowerCase();
function controleSecteur(bilan, parId, ctx, pb) {
  if (!ctx.academie) return;
  const voies = (bilan.voies || []).filter(v => parId[v.id]);
  for (const v of voies) {
    const f = parId[v.id];
    if (!nonSelective({ selectivityLabel: f.selectivite_libelle }) || !f.academie || f.academie === ctx.academie) continue;
    if (amb(v).startsWith("s")) pb.push(`${v.id} : licence non sélective de l'académie de ${f.academie}, hors du secteur de l'élève (académie de ${ctx.academie}) : jamais « Sécurité »`);
    else if (!amb(v).startsWith("amb") && plafonne(f) && f.selectivite_pct != null && f.selectivite_pct < 10)
      pb.push(`${v.id} : hors académie, plafond de non-résidents et sélectivité ${f.selectivite_pct} % (< 10 %) : à classer « Ambitieux »`);
  }
  const locale = Object.values(parId).some(f => f.academie === ctx.academie && (nonSelective({ selectivityLabel: f.selectivite_libelle }) || /BUT/.test(String(f.type || "")))
    && f.part_bacheliers_technologiques_admis_pct !== 0 || false);
  if (locale && !voies.some(v => amb(v).startsWith("s") && parId[v.id].academie === ctx.academie))
    pb.push(`aucune « Sécurité » dans l'académie de l'élève (${ctx.academie}) alors qu'une licence ou un BUT de son académie figure parmi les formations analysées : la classer en voie « Sécurité »`);
}
// Types de formation cochés (BUT, BTS) : présents dans une voie ou une autre piste.
function controleTypes(bilan, parId, pistes, profil, pb) {
  const obj = String(profil.objectifs_post_bac || "");
  const lignes = String(pistes.index || "").split("\n");
  const textes = (bilan.voies || []).map(v => parId[v.id] ? parId[v.id].type + " " + parId[v.id].nom : "")
    .concat((Array.isArray(bilan.autres_pistes) ? bilan.autres_pistes : []).filter(Boolean)
      .map(a => a.id ? (lignes.find(l => l.startsWith(a.id + " |")) || (parId[a.id] ? parId[a.id].type + " " + parId[a.id].nom : "")) : [a.nom, a.etablissement].join(" "))).join(" \n ");
  for (const [t, re] of [["BUT", /\bBUT\b|Bachelor universitaire de technologie/i], ["BTS", /\bBTS\b|brevet de technicien sup/i]])
    if (new RegExp("\\b" + t + "\\b", "i").test(obj) && !re.test(textes)) pb.push(`type « ${t} » coché par l'élève absent des voies et des autres pistes`);
}
function controler(bilan, fiches, profil, ctx, pistes = { ids: [], index: "" }) {
  const parId = Object.fromEntries(fiches.map(f => [f.id, f]));
  const prof = norm(JSON.stringify(profil) + REPERES_TECHNO + ctx.texte + web.cites.join(" ")), tout = norm(JSON.stringify(fiches) + pistes.index);
  const pb = []; let n = 0;
  controleDates(bilan, ctx, pb);
  controleTon(bilan, pb);
  const sw = Array.isArray(bilan.sources_web) ? bilan.sources_web : [];
  for (const s of sw) if (!s || !/^https?:\/\//.test(String(s.url || "")) || !web.urls.has(s.url)) pb.push(`source web non consultée : ${s && s.url}`);
  if (!Array.isArray(bilan.voies) || bilan.voies.length < 3) pb.push("moins de 3 voies");
  for (const v of bilan.voies || []) {
    const f = parId[v.id];
    if (!f) { pb.push(`formation « ${v.id} » absente des fiches`); continue; }
    const src = norm(JSON.stringify(f));
    for (const x of nombres([v.pourquoi, v.points_vigilance, v.chiffres].join(" "))) {
      n++; if (!src.includes(x) && !prof.includes(x)) pb.push(`${v.id} : « ${x} » absent de la fiche`);
    }
  }
  controleSecteur(bilan, parId, ctx, pb);
  controleTypes(bilan, parId, pistes, profil, pb);
  const voiesIds = new Set((bilan.voies || []).map(v => v.id));
  const permis = new Set([...pistes.ids, ...fiches.map(f => f.id)]);
  for (const a of Array.isArray(bilan.autres_pistes) ? bilan.autres_pistes : []) {
    if (!a || !String(a.raison || "").trim()) { pb.push("autre piste sans raison"); continue; }
    if (a.id) { if (!permis.has(a.id)) pb.push(`autre piste « ${a.id} » absente du catalogue fourni`); else if (voiesIds.has(a.id)) pb.push(`autre piste « ${a.id} » déjà classée`); }
    else if (!a.nom || !/^https?:\/\//.test(String(a.url || "")) || !web.urls.has(a.url)) pb.push(`autre piste hors catalogue sans page consultée : ${a.nom || "?"}`);
    for (const x of nombres(a.raison)) { n++; if (!tout.includes(x) && !prof.includes(x)) pb.push(`autre piste : « ${x} » absent des sources`); }
  }
  for (const k of ["synthese", "ordre_voeux", "lacunes", "calendrier"])
    for (const x of nombres(bilan[k])) { n++; if (!tout.includes(x) && !prof.includes(x)) pb.push(`${k} : « ${x} » absent des fiches`); }
  return { chiffres: n, problemes: pb };
}

// ---------- Email ----------
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// Lien vers la page du bilan sur le site : le contenu du bilan est compressé dans l'adresse (#bilan/…),
// il n'est stocké nulle part ailleurs.
function lienBilan(base, prenom, bilan) {
  const sw = (Array.isArray(bilan.sources_web) ? bilan.sources_web : [])
    .filter(s => s && /^https?:\/\//.test(String(s.url || "")) && web.urls.has(s.url)).slice(0, 12)
    .map(s => ({ t: String(s.titre || s.url).slice(0, 140), u: s.url }));
  const ap = (Array.isArray(bilan.autres_pistes) ? bilan.autres_pistes : []).filter(a => a && String(a.raison || "").trim()).slice(0, 8)
    .map(a => a.id ? { i: a.id, r: String(a.raison).slice(0, 400) }
      : (/^https?:\/\//.test(String(a.url || "")) && web.urls.has(a.url) && a.nom ? { n: String(a.nom).slice(0, 160), e: String(a.etablissement || "").slice(0, 160), u: a.url, r: String(a.raison).slice(0, 400) } : null))
    .filter(Boolean);
  const b = { synthese: bilan.synthese, ordre_voeux: bilan.ordre_voeux, lacunes: bilan.lacunes, calendrier: bilan.calendrier, sources_web: sw, autres_pistes: ap,
    voies: (bilan.voies || []).map(v => ({ id: v.id, rang: v.rang, ambition: v.ambition, pourquoi: v.pourquoi,
      points_vigilance: v.points_vigilance, chiffres: v.chiffres })) };
  const json = JSON.stringify({ v: 1, p: prenom, d: new Date().toISOString().slice(0, 10), b });
  return base.replace(/\/$/, "") + "/#bilan/" + deflateRawSync(Buffer.from(json, "utf8"), { level: 9 }).toString("base64url");
}

function emailHtml(prenom, bilan, fiches, lien) {
  const parId = Object.fromEntries(fiches.map(f => [f.id, f]));
  const voies = (bilan.voies || []).filter(v => parId[v.id]);
  const n = k => voies.filter(v => String(v.ambition || "").toLowerCase().startsWith(k)).length;
  const tuile = (val, lib, fond, coul) => `<td width="33%" style="padding:4px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${fond};border-radius:14px"><tr><td align="center" style="padding:14px 6px;font-family:Arial,sans-serif"><div style="font-size:26px;font-weight:bold;color:${coul};line-height:1.1">${val}</div><div style="font-size:12px;color:#5b6476;padding-top:2px">${lib}</div></td></tr></table></td>`;
  const bouton = `<table role="presentation" cellpadding="0" cellspacing="0" align="center"><tr><td style="background:#2B55E8;border-radius:12px"><a href="${esc(lien)}" style="display:inline-block;padding:15px 30px;font-family:Arial,sans-serif;font-size:16px;font-weight:bold;color:#ffffff;text-decoration:none">Lire mon bilan sur CapSup &rarr;</a></td></tr></table>`;
  const contenu = ["Tes " + voies.length + " formations classées, avec pour chacune pourquoi elle te correspond", "Les chiffres clés de chaque formation, avec leur année et leur source", "L'équilibre de ta liste de vœux", "Le calendrier et les points de vigilance"].concat((bilan.autres_pistes || []).length ? ["D'autres pistes à explorer"] : [])
    .map(t => `<tr><td width="26" valign="top" style="padding:5px 0;font-family:Arial,sans-serif;font-size:16px;color:#2B55E8">&#10003;</td><td style="padding:5px 0;font-family:Arial,sans-serif;font-size:14px;color:#1e232a">${esc(t)}</td></tr>`).join("");
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f8f5ee">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8f5ee"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
<tr><td style="padding:0 4px 16px;font-family:Arial,sans-serif;font-size:22px;font-weight:bold;color:#2B55E8">CapSup<span style="color:#FFB020">.</span></td></tr>
<tr><td style="background:#ffffff;border:1.5px solid #c9d4f6;border-radius:20px;padding:28px 24px">
<div style="font-family:Arial,sans-serif;font-size:12px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;color:#2B55E8">Ton bilan d'orientation</div>
<div style="font-family:Arial,sans-serif;font-size:26px;font-weight:bold;color:#1e232a;padding:6px 0 10px">${prenom ? esc(prenom) + ", ton" : "Ton"} bilan est prêt</div>
<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.55;color:#3d4452">Nous avons étudié tes réponses et sélectionné les formations qui correspondent le mieux à ton profil.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0 8px"><tr>${tuile(n("amb"), "ambitieuses", "#efeafd", "#5b21b6")}${tuile(voies.length - n("amb") - n("s"), "cohérentes", "#e8eefc", "#1e40af")}${tuile(n("s"), "de sécurité", "#fff4dc", "#92400e")}</tr></table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:14px 0 22px">${contenu}</table>
${bouton}
<div style="font-family:Arial,sans-serif;font-size:12px;color:#717680;text-align:center;padding-top:14px">Ce lien est personnel : il contient ton bilan. Garde cet email pour le retrouver.</div>
</td></tr>
<tr><td style="padding:18px 8px;font-family:Arial,sans-serif;font-size:12px;line-height:1.5;color:#717680;text-align:center">Une question ? Réponds simplement à cet email.<br>CapSup &middot; capsup.org</td></tr>
</table></td></tr></table></body></html>`;
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

  // Domaine sans serveur de messagerie (adresse mal saisie) : aucun appel à l'API, alerte à CapSup.
  let refusee = false;
  try { refusee = await adresseRefusee(email.split("@").pop()); } catch (e) { refusee = false; }
  if (refusee) {
    console.log("Bilan IA : domaine email sans messagerie, bilan non généré");
    try {
      await fetch(BILAN_SCRIPT_URL, { method: "POST", redirect: "follow", body: JSON.stringify({
        action: "brouillon", token: BILAN_TOKEN, id: String(id || ""), to: email, prenom, sujet: "", html: "", envoyer: false,
        rapport: "ADRESSE EMAIL INVALIDE : le domaine « " + email.split("@").pop() + " » ne reçoit pas d'emails. Aucun bilan généré, aucun appel à l'API. "
          + "Si l'élève a laissé un téléphone, il est dans Netlify > Forms > bilan." }) });
    } catch (e) { console.log("Bilan IA : alerte impossible", String(e)); }
    return;
  }

  // Limite par adresse email : le script répond « deja » si un bilan a été envoyé récemment à cette adresse
  // (il prévient alors l'élève). Toute autre réponse (ou erreur) laisse continuer.
  try {
    const v = await fetch(BILAN_SCRIPT_URL, { method: "POST", redirect: "follow",
      body: JSON.stringify({ action: "verifier", token: BILAN_TOKEN, to: email, prenom }) });
    const t = (await v.text()).trim();
    if (t === "deja") { console.log("Bilan IA : limite par adresse atteinte"); return; }
  } catch (e) { console.log("Bilan IA : vérification de limite impossible", String(e)); }

  let bilan = null, fiches = [], rapport = { chiffres: 0, problemes: [] }, erreur = null, ctx = null, pistes = { ids: [], index: "" };
  let ids_corriges = [], chiffres_retires = [];
  web.cites = []; web.urls = new Set();
  try {
    const { cat, calendrier } = await chargerCatalogue(URL || "https://capsup.org");
    for (const e of cat) e._acad = academieFiche(e);
    const acad = await academieEleve(data || {}, URL || "https://capsup.org");
    ctx = contexteDepuis(data || {}, calendrier, new Date(), cat, acad);
    const reg = regionEleve(data || {}, cat);
    const sel = await claude(SYS_SELECTION,
      "CONTEXTE :\n" + ctx.texte + "\n\nPROFIL :\n" + JSON.stringify(profil, null, 1) + "\n\nINDEX :\n" + cat.map(ligneIndex).join("\n"), 16000, MODELE_TRI, "étape 1 (présélection) : ");
    const ids = [...new Set((sel.ids || []).filter(i => cat.some(e => e.id === i)))].slice(0, 10);
    if (ids.length < 3) throw new Error("étape 1 : présélection insuffisante (" + ids.length + ")");
    // Compléments imposés par le code (indépendants du choix de l'IA)
    const deja = new Set(ids);
    for (const i of prepas(cat, data || {}, ctx, deja)) { ids.push(i); deja.add(i); }
    const sec = securites(cat, data || {}, ctx, deja);
    for (const i of sec.ajout) { ids.push(i); deja.add(i); }
    console.log("Bilan IA : présélection", ids.join(", "), "| région", reg || "aucune", "| académie", ctx.academie || "inconnue", "| session", ctx.session);
    fiches = ids.map(i => ficheCompacte(cat.find(e => e.id === i)));
    // pistes de l'étape 1, puis les options plus accessibles de la région non retenues (pour qu'aucune ne soit ignorée)
    const pistesIds = [...new Set([...(sel.pistes || []).slice(0, 8), ...sec.pool].filter(i => !deja.has(i) && cat.some(e => e.id === i)))].slice(0, 12);
    pistes = { ids: pistesIds, index: pistesIds.map(i => ligneIndex(cat.find(e => e.id === i))).join("\n") };
    const entree = "CONTEXTE :\n" + ctx.texte + "\n\nPROFIL :\n" + JSON.stringify(profil, null, 1) + "\n\nFICHES :\n" + JSON.stringify(fiches)
      + "\n\nAUTRES FORMATIONS DU CATALOGUE (pour \"autres_pistes\" ; une ligne : id | nom | établissement | ville | région | académie | type | domaine | sélectivité | frais | durée) :\n" + (pistes.index || "(aucune)")
      + "\n\n" + REPERES_TECHNO;
    bilan = await claude(SYS_BILAN, entree, 64000, MODELE, "étape 2 (rédaction) : ", [RECHERCHE_WEB]);
    ids_corriges.push(...reparerIds(bilan, cat, fiches, pistes));
    chiffres_retires.push(...retirerChiffresNonSources(bilan, fiches, profil, ctx, pistes));
    rapport = controler(bilan, fiches, profil, ctx, pistes);
    if (rapport.problemes.length) { // une seule nouvelle tentative, avec la liste des erreurs
      let b2 = null;
      try { b2 = await claude(SYS_BILAN, entree + "\n\nUne première version contenait ces problèmes : "
        + rapport.problemes.join(" ; ") + ". Corrige-les : chaque chiffre doit venir des fiches, de PROFIL, de CONTEXTE ou d'une page web citée ; respecte la règle Session, la règle des vœux et les règles « Ton et vocabulaire ».",
        64000, MODELE, "étape 2 bis (correction) : ", [RECHERCHE_WEB]); }
      catch (e) { console.log("Bilan IA : correction impossible, première version conservée", String(e.message || e)); }
      if (b2) {
        const c2 = reparerIds(b2, cat, fiches, pistes), x2 = retirerChiffresNonSources(b2, fiches, profil, ctx, pistes);
        const r2 = controler(b2, fiches, profil, ctx, pistes);
        if (r2.problemes.length <= rapport.problemes.length) { bilan = b2; rapport = r2; ids_corriges = c2; chiffres_retires = x2; } }
    }
  } catch (e) { erreur = String(e && e.message || e); console.log("Bilan IA : erreur", erreur); }

  const corps = {
    action: "brouillon", token: BILAN_TOKEN, id: String(id || ""), to: email, prenom,
    sujet: (prenom ? prenom + ", ton" : "Ton") + " bilan d'orientation CapSup est prêt",
    html: bilan && !erreur ? emailHtml(prenom || "", bilan, fiches, lienBilan(URL || "https://capsup.org", prenom || "", bilan)) : "",
    envoyer: !!(bilan && !erreur && !rapport.problemes.length), // envoi direct si le contrôle ne trouve rien
    rapport: erreur ? "ÉCHEC de la génération : " + erreur + ". Bilan à faire à la main."
      : (rapport.problemes.length ? "À VÉRIFIER : " + rapport.problemes.join(" ; ")
        : "Contrôle automatique : " + rapport.chiffres + " chiffres vérifiés, tous présents dans les fiches, le profil ou les pages web citées ("
          + ((bilan && bilan.sources_web) || []).length + " sources web).")
      + (ids_corriges.length ? " Identifiants corrigés automatiquement : " + ids_corriges.join(", ") + "." : "")
      + (chiffres_retires.length ? " Chiffres retirés des « autres pistes » faute de source citée : " + chiffres_retires.join(", ") + "." : "")
      + " Relire aussi les affirmations sans chiffre (lieux, procédures), que le contrôle ne vérifie pas.",
  };
  const r = await fetch(BILAN_SCRIPT_URL, { method: "POST", body: JSON.stringify(corps), redirect: "follow" });
  console.log("Bilan IA : script", r.status, (await r.text()).slice(0, 100));
};
