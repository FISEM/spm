# spm

PaaS personnel minimaliste : un binaire unique qui détecte, conteneurise et lance tes projets, chacun sur son port.

```
spm add ./blog  →  docker build + docker run  →  http://<IP du VPS>:8100
```

spm ne configure ni domaine, ni TLS, ni reverse proxy : il ouvre des ports, c'est tout.
S'il trouve un Caddyfile, il le lit (sans jamais le modifier) pour afficher les domaines de chaque projet.

La logique vit dans `src/core.ts` (fonctions qui renvoient des données, sans rien afficher) ;
`src/spm.ts` n'est que la CLI. Un futur serveur MCP pourra appeler `core.ts` directement.

## Installation

```sh
curl -sL https://tondomaine.com/install.sh | bash
```

Prérequis : Docker, et l'utilisateur dans le groupe `docker`.

## Usage

```sh
spm add ./blog                 # premier port libre à partir de 8100
spm add ./api --port 8500      # port choisi
spm add ./admin --local        # 127.0.0.1 uniquement (derrière ton propre proxy)
spm add ./app -e API_KEY=xxx -v data:/app/data

spm redeploy blog              # rebuild + remplace ; port, env et volumes conservés
spm list
spm stop|start|restart blog
spm logs blog -f
spm status blog
spm remove blog                # les données des volumes sont conservées
spm remove blog --purge        # … sauf avec --purge
```

### Docker Compose

Si le dossier contient un `compose.yaml` (ou `docker-compose.yml`…), `spm add` lance `docker compose up -d --build`
au lieu de générer un conteneur. Ports, variables et volumes se règlent alors dans le fichier compose, pas via spm.

```sh
spm add ./stack                # docker compose up -d --build
spm import ./stack             # enregistre un projet compose qui tourne déjà, sans rien relancer
spm remove stack               # désenregistre seulement : les conteneurs continuent de tourner
spm remove stack --down        # docker compose down
spm remove stack --purge       # docker compose down -v (supprime aussi les volumes)
```

`spm list` signale les conteneurs de la machine qui ne sont suivis par aucun projet, avec la commande `spm import` à lancer.

### Redéploiement

`spm redeploy` rebuild depuis le dossier du projet pendant que l'ancien conteneur tourne encore.
Si le build échoue, rien n'est touché. Si la nouvelle version plante au démarrage, spm relance
automatiquement la version précédente.

### Variables d'environnement

```sh
spm env blog                           # liste
spm env set blog DATABASE_URL=... DEBUG=0
spm env unset blog DEBUG
```

Chaque modification recrée le conteneur (et le relance s'il tournait). Les variables sont stockées
dans `~/.spm/registry.json` (mode 600) et priment sur le `.env` du projet.

### Volumes

```sh
spm volume blog                        # liste
spm volume add blog data:/app/data     # volume Docker nommé (spm-blog-data)
spm volume add blog ./uploads:/app/uploads     # dossier de l'hôte, relatif au projet
spm volume add blog /etc/ssl/certs:/certs:ro   # lecture seule
spm volume rm blog /app/data           # démonte, les données restent
```

| Détecté | Image | Port interne |
|---|---|---|
| `Dockerfile` | le tien | `EXPOSE`, sinon 3000 |
| `package.json` + `bun.lock(b)` | `oven/bun:1-alpine` | 3000 |
| `package.json` | `node:22-alpine` | 3000 |
| `main.py` + FastAPI | `python:3.12-slim` + uvicorn | 8000 |
| `requirements.txt` | `python:3.12-slim`, `python main.py\|app.py\|server.py` | 8000 |

L'application doit écouter sur `0.0.0.0:$PORT` (la variable `PORT` est injectée). `--internal-port` force le port interne ;
`PORT` ne peut pas être défini via `-e` ou `spm env`.
Le `.env` du projet est passé au conteneur (`--env-file`) mais jamais copié dans l'image : si ton Dockerfile n'a pas
de `.dockerignore`, spm en ajoute un qui exclut `.env` et `.env.*` (un `.dockerignore` existant est respecté tel quel).
Les Dockerfiles générés vivent dans `~/.spm/builds/<nom>/` : le dossier du projet n'est jamais modifié.

### Configuration

`~/.spm/config.json` (optionnel, `SPM_HOME` pour changer de dossier) :

```json
{ "port_min": 8100, "port_max": 8999, "caddyfile": "/etc/caddy/Caddyfile" }
```

Les ports déjà publiés par d'autres conteneurs (compose compris) sont évités.

⚠ Docker publie les ports en contournant `ufw` : un port ouvert par spm est joignable depuis Internet même si le pare-feu dit le contraire. Utilise `--local` pour ce qui ne doit pas être public.

## Build

```sh
bun install
bun run release    # dist/spm-linux-x64, dist/spm-linux-arm64
```

Publie `install.sh` et les deux binaires à la racine de `https://tondomaine.com/`.
