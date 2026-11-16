#!/usr/bin/env python3
"""Pappers-Hall Python worker (stdio JSON-lines).

One long-lived process serves three capabilities so the Node Host only pays the
interpreter and model start-up once:

  pdf    PyMuPDF (fitz) text/layout/render. Optional: when PyMuPDF is missing the
         Host keeps using the Poppler CLI instead.
  ocr    PP-OCRv6 tiny (det+rec via rapidocr). Models download on first use into
         `model_root_dir` chosen by the Host.
  layout PP-DocLayout-S ONNX region detection (paragraph_title/text/table/figure...).

Protocol: one JSON object per line on stdin, one per line on stdout.

  {"id":1,"op":"ping"}                                  capability + version probe
  {"id":2,"op":"info","path":"/x.pdf"}                  document facts
  {"id":3,"op":"text","path":"/x.pdf"}                  one string per page
  {"id":4,"op":"layout","path":"/x.pdf"}                word boxes per page
  {"id":5,"op":"render","path":"/x.pdf","page":1,"width":1400,"output":"/y.png"}
  {"id":6,"op":"crop","path":"/x.pdf","page":1,"box":[x0,y0,x1,y1],"output":"/y.png","dpi":120}
  {"id":7,"op":"ocrPage","path":"/x.pdf","page":1,"dpi":200,"layout":true}
  {"op":"shutdown"}

Every reply carries the request `id` (when present) plus `ok`; failures also
carry `error` and `code`. Nothing is uploaded and no model is fetched unless the
user starts an OCR job.
"""
import json
import os
import sys


def log(message):
    sys.stderr.write('[pappers-py] ' + message + '\n')
    sys.stderr.flush()


