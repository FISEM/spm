#!/usr/bin/env bun
import { parseArgs } from "node:util";
import pkg from "../package.json";
import {
  addProject, describeVolume, envList, envSet, envUnset, importProject, lifecycle, listProjects, parseEnv, parsePort,
  orphanVolumes, projectStatus, projectVolumes, pruneVolumes, redeploy, removeProject, setOptions,
  unmanagedContainers, volumeAdd, volumeList, volumeRemove,
  type Reporter, type StartResult,
} from "./core";
import { compose, containerName, docker } from "./docker";
import { acquireLock, getProject, isCompose, loadRegistry, SpmError } from "./registry";

const VERSION = pkg.version;

const HELP = `spm ${VERSION} — PaaS personnel minimaliste

Projets :
  spm add <path> [options]          détecte, build, lance et enregistre (docker compose si présent)
  spm import <path> [--name <nom>]  enregistre un projet compose existant, sans rien relancer
  spm redeploy <nom>                rebuild et remplace (port, env et volumes conservés)
  spm list [--json]                 tous les projets : statut, ports, domaines (lus dans Caddy)
  spm start|stop|restart <nom>
  spm remove <nom> [--down] [--purge]
                                    compose : désenregistre seulement, sauf --down (arrête et
                                    supprime les conteneurs) ; --purge supprime aussi les volumes
  spm logs <nom> [-f] [-n <lignes>]
  spm status <nom> [--json]         config, conteneurs, CPU, mémoire (--json : sans valeurs d'env)
  spm set <nom> memory=512m health=/health
                                    limite mémoire, chemin HTTP vérifié au démarrage ;
                                    une valeur vide retire le réglage (memory=)

Variables d'environnement :
  spm env <nom>                     liste
  spm env set <nom> CLE=valeur...   ajoute ou modifie, puis relance
  spm env unset <nom> CLE...        supprime, puis relance

Volumes :
  spm volume <nom>                  liste les volumes Docker du projet et leur état
  spm volume add <nom> <source>:<cible>[:ro]
  spm volume rm <nom> <cible>       démonte (les données sont conservées)
  spm volume prune <nom> --yes      supprime les volumes que plus rien n'utilise
                                    (orphelins d'un changement de config) ; leurs
                                    données sont perdues

Options de add :
  --port <port>            port ouvert sur la machine (défaut : premier libre à partir de 8100)
  --name <nom>             nom du projet (défaut : nom du dossier)
  --internal-port <port>   port écouté par l'app dans le conteneur (défaut : détecté)
  --local                  n'ouvrir le port que sur 127.0.0.1
  -e, --env CLE=valeur     variable d'environnement (répétable)
  -v, --volume src:cible   volume (répétable) ; src = nom court (volume Docker)
                           ou chemin (/, ./ ou ~ ; relatif au dossier du projet)
  --memory <taille>        limite mémoire du conteneur (ex. 512m, 1g)
  --health <chemin>        déploiement réussi seulement si ce chemin répond en HTTP (< 400)
`;

const cli: Reporter = { step: (m) => console.log(`→ ${m}`), stream: true };

function table(rows: string[][]) {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  for (const r of rows) console.log(r.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd());
}

/** Affiche le résultat d'un démarrage ; null = rien n'a été démarré. */
function report(name: string, res: StartResult | null, okMessage: string) {
  if (!res || res.ok) return console.log(`✓ ${okMessage}`);
  // Docker remet le code à 0 quand il relance le conteneur : on ne l'affiche que s'il est parlant.
  const code = res.exitCode ? ` (code ${res.exitCode})` : "";
  console.error(`\n✗ ${name} plante au démarrage${code}. Dernières lignes :\n\n${res.logs ?? ""}\n`);
  process.exitCode = 1;
}

// ---------------------------------------------------------------- commandes

