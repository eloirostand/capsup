// CapSup — liste des lycées pour le bilan (champ « Ton lycée »).
// Source : annuaire de l'éducation (data.education.gouv.fr, jeu « fr-en-annuaire-education »),
// tous les établissements de type « Lycée » ouverts (général, technologique, professionnel, agricole…).
// La liste est lue côté serveur : le navigateur du visiteur n'appelle que capsup.org.
// Réponse : {"source": …, "date": …, "l": [[nom, commune, code postal, 1 si privé]]}
import { gzipSync } from "node:zlib";

const URL_ANNUAIRE = "https://data.education.gouv.fr/api/explore/v2.1/catalog/datasets/fr-en-annuaire-education/exports/json"
  + "?select=nom_etablissement,statut_public_prive,nom_commune,code_postal"
  + "&where=" + encodeURIComponent('type_etablissement="Lycée" and etat="OUVERT"');
const DUREE_CACHE = 24 * 3600 * 1000;
let cache = null, cacheDate = 0;

async function charger() {
  if (cache && Date.now() - cacheDate < DUREE_CACHE) return cache;
  const r = await fetch(URL_ANNUAIRE, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error("annuaire " + r.status);
  const rows = await r.json();
  const vu = new Set(), l = [];
  for (const x of rows) {
    const nom = String(x.nom_etablissement || "").trim(), commune = String(x.nom_commune || "").trim();
    if (!nom || !commune) continue;
    const cle = (nom + "|" + commune).toLowerCase();
    if (vu.has(cle)) continue;
    vu.add(cle);
    l.push([nom, commune, String(x.code_postal || ""), /priv/i.test(x.statut_public_prive || "") ? 1 : 0]);
  }
  if (l.length < 100) throw new Error("annuaire : liste trop courte (" + l.length + ")");
  l.sort((a, b) => a[0].localeCompare(b[0], "fr") || a[1].localeCompare(b[1], "fr"));
  cache = JSON.stringify({ source: "Annuaire de l'éducation (data.education.gouv.fr)", date: new Date().toISOString().slice(0, 10), l });
  cacheDate = Date.now();
  return cache;
}

export const handler = async (event) => {
  try {
    const corps = await charger();
    const gz = /gzip/.test((event.headers || {})["accept-encoding"] || "");
    return {
      statusCode: 200,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=86400",
        ...(gz ? { "content-encoding": "gzip" } : {}) },
      body: gz ? gzipSync(Buffer.from(corps, "utf8")).toString("base64") : corps,
      isBase64Encoded: gz,
    };
  } catch (e) {
    console.log("Lycées : erreur", String(e && e.message || e));
    return { statusCode: 502, headers: { "content-type": "application/json" }, body: '{"erreur":"annuaire indisponible"}' };
  }
};