def reply(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def error_payload(request_id, message, code='failed'):
    return {'id': request_id, 'ok': False, 'error': str(message), 'code': code}


class Worker:
    def __init__(self, options):
        self.model_root = options.get('modelRoot') or None
        self.layout_model = options.get('layoutModel') or None
        self._fitz = None
        self._rapidocr = None
        self._layout_session = None
        self._layout_static = None
        self.fitz_version = None
        self.rapidocr_version = None
        self.layout_version = None
        self.layout_error = None

    # ---------------------------------------------------------------- PyMuPDF
    def fitz(self):
        if self._fitz is None:
            import pymupdf  # noqa: PLC0415 - optional dependency

            self._fitz = pymupdf
            self.fitz_version = getattr(pymupdf, 'VersionBind', None) or getattr(pymupdf, '__version__', '?')
        return self._fitz

    def open_pdf(self, path):
        pymupdf = self.fitz()
        if not isinstance(path, str) or not os.path.isfile(path):
            raise FileNotFoundError(path)
        return pymupdf.open(path)

    def info(self, path):
        doc = self.open_pdf(path)
        try:
            meta = doc.metadata or {}
            box = None
            try:
                box = doc[0].rect if doc.page_count > 0 else None
            except Exception:
                box = None
            return {
                'pageCount': int(doc.page_count),
                'title': (meta.get('title') or None),
                'author': (meta.get('author') or None),
                'subject': (meta.get('subject') or None),
                'creator': (meta.get('creator') or None),
                'producer': (meta.get('producer') or None),
                'encrypted': bool(doc.needs_pass),
                'pdfVersion': None,
                'pageWidth': round(float(box.width), 2) if box is not None else None,
                'pageHeight': round(float(box.height), 2) if box is not None else None,
            }
        finally:
            doc.close()

    def text(self, path):
        doc = self.open_pdf(path)
        try:
            return {'pages': [page.get_text('text') for page in doc]}
        finally:
            doc.close()

    def layout(self, path):
        doc = self.open_pdf(path)
        pages = []
        try:
            for index, page in enumerate(doc):
                words = []
                for item in page.get_text('words'):
                    x0, y0, x1, y1, text, block_no, line_no, _word_no = item
                    text = (text or '').strip()
                    if not text:
                        continue
                    words.append({
                        'x': round(float(x0), 2),
                        'y': round(float(y0), 2),
                        'w': round(float(x1) - float(x0), 2),
                        'h': round(float(y1) - float(y0), 2),
                        't': text,
                        'block': int(block_no),
                        'line': int(line_no),
                    })
                pages.append({
                    'page': index + 1,
                    'width': round(float(page.rect.width), 2),
                    'height': round(float(page.rect.height), 2),
                    'words': words,
                })
            return {'pages': pages}
        finally:
            doc.close()

    def render(self, path, page, width, output):
        pymupdf = self.fitz()
        doc = self.open_pdf(path)
        try:
            target = max(120, min(3000, int(width or 1400)))
            page_obj = doc[int(page) - 1]
            zoom = target / float(page_obj.rect.width)
            pixmap = page_obj.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
            directory = os.path.dirname(output)
            if directory:
                os.makedirs(directory, exist_ok=True)
            pixmap.save(output)
            return {'width': int(pixmap.width), 'height': int(pixmap.height)}
        finally:
            doc.close()

    def crop(self, path, page, box, output, dpi=120):
        pymupdf = self.fitz()
        doc = self.open_pdf(path)
        try:
            page_obj = doc[int(page) - 1]
            scale = max(1.0, float(dpi)) / 72.0
            clip = pymupdf.Rect(*[float(v) for v in (box or [0, 0, 0, 0])])
            pixmap = page_obj.get_pixmap(matrix=pymupdf.Matrix(scale, scale), clip=clip, alpha=False)
            directory = os.path.dirname(output)
            if directory:
                os.makedirs(directory, exist_ok=True)
            pixmap.save(output)
            return {'width': int(pixmap.width), 'height': int(pixmap.height)}
        finally:
            doc.close()

    # ------------------------------------------------------------------ OCR
    def rapidocr(self):
        if self._rapidocr is None:
            from rapidocr import RapidOCR  # noqa: PLC0415 - optional dependency

            params = {'Global.log_level': 'error'}
            if self.model_root:
                params['Global.model_root_dir'] = self.model_root
            # Fixed model tier: PP-OCRv6 tiny (det + rec). Measured on a real
            # 188 dpi paper page it is ~3.6× faster than `small` with the same
            # line accuracy (char recall 99.9%, average line similarity 1.0),
            # which keeps a scanned paper near two minutes instead of eight.
            try:
                from rapidocr.utils.typings import ModelType  # noqa: PLC0415

                params['Det.model_type'] = ModelType.TINY
                params['Rec.model_type'] = ModelType.TINY
            except Exception:
                pass
            self._rapidocr = RapidOCR(params=params)
            try:
                import rapidocr as package

                self.rapidocr_version = getattr(package, '__version__', '?')
            except Exception:
                self.rapidocr_version = '?'
        return self._rapidocr

    def page_image(self, path, page, dpi=200):
        pymupdf = self.fitz()
        doc = self.open_pdf(path)
        try:
            page_obj = doc[int(page) - 1]
            zoom = max(72, min(400, float(dpi))) / 72.0
            pixmap = page_obj.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
            import numpy as np  # noqa: PLC0415 - bundled with rapidocr

            image = np.frombuffer(pixmap.samples, dtype=np.uint8).reshape(pixmap.height, pixmap.width, pixmap.n)
            return image[:, :, :3].copy(), zoom
        finally:
            doc.close()

    def ocr_page(self, path, page, dpi=200, want_layout=False, regions_result=None):
        image, zoom = self.page_image(path, page, dpi)
        engine = self.rapidocr()
        result = engine(image)
        boxes = as_list(getattr(result, 'boxes', None))
        texts = as_list(getattr(result, 'txts', None))
        scores = as_list(getattr(result, 'scores', None))
        lines = []
        for index, text in enumerate(texts):
            value = str(text or '').strip()
            if not value:
                continue
            box = boxes[index] if index < len(boxes) else None
            xs = [float(point[0]) for point in box] if box is not None else []
            ys = [float(point[1]) for point in box] if box is not None else []
            line = {
                'text': value,
                'score': float(scores[index]) if index < len(scores) else None,
                'box': [min(xs), min(ys), max(xs), max(ys)] if xs and ys else None,
            }
            if line['box'] is not None:
                line['box'] = [round(v / zoom, 2) for v in line['box']]
            lines.append(line)
        payload = {'lines': lines, 'text': '\n'.join(line['text'] for line in lines)}
        if want_layout:
            payload['regions'] = regions_result if regions_result is not None else self.regions_from_image(image, zoom)
        return payload

    # --------------------------------------------------------------- layout
    def layout_session(self):
        if self._layout_session is None and self.layout_error is None:
            if not self.layout_model or not os.path.isfile(self.layout_model):
                self.layout_error = 'layout model not installed'
                return None
            try:
                import onnxruntime as ort  # noqa: PLC0415 - optional dependency

                options = ort.SessionOptions()
                options.intra_op_num_threads = 4
                self._layout_session = ort.InferenceSession(self.layout_model, options, providers=['CPUExecutionProvider'])
                self.layout_version = 'PP-DocLayout-S'
            except Exception as error:  # pragma: no cover - environment dependent
                self.layout_error = 'layout init failed: %r' % (error,)
                return None
        return self._layout_session

    def regions_from_image(self, image, zoom):
        session = self.layout_session()
        if session is None:
            return None
        try:
            import numpy as np  # noqa: PLC0415

            height, width = image.shape[:2]
            scale = min(480.0 / height, 480.0 / width)
            resized_h = max(1, int(round(height * scale)))
            resized_w = max(1, int(round(width * scale)))
            ys = (np.arange(resized_h) * height / resized_h).astype(np.int32)
            xs = (np.arange(resized_w) * width / resized_w).astype(np.int32)
            canvas = np.zeros((480, 480, 3), dtype=np.float32)
            canvas[:resized_h, :resized_w] = image[ys][:, xs].astype(np.float32)
            mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)
            std = np.array([0.229, 0.224, 0.225], dtype=np.float32)
            tensor = ((canvas / 255.0 - mean) / std).transpose(2, 0, 1)[None]
            inputs = {item.name: None for item in session.get_inputs()}
            names = [item.name for item in session.get_inputs()]
            feed = {names[0]: tensor, names[1] if len(names) > 1 else names[0]: np.array([[scale, scale]], dtype=np.float32)}
            outputs = session.run(None, feed)
            detections, count = outputs[0], outputs[1]
            labels = REGION_LABELS
            regions = []
            for row in detections[: int(count[0])]:
                class_id = int(row[0])
                score = float(row[1])
                if score < 0.4:
                    continue
                x0, y0, x1, y1 = [float(v) for v in row[2:6]]
                regions.append({
                    'label': labels[class_id] if class_id < len(labels) else 'text',
                    'score': round(score, 3),
                    'box': [round(x0 / zoom, 2), round(y0 / zoom, 2), round(x1 / zoom, 2), round(y1 / zoom, 2)],
                })
            regions.sort(key=lambda item: (item['box'][1], item['box'][0]))
            return regions
        except Exception as error:  # pragma: no cover - model dependent
            self.layout_error = 'layout inference failed: %r' % (error,)
            return None

    def ensure_models(self):
        """Load every model so the download happens during install, not first use."""
        report = {}
        try:
            engine = self.rapidocr()
            # Constructing the engine is not enough: rapidocr fetches the det/rec/
            # cls weights on the first inference, so run one on a blank image.
            import numpy as np  # noqa: PLC0415

            engine(warmup_image())
            report['ocr'] = 'ready'
        except Exception as error:
            report['ocr'] = 'failed: %r' % (error,)
        try:
            session = self.layout_session()
            if session is not None:
                import numpy as np  # noqa: PLC0415

                probe = np.zeros((1, 3, 480, 480), dtype=np.float32)
                names = [item.name for item in session.get_inputs()]
                session.run(None, {names[0]: probe, names[1]: np.array([[1.0, 1.0]], dtype=np.float32)})
            report['layout'] = 'ready' if session is not None else (self.layout_error or 'unavailable')
        except Exception as error:
            report['layout'] = 'failed: %r' % (error,)
        return report

    def capabilities(self):
        status = {'pdf': False, 'ocr': False, 'layout': False}
        try:
            self.fitz()
            status['pdf'] = True
        except Exception as error:
            status['pdf_error'] = repr(error)
        try:
            self.rapidocr()
            status['ocr'] = True
        except Exception as error:
            status['ocr_error'] = repr(error)
        status['layout'] = self.layout_session() is not None
        if self.layout_error:
            status['layout_error'] = self.layout_error
        return status


