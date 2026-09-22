/**
 * Coffre des variables d'environnement.
 *
 * Le problème qu'il règle : les secrets d'une machine finissent éparpillés dans
 * autant de fichiers `.env` qu'il y a de projets, sans inventaire, sans date de
 * modification, et parfois en double — la même clé recopiée dans deux projets,
 * dont un seul sera mis à jour le jour où on la fait tourner.
 *
 * Deux principes de conception :
 *
 * 1. **Les noms sont en clair, les valeurs sont chiffrées.** Savoir *que*
 *    `kira` possède une `ANTHROPIC_API_KEY` modifiée le 12 mars n'est pas un
 *    secret ; c'est même exactement ce qu'on veut voir d'un coup d'œil. Seule
 *    la valeur l'est. Un panneau peut donc afficher l'inventaire complet sans
 *    jamais toucher à la clé maîtresse.
 *
 * 2. **Le coffre n'est jamais une dépendance de démarrage.** spm écrit le
 *    `.env` du projet au moment du déploiement, puis s'efface. Si le coffre est
 *    illisible, c'est le prochain déploiement qui échoue — pas les services en
 *    cours d'exécution.
 *
 * La clé maîtresse vit dans `~/.spm/master.key`. La perdre rend les valeurs
 * irrécupérables : elle doit être sauvegardée avec les données.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SPM_HOME, SpmError } from "./registry";

export const SECRETS_PATH = join(SPM_HOME, "secrets.json");
export const MASTER_KEY_PATH = join(SPM_HOME, "master.key");

export interface Variable {
  /** `iv:tag:chiffré`, en base64. */
  valeur: string;
  /** Date ISO de la dernière écriture — en clair, c'est une information d'inventaire. */
  modifie: string;
}

export interface Coffre {
  version: 1;
  projets: Record<string, Record<string, Variable>>;
}

const COFFRE_VIDE: Coffre = { version: 1, projets: {} };

// ------------------------------------------------------------ clé maîtresse

/** Lit la clé maîtresse, ou en crée une à la première utilisation. */
export function cleMaitresse(): Buffer {
  if (!existsSync(MASTER_KEY_PATH)) {
    writeFileSync(MASTER_KEY_PATH, randomBytes(32).toString("base64") + "\n", { mode: 0o600 });
  }
  chmodSync(MASTER_KEY_PATH, 0o600); // au cas où elle aurait été copiée sans ses droits
  const cle = Buffer.from(readFileSync(MASTER_KEY_PATH, "utf8").trim(), "base64");
  if (cle.length !== 32) {
    throw new SpmError(`${MASTER_KEY_PATH} n'est pas une clé de 32 octets : coffre illisible`);
  }
  return cle;
}

export function chiffrer(texte: string, cle = cleMaitresse()): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", cle, iv);
  const chiffre = Buffer.concat([c.update(texte, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), chiffre].map((b) => b.toString("base64")).join(":");
}

export function dechiffrer(paquet: string, cle = cleMaitresse()): string {
  const [iv, tag, chiffre] = paquet.split(":").map((p) => Buffer.from(p, "base64"));
  if (!iv || !tag || !chiffre) throw new SpmError("valeur chiffrée illisible");
  const d = createDecipheriv("aes-256-gcm", cle, iv);
  d.setAuthTag(tag);
  // GCM authentifie : une valeur modifiée à la main dans secrets.json lève ici
  // plutôt que de produire silencieusement n'importe quoi.
  return Buffer.concat([d.update(chiffre), d.final()]).toString("utf8");
}

// ------------------------------------------------------------------- coffre

export function lireCoffre(): Coffre {
  if (!existsSync(SECRETS_PATH)) return structuredClone(COFFRE_VIDE);
  try {
    const lu = JSON.parse(readFileSync(SECRETS_PATH, "utf8")) as Coffre;
    return lu.projets ? lu : structuredClone(COFFRE_VIDE);
  } catch {
    throw new SpmError(`${SECRETS_PATH} est illisible (JSON invalide) — ne pas l'écraser, le réparer`);
  }
}

export function ecrireCoffre(coffre: Coffre) {
  // Écriture atomique : une coupure au mauvais moment ne doit pas laisser un
  // coffre tronqué, c'est-à-dire tous les secrets perdus d'un coup.
  const temporaire = `${SECRETS_PATH}.tmp`;
  writeFileSync(temporaire, JSON.stringify(coffre, null, 2) + "\n", { mode: 0o600 });
  renameSync(temporaire, SECRETS_PATH);
  chmodSync(SECRETS_PATH, 0o600);
}

// ------------------------------------------------------------------ lecture

/** L'inventaire d'un projet : noms et dates, sans déchiffrer quoi que ce soit. */
export function inventaire(projet: string): { cle: string; modifie: string }[] {
  const vars = lireCoffre().projets[projet] ?? {};
  return Object.entries(vars)
    .map(([cle, v]) => ({ cle, modifie: v.modifie }))
    .sort((a, b) => a.cle.localeCompare(b.cle));
}

