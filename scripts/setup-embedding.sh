#!/usr/bin/env bash
# Pappers-Hall optional local embedding environment (real vector retrieval).
# Creates an isolated venv under $DSH_HOME/pappers-hall/embedding and preloads
# a multilingual sentence-transformers model. The plugin never installs
# anything automatically; run this script once to enable the vector channel.
set -euo pipefail

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
ROOT="$DSH_HOME/pappers-hall"
VENV="$ROOT/embedding/venv"
CACHE="$ROOT/models"
MODEL="${PAPPERS_EMBED_MODEL:-sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2}"

if [ -x "$VENV/bin/python" ]; then
  echo "[setup-embedding] venv exists: $VENV"
else
  echo "[setup-embedding] creating venv: $VENV"
  mkdir -p "$ROOT/embedding" "$CACHE"
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install --quiet --upgrade pip
  "$VENV/bin/pip" install --quiet torch==2.2.2 sentence-transformers==2.7.0 "numpy<2"
fi

echo "[setup-embedding] preloading model: $MODEL (cache: $CACHE)"
PAPPERS_EMBED_MODEL="$MODEL" PAPPERS_EMBED_CACHE="$CACHE" "$VENV/bin/python" - <<'PY'
import os, sys
from sentence_transformers import SentenceTransformer
model_name = os.environ['PAPPERS_EMBED_MODEL']
cache = os.environ['PAPPERS_EMBED_CACHE']
model = SentenceTransformer(model_name, cache_folder=cache)
dims = model.get_sentence_embedding_dimension()
print(f"[setup-embedding] ready model={model_name} dims={dims}")
print("[setup-embedding] note: CPU-only inference; text is processed locally and not uploaded.")
PY

echo "[setup-embedding] done. Restart/reload the plugin, then Pappers-Hall -> 论文中心 shows 向量检索 available."
echo "[setup-embedding] venv: $VENV"
echo "[setup-embedding] model cache: $CACHE (~1.2GB total incl. torch)"