def warmup_image():
    """Small synthetic page with text, so the det + rec + cls weights all load."""
    import numpy as np  # noqa: PLC0415

    canvas = np.ones((120, 360, 3), dtype=np.uint8) * 255
    try:
        from PIL import Image, ImageDraw  # noqa: PLC0415 - Pillow ships with rapidocr

        image = Image.fromarray(canvas)
        draw = ImageDraw.Draw(image)
        draw.text((12, 40), 'Pappers-Hall OCR 2026', fill=(0, 0, 0))
        canvas = np.array(image)
    except Exception:
        canvas[40:60, 20:330] = 0
    return canvas


def as_list(value):
    """Normalise a numpy array / list / None into a plain list."""
    if value is None:
        return []
    if hasattr(value, 'tolist'):
        return value.tolist()
    try:
        return list(value)
    except TypeError:
        return []


REGION_LABELS = [
    'paragraph_title', 'image', 'text', 'number', 'abstract', 'content', 'figure_title',
    'formula', 'table', 'table_title', 'reference', 'doc_title', 'footnote', 'header',
    'algorithm', 'footer', 'seal', 'chart_title', 'chart', 'formula_number',
    'header_image', 'footer_image', 'aside_text',
]


def main():
    raw = os.environ.get('PAPPERS_PY_OPTIONS') or '{}'
    try:
        options = json.loads(raw)
    except Exception:
        options = {}
    worker = Worker(options)
    log('worker ready (pdf=%s)' % (options.get('layoutModel') or 'no-layout-model'))
    while True:
        line = sys.stdin.readline()
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except Exception as error:
            reply({'ok': False, 'error': 'bad_json: %r' % (error,), 'code': 'invalid_request'})
            continue
        request_id = request.get('id')
        operation = request.get('op') or 'ping'
        try:
            if operation == 'shutdown':
                break
            if operation == 'ping':
                # Capabilities first: probing them imports PyMuPDF/rapidocr and
                # records the versions the reply reports.
                capabilities = worker.capabilities()
                reply({'id': request_id, 'ok': True, 'capabilities': capabilities, 'versions': {
                    'pymupdf': worker.fitz_version,
                    'rapidocr': worker.rapidocr_version,
                    'layout': worker.layout_version,
                }})
                continue
            if operation == 'info':
                reply({'id': request_id, 'ok': True, **worker.info(request.get('path'))})
                continue
            if operation == 'text':
                reply({'id': request_id, 'ok': True, **worker.text(request.get('path'))})
                continue
            if operation == 'layout':
                reply({'id': request_id, 'ok': True, **worker.layout(request.get('path'))})
                continue
            if operation == 'render':
                reply({'id': request_id, 'ok': True, **worker.render(request.get('path'), request.get('page'), request.get('width'), request.get('output'))})
                continue
            if operation == 'crop':
                reply({'id': request_id, 'ok': True, **worker.crop(request.get('path'), request.get('page'), request.get('box'), request.get('output'), request.get('dpi', 120))})
                continue
            if operation == 'ocrPage':
                reply({'id': request_id, 'ok': True, **worker.ocr_page(request.get('path'), request.get('page'), request.get('dpi', 200), bool(request.get('layout')))})
                continue
            if operation == 'regions':
                image, zoom = worker.page_image(request.get('path'), request.get('page'), request.get('dpi', 180))
                reply({'id': request_id, 'ok': True, 'regions': worker.regions_from_image(image, zoom) or []})
                continue
            if operation == 'ensureModels':
                reply({'id': request_id, 'ok': True, 'report': worker.ensure_models()})
                continue
            reply(error_payload(request_id, 'unknown op: %s' % operation, 'unsupported'))
        except FileNotFoundError as error:
            reply(error_payload(request_id, error, 'missing_file'))
        except Exception as error:  # pragma: no cover - defensive
            log('%s failed: %r' % (operation, error))
            reply(error_payload(request_id, error))


if __name__ == '__main__':
    main()
