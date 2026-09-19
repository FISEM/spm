import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const SPM_HOME = process.env.SPM_HOME ?? join(homedir(), ".spm");
export const REGISTRY_PATH = join(SPM_HOME, "registry.json");
export const CONFIG_PATH = join(SPM_HOME, "config.json");
export const BUILDS_DIR = join(SPM_HOME, "builds");

export class SpmError extends Error {}

export type Status = "running" | "partial" | "stopped" | "failed" | "missing";

export interface Volume {
  source: string; // chemin absolu (dossier de l'hôte) ou nom court (volume Docker géré par spm)
  target: string; // chemin dans le conteneur
  readonly?: boolean;
}

interface BaseProject {
  name: string;
  path: string;
  status: Status;
  created_at: string;
}

/** Projet lancé par spm : un conteneur, Dockerfile détecté ou généré. */
export interface ContainerProject extends BaseProject {
  mode?: "container";
  bind: string; // interface hôte : 0.0.0.0 (public) ou 127.0.0.1 (--local)
  port: number; // port hôte
  internal_port: number; // port dans le conteneur
  kind: string;
  env: Record<string, string>;
  volumes: Volume[];
  container_id: string;
}

/** Projet Docker Compose : sa config (ports, env, volumes) reste dans son fichier compose. */
export interface ComposeProject extends BaseProject {
  mode: "compose";
  compose_file: string;
  compose_project: string; // nom de projet compose (label com.docker.compose.project)
}

export type Project = ContainerProject | ComposeProject;

export const isCompose = (p: Project): p is ComposeProject => p.mode === "compose";

export interface Registry {
  projects: Record<string, Project>;
}

export interface Config {
  port_min: number;
  port_max: number;
  caddyfile: string; // lu (jamais modifié) pour afficher les domaines de chaque projet
}

const DEFAULT_CONFIG: Config = { port_min: 8100, port_max: 8999, caddyfile: "/etc/caddy/Caddyfile" };

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (e) {
    throw new SpmError(`${path} est illisible : ${(e as Error).message}`);
  }
}

// Écriture atomique : pas de registre à moitié écrit si la commande est interrompue.
// Mode 600 : le registre contient les variables d'environnement (secrets compris).
function writeJson(path: string, data: unknown) {
  mkdirSync(SPM_HOME, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

export function loadConfig(): Config {
  return { ...DEFAULT_CONFIG, ...readJson<Partial<Config>>(CONFIG_PATH, {}) };
}

export function loadRegistry(): Registry {
  const reg = readJson<Registry>(REGISTRY_PATH, { projects: {} });
  reg.projects ??= {};
  for (const p of Object.values(reg.projects)) {
    if (isCompose(p)) continue;
    // Registres créés par une version antérieure
    p.env ??= {};
    p.volumes ??= [];
    p.bind ??= "0.0.0.0";
  }
  return reg;
}

export function saveRegistry(reg: Registry) {
  writeJson(REGISTRY_PATH, reg);
}

export function getProject(reg: Registry, name: string): Project {
  const p = reg.projects[name];
  if (!p) throw new SpmError(`aucun projet nommé "${name}" (voir : spm list)`);
  return p;
}

export function updateProject(name: string, patch: Partial<ContainerProject> | Partial<ComposeProject>) {
  const reg = loadRegistry();
  const p = getProject(reg, name);
  reg.projects[name] = { ...p, ...patch } as Project;
  saveRegistry(reg);
}
