/**
 * Opérations spm. Aucune n'écrit dans le terminal : elles renvoient des données et signalent
 * leur progression via un Reporter, pour être appelées aussi bien par la CLI que par un serveur MCP.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { caddyDomains } from "./caddy";
import { detect, GENERATED_DOCKERIGNORE, SECRETS_DOCKERIGNORE, type Detected } from "./detect";
import {
  allContainers, allVolumes, compose, composeOk, containerName, docker, dockerOk, imageName, inspectState,
  loggingDriver, mountedVolumes, toStatus,
  type ContainerInfo, type VolumeInfo,
} from "./docker";
import {
  BUILDS_DIR, getProject, isCompose, loadConfig, loadRegistry, saveRegistry, SPM_HOME, SpmError, updateProject,
  type ComposeProject, type ContainerProject, type Project, type Status, type Volume,
} from "./registry";
import {
  definir, fusionnerDotEnv, inventaire, lireDotEnv, supprimer, valeurs,
} from "./secrets";

export interface Reporter {
  step(message: string): void;
  /** true : sortie de docker build en direct dans le terminal ; false : capturée (renvoyée en cas d'échec). */
  stream: boolean;
}

export const quiet: Reporter = { step() {}, stream: false };

export interface StartResult {
  ok: boolean;
  exitCode?: number;
  logs?: string; // dernières lignes du conteneur quand il plante
}

// ---------------------------------------------------------------- validation

export function parsePort(value: string | number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new SpmError(`port invalide : ${value}`);
  return n;
}

const UNITS: Record<string, number> = { b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 };

/** Limite mémoire au format Docker : 512m, 1g… (6m minimum, imposé par Docker). */
export function parseMemory(value: string): string {
  const m = value.trim().toLowerCase().match(/^(\d+)([bkmg]?)$/);
  if (!m) throw new SpmError(`mémoire invalide : ${value} (ex. 512m, 1g)`);
  if (Number(m[1]) * UNITS[m[2] || "b"]! < 6 * UNITS.m!) throw new SpmError(`mémoire trop faible : ${value} (6m minimum)`);
  return `${m[1]}${m[2]}`;
}

export function parseHealth(value: string): string {
  if (!/^\/\S*$/.test(value)) throw new SpmError(`chemin de vérification invalide : ${value} (ex. /health)`);
  return value;
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function parseEnv(pairs: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const pair of pairs) {
    const i = pair.indexOf("=");
    const key = i > 0 ? pair.slice(0, i) : "";
    if (!ENV_KEY.test(key)) throw new SpmError(`variable invalide : "${pair}" (attendu : CLE=valeur)`);
    if (key === "PORT") throw new SpmError("PORT est fixé par spm : utilise --internal-port pour changer le port de l'app");
    env[key] = pair.slice(i + 1);
  }
  return env;
}

/**
 * `source:/cible[:ro]`. Une source qui commence par /, . ou ~ est un dossier de l'hôte
 * (un chemin relatif part du dossier du projet) ; sinon c'est un volume Docker nommé, géré par spm.
 */
export function parseVolume(spec: string, projectPath: string): Volume {
  const parts = spec.split(":");
  const readonly = parts.at(-1) === "ro";
  if (readonly) parts.pop();
  const [src, target] = parts;
  if (parts.length !== 2 || !src || !target) {
    throw new SpmError(`volume invalide : "${spec}" (attendu : source:/chemin/dans/le/conteneur[:ro])`);
  }
  if (!target.startsWith("/")) throw new SpmError(`le chemin dans le conteneur doit être absolu : ${target}`);

  const isPath = /^[/.~]/.test(src);
  if (!isPath && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(src)) throw new SpmError(`nom de volume invalide : ${src}`);
  return {
    source: isPath ? resolve(projectPath, src.replace(/^~(?=\/|$)/, homedir())) : src,
    target: target.replace(/(.)\/+$/, "$1"),
    ...(readonly && { readonly: true }),
  };
}

const isNamedVolume = (v: Volume) => !v.source.startsWith("/");
const dockerVolumeName = (project: string, v: Volume) => `spm-${project}-${v.source}`;

export function describeVolume(project: string, v: Volume): string {
  const src = isNamedVolume(v) ? `${v.source} (volume ${dockerVolumeName(project, v)})` : v.source;
  return `${src} → ${v.target}${v.readonly ? " (lecture seule)" : ""}`;
}

const sanitizeName = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

const COMPOSE_FILES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];

// Durée d'observation après un déploiement compose. Assez longue pour qu'une
// boucle de crash se manifeste (docker espace ses relances), assez courte pour
// ne pas faire attendre un déploiement qui va bien.
const COMPOSE_OBSERVATION_MS = 12_000;

export function findComposeFile(dir: string): string | null {
  const f = COMPOSE_FILES.find((f) => existsSync(join(dir, f)));
  return f ? join(dir, f) : null;
}

/** Projet géré conteneur par conteneur par spm (env, volumes, port) : refusé pour un projet compose. */
function getContainerProject(name: string): ContainerProject {
  const p = getProject(loadRegistry(), name);
  if (isCompose(p)) throw new SpmError(`${name} est un projet Docker Compose : sa configuration se modifie dans ${p.compose_file}`);
  return p;
}

/** "8002" ou "127.0.0.1:8001" → 8002 */
const portNumber = (p: string) => Number(p.split(":").pop());

