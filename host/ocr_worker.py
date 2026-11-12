#!/usr/bin/env python3
"""Pappers-Hall OCR worker (stdio JSON-lines, rapidocr-onnxruntime).

Protocol (one JSON object per line on stdin/stdout):
  {"id":1,"op":"ping"}                      -> {"id":1,"ok":true,"engine":"rapidocr-onnxruntime"}
  {"id":2,"op":"ocr","imagePath":"/x.png"}  -> {"id":2,"ok":true,"text":"...","blocks":[{text,score,box}]}
  {"op":"shutdown"}                         -> process exits

The worker is started by the plugin Host with the OCR venv python created by the
settings panel's "install OCR" action. Models ship inside the rapidocr-onnxruntime
package; nothing is uploaded.
"""
import json
import os
import sys


ENGINE = 'rapidocr-onnxruntime'


def log(message):
    sys.stderr.write('[pappers-ocr] ' + message + '\n')
    sys.stderr.flush()


def main():
    try:
        from rapidocr_onnxruntime import RapidOCR
    except Exception as error:  # pragma: no cover - environment dependent
        log('rapidocr import failed: %r' % (error,))
        sys.stdout.write(json.dumps({'op': 'ready', 'ok': False, 'error': 'import_failed: %s' % error}) + '\n')
        sys.stdout.flush()
        return 1
    try:
        engine = RapidOCR()
    except Exception as error:  # pragma: no cover - model/runtime dependent
        log('RapidOCR init failed: %r' % (error,))
        sys.stdout.write(json.dumps({'op': 'ready', 'ok': False, 'error': 'init_failed: %s' % error}) + '\n')
        sys.stdout.flush()
        return 1
    try:
        import rapidocr_onnxruntime as package

        version = getattr(package, '__version__', None)
    except Exception:
        version = None
    sys.stdout.write(json.dumps({'op': 'ready', 'ok': True, 'engine': ENGINE, 'version': version}) + '\n')
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
        operation = request.get('op') or 'ocr'
        if operation == 'shutdown':
            break
        if operation == 'ping':
            sys.stdout.write(json.dumps({'id': request_id, 'ok': True, 'engine': ENGINE, 'version': version}) + '\n')
            sys.stdout.flush()
            continue
        image_path = request.get('imagePath')
        if not isinstance(image_path, str) or not os.path.isfile(image_path):
            sys.stdout.write(json.dumps({'id': request_id, 'ok': False, 'error': 'image_not_found: %s' % image_path}) + '\n')
            sys.stdout.flush()
            continue
        try:
            result, _elapse = engine(image_path)
            blocks = []
            texts = []
            for entry in result or []:
                # rapidocr entries are [box, text, score]
                try:
                    box, text, score = entry[0], entry[1], entry[2]
                except Exception:
                    continue
                text = str(text or '').strip()
                if text == '':
                    continue
                blocks.append({'text': text, 'score': float(score) if score is not None else None, 'box': box})
                texts.append(text)
            payload = {'id': request_id, 'ok': True, 'engine': ENGINE, 'text': '\n'.join(texts), 'blocks': blocks}
        except Exception as error:  # pragma: no cover - runtime dependent
            payload = {'id': request_id, 'ok': False, 'error': 'ocr_failed: %s' % error}
        sys.stdout.write(json.dumps(payload, ensure_ascii=False) + '\n')
        sys.stdout.flush()
    log('exit')
    return 0


if __name__ == '__main__':
    sys.exit(main())
