import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { caddyDomains } from "../src/caddy";

test("domaines par port local", () => {
  // Le dossier est supprimé à la fin : sans ça, chaque `bun test` laissait un
  // dossier derrière lui dans /tmp — on en a retrouvé 27.
  const dir = mkdtempSync(join(tmpdir(), "spm-caddy-"));
  const file = join(dir, "Caddyfile");
  writeFileSync(file, `{
  email moi@example.com
}

blog.example.com, www.blog.example.com {
  encode gzip # commentaire
  reverse_proxy 127.0.0.1:8100
}

https://api.example.com:443 {
  handle /v1/* {
    reverse_proxy localhost:8101 :8102
  }
  header X-Id {http.request.uuid}
}

distant.example.com {
  reverse_proxy 10.0.0.5:8100
}
`);
  const map = caddyDomains(file);
  expect(map.get(8100)).toEqual(["blog.example.com", "www.blog.example.com"]);
  expect(map.get(8101)).toEqual(["api.example.com"]);
  expect(map.get(8102)).toEqual(["api.example.com"]);
  expect(map.size).toBe(3);
  rmSync(dir, { recursive: true, force: true });
});

test("pas de Caddyfile : aucun domaine", () => expect(caddyDomains("/nulle/part/Caddyfile").size).toBe(0));
