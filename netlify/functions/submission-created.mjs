// CapSup — déclenché par Netlify à chaque soumission vérifiée d'un formulaire.
// Pour le formulaire « bilan », lance la génération du brouillon de bilan en arrière-plan.
// Sans les variables d'environnement ANTHROPIC_API_KEY, BILAN_SCRIPT_URL et BILAN_TOKEN, ne fait rien.
import { createHash } from "node:crypto";

export const handler = async (event) => {
  try {
    const payload = JSON.parse(event.body || "{}").payload || {};
    const form = payload.form_name || (payload.data && payload.data["form-name"]);
    if (form !== "bilan") return { statusCode: 200, body: "ignoré" };
    const { ANTHROPIC_API_KEY, BILAN_SCRIPT_URL, BILAN_TOKEN, URL } = process.env;
    if (!ANTHROPIC_API_KEY || !BILAN_SCRIPT_URL || !BILAN_TOKEN) {
      console.log("Bilan IA : variables d'environnement absentes, rien n'est généré.");
      return { statusCode: 200, body: "non configuré" };
    }
    const cle = createHash("sha256").update("capsup:" + ANTHROPIC_API_KEY).digest("hex");
    const r = await fetch(`${URL}/.netlify/functions/bilan-ia-background`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-capsup-cle": cle },
      body: JSON.stringify({ id: payload.id || payload.number || Date.now().toString(), data: payload.data || {} }),
    });
    console.log("Bilan IA lancé :", r.status);
  } catch (e) {
    console.log("Bilan IA : échec du lancement", e && e.message);
  }
  return { statusCode: 200, body: "ok" };
};
