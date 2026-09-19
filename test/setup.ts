import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Avant tout import de src/registry, qui lit SPM_HOME au chargement : les tests ne touchent jamais ~/.spm.
process.env.SPM_HOME = mkdtempSync(join(tmpdir(), "spm-test-"));
