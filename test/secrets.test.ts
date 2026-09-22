import { describe, expect, test } from "bun:test";

import { chiffrer, dechiffrer, fusionnerDotEnv, lireDotEnv } from "../src/secrets";
import { randomBytes } from "node:crypto";

const CLE = randomBytes(32);

describe("chiffrement des valeurs", () => {
  test("un aller-retour rend la valeur d'origine", () => {
    expect(dechiffrer(chiffrer("sk-ant-secret", CLE), CLE)).toBe("sk-ant-secret");
  });

  test("deux chiffrements de la même valeur diffèrent", () => {
    // Sinon on lirait dans secrets.json que deux projets partagent une clé,
    // ce qui est déjà une fuite.
    expect(chiffrer("identique", CLE)).not.toBe(chiffrer("identique", CLE));
  });

  test("une valeur modifiée à la main est rejetée, pas déchiffrée en n'importe quoi", () => {
    const paquet = chiffrer("valeur", CLE);
    const [iv, tag, chiffre] = paquet.split(":");
    const altere = [iv, tag, Buffer.from("autre chose").toString("base64")].join(":");
    expect(() => dechiffrer(altere, CLE)).toThrow();
  });

  test("une autre clé ne déchiffre rien", () => {
    expect(() => dechiffrer(chiffrer("valeur", CLE), randomBytes(32))).toThrow();
  });
});

describe("lecture d'un .env", () => {
  test("lit les formes courantes", () => {
    const vars = lireDotEnv([
      "# un commentaire",
      "",
      "SIMPLE=valeur",
      "  ESPACES = avec des espaces  ",
      'GUILLEMETS="entre guillemets"',
      "export EXPORTE=oui",
    ].join("\n"));
    expect(vars).toEqual({
      SIMPLE: "valeur",
      ESPACES: "avec des espaces",
      GUILLEMETS: "entre guillemets",
      EXPORTE: "oui",
    });
  });

  test("une valeur contenant un = reste entière", () => {
    // Les clés d'API en base64 finissent souvent par « == » : les tronquer
    // donnerait un secret invalide, et l'erreur n'apparaîtrait qu'à l'appel.
    expect(lireDotEnv("CLE=abc==")).toEqual({ CLE: "abc==" });
  });

  test("ignore ce qui n'est pas un nom de variable", () => {
    expect(lireDotEnv("pas une ligne\n=sans nom\n2CHIFFRES=non")).toEqual({});
  });
});

describe("fusion avec un .env existant", () => {
  test("remplace les valeurs connues et garde les autres", () => {
    const existant = "CONNUE=ancienne\nINCONNUE=à ne pas perdre\n";
    const sortie = fusionnerDotEnv(existant, { CONNUE: "nouvelle" });
    expect(sortie).toContain("CONNUE=nouvelle");
    expect(sortie).toContain("INCONNUE=à ne pas perdre");
  });

  test("ajoute à la fin ce que le fichier n'avait pas", () => {
    const sortie = fusionnerDotEnv("DEJA=là\n", { AJOUTEE: "valeur" });
    expect(sortie).toContain("DEJA=là");
    expect(sortie).toContain("AJOUTEE=valeur");
  });

  test("préserve les commentaires et l'ordre", () => {
    const existant = "# en-tête\nA=1\n# milieu\nB=2\n";
    const sortie = fusionnerDotEnv(existant, { B: "trois" });
    expect(sortie.split("\n").slice(0, 4)).toEqual(["# en-tête", "A=1", "# milieu", "B=trois"]);
  });

  test("un coffre vide ne touche à rien", () => {
    const existant = "A=1\nB=2\n";
    expect(fusionnerDotEnv(existant, {})).toBe(existant);
  });

  test("ne duplique pas une variable déjà présente", () => {
    const sortie = fusionnerDotEnv("A=ancienne\n", { A: "nouvelle" });
    expect(sortie.split("\n").filter((l) => l.startsWith("A=")).length).toBe(1);
  });
});