async function add(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      port: { type: "string", short: "p" },
      name: { type: "string" },
      "internal-port": { type: "string" },
      local: { type: "boolean" },
      env: { type: "string", short: "e", multiple: true },
      volume: { type: "string", short: "v", multiple: true },
      memory: { type: "string" },
      health: { type: "string" },
    },
  });
  if (!positionals[0]) throw new SpmError("usage : spm add <path> [--port <port>]");

  const { project, start } = await addProject(
    {
      path: positionals[0],
      name: values.name,
      port: values.port ? parsePort(values.port) : undefined,
      internalPort: values["internal-port"] ? parsePort(values["internal-port"]) : undefined,
      local: values.local,
      env: parseEnv(values.env ?? []),
      volumes: values.volume,
      memory: values.memory,
      health: values.health,
    },
    cli,
  );
  report(
    project.name, start,
    isCompose(project)
      ? `${project.name} lancé avec docker compose`
      : `${project.name} tourne sur le port ${project.port}${project.bind === "127.0.0.1" ? " (127.0.0.1 uniquement)" : ""}`,
  );
  if (!start.ok) console.error(`Corrige puis : spm redeploy ${project.name}`);
}

async function redeployCmd(name: string) {
  const { start, rolledBack } = await redeploy(name, cli);
  if (start.ok) return console.log(`✓ ${name} redéployé`);
  report(name, start, "");
  console.error(rolledBack ? "↩ version précédente relancée, elle tourne toujours." : "✗ aucune version ne tourne.");
}

async function importCmd(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { name: { type: "string" } } });
  if (!positionals[0]) throw new SpmError("usage : spm import <path> [--name <nom>]");
  const { project, status } = await importProject(positionals[0], values.name);
  console.log(`✓ ${project.name} importé (${status}), rien n'a été relancé`);
}

const printJson = (data: unknown) => console.log(JSON.stringify(data, null, 2));

async function list(args: string[]) {
  const projects = await listProjects();
  if (args.includes("--json")) {
    const unmanaged = (await unmanagedContainers()).map(({ name, state, ports, composeDir }) => ({
      name, state, ports, compose_dir: composeDir || null,
    }));
    return printJson({ projects, unmanaged });
  }
  if (projects.length) {
    table([
      ["NOM", "TYPE", "STATUT", "PORTS", "DOMAINES"],
      ...projects.map((p) => [p.name, p.kind, p.status, p.ports.join(", ") || "-", p.domains.join(", ") || "-"]),
    ]);
  } else {
    console.log("aucun projet (spm add <path>, ou spm import <path> pour un projet compose existant)");
  }

  // Ce qui tourne sur la machine sans être suivi par spm
  const others = await unmanagedContainers();
  if (others.length) {
    const dirs = [...new Set(others.map((c) => c.composeDir).filter(Boolean))];
    const loose = others.filter((c) => !c.composeDir).map((c) => c.name);
    console.log(`\nnon suivis par spm : ${others.map((c) => c.name).join(", ")}`);
    for (const d of dirs) console.log(`  spm import ${d}`);
    if (loose.length) console.log(`  (hors compose : ${loose.join(", ")})`);
  }
}

async function lifecycleCmd(action: "start" | "stop" | "restart", name: string) {
  const res = await lifecycle(name, action, cli);
  report(name, res, `${name} ${{ start: "démarré", stop: "arrêté", restart: "redémarré" }[action]}`);
}

async function remove(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { down: { type: "boolean" }, purge: { type: "boolean" } },
  });
  const name = positionals[0];
  if (!name) throw new SpmError("usage : spm remove <nom> [--down] [--purge]");
  const { keptVolumes, untouched } = await removeProject(name, { down: values.down, purge: values.purge });
  if (untouched) return console.log(`✓ ${name} retiré de spm (ses conteneurs tournent toujours ; --down pour les arrêter)`);
  console.log(`✓ ${name} supprimé`);
  if (keptVolumes.length) console.log(`  données conservées : ${keptVolumes.join(", ")} (--purge pour supprimer les volumes Docker)`);
}

async function logs(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { follow: { type: "boolean", short: "f" }, lines: { type: "string", short: "n", default: "100" } },
  });
  const name = positionals[0];
  if (!name) throw new SpmError("usage : spm logs <nom> [-f] [-n <lignes>]");
  const p = getProject(loadRegistry(), name);
  const args2 = ["logs", "--tail", values.lines!, ...(values.follow ? ["-f"] : [])];
  const r = isCompose(p) ? await compose(p, args2, true) : await docker([...args2, containerName(name)], true);
  process.exitCode = r.code;
}

