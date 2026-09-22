import { describe, expect, test } from "bun:test";

import { imagesConstruites } from "../src/core";

describe("images à protéger avant un redéploiement", () => {
  test("ne garde que ce que le projet construit", () => {
    // Réétiqueter postgres comme « secours » ne protégerait de rien, et
    // remettre une ancienne image de base sur une base de données serait
    // même dangereux.
    const declarees = ["kira-kira", "postgres:17-alpine", "", "  kira-worker  ", "redis:7"];
    expect(imagesConstruites(declarees, "kira").map((i) => i.image)).toEqual(["kira-kira", "kira-worker"]);
  });

  test("l'étiquette de secours ne dépend pas de la version courante", () => {
    const [premier] = imagesConstruites(["kira-kira:v3"], "kira");
    expect(premier?.secours).toBe("kira-kira:spm-previous");
  });

  test("reconnaît aussi l'ancien séparateur de docker compose", () => {
    expect(imagesConstruites(["mcp_server"], "mcp").map((i) => i.image)).toEqual(["mcp_server"]);
  });

  test("un projet sans image construite ne donne rien à protéger", () => {
    expect(imagesConstruites(["postgres:17", "caddy:2"], "vitrine")).toEqual([]);
  });

  test("le nom d'un autre projet n'est jamais confondu", () => {
    // « kiravideos-web » ne doit pas passer pour une image du projet « kira » :
    // on remettrait alors une image de secours sur le mauvais service.
    expect(imagesConstruites(["kiravideos-web"], "kira")).toEqual([]);
  });
});
