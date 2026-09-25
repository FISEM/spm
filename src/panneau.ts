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
 * Ce qu'il permet **d'écrire** : poser une nouvelle valeur, et l'appliquer.
 * Écrire n'oblige pas à lire — on remplace une clé sans jamais afficher
 * l'ancienne, ce qui est exactement ce qu'on fait le jour d'une rotation.
 * L'application recrée les conteneurs à partir des images déjà construites :
 * changer une clé ne doit pas déclencher un build de plusieurs minutes sur une
 * machine qui fait tourner de la production.
 *
 * L'accès est protégé par un jeton (`~/.spm/panneau.token`, créé au premier
 * lancement) et l'écoute est sur 127.0.0.1 par défaut : pour y accéder depuis
 * l'extérieur, il faut le placer derrière Caddy, en connaissance de cause.
 *
 * Le jeton n'est dans l'adresse qu'une fois. À la première visite on le dépose
 * dans un cookie `HttpOnly` et on renvoie vers l'adresse propre : une adresse
 * qui porte un secret finit dans l'historique du navigateur, dans les favoris,
 * dans l'en-tête `Referer` de tout lien sortant, et dans le journal de tout ce
 * qui se trouve sur le chemin. Le cookie ne voyage pas ailleurs
 * (`SameSite=Strict`) et JavaScript ne peut pas le lire.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";

import { SPM_HOME } from "./registry";
import { lireCoffre, definir, ouEstUtilisee } from "./secrets";
import { envAppliquer, quiet } from "./core";

export const TOKEN_PATH = join(SPM_HOME, "panneau.token");
export const PORT_PAR_DEFAUT = 8140;

export function jeton(): string {
  if (!existsSync(TOKEN_PATH)) {
    writeFileSync(TOKEN_PATH, randomBytes(24).toString("base64url") + "\n", { mode: 0o600 });
  }
  return readFileSync(TOKEN_PATH, "utf8").trim();
}

export const COOKIE = "spm_panneau";

/** Ce qu'on refuse à toutes les réponses : être encadré ailleurs, laisser fuir
 *  l'adresse par `Referer`, ou être deviné par reniflage de type. */
const ENTETES = {
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
} as const;

function cookie(requete: Request, nom: string): string | null {
  const brut = requete.headers.get("cookie");
  if (!brut) return null;
  for (const morceau of brut.split(";")) {
    const [c, ...reste] = morceau.trim().split("=");
    if (c === nom) return decodeURIComponent(reste.join("="));
  }
  return null;
}

/** `Secure` seulement en HTTPS : en local, sur 127.0.0.1, il empêcherait le
 *  cookie d'être posé du tout, et le panneau redemanderait le jeton sans fin. */
function securise(requete: Request): boolean {
  const proto = requete.headers.get("x-forwarded-proto");
  return proto ? proto.split(",")[0].trim() === "https" : new URL(requete.url).protocol === "https:";
}

function poserCookie(valeur: string, https: boolean): string {
  return [
    `${COOKIE}=${encodeURIComponent(valeur)}`,
    "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=2592000",
    https ? "Secure" : "",
  ].filter(Boolean).join("; ");
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
  /** Renvoyé dans les formulaires : une écriture doit prouver qu'elle vient d'ici. */
  jeton: string;
  /** Le compte rendu de la dernière action, s'il y en a eu une. */
  avis?: { ok: boolean; texte: string };
}

