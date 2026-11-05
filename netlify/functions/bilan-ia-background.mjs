// CapSup — génération du brouillon de bilan (fonction d'arrière-plan, 15 min max).
// 1. Lit le catalogue réel dans le bundle publié du site.
// 2. Étape 1 (IA) : choisit 8 à 14 fiches adaptées au profil, à partir d'un index court.
//    Le code ajoute ensuite au moins 2 formations moins sélectives (domaines et région de l'élève)
//    et, pour un élève de lycée privé en voie générale (moyenne ≥ 12), au moins 2 CPGE.
// 3. Étape 2 (IA) : rédige le bilan à partir de ces fiches, avec recherche web autorisée (sources citées),
//    pour la session Parcoursup calculée à partir de la classe (Première → année suivante).
// 4. Contrôle : chaque formation existe ; chaque chiffre figure dans sa fiche, les réponses, le contexte
//    ou un extrait cité d'une page web ; sources web réellement consultées ; dates de la bonne session.
// 5. Envoie le résultat au script Google Apps Script, qui crée un BROUILLON Gmail adressé à l'élève
//    (rien n'est envoyé à l'élève sans relecture) et prévient CapSup.
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";

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

// ---------- Contexte calculé (session visée, priorités) ----------
const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const dateFr = d => { const [a, m, j] = String(d).split("-").map(Number); return (j === 1 ? "1er" : j) + " " + MOIS[m - 1] + " " + a; };
function contexteDepuis(data, calendrier, maintenant = new Date()) {
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
  const prepa = prive && voie === "generale" && !moyenneFaible;
  if (prepa) lignes.push("PRÉPA PRIORITAIRE : oui (lycée privé, voie générale, moyenne d'au moins 12).");
  return { session, officiel, voie, enFrance, prepa, texte: lignes.join("\n") };
}

// ---------- Compléments imposés à la présélection ----------
const domainesEleve = data => String(data.domaines || "").split(/[,;]\s*/).map(s => s.trim()).filter(Boolean);
const regionEleve = (data, cat) => cat.some(e => e.region === data.localisation) ? data.localisation : null;
const compatible = (e, ctx) => ctx.voie !== "techno" || e.bacTechnoPct !== 0;
// Au moins 2 formations nettement moins sélectives des domaines et de la région de l'élève.
// « Moins sélective » = licence marquée non sélective (capacité limitée) ou sélectivité (places ÷ candidats) ≥ 5 %.
// Les CPGE sont traitées à part (toutes autour de 1 à 3 % : la sélectivité ne les distingue pas).
const nonSelective = e => /non s[ée]lective/i.test(String(e.selectivityLabel || ""));
function securites(cat, data, ctx, deja) {
  const reg = regionEleve(data, cat), doms = domainesEleve(data);
  const pools = doms.map(d => cat.filter(e => e.domain === d && e.category !== "cpge" && (!reg || e.region === reg) && compatible(e, ctx)
      && (nonSelective(e) || (e.selectivityRate != null && e.selectivityRate >= 5)))
    .sort((a, b) => (nonSelective(b) - nonSelective(a)) || ((b.selectivityRate || 0) - (a.selectivityRate || 0))).slice(0, 3));
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
  return [e.id, e.name, e.university, e.city, e.region, e.categoryLabel, e.domain,
    e.selectivityRate != null ? e.selectivityRate + " %" : "?", e.feesDisplay || "?", e.durationLabel || "",
    e.bacTechnoPct != null ? "bac techno admis " + e.bacTechnoPct + " %" : "bac techno admis ?"].join(" | ");
}