async function portIsFree(port: number): Promise<boolean> {
  try {
    const s = Bun.listen({ hostname: "0.0.0.0", port, socket: { data() {} } });
    s.stop(true);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ports réservés par les projets spm (même arrêtés) et publiés par n'importe quel conteneur :
 * un bind de test ne les voit pas toujours (userland-proxy désactivé, conteneur arrêté).
 */
async function usedPorts(): Promise<Set<number>> {
  const reserved = Object.values(loadRegistry().projects).flatMap((p) => (isCompose(p) ? [] : [p.port]));
  const published = (await allContainers()).flatMap((c) => c.ports.map(portNumber));
  return new Set([...reserved, ...published]);
}

async function allocatePort(): Promise<number> {
  const { port_min, port_max } = loadConfig();
  const used = await usedPorts();
  for (let port = port_min; port <= port_max; port++) {
    if (!used.has(port) && (await portIsFree(port))) return port;
  }
  throw new SpmError(`plus aucun port libre entre ${port_min} et ${port_max}`);
}

// ---------------------------------------------------------------- docker

async function buildImage(name: string, path: string, r: Reporter): Promise<Detected> {
  if (!existsSync(path)) throw new SpmError(`le dossier du projet n'existe plus : ${path}`);
  const detected = detect(path);
  const ownIgnore = existsSync(join(path, ".dockerignore")) || existsSync(join(path, "Dockerfile.dockerignore"));
  let dockerfile = join(path, "Dockerfile");
  // BuildKit lit <Dockerfile>.dockerignore à côté du Dockerfile : on écrit les deux dans ~/.spm/builds,
  // le contexte reste le dossier du projet, qui n'est jamais modifié.
  const writeBuild = (content: string, ignore: string) => {
    const dir = join(BUILDS_DIR, name);
    mkdirSync(dir, { recursive: true });
    dockerfile = join(dir, "Dockerfile");
    writeFileSync(dockerfile, content);
    writeFileSync(`${dockerfile}.dockerignore`, ignore);
  };
  if (detected.dockerfile) {
    writeBuild(detected.dockerfile, GENERATED_DOCKERIGNORE);
    r.step(`projet ${detected.kind} détecté, Dockerfile généré dans ${dockerfile}`);
  } else if (!ownIgnore) {
    writeBuild(readFileSync(dockerfile, "utf8"), SECRETS_DOCKERIGNORE);
    r.step("Dockerfile du projet utilisé (sans .dockerignore : .env exclu de l'image)");
  } else {
    rmSync(join(BUILDS_DIR, name), { recursive: true, force: true });
    r.step("Dockerfile du projet utilisé");
  }
  r.step(`docker build -t ${imageName(name)}`);
  // Label : permet de retrouver les anciennes images de ce projet pour les nettoyer.
  await dockerOk(["build", "-t", imageName(name), "--label", `spm.project=${name}`, "-f", dockerfile, path], r.stream);
  return detected;
}

/** Supprime les anciennes images du projet, remplacées par un build plus récent (sinon le disque se remplit). */
const pruneImages = (name: string) => docker(["image", "prune", "-f", "--filter", `label=spm.project=${name}`]);

/** (Re)crée le conteneur depuis la config du registre. `start` : run, sinon create (démarré plus tard). */
async function createContainer(p: ContainerProject, start: boolean): Promise<string> {
  await docker(["rm", "-f", containerName(p.name)]);
  // Créés par nous plutôt que par Docker, sinon ils appartiendraient à root.
  for (const v of p.volumes) if (!isNamedVolume(v)) mkdirSync(v.source, { recursive: true });

  const envFile = join(p.path, ".env");
  const { log_max_size, log_max_files } = loadConfig();
  // json-file (défaut de Docker) ne fait aucune rotation : sans ça, les logs finissent par remplir le disque.
  // Les autres pilotes (local, journald…) gèrent déjà la leur.
  const logOpts = (await loggingDriver()) === "json-file"
    ? ["--log-opt", `max-size=${log_max_size}`, "--log-opt", `max-file=${log_max_files}`]
    : [];
  const id = await dockerOk(
    [
      ...(start ? ["run", "-d"] : ["create"]),
      "--name", containerName(p.name),
      "--label", `spm.project=${p.name}`,
      "--restart", "unless-stopped",
      ...logOpts,
      ...(p.memory ? ["--memory", p.memory] : []),
      "-p", `${p.bind}:${p.port}:${p.internal_port}`,
      ...(existsSync(envFile) ? ["--env-file", envFile] : []),
      // -e prime sur --env-file. Valeurs passées par l'environnement, pas en argument.
      ...Object.keys(p.env).flatMap((k) => ["-e", k]),
      // En dernier : doit correspondre au port mappé, quoi que disent .env ou un ancien registre.
      "-e", `PORT=${p.internal_port}`,
      ...p.volumes.flatMap((v) => [
        "-v", `${isNamedVolume(v) ? dockerVolumeName(p.name, v) : v.source}:${v.target}${v.readonly ? ":ro" : ""}`,
      ]),
      imageName(p.name),
    ],
    false,
    p.env,
  );
  const containerId = id.slice(0, 12);
  updateProject(p.name, { container_id: containerId, status: start ? "running" : "stopped" });
  return containerId;
}

const HEALTH_TIMEOUT_MS = 30_000;

type State = Awaited<ReturnType<typeof inspectState>>;
const alive = (s: State, restartsBefore: number) => s?.state === "running" && s.restarts === restartsBefore;

/** Interroge http://127.0.0.1:<port><health> jusqu'à une réponse < 400. Renvoie "" si c'est bon, sinon la raison. */
async function waitHealthy(p: ContainerProject, restartsBefore: number): Promise<string> {
  const url = `http://127.0.0.1:${p.port}${p.health}`;
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5000) });
      if (res.status < 400) return "";
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = (e as Error).message;
    }
    if (!alive(await inspectState(p.name), restartsBefore)) return ""; // crash : signalé par l'appelant
    await Bun.sleep(1000);
  }
  return `${url} ne répond pas correctement après ${HEALTH_TIMEOUT_MS / 1000} s (${last})`;
}