async function status(args: string[]) {
  const name = args.find((a) => !a.startsWith("-"));
  if (!name) throw new SpmError("usage : spm status <nom> [--json]");
  const { project: p, status, domains, containers } = await projectStatus(name);
  if (args.includes("--json")) {
    // Noms des variables seulement : leurs valeurs (secrets) ne sortent jamais du registre.
    const config = isCompose(p)
      ? { compose_file: p.compose_file, compose_project: p.compose_project }
      : {
          bind: p.bind, port: p.port, internal_port: p.internal_port, kind: p.kind,
          memory: p.memory ?? null, health: p.health ?? null, env_keys: Object.keys(p.env), volumes: p.volumes,
        };
    return printJson({
      name: p.name, mode: isCompose(p) ? "compose" : "container", status, path: p.path, domains, ...config,
      containers: containers.map(({ name, state, exitCode, ports, stats }) => ({ name, state, exit_code: exitCode, ports, stats })),
    });
  }
  if (isCompose(p)) {
    console.log(`${p.name}  docker compose  (${status})`);
    console.log(`fichier   : ${p.compose_file}`);
  } else {
    console.log(`${p.name}  ${p.bind}:${p.port} → ${p.internal_port}  (${p.kind}, ${status})`);
    console.log(`chemin    : ${p.path}`);
    if (p.memory) console.log(`mémoire   : ${p.memory} max`);
    if (p.health) console.log(`santé     : GET ${p.health}`);
    if (Object.keys(p.env).length) console.log(`env       : ${Object.keys(p.env).join(", ")}`);
    for (const v of p.volumes) console.log(`volume    : ${describeVolume(p.name, v)}`);
  }
  if (domains.length) console.log(`domaines  : ${domains.join(", ")}`);
  if (!containers.length) return console.log("conteneur : aucun");

  console.log();
  table([
    ["CONTENEUR", "ÉTAT", "PORTS", "CPU", "MÉMOIRE", "MÉM %", "RÉSEAU", "PIDS"],
    ...containers.map((c) => [
      c.name,
      c.state + (c.state === "exited" ? ` (${c.exitCode})` : ""),
      c.ports.join(", ") || "-",
      c.stats?.cpu ?? "-", c.stats?.memory ?? "-", c.stats?.memoryPercent ?? "-", c.stats?.network ?? "-", c.stats?.pids ?? "-",
    ]),
  ]);
}

async function env(args: string[]) {
  const [sub, name, ...rest] = args;
  if (sub === "set" && name) return report(name, await envSet(name, parseEnv(rest), cli), `variables mises à jour pour ${name}`);
  if (sub === "unset" && name && rest.length) return report(name, await envUnset(name, rest, cli), `variables supprimées pour ${name}`);
  if (sub && !name && !["set", "unset"].includes(sub)) {
    const vars = Object.entries(envList(sub));
    if (!vars.length) return console.log(`aucune variable pour ${sub} (spm env set ${sub} CLE=valeur)`);
    for (const [k, v] of vars) console.log(`${k}=${v}`);
    return;
  }
  throw new SpmError("usage : spm env <nom> | spm env set <nom> CLE=valeur... | spm env unset <nom> CLE...");
}

/** Volumes Docker du projet : ce qui sert encore, et ce qui traîne. */
async function volumeState(name: string) {
  const volumes = await projectVolumes(name);
  if (!volumes.length) return console.log(`aucun volume Docker pour ${name}`);
  table([
    ["VOLUME", "ÉTAT"],
    ...volumes.map((v) => [v.name, v.used ? "utilisé" : v.declared ? "déclaré, non monté" : "orphelin"]),
  ]);
  const orphelins = orphanVolumes(volumes);
  if (orphelins.length) {
    console.log(`\n${orphelins.length} orphelin(s) : plus aucun conteneur ni config ne les utilise.`);
    console.log(`  spm volume prune ${name} --yes    (les données qu'ils contiennent seront perdues)`);
  }
}

