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
curl -fsSL https://raw.githubusercontent.com/FISEM/spm/main/install.sh | bash
```

Prérequis : Docker, et l'utilisateur dans le groupe `docker`.

## Usage

```sh
spm add ./blog                 # premier port libre à partir de 8100
spm add ./api --port 8500      # port choisi
spm add ./admin --local        # 127.0.0.1 uniquement (derrière ton propre proxy)
spm add ./app -e API_KEY=xxx -v data:/app/data
spm add ./api --memory 512m --health /health   # limite mémoire, vérification HTTP au déploiement

spm redeploy blog              # rebuild + remplace ; port, env et volumes conservés
spm list                       # --json : sortie lisible par un script ou une IA
spm stop|start|restart blog
spm logs blog -f
spm status blog                # --json aussi (noms des variables d'env, jamais leurs valeurs)
spm remove blog                # les données des volumes sont conservées
spm remove blog --purge        # … sauf avec --purge
```

Une seule commande qui modifie l'état tourne à la fois (`spm list`, `status` et `logs` restent libres) :
une deuxième est refusée avec le nom de celle en cours.

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
Si le build échoue, rien n'est touché. Si la nouvelle version plante au démarrage (ou, avec `--health`,
si ce chemin ne répond pas en moins de 400 dans les 30 s), spm relance automatiquement la version précédente.
Les anciennes images du projet sont ensuite supprimées.

Le service est coupé quelques secondes pendant le remplacement (l'ancien et le nouveau conteneur ne
peuvent pas écouter le même port en même temps).

**Projets compose.** Même principe : les images construites par le projet sont étiquetées
`…:spm-previous` avant le build, puis `docker compose up -d` remplace les conteneurs. Si la nouvelle
version ne démarre pas — un conteneur en échec, ou qui redémarre en boucle pendant les 12 s
d'observation — spm remet les images de secours et relance la version précédente. Seules les images
que le projet construit lui-même sont concernées : une base de données ou un cache tirés d'un
registre ne sont jamais réétiquetés. **Une fois le démarrage confirmé, le filet est retiré** — sinon
chaque redéploiement laisserait un jeu d'images de plus, pour toujours. Après un retour arrière il
est conservé : ce sont ces images-là qui font tourner le service.

### Suivre une branche

Pousser sur la branche suivie déclenche le redéploiement, sans ouvrir de terminal.

```
spm watch mon-projet --branch main   met le projet sous suivi (main par défaut)
spm watch                            liste ce qui est suivi, et le dernier commit déployé
spm sync                             une passe : ce qui a bougé est redéployé
spm sync --dry-run                   dit ce qu'il ferait, sans rien faire
spm unwatch mon-projet               cesse de suivre ; rien n'est arrêté
```

**Scrutation, pas webhook.** Un webhook demande un port ouvert, une URL publique et un secret
partagé — trois choses à configurer et à protéger, pour gagner quelques dizaines de secondes.
`spm sync` interroge git et ne demande rien. Une minuterie l'appelle aussi souvent qu'on veut :

```
*/2 * * * * /usr/local/bin/spm sync >> /var/log/spm-sync.log 2>&1
```

**Ce que spm refuse de faire**, parce que le dossier d'un projet est aussi l'endroit où on l'édite :

- des modifications **non commitées** dans le dossier : il ne déploie pas, et le dit. Un `git pull`
  par-dessus perdrait du travail que personne n'a sauvegardé ailleurs ;
- des branches **divergentes** : il ne tranche pas à votre place et ne fabrique pas de commit de
  fusion. L'avance est directe (`--ff-only`) ou elle n'a pas lieu ;
- un **distant injoignable** : il le signale plutôt que de conclure que tout va bien — confondre les
  deux ferait croire au suivi de fonctionner alors qu'il ne verrait plus rien passer.

Chaque passe dit ce qu'elle a fait, projet par projet, y compris « rien ». `spm sync` sort avec un
code non nul si un déploiement a échoué, pour qu'une minuterie puisse s'en apercevoir. Le
redéploiement lui-même garde ses garanties : build à côté, retour arrière si la nouvelle version ne
démarre pas.

### Limites et vérification

```sh
spm set blog memory=512m               # limite mémoire (le conteneur est tué s'il la dépasse, puis relancé)
spm set blog health=/health            # le déploiement n'est réussi que si GET /health répond < 400
spm set blog memory= health=           # retire les deux
```

### Variables d'environnement

```sh
spm env blog                           # les noms et leur date, jamais les valeurs
spm env reveal blog                    # les valeurs
spm env set blog DATABASE_URL=... DEBUG=0
spm env unset blog DEBUG
spm env import blog                    # reprend le .env existant du projet
```

Les valeurs sont chiffrées (AES-256-GCM) dans `~/.spm/secrets.json`, avec la clé maîtresse
`~/.spm/master.key` (mode 600 tous les deux). Les noms et les dates de modification restent en
clair : savoir *qu'*un projet possède une clé modifiée le 12 mars n'est pas un secret, c'est
l'inventaire qu'on veut consulter d'un coup d'œil.

**La clé maîtresse doit être sauvegardée avec le coffre.** Sans elle, `secrets.json` ne vaut rien.
Le format ne dépend pas de spm — `iv:tag:chiffré` en base64, la clé étant les 32 octets en base64
de `master.key` — donc les valeurs restent récupérables sans le binaire.

**Projet conteneur :** chaque modification recrée le conteneur et le relance s'il tournait.

**Projet compose :** spm écrit le `.env` du projet juste avant le déploiement, puis s'efface — le
coffre n'est jamais une dépendance de démarrage. Le fichier est **fusionné, pas remplacé** : une
variable présente dans le `.env` mais absente du coffre est conservée, et une copie de l'original
est gardée dans `.env.avant-spm` la première fois.

### Panneau web

```sh
spm serve                              # http://127.0.0.1:8140, jeton dans ~/.spm/panneau.token
spm serve --port 9000 --public         # toutes les interfaces : à placer derrière Caddy
```

L'inventaire du coffre, avec les variables partagées par plusieurs projets mises en évidence —
c'est ce qui casse un service le jour d'une rotation, quand une seule des deux copies est mise à
jour. Le panneau n'affiche **jamais** une valeur : pour ça il faut être sur la machine.

### Volumes

```sh
spm volume blog                        # volumes Docker du projet et leur état
spm volume add blog data:/app/data     # volume Docker nommé (spm-blog-data)
spm volume add blog ./uploads:/app/uploads     # dossier de l'hôte, relatif au projet
spm volume add blog /etc/ssl/certs:/certs:ro   # lecture seule
spm volume rm blog /app/data           # démonte, les données restent
spm volume prune blog --yes            # supprime les volumes orphelins (données perdues)
```

Un volume devient **orphelin** quand plus aucun conteneur ne le monte et qu'aucune
config ne le déclare — typiquement après un changement d'architecture, par exemple
en passant de SQLite à PostgreSQL. Plus rien ne le suit, il occupe le disque en
silence. `spm volume <nom>` les signale, y compris pour les projets Docker Compose,
dont spm ne gère pourtant pas la configuration. La suppression exige `--yes` :
les données du volume sont perdues.

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
{ "port_min": 8100, "port_max": 8999, "caddyfile": "/etc/caddy/Caddyfile", "log_max_size": "10m", "log_max_files": 3 }
```

Les logs de chaque conteneur tournent (3 fichiers de 10 Mo par défaut) quand Docker utilise le pilote `json-file`,
celui par défaut, qui sinon les garde sans limite. Appliqué à la création du conteneur : les projets existants
en profitent au prochain `redeploy`, `env set` ou `set`.

Les ports déjà publiés par d'autres conteneurs (compose compris) sont évités.

⚠ Docker publie les ports en contournant `ufw` : un port ouvert par spm est joignable depuis Internet même si le pare-feu dit le contraire. Utilise `--local` pour ce qui ne doit pas être public.

## Build

```sh
bun install
bun test           # tests unitaires
bun run typecheck
bun run release    # dist/spm-linux-x64, dist/spm-linux-arm64, dist/SHA256SUMS
```

Publication : `bun run release`, puis une release GitHub `vX.Y.Z` avec les deux binaires et `dist/SHA256SUMS`
(`gh release create vX.Y.Z dist/spm-linux-x64 dist/spm-linux-arm64 dist/SHA256SUMS`).
`install.sh` télécharge la dernière release et refuse un binaire dont l'empreinte ne correspond pas.
