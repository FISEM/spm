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
  allContainers, compose, composeOk, containerName, docker, dockerOk, imageName, inspectState, toStatus,
  type ContainerInfo,
} from "./docker";
import {
  BUILDS_DIR, getProject, isCompose, loadConfig, loadRegistry, saveRegistry, SpmError, updateProject,
  type ComposeProject, type ContainerProject, type Project, type Status, type Volume,
} from "./registry";

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
  await dockerOk(["build", "-t", imageName(name), "-f", dockerfile, path], r.stream);
  return detected;
}

/** (Re)crée le conteneur depuis la config du registre. `start` : run, sinon create (démarré plus tard). */
async function createContainer(p: ContainerProject, start: boolean): Promise<string> {
  await docker(["rm", "-f", containerName(p.name)]);
  // Créés par nous plutôt que par Docker, sinon ils appartiendraient à root.
  for (const v of p.volumes) if (!isNamedVolume(v)) mkdirSync(v.source, { recursive: true });

  const envFile = join(p.path, ".env");
  const id = await dockerOk(
    [
      ...(start ? ["run", "-d"] : ["create"]),
      "--name", containerName(p.name),
      "--label", `spm.project=${p.name}`,
      "--restart", "unless-stopped",
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

/**
 * Laisse 2 s au conteneur pour planter. Avec --restart unless-stopped, un crash apparaît comme
 * "restarting" ou comme un redémarrage de plus : dans ce cas on coupe la boucle et on renvoie les logs.
 */
async function checkStarted(name: string, restartsBefore: number): Promise<StartResult> {
  await Bun.sleep(2000);
  const s = await inspectState(name);
  if (s?.state === "running" && s.restarts === restartsBefore) {
    updateProject(name, { status: "running" });
    return { ok: true };
  }
  await docker(["stop", "-t", "1", containerName(name)]);
  const logs = await docker(["logs", "--tail", "20", containerName(name)]);
  updateProject(name, { status: "failed" });
  return { ok: false, exitCode: s?.exitCode, logs: [logs.out, logs.err].filter(Boolean).join("\n") };
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

/** Comme checkStarted, pour tous les services d'un projet compose. On ne coupe rien : la politique de redémarrage est la sienne. */
async function checkComposeStarted(p: ComposeProject): Promise<StartResult> {
  await Bun.sleep(3000);
  const containers = await composeContainers(p);
  const status = aggregateStatus(containers);
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

// ---------------------------------------------------------------- opérations

export interface AddOptions {
  path: string;
  name?: string;
  port?: number; // port hôte ; défaut : premier libre
  internalPort?: number; // défaut : détecté
  local?: boolean; // 127.0.0.1 uniquement
  env?: Record<string, string>;
  volumes?: string[];
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
    if (opts.port !== undefined || opts.internalPort !== undefined || opts.local || opts.volumes?.length || Object.keys(opts.env ?? {}).length) {
      throw new SpmError(`${basename(composeFile)} trouvé : ports, env et volumes se règlent dans ce fichier, pas via spm`);
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

  const detected = await buildImage(name, path, r);
  const project: Project = {
    name, path, port,
    bind: opts.local ? "127.0.0.1" : "0.0.0.0",
    mode: "container",
    internal_port: opts.internalPort !== undefined ? parsePort(opts.internalPort) : detected.internalPort,
    kind: detected.kind,
    env: opts.env ?? {},
    volumes,
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
  if (isCompose(found)) {
    // Pas de retour arrière automatique en compose : plusieurs services, images et volumes à coordonner.
    r.step("docker compose up -d --build");
    await composeOk(found, ["up", "-d", "--build"], r.stream);
    return { start: await checkComposeStarted(found), rolledBack: false };
  }
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
    if (status !== p.status) (p.status = status), (changed = true);
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
  if (changed) saveRegistry(reg);
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

export function envList(name: string): Record<string, string> {
  return getContainerProject(name).env;
}

export async function envSet(name: string, vars: Record<string, string>, r: Reporter): Promise<StartResult | null> {
  const p = getContainerProject(name);
  if (!Object.keys(vars).length) throw new SpmError("aucune variable fournie (CLE=valeur)");
  updateProject(name, { env: { ...p.env, ...vars } });
  return applyConfig(name, r);
}

export async function envUnset(name: string, keys: string[], r: Reporter): Promise<StartResult | null> {
  const env = { ...getContainerProject(name).env };
  const unknown = keys.filter((k) => !(k in env));
  if (unknown.length) throw new SpmError(`variable(s) inconnue(s) : ${unknown.join(", ")}`);
  for (const k of keys) delete env[k];
  updateProject(name, { env });
  return applyConfig(name, r);
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
