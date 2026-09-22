/**
 * Panneau web du coffre : `spm serve`.
 *
 * Ce qu'il montre : quels projets existent, quelles variables ils possèdent,
 * quand chacune a changé, et — la question qui compte le jour d'une rotation —
 * quelles variables sont partagées par plusieurs projets.
 *
 * Ce qu'il ne montre pas : les valeurs. Elles restent dans le coffre chiffré.
 * Un panneau sert à savoir *ce qu'on a* ; pour lire un secret il faut être sur
 * la machine, avec `spm env reveal`. C'est délibéré : un écran laissé ouvert,
 * une capture d'écran ou un historique de navigateur ne doivent pas suffire à
 * faire fuiter une clé d'API.
 *
 * L'accès est protégé par un jeton (`~/.spm/panneau.token`, créé au premier
 * lancement) et l'écoute est sur 127.0.0.1 par défaut : pour y accéder depuis
 * l'extérieur, il faut le placer derrière Caddy, en connaissance de cause.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";

import { SPM_HOME } from "./registry";
import { lireCoffre, ouEstUtilisee } from "./secrets";

export const TOKEN_PATH = join(SPM_HOME, "panneau.token");
export const PORT_PAR_DEFAUT = 8140;

export function jeton(): string {
  if (!existsSync(TOKEN_PATH)) {
    writeFileSync(TOKEN_PATH, randomBytes(24).toString("base64url") + "\n", { mode: 0o600 });
  }
  return readFileSync(TOKEN_PATH, "utf8").trim();
}

/** Comparaison à temps constant : un `===` laisse deviner le jeton caractère par caractère. */
function jetonValide(fourni: string | null, attendu: string): boolean {
  if (!fourni) return false;
  const a = Buffer.from(fourni);
  const b = Buffer.from(attendu);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface VueDuCoffre {
  projets: { nom: string; variables: { cle: string; modifie: string; partagee: string[] }[] }[];
  total: number;
  partagees: { cle: string; projets: string[] }[];
}

/** L'inventaire complet, sans jamais déchiffrer une valeur. */
export function vue(): VueDuCoffre {
  const coffre = lireCoffre();
  const projets = Object.entries(coffre.projets)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([nom, vars]) => ({
      nom,
      variables: Object.entries(vars)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([cle, v]) => ({
          cle,
          modifie: v.modifie,
          partagee: ouEstUtilisee(cle).filter((p) => p !== nom),
        })),
    }));

  const compte = new Map<string, string[]>();
  for (const { nom, variables } of projets) {
    for (const { cle } of variables) compte.set(cle, [...(compte.get(cle) ?? []), nom]);
  }

  return {
    projets,
    total: projets.reduce((n, p) => n + p.variables.length, 0),
    partagees: [...compte.entries()]
      .filter(([, p]) => p.length > 1)
      .map(([cle, projets]) => ({ cle, projets }))
      .sort((a, b) => a.cle.localeCompare(b.cle)),
  };
}

const echapper = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function page(v: VueDuCoffre): string {
  const jours = (iso: string) => {
    const n = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
    return n <= 0 ? "aujourd'hui" : n === 1 ? "hier" : `il y a ${n} jours`;
  };

  const projets = v.projets.map((p) => `
    <section>
      <h2>${echapper(p.nom)} <span class="compte">${p.variables.length}</span></h2>
      <table>
        ${p.variables.map((x) => `
          <tr>
            <td class="cle">${echapper(x.cle)}</td>
            <td class="date">${jours(x.modifie)}</td>
            <td class="partage">${x.partagee.length ? `aussi dans ${x.partagee.map(echapper).join(", ")}` : ""}</td>
          </tr>`).join("")}
      </table>
    </section>`).join("");

  const alerte = v.partagees.length ? `
    <div class="alerte">
      <strong>${v.partagees.length} variable(s) partagée(s) par plusieurs projets.</strong>
      Le jour où tu en fais tourner une, il faut la changer partout — sinon un
      service casse sans dire pourquoi.
      <ul>${v.partagees.map((p) => `<li><code>${echapper(p.cle)}</code> — ${p.projets.map(echapper).join(", ")}</li>`).join("")}</ul>
    </div>` : "";

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Coffre spm</title>
<style>
  :root { color-scheme: dark; }
  body { font: 15px/1.6 system-ui, sans-serif; max-width: 760px; margin: 0 auto; padding: 24px 16px 64px;
         background: #14161a; color: #e7e9ee; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sous-titre { color: #939aa8; margin: 0 0 28px; }
  h2 { font-size: 15px; margin: 28px 0 8px; display: flex; align-items: center; gap: 8px; }
  .compte { font-weight: 400; font-size: 12px; color: #939aa8; border: 1px solid #333842;
            border-radius: 999px; padding: 1px 8px; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 6px 0; border-top: 1px solid #23262d; vertical-align: top; }
  .cle { font-family: ui-monospace, monospace; font-size: 13px; }
  .date, .partage { color: #939aa8; font-size: 13px; text-align: right; white-space: nowrap; }
  .partage { text-align: right; }
  .alerte { background: #2a2113; border: 1px solid #5a4620; border-radius: 8px; padding: 12px 16px; margin: 20px 0; }
  .alerte ul { margin: 8px 0 0; padding-left: 20px; }
  code { font-family: ui-monospace, monospace; font-size: 13px; }
  footer { margin-top: 40px; color: #6f7684; font-size: 13px; border-top: 1px solid #23262d; padding-top: 16px; }
</style>
</head>
<body>
  <h1>Coffre spm</h1>
  <p class="sous-titre">${v.total} variable(s) dans ${v.projets.length} projet(s). Les valeurs ne s'affichent pas ici.</p>
  ${alerte}
  ${projets || "<p>Le coffre est vide. <code>spm env import &lt;projet&gt;</code> pour reprendre un .env existant.</p>"}
  <footer>Pour lire une valeur : <code>spm env reveal &lt;projet&gt;</code>, sur la machine.</footer>
</body>
</html>`;
}

export function servir(port = PORT_PAR_DEFAUT, hote = "127.0.0.1") {
  const attendu = jeton();

  const serveur = Bun.serve({
    port,
    hostname: hote,
    fetch(requete) {
      const url = new URL(requete.url);
      const fourni = url.searchParams.get("jeton")
        ?? requete.headers.get("authorization")?.replace(/^Bearer\s+/i, "")
        ?? null;

      if (!jetonValide(fourni, attendu)) {
        return new Response("jeton requis : ajoute ?jeton=… à l'adresse\n", { status: 401 });
      }
      if (url.pathname === "/json") {
        return Response.json(vue());
      }
      return new Response(page(vue()), { headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });

  return { serveur, url: `http://${hote}:${port}/?jeton=${attendu}` };
}