const court = t => t; // pas de coupe : textes complets (décision d'Eloi, 04/11)
function ficheCompacte(e) {
  const L = e.legacy || {};
  const F = L.fiabilite || {};
  return {
    id: e.id, nom: e.name, etablissement: e.university, ville: e.city, region: e.region,
    type: e.categoryLabel, domaine: e.domain, duree: e.durationLabel,
    places: e.capacity, candidats: e.applicantsCount,
    selectivite_pct: e.selectivityRate, selectivite_libelle: e.selectivityLabel,
    selectivite_detail: court(L.taux_acces), selectivite_source: F.taux_acces,
    frais: e.feesDisplay, frais_detail: court(L.frais_scolarite), frais_source: F.frais_scolarite, cout_total: court(L.cout_total_estime),
    parcoursup: L.parcoursup, selection: court(L.selection),
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
Ces repères ne désignent aucune formation précise du catalogue : ne les présente pas comme des fiches CapSup.`;
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
Tu reçois son PROFIL et l'INDEX du catalogue (une ligne par formation : id | nom | établissement | ville | région | type | domaine | sélectivité = places ÷ candidats | frais | durée).
Le champ « bac techno admis » indique la part de bacheliers technologiques parmi les admis quand la fiche la renseigne.
Si l'élève est en voie technologique (type_lycee / serie_bac) : privilégie les formations qui admettent des bacheliers technologiques (BUT, BTS, part « bac techno admis » supérieure à 0 %) et en lien avec sa série ; n'inclus une formation à 0 % de bacheliers technologiques admis (CPGE ECG, B/L, scientifiques, CPES… réservées au bac général d'après leurs fiches) que si l'élève la vise explicitement.
Choisis 8 à 10 formations pertinentes : domaine et objectifs de l'élève, contraintes de budget et de mobilité, et un mélange de vœux ambitieux et plus accessibles quand le catalogue le permet. Inclus les établissements que l'élève vise s'ils sont dans l'index. Au plus 3 CPGE ECG, de lycées différents. Évite de choisir plusieurs formations quasi identiques.
Inclus au moins 2 formations nettement moins sélectives (sélectivité plus élevée) dans les domaines et la région de l'élève : une prépa, une licence, une double licence ou un BUT qui mène vers son objectif compte, même si ce n'est pas un diplôme à Bac+5 direct.
Si CONTEXTE indique « PRÉPA PRIORITAIRE : oui », inclus au moins 2 CPGE correspondant à ses domaines (scientifiques pour l'ingénierie ou l'informatique, ECG pour le commerce, B/L ou D2 pour l'économie), de préférence dans sa région et de sélectivités différentes.
Réponds uniquement en JSON : {"ids": ["id1", "id2", …]}`;

const SYS_BILAN = `Tu rédiges le bilan d'orientation d'un lycéen pour CapSup. Tu reçois CONTEXTE (date, session Parcoursup visée, calendrier, priorités calculées), PROFIL (ses réponses au formulaire) et FICHES (formations présélectionnées du catalogue CapSup, en JSON).
Règles absolues :
- Tu ne recommandes QUE des formations présentes dans FICHES, identifiées par leur id exact.
- Chiffres (places, candidats, sélectivité, frais, pourcentages, dates, années) : uniquement ceux de la fiche concernée, de PROFIL, de CONTEXTE, ou d'une page trouvée par ta recherche web et citée. Pas de chiffre calculé par toi (pas de somme, pas d'arrondi). Chaque chiffre est accompagné de son année et de sa source.
- Recherche web : tu peux et tu es encouragé à chercher des informations utiles absentes des fiches ou plus récentes (procédures, attendus, dates de la session visée, niveau des admis, débouchés, formations proches). Priorité aux sources officielles (parcoursup.gouv.fr, onisep.fr, sites des établissements, service-public.fr, enseignementsup-recherche.gouv.fr) ; une source secondaire (presse, classements) est signalée comme telle. Toute information hors fiche indique dans le texte sa source (nom du site) et son année, et chaque page utilisée figure dans "sources_web". Si une page contredit une fiche, signale la contradiction et indique ce que tu retiens. N'écris jamais dans une requête de recherche le prénom, l'email, le lycée ou d'autres informations personnelles de l'élève.
- Sans fiche ni source web citée, n'affirme aucun fait (lieu, école, procédure, débouché), même s'il te semble vrai. Si une fiche marque un chiffre « à confirmer », garde cette mention.
- Tu ne donnes jamais de probabilité d'admission chiffrée. Le niveau d'ambition est qualitatif : "Ambitieux", "Cohérent" ou "Sécurité", justifié par la fiche. Si la fiche ne donne pas le niveau des admis, dis-le.
- Sécurité : classe en « Sécurité » au moins une formation quand FICHES en contient une adaptée (moins sélective, dans ses domaines, accessible avec son profil). Une prépa, une licence, une double licence ou un BUT qui mène à son objectif (par exemple une école d'ingénieurs par concours ou admission parallèle) compte comme voie vers cet objectif, même sans Bac+5 direct. Ne classe pas en « Sécurité » une formation à l'étranger ni une formation dont l'élève ne remplit pas une condition (langue, spécialité). Ne déclare dans "lacunes" l'absence d'option de sécurité qu'après avoir examiné toutes les FICHES.
- PRÉPA PRIORITAIRE : si CONTEXTE l'indique, place au moins 2 CPGE de FICHES correspondant à ses domaines aux premiers rangs (rangs 1 à 3).
- Session : les dates de candidature concernent uniquement la SESSION VISÉE de CONTEXTE. N'écris aucune date d'une session passée ou d'une autre session, même si elle figure dans une fiche ou sur une page web : une fiche datée d'une autre session ne sert pas pour le calendrier. S'il existe un CALENDRIER OFFICIEL dans CONTEXTE, utilise-le (avec sa source). Sinon, indique seulement les mois habituels (par exemple « vœux de mi-janvier à mi-mars », « réponses à partir de début juin »), sans jour ni année, en précisant qu'ils sont à revérifier quand le calendrier officiel de sa session sera publié. Pour les candidatures hors Parcoursup, même règle. Si l'élève est en Première, dis-le dans la synthèse (il candidatera l'année suivante).
- Langues : si l'élève est scolarisé en France, ne mentionne pas les conditions de langue destinées aux candidats étrangers ou non francophones (niveau de français, DELF/DALF, TCF…).
- Vœux Parcoursup : ils ne sont pas classés par ordre de préférence. Dans "ordre_voeux", décris l'équilibre de la liste (part d'ambitieux, de cohérents et de sécurités, formations hors Parcoursup à part) et rappelle explicitement que les vœux ne sont pas classés ; ne dis jamais de placer un vœu « d'abord », « en premier » ou « en tête ».
- La sélectivité est « places ÷ candidats ». N'emploie jamais « taux d'accès » et ne parle pas de propositions comme d'un taux d'accès.
- Donnée absente : « Donnée non disponible ». Si le catalogue ne contient pas de formation adaptée à un besoin de l'élève, dis-le explicitement dans "lacunes" au lieu de forcer un substitut.
- Ne favorise aucune voie par principe. Tutoie l'élève, parle au nom de CapSup (« nous », jamais « je »). Une CPGE ECG est en « lycée public ou privé sous contrat ».
- Voie technologique : si PROFIL indique la voie technologique (type_lycee, serie_bac, spécialités de sa série), vérifie pour chaque formation dans la fiche (conditions, profil attendu, spécialités recommandées, part de bacheliers technologiques admis) qu'elle est accessible à sa série ; si une fiche réserve la formation au bac général, ne la recommande pas, ou seulement si l'élève la vise explicitement, en le signalant dans "points_vigilance". Tu peux t'appuyer sur REPÈRES (voie technologique) pour les généralités (taux minimal de bacheliers technologiques en BUT, prépas ECT, TSI, TPC, TB) en citant leur source ; si une voie pensée pour sa série manque au catalogue, dis-le dans "lacunes".
- N'applique pas aux bacheliers technologiques les attentes de spécialités de la voie générale (ex. « spécialité maths ») : compare plutôt avec ses spécialités de série et ses notes.
- Phrases courtes et concrètes, sans flatterie.
Réponds uniquement en JSON :
{"synthese": "3-4 phrases", "voies": [{"id": "…", "rang": 1, "ambition": "Ambitieux|Cohérent|Sécurité", "pourquoi": "2-3 phrases liées au profil", "points_vigilance": "…", "chiffres": "chiffres avec année et source"}], "ordre_voeux": "équilibre de la liste (vœux non classés)", "lacunes": "…", "calendrier": "dates de la session visée uniquement (voir règle Session)", "sources_web": [{"titre": "…", "url": "https://…"}]}
"sources_web" : uniquement des pages réellement consultées par ta recherche ; liste vide si aucune.
Entre 5 et 8 voies, classées. Ta réponse finale est uniquement ce JSON.`;

// ---------- Contrôle ----------
const norm = s => String(s).replace(/[  \s]/g, "").replace(/,/g, ".");
const nombres = t => (String(t || "").match(/\d[\d\s  ]*(?:[.,]\d+)?/g) || []).map(x => norm(x).replace(/\.$/, "")).filter(Boolean);
const RE_MOIS = "janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre";
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
function controler(bilan, fiches, profil, ctx) {
  const parId = Object.fromEntries(fiches.map(f => [f.id, f]));
  const prof = norm(JSON.stringify(profil) + REPERES_TECHNO + ctx.texte + web.cites.join(" ")), tout = norm(JSON.stringify(fiches));
  const pb = []; let n = 0;
  controleDates(bilan, ctx, pb);
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
  const b = { synthese: bilan.synthese, ordre_voeux: bilan.ordre_voeux, lacunes: bilan.lacunes, calendrier: bilan.calendrier, sources_web: sw,
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
  const contenu = ["Tes " + voies.length + " formations classées, avec pour chacune pourquoi elle te correspond", "Les chiffres clés de chaque formation, avec leur année et leur source", "L'équilibre de ta liste de vœux", "Le calendrier et les points de vigilance"]
    .map(t => `<tr><td width="26" valign="top" style="padding:5px 0;font-family:Arial,sans-serif;font-size:16px;color:#2B55E8">&#10003;</td><td style="padding:5px 0;font-family:Arial,sans-serif;font-size:14px;color:#1e232a">${esc(t)}</td></tr>`).join("");
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f8f5ee">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8f5ee"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
<tr><td style="padding:0 4px 16px;font-family:Arial,sans-serif;font-size:22px;font-weight:bold;color:#2B55E8">CapSup<span style="color:#FFB020">.</span></td></tr>
<tr><td style="background:#ffffff;border:1.5px solid #c9d4f6;border-radius:20px;padding:28px 24px">
<div style="font-family:Arial,sans-serif;font-size:12px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;color:#2B55E8">Ton bilan d'orientation</div>
<div style="font-family:Arial,sans-serif;font-size:26px;font-weight:bold;color:#1e232a;padding:6px 0 10px">${prenom ? esc(prenom) + ", ton" : "Ton"} bilan est prêt</div>
<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.55;color:#3d4452">Nous avons étudié tes réponses et sélectionné dans notre catalogue les formations qui correspondent le mieux à ton profil.</div>
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

  // Limite par adresse email : le script répond « deja » si un bilan a été envoyé récemment à cette adresse
  // (il prévient alors l'élève). Toute autre réponse (ou erreur) laisse continuer.
  try {
    const v = await fetch(BILAN_SCRIPT_URL, { method: "POST", redirect: "follow",
      body: JSON.stringify({ action: "verifier", token: BILAN_TOKEN, to: email, prenom }) });
    const t = (await v.text()).trim();
    if (t === "deja") { console.log("Bilan IA : limite par adresse atteinte"); return; }
  } catch (e) { console.log("Bilan IA : vérification de limite impossible", String(e)); }

  let bilan = null, fiches = [], rapport = { chiffres: 0, problemes: [] }, erreur = null, ctx = null;
  web.cites = []; web.urls = new Set();
  try {
    const { cat, calendrier } = await chargerCatalogue(URL || "https://capsup.org");
    ctx = contexteDepuis(data || {}, calendrier);
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
    console.log("Bilan IA : présélection", ids.join(", "), "| région", reg || "aucune", "| session", ctx.session);
    fiches = ids.map(i => ficheCompacte(cat.find(e => e.id === i)));
    const entree = "CONTEXTE :\n" + ctx.texte + "\n\nPROFIL :\n" + JSON.stringify(profil, null, 1) + "\n\nFICHES :\n" + JSON.stringify(fiches)
      + "\n\n" + REPERES_TECHNO;
    bilan = await claude(SYS_BILAN, entree, 64000, MODELE, "étape 2 (rédaction) : ", [RECHERCHE_WEB]);
    rapport = controler(bilan, fiches, profil, ctx);
    if (rapport.problemes.length) { // une seule nouvelle tentative, avec la liste des erreurs
      let b2 = null;
      try { b2 = await claude(SYS_BILAN, entree + "\n\nUne première version contenait ces problèmes : "
        + rapport.problemes.join(" ; ") + ". Corrige-les : chaque chiffre doit venir des fiches, de PROFIL, de CONTEXTE ou d'une page web citée ; respecte la règle Session et la règle des vœux.",
        64000, MODELE, "étape 2 bis (correction) : ", [RECHERCHE_WEB]); }
      catch (e) { console.log("Bilan IA : correction impossible, première version conservée", String(e.message || e)); }
      if (b2) { const r2 = controler(b2, fiches, profil, ctx);
        if (r2.problemes.length <= rapport.problemes.length) { bilan = b2; rapport = r2; } }
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
      + " Relire aussi les affirmations sans chiffre (lieux, procédures), que le contrôle ne vérifie pas.",
  };
  const r = await fetch(BILAN_SCRIPT_URL, { method: "POST", body: JSON.stringify(corps), redirect: "follow" });
  console.log("Bilan IA : script", r.status, (await r.text()).slice(0, 100));
};
