import { SpmError, type ComposeProject, type Status } from "./registry";

export const containerName = (name: string) => `spm-${name}`;
export const imageName = (name: string) => `spm-${name}`;

interface Result {
  code: number;
  out: string;
  err: string;
}

/**
 * Lance docker. `stream` : sortie directement dans le terminal (build, logs).
 * `env` : variables transmises par l'environnement du processus plutôt que par la ligne de commande
 * (avec `-e CLE` sans valeur), pour que les secrets n'apparaissent pas dans `ps`.
 */
export async function docker(args: string[], stream = false, env?: Record<string, string>): Promise<Result> {
  let proc;
  try {
    proc = Bun.spawn(["docker", ...args], {
      env: env ? { ...process.env, ...env } : undefined,
      stdin: "inherit",
      stdout: stream ? "inherit" : "pipe",
      stderr: stream ? "inherit" : "pipe",
    });
  } catch {
    throw new SpmError("docker introuvable : installe Docker et vérifie qu'il est dans le PATH");
  }
  const [out, err] = stream
    ? ["", ""]
    : await Promise.all([new Response(proc.stdout as ReadableStream).text(), new Response(proc.stderr as ReadableStream).text()]);
  return { code: await proc.exited, out: out.trim(), err: err.trim() };
}

export async function dockerOk(args: string[], stream = false, env?: Record<string, string>): Promise<string> {
  const r = await docker(args, stream, env);
  if (r.code !== 0) {
    const err = r.err.split("\n").slice(-30).join("\n"); // la fin d'un build raté suffit
    throw new SpmError(`docker ${args[0]} a échoué${err ? ` :\n${err}` : ""}`);
  }
  return r.out;
}

export function toStatus(dockerState: string | undefined): Status {
  if (!dockerState) return "missing";
  if (dockerState === "running") return "running";
  if (dockerState === "restarting" || dockerState === "dead") return "failed"; // boucle de crash
  return "stopped";
}

export interface ContainerInfo {
  name: string;
  spmProject: string; // label spm.project
  composeProject: string; // label com.docker.compose.project
  composeDir: string; // label com.docker.compose.project.working_dir
  state: string;
  exitCode: number;
  ports: string[]; // "8002" (toutes interfaces) ou "127.0.0.1:8001"
}

/** Tous les conteneurs de la machine, en un seul appel docker. */
export async function allContainers(): Promise<ContainerInfo[]> {
  const out = await dockerOk([
    "ps", "-a", "--format",
    '{{.Names}}\t{{.Label "spm.project"}}\t{{.Label "com.docker.compose.project"}}\t' +
      '{{.Label "com.docker.compose.project.working_dir"}}\t{{.State}}\t{{.Status}}\t{{.Ports}}',
  ]);
  return out.split("\n").filter(Boolean).map((line) => {
    const [name, spmProject, composeProject, composeDir, state, status, ports] = line.split("\t");
    const exit = status?.match(/Exited \((\d+)\)/);
    return {
      name: name!, spmProject: spmProject!, composeProject: composeProject!, composeDir: composeDir!, state: state!,
      exitCode: exit ? Number(exit[1]) : 0,
      ports: parsePorts(ports ?? ""),
    };
  });
}

/** "127.0.0.1:8001->8000/tcp, 0.0.0.0:8002->3000/tcp, [::]:8002->3000/tcp" → ["127.0.0.1:8001", "8002"] */
function parsePorts(raw: string): string[] {
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const host = part.trim().split("->")[0];
    if (!host || !part.includes("->")) continue;
    const m = host.match(/^(.*):(\d+)$/);
    if (!m) continue;
    seen.add(m[1] === "0.0.0.0" || m[1] === "[::]" || m[1] === "::" ? m[2]! : `${m[1]}:${m[2]}`);
  }
  return [...seen];
}

export function compose(p: ComposeProject, args: string[], stream = false) {
  return docker(["compose", "-f", p.compose_file, "-p", p.compose_project, ...args], stream);
}

export async function composeOk(p: ComposeProject, args: string[], stream = false) {
  const r = await compose(p, args, stream);
  if (r.code !== 0) {
    const err = r.err.split("\n").slice(-30).join("\n");
    throw new SpmError(`docker compose ${args[0]} a échoué${err ? ` :\n${err}` : ""}`);
  }
  return r.out;
}

export async function inspectState(name: string): Promise<{ state: string; exitCode: number; restarts: number } | null> {
  const r = await docker(["inspect", "--format", "{{.State.Status}}\t{{.State.ExitCode}}\t{{.RestartCount}}", containerName(name)]);
  if (r.code !== 0) return null;
  const [state, code, restarts] = r.out.split("\t");
  return { state: state!, exitCode: Number(code), restarts: Number(restarts) };
}
