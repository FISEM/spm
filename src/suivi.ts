/**
 * Suivre une branche : pousser déclenche le déploiement.
 *
 * **Ce que ça doit produire.** Pousser du code et que ça parte, sans ouvrir
 * un terminal. Et savoir que c'est parti — un déploiement silencieux
 * obligerait à aller vérifier à la main, ce qui rendrait la fonctionnalité
 * inutile.
 *
 * **Ce que ça ne doit jamais produire.** Écraser du travail non commité.
 * Sur cette machine, le dossier d'un projet est aussi l'endroit où on
 * l'édite : un `git pull` par-dessus des modifications en cours détruirait
 * ce que personne n'a sauvegardé ailleurs. spm refuse alors, et le dit.
 *
 * **Scrutation, pas webhook.** Un webhook exige un port ouvert, une URL
 * publique et un secret partagé — trois choses à configurer et à protéger,
 * pour gagner quelques dizaines de secondes. Demander à git, toutes les
 * minutes, ne demande rien.
 *
 * Ce fichier ne décide que *quoi faire*. Il ne lance rien : c'est ce qui
 * permet de vérifier chaque cas sans dépôt ni réseau.
 */

import { SpmError, getProject, loadRegistry, updateProject } from "./registry";

/** L'état d'un dépôt, tel qu'on peut le lire avec git. */
export interface EtatDepot {
  /** Commit de la branche locale, ou "" si elle n'existe pas. */
  local: string;
  /** Commit de la même branche sur le distant, ou "" s'il est injoignable. */
  distant: string;
  /** Vrai si des modifications non commitées traînent dans le dossier. */
  sale: boolean;
  /** Vrai si `local` est un ancêtre de `distant` — donc si l'avance est directe. */
  avanceDirecte: boolean;
}

export type Verdict = "a-jour" | "deployer" | "refuse";

export interface Decision {
  verdict: Verdict;
  /** Pourquoi, en une phrase destinée à être lue — jamais un code. */
  raison: string;
}

/**
 * Ce qu'il faut faire d'un projet suivi.
 *
 * L'ordre des refus compte : on regarde d'abord ce qui pourrait détruire du
 * travail, ensuite seulement ce qui empêche d'avancer.
 */
export function decision(etat: EtatDepot): Decision {
  if (etat.sale) {
    return {
      verdict: "refuse",
      raison: "des modifications non commitées attendent dans le dossier — les écraser les perdrait",
    };
  }
  if (!etat.local) {
    return { verdict: "refuse", raison: "cette branche n'existe pas en local" };
  }
  if (!etat.distant) {
    return { verdict: "refuse", raison: "le distant est injoignable ou la branche n'y est pas" };
  }
  if (etat.local === etat.distant) {
    return { verdict: "a-jour", raison: "rien de neuf" };
  }
  if (!etat.avanceDirecte) {
    return {
      verdict: "refuse",
      raison: "le local a divergé du distant — il faut trancher à la main",
    };
  }
  return { verdict: "deployer", raison: `${etat.local.slice(0, 7)} → ${etat.distant.slice(0, 7)}` };
}

/** Un identifiant de branche acceptable. */
export function brancheValide(nom: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/.test(nom) && !nom.includes("..");
}

// ---------------------------------------------------------------- git

interface Sortie { code: number; out: string }

/** Lance git dans un dossier. Ne jette jamais sur un code non nul : c'est
 *  l'appelant qui décide si l'échec est une erreur ou une information. */
export async function git(dossier: string, args: string[]): Promise<Sortie> {
  let proc;
  try {
    proc = Bun.spawn(["git", "-C", dossier, ...args], { stdout: "pipe", stderr: "pipe" });
  } catch {
    throw new SpmError("git introuvable : installe-le et vérifie qu'il est dans le PATH");
  }
  const [out, err] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
  ]);
  return { code: await proc.exited, out: (out + err).trim() };
}