/** L'inventaire complet, sans jamais déchiffrer une valeur. */
export function vue(jetonDuPanneau = "", avis?: { ok: boolean; texte: string }): VueDuCoffre {
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
    jeton: jetonDuPanneau,
    avis,
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

  const champ = (projet: string, cle: string, jeton: string) => `
    <form method="post" action="/definir" class="ligne-form">
      <input type="hidden" name="jeton" value="${echapper(jeton)}">
      <input type="hidden" name="projet" value="${echapper(projet)}">
      <input type="hidden" name="cle" value="${echapper(cle)}">
      <input type="password" name="valeur" placeholder="nouvelle valeur" autocomplete="off"
             spellcheck="false" required>
      <button type="submit">Enregistrer</button>
    </form>`;

  const projets = v.projets.map((p) => `
    <section>
      <h2>${echapper(p.nom)} <span class="compte">${p.variables.length}</span></h2>
      <table>
        ${p.variables.map((x) => `
          <tr>
            <td class="cle">${echapper(x.cle)}</td>
            <td class="date">${jours(x.modifie)}</td>
            <td class="partage">${x.partagee.length ? `aussi dans ${x.partagee.map(echapper).join(", ")}` : ""}</td>
          </tr>
          <tr class="edition"><td colspan="3">${champ(p.nom, x.cle, v.jeton)}</td></tr>`).join("")}
      </table>
      <details class="ajout">
        <summary>Ajouter une variable</summary>
        <form method="post" action="/definir" class="ligne-form">
          <input type="hidden" name="jeton" value="${echapper(v.jeton)}">
          <input type="hidden" name="projet" value="${echapper(p.nom)}">
          <input type="text" name="cle" placeholder="NOM_DE_LA_VARIABLE" autocomplete="off"
                 spellcheck="false" pattern="[A-Za-z_][A-Za-z0-9_]*" required>
          <input type="password" name="valeur" placeholder="valeur" autocomplete="off" required>
          <button type="submit">Enregistrer</button>
        </form>
      </details>
      <form method="post" action="/appliquer" class="appliquer">
        <input type="hidden" name="jeton" value="${echapper(v.jeton)}">
        <input type="hidden" name="projet" value="${echapper(p.nom)}">
        <button type="submit">Appliquer à ${echapper(p.nom)}</button>
        <span class="aide">écrit le .env et recrée les conteneurs — sans reconstruire</span>
      </form>
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
  .edition td { border-top: 0; padding-top: 0; padding-bottom: 12px; }
  .ligne-form { display: flex; gap: 6px; flex-wrap: wrap; }
  .ligne-form input { flex: 1 1 12rem; min-width: 0; background: #1b1e24; color: #e7e9ee;
                      border: 1px solid #333842; border-radius: 6px; padding: 7px 10px;
                      font: inherit; font-size: 13px; }
  .ligne-form button, .appliquer button { background: #1f6f4a; color: #fff; border: 0;
                      border-radius: 6px; padding: 7px 14px; font: inherit; font-size: 13px;
                      font-weight: 600; cursor: pointer; }
  .ligne-form button:hover, .appliquer button:hover { background: #248156; }
  .ajout { margin: 12px 0 0; }
  .ajout summary { cursor: pointer; color: #939aa8; font-size: 13px; padding: 4px 0; }
  .appliquer { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 14px; }
  .appliquer .aide { color: #6f7684; font-size: 12px; }
  .avis { border-radius: 8px; padding: 12px 16px; margin: 16px 0; }
  .avis.ok { background: #13291f; border: 1px solid #245c3e; }
  .avis.raté { background: #2a1616; border: 1px solid #5c2424; }
  footer { margin-top: 40px; color: #6f7684; font-size: 13px; border-top: 1px solid #23262d; padding-top: 16px; }
</style>
</head>
<body>
  <h1>Coffre spm</h1>
  <p class="sous-titre">${v.total} variable(s) dans ${v.projets.length} projet(s). Les valeurs ne s'affichent pas ici.</p>
  ${v.avis ? `<div class="avis ${v.avis.ok ? "ok" : "raté"}">${echapper(v.avis.texte)}</div>` : ""}
  ${alerte}
  ${projets || "<p>Le coffre est vide. <code>spm env import &lt;projet&gt;</code> pour reprendre un .env existant.</p>"}
  <footer>Pour lire une valeur : <code>spm env reveal &lt;projet&gt;</code>, sur la machine.</footer>
</body>
</html>`;
}

/**
 * Les deux seules écritures possibles.
 *
 * Pas de suppression depuis le panneau : effacer une variable casse un service
 * en silence, et ça ne se décide pas sur un écran de téléphone. `spm env
 * unset` reste sur la machine, là où on voit ce qu'on fait.
 */
async function agir(chemin: string, corps: FormData): Promise<{ ok: boolean; texte: string }> {
  const projet = String(corps.get("projet") ?? "").trim();
  const connus = new Set(Object.keys(lireCoffre().projets));

  if (chemin === "/definir") {
    const cle = String(corps.get("cle") ?? "").trim();
    const valeur = String(corps.get("valeur") ?? "");
    if (!projet || !cle) return { ok: false, texte: "projet ou variable manquant" };
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(cle)) {
      return { ok: false, texte: `nom de variable invalide : ${cle}` };
    }
    if (!valeur) return { ok: false, texte: "valeur vide — rien n'a été écrit" };
    try {
      definir(projet, { [cle]: valeur });
      return {
        ok: true,
        texte: `${cle} enregistrée pour ${projet}. Clique « Appliquer » pour que le service la prenne.`,
      };
    } catch (e) {
      return { ok: false, texte: `échec : ${(e as Error).message}` };
    }
  }

  if (chemin === "/appliquer") {
    if (!connus.has(projet)) return { ok: false, texte: `projet inconnu : ${projet}` };
    try {
      const r = await envAppliquer(projet, quiet);
      if (r && !r.ok) return { ok: false, texte: `${projet} : les conteneurs n'ont pas démarré correctement` };
      return { ok: true, texte: `${projet} : configuration appliquée, conteneurs recréés.` };
    } catch (e) {
      return { ok: false, texte: `échec : ${(e as Error).message}` };
    }
  }

  return { ok: false, texte: "action inconnue" };
}

