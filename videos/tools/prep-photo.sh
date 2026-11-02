#!/usr/bin/env bash
# Prepara a foto da modelo no estilo da referência: P&B, contraste alto, fundo escurecido, vinheta, 1080x1920.
# Uso: bash tools/prep-photo.sh caminho/da/foto.jpg   (rode de dentro de videos/)
set -euo pipefail
IN="$1"; OUT="assets/modelo.jpg"
ffmpeg -v error -y -i "$IN" -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920:(iw-1080)/2:0,\
format=gray,curves=all='0/0 0.35/0.22 0.75/0.55 1/0.62',eq=contrast=1.15,vignette=angle=PI/3.2" -q:v 2 "$OUT"
echo "ok -> $OUT"