/**
 * Laisse 2 s au conteneur pour planter. Avec --restart unless-stopped, un crash apparaît comme
 * "restarting" ou comme un redémarrage de plus : dans ce cas on coupe la boucle et on renvoie les logs.
 * Avec un chemin `health`, l'app doit en plus répondre en HTTP.
 */
async function checkStarted(name: string, restartsBefore: number): Promise<StartResult> {
  await Bun.sleep(2000);
  let s = await inspectState(name);
  const p = getContainerProject(name);
  let unhealthy = "";
  if (alive(s, restartsBefore) && p.health) {
    unhealthy = await waitHealthy(p, restartsBefore);
    s = await inspectState(name);
  }
  if (alive(s, restartsBefore) && !unhealthy) {
    updateProject(name, { status: "running" });
    return { ok: true };
  }
  await docker(["stop", "-t", "1", containerName(name)]);
  const logs = await docker(["logs", "--tail", "20", containerName(name)]);
  updateProject(name, { status: "failed" });
  return { ok: false, exitCode: s?.exitCode, logs: [unhealthy, logs.out, logs.err].filter(Boolean).join("\n") };
}

/** Applique une nouvelle config (env, volumes) : recrée le conteneur, et le relance s'il tournait. */
async function applyConfig(name: string, r: Reporter): Promise<StartResult | null> {
  const p = getContainerProject(name);
  const s = await inspectState(name);
  const running = s?.state === "running" || s?.state === "restarting";
  r.step(running ? "recréation du conteneur avec la nouvelle configuration" : "enregistré, appliqué au prochain démarrage");
  await createContainer(p, running);
  return running ? checkStarted(name, 0) : null;
}

function containerStatus(c: ContainerInfo): Status {
  const s = toStatus(c.state);
  // Arrêté par un crash (et non par docker stop : 137/143) → failed
  return s === "stopped" && ![0, 137, 143].includes(c.exitCode) ? "failed" : s;
}

function aggregateStatus(containers: ContainerInfo[]): Status {
  if (!containers.length) return "missing";
  const all = containers.map(containerStatus);
  if (all.every((s) => s === "running")) return "running";
  if (all.includes("failed")) return "failed";
  return all.includes("running") ? "partial" : "stopped";
}

const composeContainers = async (p: ComposeProject) =>
  (await allContainers()).filter((c) => c.composeProject === p.compose_project);

/** Nombre de redémarrages de chaque conteneur du projet, à un instant donné. */
async function redemarrages(p: ComposeProject): Promise<Map<string, number>> {
  const compte = new Map<string, number>();
  for (const c of await composeContainers(p)) {
    compte.set(c.name, (await inspectState(c.name))?.restarts ?? 0);
  }
  return compte;
}

/**
 * Comme checkStarted, pour tous les services d'un projet compose. On ne coupe
 * rien : la politique de redémarrage est la sienne.
 *
 * La surveillance dure plusieurs secondes, et pas un instantané : un conteneur
 * qui plante au démarrage et que docker relance **oscille** entre « démarré »
 * et « redémarrage ». Un seul coup d'œil tombait une fois sur deux sur un
 * moment où il tournait, et spm annonçait un succès sur un service mort —
 * constaté en provoquant la panne pour de vrai.
 */
async function checkComposeStarted(p: ComposeProject, avant?: Map<string, number>): Promise<StartResult> {
  const deadline = Date.now() + COMPOSE_OBSERVATION_MS;
  let containers = await composeContainers(p);
  let status: Status = "missing";

  while (Date.now() < deadline) {
    await Bun.sleep(1500);
    containers = await composeContainers(p);
    status = aggregateStatus(containers);
    if (status !== "running") break;

    // Un conteneur qui a redémarré depuis le déploiement est en train de
    // tomber, même s'il paraît debout à cet instant précis.
    const maintenant = await redemarrages(p);
    const relance = [...maintenant].find(([nom, n]) => n > (avant?.get(nom) ?? 0));
    if (relance) {
      status = "failed";
      break;
    }
  }

  updateProject(p.name, { status });
  if (status === "running") return { ok: true };
  const bad = containers.filter((c) => containerStatus(c) !== "running");
  const logs = await compose(p, ["logs", "--tail", "20", "--no-color"]);
  return {
    ok: false,
    exitCode: bad.find((c) => c.exitCode)?.exitCode,
    logs: `services en échec : ${bad.map((c) => c.name).join(", ") || "aucun conteneur"}\n${[logs.out, logs.err].filter(Boolean).join("\n")}`,
  };
}

/**
 * Parmi les images déclarées par un fichier compose, celles que ce projet
 * construit lui-même — les seules qui changent d'un déploiement à l'autre.
 *
 * Les images tirées d'un registre (postgres, redis, nginx) sont écartées :
 * les étiqueter comme secours ne protégerait de rien, et remettre une ancienne
 * image de base sur une base de données serait même dangereux.
 *
 * Reconnaissance par préfixe, comme docker compose nomme ce qu'il construit :
 * `<projet>-<service>` (ou `_` sur les anciennes versions).
 */
export function imagesConstruites(declarees: string[], composeProject: string): { image: string; secours: string }[] {
  return declarees
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((i) => i.startsWith(`${composeProject}-`) || i.startsWith(`${composeProject}_`))
    .map((image) => ({ image, secours: `${image.split(":")[0]}:spm-previous` }));
}