/** L'état d'un dépôt, lu sans rien modifier.
 *
 *  `fetch` met à jour la connaissance du distant sans toucher au dossier de
 *  travail : c'est la seule commande de cette fonction qui parle au réseau,
 *  et aucune ne change un fichier. */
export async function lireEtat(dossier: string, branche: string): Promise<EtatDepot> {
  await git(dossier, ["fetch", "--quiet", "origin", branche]);

  const local = (await git(dossier, ["rev-parse", "--verify", `refs/heads/${branche}`]));
  const distant = (await git(dossier, ["rev-parse", "--verify", `refs/remotes/origin/${branche}`]));
  const sale = (await git(dossier, ["status", "--porcelain"])).out !== "";

  const l = local.code === 0 ? local.out : "";
  const d = distant.code === 0 ? distant.out : "";
  // `merge-base --is-ancestor` répond par son code : 0 si l'avance est directe.
  const direct = l && d
    ? (await git(dossier, ["merge-base", "--is-ancestor", l, d])).code === 0
    : false;

  return { local: l, distant: d, sale, avanceDirecte: direct };
}

/** Avance la branche locale jusqu'au distant, sans fusion possible.
 *
 *  `--ff-only` plutôt que `pull` : si l'avance n'est pas directe, git refuse
 *  au lieu de fabriquer un commit de fusion que personne n'a demandé. */
export async function avancer(dossier: string, branche: string): Promise<Sortie> {
  return git(dossier, ["merge", "--ff-only", `refs/remotes/origin/${branche}`]);
}

// ------------------------------------------------------------ une passe

export interface Passe {
  nom: string;
  verdict: Verdict | "casse";
  raison: string;
}

/**
 * Une passe sur tous les projets suivis.
 *
 * Elle ne boucle pas : c'est une minuterie extérieure qui la rappelle. Un
 * processus qui dort en permanence serait une chose de plus à surveiller, et
 * il mourrait en silence.
 *
 * Elle rend ce qu'elle a fait, projet par projet — y compris « rien ». Un
 * déploiement silencieux obligerait à aller vérifier à la main.
 */
export async function passe(
  deployer: (nom: string) => Promise<{ ok: boolean; detail: string }>,
  seulementVoir = false,
): Promise<Passe[]> {
  // Le registre est une table nom → projet, pas une liste.
  const projets = Object.values(loadRegistry().projects).filter((p) => p.suivi?.branche);
  const resultats: Passe[] = [];

  for (const p of projets) {
    const branche = p.suivi!.branche;
    const etat = await lireEtat(p.path, branche);
    const { verdict, raison } = decision(etat);

    if (verdict !== "deployer" || seulementVoir) {
      resultats.push({ nom: p.name, verdict, raison });
      continue;
    }

    const avance = await avancer(p.path, branche);
    if (avance.code !== 0) {
      resultats.push({ nom: p.name, verdict: "casse", raison: `git a refusé d'avancer : ${avance.out}` });
      continue;
    }

    const r = await deployer(p.name);
    // La trace du dernier commit déployé est écrite quoi qu'il arrive : sans
    // elle, un échec serait rejoué à chaque passe, indéfiniment.
    updateProject(p.name, {
      suivi: { branche, dernier: etat.distant, le: new Date().toISOString() },
    });
    resultats.push({
      nom: p.name,
      verdict: r.ok ? "deployer" : "casse",
      raison: r.ok ? `déployé en ${etat.distant.slice(0, 7)}` : r.detail,
    });
  }

  return resultats;
}

/** Met un projet sous suivi, ou l'en retire. */
export function suivre(nom: string, branche: string | null) {
  const projet = getProject(loadRegistry(), nom);
  if (branche === null) {
    updateProject(nom, { suivi: undefined });
    return projet;
  }
  if (!brancheValide(branche)) throw new SpmError(`nom de branche invalide : ${branche}`);
  updateProject(nom, { suivi: { branche } });
  return projet;
}