async function volumePrune(name: string, confirme: boolean) {
  const orphelins = orphanVolumes(await projectVolumes(name));
  if (!orphelins.length) return console.log(`aucun volume orphelin pour ${name}`);
  if (!confirme) {
    console.log(`${orphelins.length} volume(s) seraient supprimés, avec leurs données :`);
    for (const v of orphelins) console.log(`  ${v.name}`);
    throw new SpmError(`relance avec --yes pour confirmer : spm volume prune ${name} --yes`);
  }
  const { removed, failed } = await pruneVolumes(name);
  for (const v of removed) console.log(`✓ ${v} supprimé`);
  for (const v of failed) console.error(`✗ ${v} n'a pas pu être supprimé (utilisé par un conteneur ?)`);
  if (failed.length) process.exitCode = 1;
}

async function volume(args: string[]) {
  const [sub, name, arg] = args;
  if (sub === "prune" && name) return volumePrune(name, args.includes("--yes"));
  if (sub === "add" && name && arg) return report(name, await volumeAdd(name, arg, cli), `volume monté pour ${name}`);
  if ((sub === "rm" || sub === "remove") && name && arg) {
    return report(name, await volumeRemove(name, arg, cli), `volume démonté pour ${name} (données conservées)`);
  }
  if (sub && !name && !["add", "rm", "remove", "prune"].includes(sub)) {
    // Projet compose : sa config n'appartient pas à spm, on montre l'état réel côté Docker.
    const p = getProject(loadRegistry(), sub);
    if (isCompose(p)) return volumeState(sub);
    const vols = volumeList(sub);
    if (vols.length) for (const v of vols) console.log(describeVolume(sub, v));
    else console.log(`aucun volume déclaré pour ${sub} (spm volume add ${sub} data:/app/data)`);
    console.log();
    return volumeState(sub);
  }
  throw new SpmError(
    "usage : spm volume <nom> | spm volume add <nom> <source>:<cible>[:ro] | " +
    "spm volume rm <nom> <cible> | spm volume prune <nom> --yes",
  );
}

async function set(args: string[]) {
  const [name, ...pairs] = args;
  if (!name) throw new SpmError("usage : spm set <nom> memory=512m health=/health");
  report(name, await setOptions(name, pairs, cli), `réglages mis à jour pour ${name}`);
}

// ---------------------------------------------------------------- main

/** Commandes qui modifient l'état : une seule à la fois (les listes et les logs restent libres). */
function mutates(cmd: string | undefined, rest: string[]): boolean {
  if (cmd === "env") return rest[0] === "set" || rest[0] === "unset";
  if (cmd === "volume" || cmd === "volumes") return ["add", "rm", "remove", "prune"].includes(rest[0] ?? "");
  return ["add", "import", "redeploy", "deploy", "start", "stop", "restart", "remove", "rm", "set"].includes(cmd ?? "");
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const needName = () => {
    if (!rest[0]) throw new SpmError(`usage : spm ${cmd} <nom>`);
    return rest[0];
  };
  // Sans les CLE=valeur : le verrou affiche la commande en cours, pas les secrets qu'elle contient.
  if (mutates(cmd, rest)) acquireLock([cmd, ...rest.slice(0, 2)].filter((a) => !a!.includes("=")).join(" "));

  switch (cmd) {
    case "add": return add(rest);
    case "import": return importCmd(rest);
    case "redeploy": case "deploy": return redeployCmd(needName());
    case "list": case "ls": return list(rest);
    case "start": case "stop": case "restart": return lifecycleCmd(cmd, needName());
    case "remove": case "rm": return remove(rest);
    case "logs": return logs(rest);
    case "status": return status(rest);
    case "env": return env(rest);
    case "volume": case "volumes": return volume(rest);
    case "set": return set(rest);
    case "-v": case "--version": case "version": return console.log(VERSION);
    case undefined: case "-h": case "--help": case "help": return console.log(HELP);
    default: throw new SpmError(`commande inconnue : ${cmd}\n\n${HELP}`);
  }
}

main().catch((e) => {
  console.error(e instanceof SpmError ? `spm : ${e.message}` : e);
  process.exit(1);
});