async function composeImages(p: ComposeProject): Promise<{ image: string; secours: string }[]> {
  const { out } = await compose(p, ["config", "--images"]);
  return imagesConstruites(out.split("\n"), p.compose_project);
}

/**
 * Redéploie un projet compose, avec retour arrière.
 *
 * Ce que ça change par rapport à `docker compose up -d --build` : avant de
 * construire, on étiquette les images en service comme images de secours. Si
 * le nouveau code ne démarre pas, on les remet et on relance — au lieu de
 * laisser le service mort avec rien pour revenir, ce qui était le seul défaut
 * capable de coûter une soirée.
 *
 * Ce que ça ne fait **pas** : supprimer l'interruption. L'ancien conteneur est
 * remplacé, donc le service est absent une dizaine de secondes. Servir les
 * deux versions en parallèle demanderait un second port et une bascule dans
 * Caddy — et surtout que chaque migration reste compatible avec la version
 * précédente, puisque les deux parleraient à la même base. C'est une autre
 * décision, à prendre en connaissance de cause.
 */
async function redeployCompose(p: ComposeProject, r: Reporter): Promise<{ start: StartResult; rolledBack: boolean }> {
  // Avant tout le reste : le `.env` que docker compose lira. C'est le seul
  // moment où le coffre intervient — ensuite spm s'efface, et les conteneurs
  // tournent sans dépendre de lui.
  ecrireEnvDepuisLeCoffre(p, r);

  const images = await composeImages(p);

  // 1. Filet de sécurité : les images en service deviennent les images de secours.
  const gardees: { image: string; secours: string }[] = [];
  for (const { image, secours } of images) {
    if ((await docker(["image", "inspect", image])).code !== 0) continue; // première construction
    if ((await docker(["tag", image, secours])).code === 0) gardees.push({ image, secours });
  }
  if (gardees.length) r.step(`filet : ${gardees.length} image(s) étiquetée(s) pour un retour arrière`);

  // 2. Construction pendant que l'ancienne version sert encore : c'est la
  //    partie longue, et elle n'interrompt rien.
  r.step("docker compose build");
  try {
    await composeOk(p, ["build"], r.stream);
  } catch (e) {
    r.step("construction échouée : le service en place n'a pas été touché");
    throw e;
  }

  // 3. Remplacement : c'est ici, et seulement ici, que le service s'absente.
  const avant = await redemarrages(p);
  r.step("docker compose up -d");
  await composeOk(p, ["up", "-d"], r.stream);

  const start = await checkComposeStarted(p, avant);
  if (start.ok || !gardees.length) return { start, rolledBack: false };

  // 4. Le nouveau code ne tient pas : on remet l'ancien.
  r.step("démarrage raté — retour à la version précédente");
  for (const { image, secours } of gardees) await docker(["tag", secours, image]);
  const avantRetour = await redemarrages(p);
  await composeOk(p, ["up", "-d", "--force-recreate"], r.stream);
  const retour = await checkComposeStarted(p, avantRetour);

  return {
    start: retour.ok
      ? { ...start, logs: `${start.logs ?? ""}\n\nversion précédente rétablie : le service répond de nouveau`.trim() }
      : { ...retour, logs: `${start.logs ?? ""}\n\nle retour arrière a échoué lui aussi :\n${retour.logs ?? ""}`.trim() },
    rolledBack: true,
  };
}

// ---------------------------------------------------------------- opérations

export interface AddOptions {
  path: string;
  name?: string;
  port?: number; // port hôte ; défaut : premier libre
  internalPort?: number; // défaut : détecté
  local?: boolean; // 127.0.0.1 uniquement
  env?: Record<string, string>;
  volumes?: string[];
  memory?: string; // ex. 512m
  health?: string; // ex. /health
}

export async function addProject(opts: AddOptions, r: Reporter): Promise<{ project: Project; start: StartResult }> {
  const path = resolve(opts.path);
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new SpmError(`${path} n'est pas un dossier`);

  const name = sanitizeName(opts.name ?? basename(path));
  if (!name) throw new SpmError("nom de projet vide : précise un nom");

  const reg = loadRegistry();
  if (reg.projects[name]) throw new SpmError(`le projet "${name}" existe déjà (spm redeploy ${name} pour le mettre à jour)`);

  const composeFile = findComposeFile(path);
  if (composeFile) {
    if (
      opts.port !== undefined || opts.internalPort !== undefined || opts.local || opts.volumes?.length ||
      Object.keys(opts.env ?? {}).length || opts.memory || opts.health
    ) {
      throw new SpmError(`${basename(composeFile)} trouvé : ports, env, volumes et limites se règlent dans ce fichier, pas via spm`);
    }
    return addCompose(name, path, composeFile, r);
  }

  // Tout est validé avant le build, pour échouer vite.
  let port: number;
  if (opts.port !== undefined) {
    port = parsePort(opts.port);
    const owner = Object.values(reg.projects).find((p) => !isCompose(p) && p.port === port);
    if (owner) throw new SpmError(`le port ${port} est déjà utilisé par "${owner.name}"`);
    if ((await usedPorts()).has(port) || !(await portIsFree(port))) throw new SpmError(`le port ${port} est déjà occupé sur la machine`);
  } else {
    port = await allocatePort();
  }
  const volumes = (opts.volumes ?? []).map((v) => parseVolume(v, path));
  const targets = volumes.map((v) => v.target);
  const dup = targets.find((t, i) => targets.indexOf(t) !== i);
  if (dup) throw new SpmError(`deux volumes montés sur ${dup}`);
  const memory = opts.memory !== undefined ? parseMemory(opts.memory) : undefined;
  const health = opts.health !== undefined ? parseHealth(opts.health) : undefined;

  const detected = await buildImage(name, path, r);
  const project: Project = {
    name, path, port,
    bind: opts.local ? "127.0.0.1" : "0.0.0.0",
    mode: "container",
    internal_port: opts.internalPort !== undefined ? parsePort(opts.internalPort) : detected.internalPort,
    kind: detected.kind,
    env: opts.env ?? {},
    volumes,
    ...(memory && { memory }),
    ...(health && { health }),
    container_id: "",
    status: "stopped",
    created_at: new Date().toISOString(),
  };

  // Enregistré avant le lancement : même si le conteneur plante, le projet reste gérable (logs, redeploy).
  const fresh = loadRegistry();
  fresh.projects[name] = project;
  saveRegistry(fresh);

  r.step(`docker run spm-${name} (${project.bind}:${port} → ${project.internal_port})`);
  try {
    await createContainer(project, true);
  } catch (e) {
    updateProject(name, { status: "failed" });
    throw e;
  }
  const start = await checkStarted(name, 0);
  return { project: getProject(loadRegistry(), name), start };
}

