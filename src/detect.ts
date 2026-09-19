import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SpmError } from "./registry";

export interface Detected {
  kind: "dockerfile" | "bun" | "node" | "fastapi" | "python";
  internalPort: number;
  /** Contenu du Dockerfile généré, ou null si le projet a déjà le sien. */
  dockerfile: string | null;
}

const has = (dir: string, f: string) => existsSync(join(dir, f));
const read = (dir: string, f: string) => (has(dir, f) ? readFileSync(join(dir, f), "utf8") : "");

function packageScripts(dir: string): Record<string, string> {
  try {
    return JSON.parse(read(dir, "package.json")).scripts ?? {};
  } catch {
    throw new SpmError("package.json invalide");
  }
}

function requireStartScript(scripts: Record<string, string>) {
  if (!scripts.start) throw new SpmError('package.json n\'a pas de script "start" : ajoute-en un ou fournis un Dockerfile');
}

/**
 * Ordre de détection : du plus spécifique au plus générique.
 * FastAPI passe avant requirements.txt, car un projet FastAPI a presque toujours un requirements.txt.
 */
export function detect(dir: string): Detected {
  if (has(dir, "Dockerfile")) {
    const expose = read(dir, "Dockerfile").match(/^\s*EXPOSE\s+(\d+)/im);
    return { kind: "dockerfile", internalPort: expose ? Number(expose[1]) : 3000, dockerfile: null };
  }

  if (has(dir, "package.json")) {
    const scripts = packageScripts(dir);
    requireStartScript(scripts);
    const build = scripts.build ? "RUN %s run build\n" : "";

    if (has(dir, "bun.lockb") || has(dir, "bun.lock")) {
      return {
        kind: "bun",
        internalPort: 3000,
        dockerfile: `FROM oven/bun:1-alpine
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile
COPY . .
${build.replace("%s", "bun")}ENV NODE_ENV=production PORT=3000
EXPOSE 3000
CMD ["bun", "run", "start"]
`,
      };
    }

    const install = has(dir, "package-lock.json") ? "npm ci" : "npm install";
    return {
      kind: "node",
      internalPort: 3000,
      dockerfile: `FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN ${install}
COPY . .
${build.replace("%s", "npm")}ENV NODE_ENV=production PORT=3000
EXPOSE 3000
CMD ["npm", "start"]
`,
    };
  }

  const reqs = read(dir, "requirements.txt");
  const pipInstall = reqs ? "COPY requirements.txt ./\nRUN pip install --no-cache-dir -r requirements.txt\n" : "";

  if (has(dir, "main.py") && (/fastapi/i.test(reqs) || /^\s*(from|import)\s+fastapi/m.test(read(dir, "main.py")))) {
    // uvicorn est ajouté même s'il manque du requirements.txt, sinon le CMD échoue.
    const extra = /^uvicorn/im.test(reqs) ? "" : `RUN pip install --no-cache-dir ${reqs ? "" : "fastapi "}"uvicorn[standard]"\n`;
    return {
      kind: "fastapi",
      internalPort: 8000,
      dockerfile: `FROM python:3.12-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PORT=8000
${pipInstall}${extra}COPY . .
EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
`,
    };
  }

  if (reqs) {
    const entry = ["main.py", "app.py", "server.py"].find((f) => has(dir, f));
    if (!entry) throw new SpmError("requirements.txt trouvé, mais aucun point d'entrée (main.py, app.py, server.py)");
    return {
      kind: "python",
      internalPort: 8000,
      dockerfile: `FROM python:3.12-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PORT=8000
${pipInstall}COPY . .
EXPOSE 8000
CMD ["python", "${entry}"]
`,
    };
  }

  throw new SpmError(`type de projet non reconnu dans ${dir} (attendu : Dockerfile, package.json, requirements.txt ou main.py FastAPI)`);
}

/** Exclusions de contexte pour les Dockerfiles générés (lu par BuildKit à côté du Dockerfile). */
export const GENERATED_DOCKERIGNORE = `.git
node_modules
.venv
venv
__pycache__
*.pyc
.env
.env.*
Dockerfile*
`;