/** Après une écriture, on renvoie la page entière : pas de rechargement qui
 *  rejouerait le formulaire si l'utilisateur appuie sur « actualiser ». */
function reponseApres(avis: { ok: boolean; texte: string }, jetonDuPanneau: string): Response {
  return new Response(page(vue(jetonDuPanneau, avis)), {
    status: avis.ok ? 200 : 400,
    headers: { "content-type": "text/html; charset=utf-8", ...ENTETES },
  });
}

export function servir(port = PORT_PAR_DEFAUT, hote = "127.0.0.1") {
  const attendu = jeton();

  const serveur = Bun.serve({
    port,
    hostname: hote,
    async fetch(requete) {
      const url = new URL(requete.url);
      const fourni = url.searchParams.get("jeton")
        ?? requete.headers.get("authorization")?.replace(/^Bearer\s+/i, "")
        ?? cookie(requete, COOKIE)
        ?? null;

      // Une écriture porte son jeton dans le corps du formulaire : le mettre
      // dans l'adresse le ferait figurer dans l'historique du navigateur et
      // dans le journal de tout ce qui se trouve sur le chemin.
      if (requete.method === "POST") {
        const corps = await requete.formData();
        const jetonDuFormulaire = String(corps.get("jeton") ?? "");
        if (!jetonValide(jetonDuFormulaire, attendu)) {
          return new Response("jeton invalide\n", { status: 403 });
        }
        return reponseApres(await agir(url.pathname, corps), attendu);
      }

      if (!jetonValide(fourni, attendu)) {
        return new Response("jeton requis : ajoute ?jeton=… à l'adresse\n", { status: 401 });
      }
      if (url.pathname === "/json") {
        // Le jeton ne part pas dans le JSON : il sert aux formulaires, pas aux
        // appelants qui l'ont déjà fourni pour arriver ici.
        const { jeton: _, ...sansJeton } = vue();
        return Response.json(sansJeton);
      }
      // Le jeton vient de l'adresse : on le range et on renvoie vers l'adresse
      // propre, pour qu'il n'y reste pas.
      if (url.searchParams.has("jeton")) {
        return new Response(null, {
          status: 303,
          headers: {
            location: url.pathname,
            "set-cookie": poserCookie(attendu, securise(requete)),
            ...ENTETES,
          },
        });
      }
      return new Response(page(vue(attendu)), {
        headers: { "content-type": "text/html; charset=utf-8", ...ENTETES },
      });
    },
  });

  return { serveur, url: `http://${hote}:${port}/?jeton=${attendu}` };
}