async function composeProjectFor(path: string): Promise<{ name: string; running: boolean }> {
  const existing = (await allContainers()).find((c) => c.composeDir === path && c.composeProject);
  // Même règle de nommage que docker compose, pour retrouver les conteneurs déjà créés.
  return { name: existing?.composeProject ?? basename(path).toLowerCase().replace(/[^a-z0-9_-]/g, ""), running: !!existing };
}

function registerCompose(name: string, path: string, composeFile: string, composeProject: string): ComposeProject {
  const reg = loadRegistry();
  const project: ComposeProject = {
    name, path, mode: "compose",
    compose_file: composeFile,
    compose_project: composeProject,
    status: "missing",
    created_at: new Date().toISOString(),
  };
  reg.projects[name] = project;
  saveRegistry(reg);
  return project;
}

async function addCompose(name: string, path: string, composeFile: string, r: Reporter) {
  const { name: composeProject, running } = await composeProjectFor(path);
  if (running) throw new SpmError(`ce projet compose tourne déjà : spm import ${path} l'enregistre sans rien relancer`);
  const project = registerCompose(name, path, composeFile, composeProject);
  r.step(`docker compose up -d --build (${basename(composeFile)})`);
  await composeOk(project, ["up", "-d", "--build"], r.stream);
  const start = await checkComposeStarted(project);
  return { project: getProject(loadRegistry(), name), start };
}

/** Enregistre un projet compose existant, sans rien builder ni relancer. */
export async function importProject(dir: string, name?: string): Promise<{ project: Project; status: Status }> {
  const path = resolve(dir);
  const composeFile = findComposeFile(path);
  if (!composeFile) throw new SpmError(`aucun fichier compose dans ${path} (pour un projet sans compose : spm add)`);

  const projectName = sanitizeName(name ?? basename(path));
  const reg = loadRegistry();
  if (reg.projects[projectName]) throw new SpmError(`le projet "${projectName}" existe déjà (--name autre-nom)`);
  const same = Object.values(reg.projects).find((p) => p.path === path);
  if (same) throw new SpmError(`${path} est déjà enregistré sous le nom "${same.name}"`);

  const { name: composeProject } = await composeProjectFor(path);
  const project = registerCompose(projectName, path, composeFile, composeProject);
  const status = aggregateStatus(await composeContainers(project));
  updateProject(projectName, { status });
  return { project: getProject(loadRegistry(), projectName), status };
}

/**
 * Rebuild depuis le dossier du projet et remplace le conteneur, en gardant port, env et volumes.
 * L'ancien conteneur tourne pendant le build. Si la nouvelle version plante, retour à la précédente.
 */
export async function redeploy(name: string, r: Reporter): Promise<{ start: StartResult; rolledBack: boolean }> {
  const found = getProject(loadRegistry(), name);
  if (isCompose(found)) return redeployCompose(found, r);
  const p = found;
  const previous = `${imageName(name)}:previous`;
  const hadImage = (await docker(["image", "inspect", imageName(name)])).code === 0;
  if (hadImage) await dockerOk(["tag", imageName(name), previous]);

  let detected: Detected;
  try {
    detected = await buildImage(name, p.path, r);
  } catch (e) {
    if (hadImage) await docker(["rmi", previous]); // build raté : l'ancien conteneur n'a pas été touché
    throw e;
  }
  const result = await replaceContainer(p, detected, hadImage, previous, r);
  await pruneImages(name);
  return result;
}

/** Remplace le conteneur par la nouvelle image ; si elle plante, relance `previous`. */
async function replaceContainer(
  p: ContainerProject, detected: Detected, hadImage: boolean, previous: string, r: Reporter,
): Promise<{ start: StartResult; rolledBack: boolean }> {
  const { name } = p;
  r.step("remplacement du conteneur");
  let start: StartResult;
  try {
    await createContainer(p, true);
    start = await checkStarted(name, 0);
  } catch (e) {
    // Ex. : port pris entre-temps. L'ancien conteneur est déjà supprimé : on passe au retour arrière.
    if (!(e instanceof SpmError)) throw e;
    updateProject(name, { status: "failed" });
    start = { ok: false, logs: e.message };
  }
  if (start.ok) updateProject(name, { kind: detected.kind });
  if (start.ok || !hadImage) {
    if (hadImage) await docker(["rmi", previous]);
    return { start, rolledBack: false };
  }

  r.step("la nouvelle version plante : retour à la version précédente");
  await dockerOk(["tag", previous, imageName(name)]);
  await docker(["rmi", previous]);
  await createContainer(p, true);
  const again = await checkStarted(name, 0);
  return { start, rolledBack: again.ok };
}

