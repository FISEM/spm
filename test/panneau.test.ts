import { describe, expect, it, beforeAll, afterAll } from "bun:test";

import "./setup";
import { definir, valeurs } from "../src/secrets";
import { jeton, servir, vue } from "../src/panneau";

/**
 * Le panneau écrit maintenant. Deux propriétés valent d'être tenues :
 *
 * 1. **Une valeur ne sort jamais.** On peut remplacer une clé sans jamais voir
 *    l'ancienne — c'est exactement ce qu'on fait le jour d'une rotation, et
 *    c'est ce qui rend un écran resté ouvert inoffensif.
 * 2. **Une écriture prouve qu'elle vient d'ici.** Sans le jeton dans le corps
 *    du formulaire, rien ne passe : une page malveillante ouverte à côté ne
 *    doit pas pouvoir poster à notre place.
 */

const PORT = 8149;   // ≥ 8100, hors de tout service réel
let serveur: ReturnType<typeof servir>;

const SECRET = "valeur-tres-secrete-0123456789";

beforeAll(() => {
  definir("projet-de-test-panneau", { UNE_CLE: SECRET, AUTRE_CLE: "x" });
  serveur = servir(PORT, "127.0.0.1");
});

afterAll(() => serveur.serveur.stop(true));

const adresse = (chemin = "/") => `http://127.0.0.1:${PORT}${chemin}?jeton=${jeton()}`;

/** Le jeton passe par l'adresse une fois, puis par le cookie : on suit le même
 *  chemin qu'un navigateur. */
const lire = (chemin = "/") =>
  fetch(`http://127.0.0.1:${PORT}${chemin}`, { headers: { cookie: `spm_panneau=${jeton()}` } });

const poster = (chemin: string, champs: Record<string, string>) => {
  const corps = new FormData();
  for (const [k, v] of Object.entries(champs)) corps.set(k, v);
  return fetch(`http://127.0.0.1:${PORT}${chemin}`, { method: "POST", body: corps });
};

describe("lecture", () => {
  it("refuse sans jeton", async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/`);
    expect(r.status).toBe(401);
  });

  it("range le jeton dans un cookie et le retire de l'adresse", async () => {
    const r = await fetch(adresse(), { redirect: "manual" });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/");
    const biscuit = r.headers.get("set-cookie") ?? "";
    expect(biscuit).toContain("spm_panneau=");
    expect(biscuit).toContain("HttpOnly");
    expect(biscuit).toContain("SameSite=Strict");
  });

  it("ne laisse pas fuir l'adresse par Referer", async () => {
    const r = await lire();
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
  });

  it("montre les noms de variables", async () => {
    const html = await (await lire()).text();
    expect(html).toContain("UNE_CLE");
    expect(html).toContain("projet-de-test-panneau");
  });

  it("n'écrit jamais une valeur dans la page", async () => {
    const html = await (await lire()).text();
    expect(html).not.toContain(SECRET);
  });

  it("ne met pas le jeton dans le JSON", async () => {
    const d = await (await lire("/json")).json();
    expect(d.jeton).toBeUndefined();
    expect(JSON.stringify(d)).not.toContain(SECRET);
  });
});

describe("écriture", () => {
  it("refuse un POST sans jeton", async () => {
    const r = await poster("/definir", { projet: "projet-de-test-panneau", cle: "UNE_CLE", valeur: "pirate" });
    expect(r.status).toBe(403);
    expect(valeurs("projet-de-test-panneau").UNE_CLE).toBe(SECRET);
  });

  it("refuse un POST avec un mauvais jeton", async () => {
    const r = await poster("/definir", {
      jeton: "pas-le-bon", projet: "projet-de-test-panneau", cle: "UNE_CLE", valeur: "pirate",
    });
    expect(r.status).toBe(403);
    expect(valeurs("projet-de-test-panneau").UNE_CLE).toBe(SECRET);
  });

  it("remplace une valeur sans jamais montrer l'ancienne", async () => {
    const r = await poster("/definir", {
      jeton: jeton(), projet: "projet-de-test-panneau", cle: "UNE_CLE", valeur: "nouvelle-valeur",
    });
    const html = await r.text();
    expect(r.status).toBe(200);
    expect(html).toContain("UNE_CLE enregistrée");
    expect(html).not.toContain(SECRET);
    expect(html).not.toContain("nouvelle-valeur");
    expect(valeurs("projet-de-test-panneau").UNE_CLE).toBe("nouvelle-valeur");
  });

  it("refuse une valeur vide plutôt que d'effacer en silence", async () => {
    const r = await poster("/definir", {
      jeton: jeton(), projet: "projet-de-test-panneau", cle: "AUTRE_CLE", valeur: "",
    });
    expect(r.status).toBe(400);
    expect(valeurs("projet-de-test-panneau").AUTRE_CLE).toBe("x");
  });

  it("refuse un nom de variable que le shell ne saurait pas lire", async () => {
    const r = await poster("/definir", {
      jeton: jeton(), projet: "projet-de-test-panneau", cle: "MA CLE", valeur: "v",
    });
    expect(r.status).toBe(400);
    expect(await r.text()).toContain("nom de variable invalide");
  });

  it("ajoute une variable qui n'existait pas", async () => {
    await poster("/definir", {
      jeton: jeton(), projet: "projet-de-test-panneau", cle: "TOUTE_NEUVE", valeur: "v",
    });
    expect(valeurs("projet-de-test-panneau").TOUTE_NEUVE).toBe("v");
  });

  it("refuse d'appliquer sur un projet que le coffre ne connaît pas", async () => {
    const r = await poster("/appliquer", { jeton: jeton(), projet: "nexiste-pas" });
    expect(r.status).toBe(400);
    expect(await r.text()).toContain("projet inconnu");
  });
});

describe("la vue", () => {
  it("porte le jeton pour les formulaires, et seulement là", () => {
    expect(vue("abc").jeton).toBe("abc");
    expect(vue().jeton).toBe("");
  });
});
