import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireLock, SPM_HOME } from "../src/registry";

const lock = join(SPM_HOME, "lock"); // SPM_HOME temporaire : voir test/setup.ts
mkdirSync(SPM_HOME, { recursive: true });

test("refusé si une autre commande vivante le tient", () => {
  writeFileSync(lock, `${process.ppid} redeploy blog\n`);
  expect(() => acquireLock("add ./x")).toThrow("spm redeploy blog");
});

test("repris si son processus est mort", () => {
  writeFileSync(lock, "999999999 redeploy blog\n");
  acquireLock("add ./x");
  expect(readFileSync(lock, "utf8")).toBe(`${process.pid} add ./x\n`);
});

test("pris quand il n'existe pas", () => {
  rmSync(lock);
  acquireLock("stop blog");
  expect(existsSync(lock)).toBe(true);
});