/** Les valeurs en clair. N'appeler que pour écrire un `.env` ou révéler une clé. */
export function valeurs(projet: string): Record<string, string> {
  const vars = lireCoffre().projets[projet] ?? {};
  const cle = cleMaitresse();
  return Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, dechiffrer(v.valeur, cle)]));
}

/** Quels projets utilisent une variable de ce nom — la question que pose une rotation. */
export function ouEstUtilisee(nomDeLaVariable: string): string[] {
  const coffre = lireCoffre();
  return Object.entries(coffre.projets)
    .filter(([, vars]) => nomDeLaVariable in vars)
    .map(([projet]) => projet)
    .sort();
}

// ------------------------------------------------------------------ écriture

export function definir(projet: string, vars: Record<string, string>): number {
  if (!Object.keys(vars).length) return 0;
  const coffre = lireCoffre();
  const cle = cleMaitresse();
  const existant = coffre.projets[projet] ?? {};
  const maintenant = new Date().toISOString();
  for (const [k, v] of Object.entries(vars)) {
    // Réécrire une variable à l'identique ne doit pas rajeunir sa date : la
    // date sert à savoir quand un secret a vraiment changé.
    const inchange = existant[k] && dechiffrer(existant[k].valeur, cle) === v;
    if (inchange) continue;
    existant[k] = { valeur: chiffrer(v, cle), modifie: maintenant };
  }
  coffre.projets[projet] = existant;
  ecrireCoffre(coffre);
  return Object.keys(vars).length;
}

export function supprimer(projet: string, cles: string[]): string[] {
  const coffre = lireCoffre();
  const vars = coffre.projets[projet];
  if (!vars) return [];
  const retirees = cles.filter((c) => c in vars);
  for (const c of retirees) delete vars[c];
  if (!Object.keys(vars).length) delete coffre.projets[projet];
  ecrireCoffre(coffre);
  return retirees;
}

export function projets(): string[] {
  return Object.keys(lireCoffre().projets).sort();
}

// -------------------------------------------------------------------- .env

/**
 * Lit un fichier `.env`. Volontairement simple : `CLE=valeur`, les guillemets
 * qui entourent toute la valeur sont retirés, les commentaires et les lignes
 * vides sont ignorés. `export CLE=valeur` est accepté parce que c'est courant.
 *
 * Ce qui n'est **pas** géré : les valeurs sur plusieurs lignes. Un `.env` qui
 * en contient doit être repris à la main — mieux vaut refuser clairement que
 * tronquer un certificat en silence.
 */
export function lireDotEnv(contenu: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const ligne of contenu.split("\n")) {
    const nette = ligne.trim();
    if (!nette || nette.startsWith("#")) continue;
    const sansExport = nette.startsWith("export ") ? nette.slice(7).trim() : nette;
    const egal = sansExport.indexOf("=");
    if (egal <= 0) continue;
    const cle = sansExport.slice(0, egal).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(cle)) continue;
    let valeur = sansExport.slice(egal + 1).trim();
    if (valeur.length >= 2 && ((valeur.startsWith('"') && valeur.endsWith('"')) || (valeur.startsWith("'") && valeur.endsWith("'")))) {
      valeur = valeur.slice(1, -1);
    }
    vars[cle] = valeur;
  }
  return vars;
}

/**
 * Fabrique le contenu d'un `.env` en fusionnant l'existant et le coffre.
 *
 * La fusion n'est pas un confort, c'est une protection : un projet peut avoir
 * dans son `.env` des variables qui ne sont pas encore dans le coffre. Les
 * écraser au premier déploiement effacerait des secrets que personne n'a
 * ailleurs. Le coffre est prioritaire sur les clés qu'il connaît, et ne touche
 * jamais aux autres.
 */
export function fusionnerDotEnv(existant: string, duCoffre: Record<string, string>): string {
  const vus = new Set<string>();
  const lignes = existant.split("\n").map((ligne) => {
    const nette = ligne.trim();
    if (!nette || nette.startsWith("#")) return ligne;
    const egal = nette.indexOf("=");
    if (egal <= 0) return ligne;
    const cle = nette.slice(0, egal).trim().replace(/^export\s+/, "");
    if (!(cle in duCoffre)) return ligne;
    vus.add(cle);
    return `${cle}=${duCoffre[cle]}`;
  });

  const nouvelles = Object.entries(duCoffre).filter(([k]) => !vus.has(k));
  if (nouvelles.length) {
    if (lignes.at(-1)?.trim()) lignes.push("");
    lignes.push("# Ajouté par spm depuis le coffre");
    for (const [k, v] of nouvelles) lignes.push(`${k}=${v}`);
  }
  return lignes.join("\n").replace(/\n*$/, "\n");
}
