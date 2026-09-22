import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Avant tout import de src/registry, qui lit SPM_HOME au chargement : les tests ne touchent jamais ~/.spm.
const maison = mkdtempSync(join(tmpdir(), "spm-test-"));
process.env.SPM_HOME = maison;

// Et on le rend à la fin. Un dossier oublié par exécution finit par en faire
// des dizaines : on en avait retrouvé 27 dans /tmp avant d'ajouter ceci.
// (process.on("exit") ne se déclenche pas sous bun test : il faut afterAll.)
afterAll(() => rmSync(maison, { recursive: true, force: true }));