export async function lifecycle(name: string, action: "start" | "stop" | "restart", r: Reporter): Promise<StartResult> {
  const p = getProject(loadRegistry(), name);
  if (isCompose(p)) {
    // "up -d" plutôt que "start" : recrée aussi les conteneurs supprimés, sans rebuild.
    await composeOk(p, action === "start" ? ["up", "-d"] : [action]);
    if (action !== "stop") return checkComposeStarted(p);
    updateProject(name, { status: "stopped" });
    return { ok: true };
  }
  const s = await inspectState(name);

  if (action === "stop") {
    if (s) await dockerOk(["stop", containerName(name)]);
    updateProject(name, { status: "stopped" });
    return { ok: true };
  }
  if (!s) {
    // Conteneur supprimé à la main : on le recrée depuis l'image.
    r.step(`conteneur absent, recréation depuis ${imageName(name)}`);
    await createContainer(p, true);
    return checkStarted(name, 0);
  }
  await dockerOk([action, containerName(name)]);
  return checkStarted(name, s.restarts);
}

export interface RemoveOptions {
  down?: boolean; // compose : arrête et supprime aussi les conteneurs (sinon : simple désenregistrement)
  purge?: boolean; // supprime aussi les volumes Docker (données)
}

export async function removeProject(name: string, opts: RemoveOptions = {}): Promise<{ keptVolumes: string[]; untouched: boolean }> {
  const reg = loadRegistry();
  const p = getProject(reg, name);

  if (isCompose(p)) {
    // Par défaut on ne touche à rien : un projet importé tourne souvent en production.
    if (opts.down || opts.purge) await composeOk(p, ["down", ...(opts.purge ? ["-v"] : [])]);
    delete reg.projects[name];
    saveRegistry(reg);
    return { keptVolumes: [], untouched: !(opts.down || opts.purge) };
  }

  await docker(["rm", "-f", containerName(name)]);
  await docker(["rmi", imageName(name)]);
  await docker(["rmi", `${imageName(name)}:previous`]);
  await pruneImages(name);
  rmSync(join(BUILDS_DIR, name), { recursive: true, force: true });

  // Les données ne sont jamais supprimées sans --purge.
  const named = p.volumes.filter(isNamedVolume).map((v) => dockerVolumeName(name, v));
  if (opts.purge) for (const v of named) await docker(["volume", "rm", v]);
  const keptVolumes = opts.purge ? [] : [...named, ...p.volumes.filter((v) => !isNamedVolume(v)).map((v) => v.source)];

  delete reg.projects[name];
  saveRegistry(reg);
  return { keptVolumes, untouched: false };
}

export interface ProjectRow {
  name: string;
  mode: "container" | "compose";
  kind: string;
  status: Status;
  ports: string[];
  domains: string[];
  path: string;
}

function domainsFor(ports: string[], caddy: Map<number, string[]>): string[] {
  return [...new Set(ports.flatMap((p) => caddy.get(portNumber(p)) ?? []))];
}

function containersOf(p: Project, all: ContainerInfo[]): ContainerInfo[] {
  return all.filter((c) => (isCompose(p) ? c.composeProject === p.compose_project : c.spmProject === p.name));
}

function portsOf(p: Project, containers: ContainerInfo[]): string[] {
  const live = [...new Set(containers.flatMap((c) => c.ports))];
  if (live.length || isCompose(p)) return live;
  return [p.bind === "127.0.0.1" ? `127.0.0.1:${p.port}` : String(p.port)]; // conteneur arrêté : port réservé
}

