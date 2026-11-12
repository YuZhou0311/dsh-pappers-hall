#!/usr/bin/env python3
"""Pappers-Hall embedding worker (stdio JSON-lines).

Protocol (one JSON object per line):
  {"id":1,"op":"embed","texts":["a","b"]}       -> {"id":1,"ok":true,"vectors":[[...]],"dims":384,"model":"..."}
  {"id":2,"op":"ping"}                          -> {"id":2,"ok":true,"model":"...","dims":384}
  {"id":3,"op":"shutdown"}                       -> process exits

The worker is intentionally dependency-light from the Host's perspective: it is
started by the plugin Host with the venv python selected by
`embedding.python` (default: ~/.dsh/pappers-hall/embedding/venv/bin/python).
"""
import json
import os
import sys

MODEL_NAME = os.environ.get('PAPPERS_EMBED_MODEL', 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2')
CACHE_DIR = os.environ.get('PAPPERS_EMBED_CACHE', os.path.expanduser('~/.dsh/pappers-hall/models'))


def log(message):
    sys.stderr.write('[pappers-embed] ' + message + '\n')
    sys.stderr.flush()


def main():
    try:
        from sentence_transformers import SentenceTransformer
    except Exception as error:  # pragma: no cover - environment dependent
        log('sentence_transformers import failed: %r' % (error,))
        sys.stdout.write(json.dumps({'ok': False, 'error': 'import_failed: %s' % error}) + '\n')
        sys.stdout.flush()
        return 1
    os.makedirs(CACHE_DIR, exist_ok=True)
    log('loading model %s (cache %s)' % (MODEL_NAME, CACHE_DIR))
    model = SentenceTransformer(MODEL_NAME, cache_folder=CACHE_DIR)
    dims = int(model.get_sentence_embedding_dimension())
    log('model ready dims=%d' % dims)
    sys.stdout.write(json.dumps({'op': 'ready', 'model': MODEL_NAME, 'dims': dims}) + '\n')
    sys.stdout.flush()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except Exception as error:
            sys.stdout.write(json.dumps({'ok': False, 'error': 'bad_json: %s' % error}) + '\n')
            sys.stdout.flush()
            continue
        request_id = request.get('id')
        operation = request.get('op') or 'embed'
        if operation == 'shutdown':
            break
        if operation == 'ping':
            sys.stdout.write(json.dumps({'id': request_id, 'ok': True, 'model': MODEL_NAME, 'dims': dims}) + '\n')
            sys.stdout.flush()
            continue
        texts = request.get('texts') or []
        if not isinstance(texts, list):
            sys.stdout.write(json.dumps({'id': request_id, 'ok': False, 'error': 'texts must be a list'}) + '\n')
            sys.stdout.flush()
            continue
        try:
            vectors = model.encode(
                [str(text or '') for text in texts],
                batch_size=int(request.get('batchSize') or 16),
                normalize_embeddings=True,
                show_progress_bar=False,
            )
            payload = {'id': request_id, 'ok': True, 'model': MODEL_NAME, 'dims': dims,
                       'vectors': [[round(float(value), 6) for value in vector] for vector in vectors]}
        except Exception as error:  # pragma: no cover - model/runtime dependent
            payload = {'id': request_id, 'ok': False, 'error': 'encode_failed: %s' % error}
        sys.stdout.write(json.dumps(payload) + '\n')
        sys.stdout.flush()
    log('exit')
    return 0


if __name__ == '__main__':
    sys.exit(main())
