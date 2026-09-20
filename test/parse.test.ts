import { describe, expect, test } from "bun:test";
import {
  belongsToProject, orphanVolumes, parseEnv, parseHealth, parseMemory, parsePort, parseVolume,
} from "../src/core";
import { parsePorts } from "../src/docker";

describe("parsePort", () => {
  test("accepte 1 à 65535", () => {
    expect(parsePort("8100")).toBe(8100);
    expect(parsePort(65535)).toBe(65535);
  });
  test.each(["0", "65536", "80.5", "abc", ""])("refuse %p", (v) => expect(() => parsePort(v)).toThrow("port invalide"));
});

describe("parseEnv", () => {
  test("découpe au premier =", () => {
    expect(parseEnv(["A=1", "URL=postgres://u:p@h/db?x=y", "VIDE="])).toEqual({ A: "1", URL: "postgres://u:p@h/db?x=y", VIDE: "" });
  });
  test.each(["SANS_EGAL", "=valeur", "1A=x", "A-B=x"])("refuse %p", (v) => expect(() => parseEnv([v])).toThrow("variable invalide"));
  test("PORT est réservé à spm", () => expect(() => parseEnv(["PORT=1"])).toThrow("--internal-port"));
});

describe("parseVolume", () => {
  test("volume nommé", () => expect(parseVolume("data:/app/data", "/p")).toEqual({ source: "data", target: "/app/data" }));
  test("chemin relatif au projet, lecture seule, / final retiré", () => {
    expect(parseVolume("./up:/app/up/:ro", "/srv/blog")).toEqual({ source: "/srv/blog/up", target: "/app/up", readonly: true });
  });
  test("~ = dossier personnel", () => {
    expect(parseVolume("~/x:/x", "/p").source).toBe(`${require("node:os").homedir()}/x`);
  });
  test.each(["data", "data:app", "a:b:c", "bad name:/x", ":/x"])("refuse %p", (v) => expect(() => parseVolume(v, "/p")).toThrow());
});

describe("parseMemory", () => {
  test.each([["512m", "512m"], ["1G", "1g"], [" 64m ", "64m"], ["6291456", "6291456"]])("%p → %p", (v, out) => {
    expect(parseMemory(v)).toBe(out);
  });
  test.each(["abc", "512mb", "-1m", "1.5g"])("refuse %p", (v) => expect(() => parseMemory(v)).toThrow("mémoire invalide"));
  test.each(["5m", "1000k"])("refuse %p (< 6m)", (v) => expect(() => parseMemory(v)).toThrow("trop faible"));
});

describe("parseHealth", () => {
  test("accepte un chemin", () => expect(parseHealth("/health?full=1")).toBe("/health?full=1"));
  test.each(["health", "/a b", ""])("refuse %p", (v) => expect(() => parseHealth(v)).toThrow());
});

describe("parsePorts", () => {
  test("toutes interfaces → port seul, 127.0.0.1 gardé, doublons IPv6 fusionnés", () => {
    expect(parsePorts("127.0.0.1:8001->8000/tcp, 0.0.0.0:8002->3000/tcp, [::]:8002->3000/tcp, 5432/tcp")).toEqual([
      "127.0.0.1:8001", "8002",
    ]);
  });
  test("vide", () => expect(parsePorts("")).toEqual([]));
});

describe("volumes d'un projet", () => {
  const compose = { name: "kira", mode: "compose", compose_project: "kira" } as never;
  const conteneur = { name: "blog", mode: "container", volumes: [] } as never;
  const vol = (name: string, composeProject = "", spmProject = "") => ({ name, composeProject, spmProject });

  test("compose : reconnu par l'étiquette, même retiré du fichier", () => {
    expect(belongsToProject(vol("kira_kira_data", "kira"), compose)).toBe(true);
    expect(belongsToProject(vol("budget_data", "budget"), compose)).toBe(false);
  });

  test("projet spm : reconnu par le préfixe ou l'étiquette", () => {
    expect(belongsToProject(vol("spm-blog-data"), conteneur)).toBe(true);
    expect(belongsToProject(vol("autre", "", "blog"), conteneur)).toBe(true);
    expect(belongsToProject(vol("spm-blogue-data"), conteneur)).toBe(false); // préfixe complet exigé
  });

  test("orphelin = ni monté, ni déclaré", () => {
    const volumes = [
      { name: "utilise", used: true, declared: true },
      { name: "declare-arrete", used: false, declared: true },
      { name: "orphelin", used: false, declared: false },
    ];
    expect(orphanVolumes(volumes).map((v) => v.name)).toEqual(["orphelin"]);
  });
});
