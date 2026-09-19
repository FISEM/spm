#!/usr/bin/env bash
# Installation de spm :
#   curl -fsSL https://raw.githubusercontent.com/FISEM/spm/main/install.sh | bash
#
# SPM_BASE_URL : d'où télécharger le binaire (défaut : dernière release GitHub)
set -euo pipefail

BASE_URL="${SPM_BASE_URL:-https://github.com/FISEM/spm/releases/latest/download}"
BIN=/usr/local/bin/spm

say() { printf '\033[1m→ %s\033[0m\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

SUDO=""
[ "$(id -u)" -eq 0 ] || SUDO="sudo"

[ "$(uname -s)" = Linux ] || die "spm ne vise que Linux"
case "$(uname -m)" in
  x86_64 | amd64) ARCH=x64 ;;
  aarch64 | arm64) ARCH=arm64 ;;
  *) die "architecture non supportée : $(uname -m)" ;;
esac

command -v sha256sum >/dev/null || die "sha256sum manquant (paquet coreutils)"
command -v docker >/dev/null || die "Docker n'est pas installé : https://docs.docker.com/engine/install/"
docker info >/dev/null 2>&1 || die "impossible de parler à Docker (ajoute-toi au groupe docker : sudo usermod -aG docker $(id -un), puis reconnecte-toi)"

say "téléchargement de spm-linux-$ARCH"
TMP="$(mktemp)"
trap 'rm -f "$TMP" "$TMP.sums"' EXIT
curl -fsSL "$BASE_URL/spm-linux-$ARCH" -o "$TMP" || die "téléchargement impossible depuis $BASE_URL"

# Détecte un téléchargement tronqué ou altéré en route (pas un serveur compromis : les sommes viennent du même endroit).
curl -fsSL "$BASE_URL/SHA256SUMS" -o "$TMP.sums" || die "SHA256SUMS introuvable sur $BASE_URL"
EXPECTED="$(awk -v f="spm-linux-$ARCH" '$2 == f || $2 == "*" f { print $1 }' "$TMP.sums")"
[ -n "$EXPECTED" ] || die "spm-linux-$ARCH absent de SHA256SUMS"
[ "$(sha256sum "$TMP" | cut -d' ' -f1)" = "$EXPECTED" ] || die "empreinte SHA-256 invalide : binaire corrompu, installation annulée"
chmod +x "$TMP"
"$TMP" --version >/dev/null || die "le binaire téléchargé ne s'exécute pas"
$SUDO install -m 0755 "$TMP" "$BIN"

say "spm $("$BIN" --version) installé dans $BIN"
echo "  Puis : spm add ./mon-projet"
