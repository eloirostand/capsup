// CapSup — vérifie qu'un domaine d'adresse email peut recevoir des emails (serveur de messagerie déclaré dans le DNS).
// Appelée par le formulaire du bilan avec le seul domaine (?d=gmail.com) : l'adresse complète n'est ni reçue ni stockée.
// Réponse : {"ok": true|false}. En cas de doute (erreur DNS temporaire), ok = true pour ne jamais bloquer à tort.
import { resolveMx, resolve4, resolve6 } from "node:dns/promises";

export async function domaineRecoitEmails(domaine) {
  const d = String(domaine || "").trim().toLowerCase().replace(/\.$/, "");
  if (!/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(d)) return false;
  const absent = e => e && ["ENOTFOUND", "ENODATA", "NXDOMAIN"].includes(e.code);
  try {
    const mx = await resolveMx(d);
    // « MX nul » (RFC 7505) : le domaine déclare ne recevoir aucun email
    return mx.some(m => m.exchange && m.exchange !== ".");
  } catch (e) {
    if (!absent(e)) return true;
  }
  // Sans MX, un domaine qui a une adresse IP peut quand même recevoir des emails (RFC 5321, MX implicite)
  for (const f of [resolve4, resolve6]) {
    try { if ((await f(d)).length) return true; } catch (e) { if (!absent(e)) return true; }
  }
  return false;
}

// Résultat négatif confirmé seulement si le DNS fonctionne (un domaine de référence se résout) :
// une panne de résolution ne doit jamais faire refuser une adresse valide.
export async function adresseRefusee(domaine) {
  if (await domaineRecoitEmails(domaine)) return false;
  return await domaineRecoitEmails("gmail.com");
}

export const handler = async (event) => {
  const d = (event.queryStringParameters || {}).d || "";
  let ok = true;
  try { ok = !(await adresseRefusee(d)); } catch (e) { ok = true; }
  return {
    statusCode: 200,
    headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" },
    body: JSON.stringify({ ok }),
  };
};
