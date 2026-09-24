/**
 * Ce que spm décide d'un projet suivi.
 *
 * Ces tests portent d'abord sur les refus : un déploiement qu'on rate se
 * relance, du travail non commité qu'on écrase ne se récupère pas.
 */
import { describe, expect, test } from "bun:test";

import { brancheValide, decision } from "../src/suivi";

const etat = (p: Partial<Parameters<typeof decision>[0]> = {}) => ({
  local: "aaaaaaa1", distant: "aaaaaaa1", sale: false, avanceDirecte: true, ...p,
});

describe("ce qui déclenche un déploiement", () => {
  test("le distant a avancé : on déploie", () => {
    const d = decision(etat({ local: "aaaaaaa1", distant: "bbbbbbb2" }));
    expect(d.verdict).toBe("deployer");
    expect(d.raison).toContain("aaaaaaa");
  });

  test("rien n'a bougé : on ne touche à rien", () => {
    expect(decision(etat()).verdict).toBe("a-jour");
  });
});

describe("ce qui doit être refusé", () => {
  test("des modifications non commitées : on n'y touche pas", () => {
    // Sur cette machine, le dossier du projet est aussi l'endroit où on
    // l'édite. Un pull par-dessus perdrait ce que personne n'a sauvegardé.
    const d = decision(etat({ sale: true, local: "aaaaaaa1", distant: "bbbbbbb2" }));
    expect(d.verdict).toBe("refuse");
    expect(d.raison).toContain("non commitées");
  });

  test("le travail en cours passe avant tout le reste", () => {
    // Même si la branche a divergé et que le distant est injoignable, c'est
    // la perte possible qu'on signale en premier.
    expect(decision(etat({ sale: true, distant: "", avanceDirecte: false })).raison)
      .toContain("non commitées");
  });

  test("les branches ont divergé : on ne tranche pas à sa place", () => {
    const d = decision(etat({ local: "aaaaaaa1", distant: "bbbbbbb2", avanceDirecte: false }));
    expect(d.verdict).toBe("refuse");
    expect(d.raison).toContain("divergé");
  });

  test("le distant est injoignable : on ne conclut pas que tout va bien", () => {
    // Confondre « injoignable » et « à jour » ferait croire au suivi de
    // fonctionner alors qu'il ne verrait plus rien passer.
    const d = decision(etat({ distant: "" }));
    expect(d.verdict).toBe("refuse");
    expect(d.raison).toContain("injoignable");
  });

  test("la branche n'existe pas en local", () => {
    expect(decision(etat({ local: "" })).verdict).toBe("refuse");
  });
});

describe("le nom d'une branche", () => {
  test("les noms ordinaires passent", () => {
    for (const n of ["main", "master", "release/1.0", "feat_a-b.c"]) {
      expect(brancheValide(n)).toBe(true);
    }
  });

  test("ce qui pourrait sortir du dépôt est refusé", () => {
    for (const n of ["", "-x", "../ailleurs", "a..b", "a b", "a;rm -rf /"]) {
      expect(brancheValide(n)).toBe(false);
    }
  });
});
