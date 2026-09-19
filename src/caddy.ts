import { readFileSync } from "node:fs";

/**
 * Lit le Caddyfile (sans jamais le modifier) et renvoie port local → domaines,
 * d'après les blocs `domaine { reverse_proxy 127.0.0.1:PORT }`.
 * Lecture volontairement simple : les blocs sans accolades et les `import` sont ignorés.
 */
export function caddyDomains(path: string): Map<number, string[]> {
  const map = new Map<number, string[]>();
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return map; // pas de Caddy, ou fichier illisible : pas de colonne domaine, c'est tout
  }

  let depth = 0;
  let site: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!line) continue;

    if (depth === 0 && line.endsWith("{")) {
      // "{" seul = options globales ; sinon, adresses du site
      site = line.slice(0, -1).trim().split(/[\s,]+/).filter(Boolean)
        .map((a) => a.replace(/^https?:\/\//, "").replace(/:443$/, ""));
    }

    const proxy = depth >= 1 && line.match(/^reverse_proxy\s+([^{]+)/);
    if (proxy && site.length) {
      for (const upstream of proxy[1]!.trim().split(/\s+/)) {
        const m = upstream.match(/^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|\[::1\])?:(\d+)$/);
        if (!m) continue; // upstream distant (autre machine, VM…)
        const port = Number(m[1]);
        map.set(port, [...new Set([...(map.get(port) ?? []), ...site])]);
      }
    }

    // Les placeholders {…} sont équilibrés sur leur ligne : le comptage reste juste.
    depth += (line.match(/{/g)?.length ?? 0) - (line.match(/}/g)?.length ?? 0);
    if (depth <= 0) (depth = 0), (site = []);
  }
  return map;
}
