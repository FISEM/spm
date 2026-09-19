import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detect } from "../src/detect";

let dir = "";
function project(files: Record<string, string>) {
  dir = mkdtempSync(join(tmpdir(), "spm-detect-"));
  for (const [f, content] of Object.entries(files)) writeFileSync(join(dir, f), content);
  return dir;
}
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const pkg = (scripts: Record<string, string>) => JSON.stringify({ scripts });

describe("detect", () => {
  test("Dockerfile : EXPOSE lu, rien de généré", () => {
    expect(detect(project({ Dockerfile: "FROM x\nEXPOSE 8080/tcp\n" }))).toEqual({ kind: "dockerfile", internalPort: 8080, dockerfile: null });
  });
  test("Dockerfile sans EXPOSE : 3000", () => expect(detect(project({ Dockerfile: "FROM x\n" })).internalPort).toBe(3000));

  test("bun, avec build", () => {
    const d = detect(project({ "package.json": pkg({ start: "bun x", build: "b" }), "bun.lock": "" }));
    expect(d.kind).toBe("bun");
    expect(d.dockerfile).toContain("RUN bun run build");
  });
  test("node : npm ci seulement avec package-lock.json", () => {
    expect(detect(project({ "package.json": pkg({ start: "node ." }), "package-lock.json": "{}" })).dockerfile).toContain("RUN npm ci");
    rmSync(dir, { recursive: true });
    expect(detect(project({ "package.json": pkg({ start: "node ." }) })).dockerfile).toContain("RUN npm install");
  });
  test("package.json sans script start : refusé", () => {
    expect(() => detect(project({ "package.json": pkg({}) }))).toThrow('script "start"');
  });

  test("FastAPI : uvicorn lit $PORT", () => {
    const d = detect(project({ "main.py": "from fastapi import FastAPI\n", "requirements.txt": "fastapi\n" }));
    expect(d.kind).toBe("fastapi");
    expect(d.dockerfile).toContain('--port "${PORT:-8000}"');
    expect(d.dockerfile).toContain('"uvicorn[standard]"'); // absent de requirements.txt : ajouté
  });
  test("python : point d'entrée app.py", () => {
    const d = detect(project({ "app.py": "", "requirements.txt": "flask\n" }));
    expect(d.kind).toBe("python");
    expect(d.dockerfile).toContain('CMD ["python", "app.py"]');
  });
  test("requirements.txt sans point d'entrée : refusé", () => {
    expect(() => detect(project({ "requirements.txt": "flask\n" }))).toThrow("point d'entrée");
  });
  test("dossier inconnu : refusé", () => expect(() => detect(project({ "README.md": "" }))).toThrow("non reconnu"));
});