/** Vue d'ensemble : état réel (un seul appel docker), ports et domaines Caddy. Le registre est resynchronisé. */
export async function listProjects(): Promise<ProjectRow[]> {
  const reg = loadRegistry();
  const all = await allContainers();
  const caddy = caddyDomains(loadConfig().caddyfile);
  let changed = false;

  const rows = Object.values(reg.projects).map((p): ProjectRow => {
    const containers = containersOf(p, all);
    const status = aggregateStatus(containers);
    if (status !== p.status) changed = true;
    const ports = portsOf(p, containers);
    return {
      name: p.name,
      mode: isCompose(p) ? "compose" : "container",
      kind: isCompose(p) ? "compose" : p.kind,
      status, ports,
      domains: domainsFor(ports, caddy),
      path: p.path,
    };
  });
  if (changed) {
    // Relu juste avant d'écrire : list ne prend pas le verrou et ne doit pas écraser une commande en cours.
    const fresh = loadRegistry();
    for (const row of rows) if (fresh.projects[row.name]) fresh.projects[row.name]!.status = row.status;
    saveRegistry(fresh);
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/** Conteneurs de la machine qui n'appartiennent à aucun projet spm : candidats à `spm import`. */
export async function unmanagedContainers(): Promise<ContainerInfo[]> {
  const reg = loadRegistry();
  const all = await allContainers();
  const managed = new Set(Object.values(reg.projects).flatMap((p) => containersOf(p, all).map((c) => c.name)));
  return all.filter((c) => !managed.has(c.name));
}

export interface ContainerStats {
  cpu: string;
  memory: string;
  memoryPercent: string;
  network: string;
  disk: string;
  pids: string;
}

export interface ProjectStatus {
  project: Project;
  status: Status;
  domains: string[];
  containers: (ContainerInfo & { stats: ContainerStats | null })[];
}

export async function projectStatus(name: string): Promise<ProjectStatus> {
  const project = getProject(loadRegistry(), name);
  const containers = containersOf(project, await allContainers());
  const running = containers.filter((c) => c.state === "running").map((c) => c.name);

  const stats = new Map<string, ContainerStats>();
  if (running.length) {
    const out = await dockerOk(["stats", "--no-stream", "--format", "{{json .}}", ...running]);
    for (const line of out.split("\n").filter(Boolean)) {
      const raw = JSON.parse(line);
      stats.set(raw.Name, { cpu: raw.CPUPerc, memory: raw.MemUsage, memoryPercent: raw.MemPerc, network: raw.NetIO, disk: raw.BlockIO, pids: raw.PIDs });
    }
  }
  return {
    project,
    status: aggregateStatus(containers),
    domains: domainsFor(portsOf(project, containers), caddyDomains(loadConfig().caddyfile)),
    containers: containers.map((c) => ({ ...c, stats: stats.get(c.name) ?? null })),
  };
}

// ---------------------------------------------------------------- env

/**
 * Les variables vivent dans le coffre (`~/.spm/secrets.json`, chiffré), pour
 * tous les projets — conteneur comme compose.
 *
 * Avant, `spm env` refusait les projets compose en renvoyant l'utilisateur vers
 * son `docker-compose.yml`, ce qui était exact et inutile : le compose lit un
 * `.env` que personne ne gérait. Désormais spm écrit ce `.env` au déploiement.
 *
 * Les projets conteneur déjà enregistrés gardent leurs variables dans le
 * registre : elles sont reversées dans le coffre à la première lecture, pour
 * qu'une installation existante n'ait rien à faire.
 */
function migrerDepuisLeRegistre(name: string) {
  const p = getProject(loadRegistry(), name);
  if (isCompose(p) || !Object.keys(p.env).length) return;
  if (inventaire(name).length) return; // déjà migré
  definir(name, p.env);
}

export function envList(name: string): { cle: string; modifie: string }[] {
  getProject(loadRegistry(), name);
  migrerDepuisLeRegistre(name);
  return inventaire(name);
}

export function envReveal(name: string): Record<string, string> {
  getProject(loadRegistry(), name);
  migrerDepuisLeRegistre(name);
  return valeurs(name);
}

export async function envSet(name: string, vars: Record<string, string>, r: Reporter): Promise<StartResult | null> {
  const p = getProject(loadRegistry(), name);
  if (!Object.keys(vars).length) throw new SpmError("aucune variable fournie (CLE=valeur)");
  migrerDepuisLeRegistre(name);
  definir(name, vars);
  // Un projet compose relit son `.env` au prochain déploiement : on ne
  // redémarre rien ici, pour ne pas couper un service sur un `env set`.
  if (isCompose(p)) {
    r.step(`${Object.keys(vars).length} variable(s) enregistrée(s) — actives au prochain spm redeploy ${name}`);
    return null;
  }
  updateProject(name, { env: { ...p.env, ...vars } });
  return applyConfig(name, r);
}

export async function envUnset(name: string, keys: string[], r: Reporter): Promise<StartResult | null> {
  const p = getProject(loadRegistry(), name);
  migrerDepuisLeRegistre(name);
  const connues = new Set(inventaire(name).map((v) => v.cle));
  const inconnues = keys.filter((k) => !connues.has(k));
  if (inconnues.length) throw new SpmError(`variable(s) inconnue(s) : ${inconnues.join(", ")}`);
  supprimer(name, keys);
  if (isCompose(p)) {
    r.step(`${keys.length} variable(s) retirée(s) du coffre — le .env sera nettoyé au prochain redeploy`);
    return null;
  }
  const env = { ...p.env };
  for (const k of keys) delete env[k];
  updateProject(name, { env });
  return applyConfig(name, r);
}

/** Avale un `.env` existant : c'est la porte d'entrée pour un projet déjà en place. */
export function envImport(name: string, r: Reporter): number {
  const p = getProject(loadRegistry(), name);
  const fichier = join(p.path, ".env");
  if (!existsSync(fichier)) throw new SpmError(`pas de .env dans ${p.path}`);
  const vars = lireDotEnv(readFileSync(fichier, "utf8"));
  if (!Object.keys(vars).length) throw new SpmError(`${fichier} ne contient aucune variable lisible`);
  definir(name, vars);
  r.step(`${Object.keys(vars).length} variable(s) reprises depuis ${fichier}`);
  return Object.keys(vars).length;
}

/**
 * Écrit le `.env` du projet depuis le coffre, juste avant un déploiement.
 *
 * Fusion et non remplacement : un `.env` peut contenir des variables que le
 * coffre ne connaît pas encore, et les écraser effacerait des secrets que
 * personne n'a ailleurs. Une copie de l'original est gardée la première fois.
 *
 * Cette copie va dans `~/.spm/anciens-env/`, **jamais** à côté du `.env`. La
 * première version la déposait dans le dossier du projet, c'est-à-dire dans un
 * arbre git : un dépôt dont le `.gitignore` ne listait que `.env` (et pas
 * `.env.*`) se retrouvait à un `git add -A` de publier ses secrets. spm ne doit
 * pas créer, dans le dossier de quelqu'un, un fichier qu'il ne lui a pas
 * demandé d'ignorer.
 */
export const ANCIENS_ENV = join(SPM_HOME, "anciens-env");

export function ecrireEnvDepuisLeCoffre(p: Project, r: Reporter) {
  const duCoffre = valeurs(p.name);
  if (!Object.keys(duCoffre).length) return;

  const fichier = join(p.path, ".env");
  const existant = existsSync(fichier) ? readFileSync(fichier, "utf8") : "";
  const sauvegarde = join(ANCIENS_ENV, `${p.name}.env`);
  if (existant && !existsSync(sauvegarde)) {
    mkdirSync(ANCIENS_ENV, { recursive: true, mode: 0o700 });
    writeFileSync(sauvegarde, existant, { mode: 0o600 });
    r.step(`copie de l'ancien .env dans ${sauvegarde}`);
  }

  const fusionne = fusionnerDotEnv(existant, duCoffre);
  if (fusionne === existant) return;
  writeFileSync(fichier, fusionne, { mode: 0o600 });
  r.step(`.env écrit depuis le coffre (${Object.keys(duCoffre).length} variable(s))`);
}

// ---------------------------------------------------------------- volumes

export function volumeList(name: string): Volume[] {
  return getContainerProject(name).volumes;
}

export async function volumeAdd(name: string, spec: string, r: Reporter): Promise<StartResult | null> {
  const p = getContainerProject(name);
  const v = parseVolume(spec, p.path);
  if (p.volumes.some((x) => x.target === v.target)) throw new SpmError(`un volume est déjà monté sur ${v.target}`);
  updateProject(name, { volumes: [...p.volumes, v] });
  return applyConfig(name, r);
}

/** Démonte un volume. Ses données restent (volume Docker ou dossier de l'hôte). */
export async function volumeRemove(name: string, target: string, r: Reporter): Promise<StartResult | null> {
  const p = getContainerProject(name);
  const t = target.replace(/(.)\/+$/, "$1");
  if (!p.volumes.some((v) => v.target === t)) throw new SpmError(`aucun volume monté sur ${t}`);
  updateProject(name, { volumes: p.volumes.filter((v) => v.target !== t) });
  return applyConfig(name, r);
}

// ---------------------------------------------------------------- réglages

const SETTINGS = { memory: parseMemory, health: parseHealth } as const;
export type Setting = keyof typeof SETTINGS;
export const SETTING_NAMES = Object.keys(SETTINGS) as Setting[];

/** memory=512m, health=/health ; une valeur vide retire le réglage. Recrée le conteneur s'il tournait. */
export async function setOptions(name: string, pairs: string[], r: Reporter): Promise<StartResult | null> {
  getContainerProject(name);
  if (!pairs.length) throw new SpmError(`aucun réglage fourni (${SETTING_NAMES.map((k) => `${k}=…`).join(", ")})`);
  const patch: Partial<ContainerProject> = {};
  for (const pair of pairs) {
    const i = pair.indexOf("=");
    const key = pair.slice(0, i) as Setting;
    if (i < 0 || !(key in SETTINGS)) throw new SpmError(`réglage inconnu : "${pair}" (possibles : ${SETTING_NAMES.join(", ")})`);
    const value = pair.slice(i + 1);
    patch[key] = value ? SETTINGS[key](value) : undefined;
  }
  updateProject(name, patch);
  return applyConfig(name, r);
}

// ---------------------------------------------------------------- volumes Docker

export interface ProjectVolume {
  name: string;
  used: boolean; // monté par un conteneur, même arrêté
  declared: boolean; // encore décrit par la config du projet
}

/**
 * Les volumes Docker qui appartiennent à un projet.
 *
 * Compose les étiquette (`com.docker.compose.project`) ; spm nomme les siens
 * `spm-<projet>-<source>`. Un volume retiré du docker-compose.yml garde son
 * étiquette : c'est ainsi qu'on retrouve les orphelins d'un changement
 * d'architecture, que plus aucun outil ne suivrait autrement.
 */
export function belongsToProject(v: VolumeInfo, p: Project): boolean {
  return isCompose(p)
    ? v.composeProject === p.compose_project
    : v.spmProject === p.name || v.name.startsWith(`spm-${p.name}-`);
}

export async function projectVolumes(name: string): Promise<ProjectVolume[]> {
  const p = getProject(loadRegistry(), name);
  const [volumes, montes] = await Promise.all([allVolumes(), mountedVolumes()]);
  const declares = new Set(
    isCompose(p) ? [] : p.volumes.filter(isNamedVolume).map((v) => dockerVolumeName(p.name, v)),
  );
  return volumes
    .filter((v) => belongsToProject(v, p))
    .map((v) => ({
      name: v.name,
      used: montes.has(v.name),
      // En compose, la config vit dans le fichier : un volume monté est, de fait, déclaré.
      declared: isCompose(p) ? montes.has(v.name) : declares.has(v.name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Volumes du projet que plus rien n'utilise : candidats à la suppression. */
export const orphanVolumes = (volumes: ProjectVolume[]): ProjectVolume[] =>
  volumes.filter((v) => !v.used && !v.declared);

/**
 * Supprime les volumes orphelins du projet. Les données qu'ils contiennent
 * sont perdues : l'appelant doit avoir obtenu un accord explicite.
 */
export async function pruneVolumes(name: string): Promise<{ removed: string[]; failed: string[] }> {
  const orphelins = orphanVolumes(await projectVolumes(name));
  const removed: string[] = [];
  const failed: string[] = [];
  for (const v of orphelins) {
    // Docker refuse de supprimer un volume utilisé : dernière sécurité si un
    // conteneur est apparu entre la liste et la suppression.
    ((await docker(["volume", "rm", v.name])).code === 0 ? removed : failed).push(v.name);
  }
  return { removed, failed };
}
