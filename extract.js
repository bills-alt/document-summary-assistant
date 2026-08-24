/* ============================================================================
 * extract.js — getting text out of a file, with its shape intact.
 *
 * Two paths:
 *
 *  PDF   PDF.js hands back positioned glyph runs, not paragraphs. Reading them
 *        in array order gives you soup. So we rebuild the page: group runs into
 *        lines by their y-coordinate, order each line by x, insert spaces where
 *        the horizontal gap is wider than a space, then group lines into
 *        paragraphs by comparing each vertical gap to the page's own median.
 *        Font height relative to the page median is what marks a heading.
 *        That is what "maintaining formatting" means here — the summariser
 *        later uses those headings as topic signal, so it is not decoration.
 *
 *  Image OCR via Tesseract. Raw phone photos of documents OCR badly, so the
 *        bitmap is upscaled to a sane working width, converted to luminance and
 *        contrast-stretched between its own 2nd and 98th percentiles first.
 *
 *  A PDF whose text layer is empty is a scan wearing a PDF costume: we detect
 *  that, render its pages to canvas, and send them down the OCR path instead.
 *
 * window.Lens.Extractor
 * ========================================================================== */
(function (global) {
  'use strict';

  var MAX_BYTES = 25 * 1024 * 1024;
  var OCR_WIDTH_MIN = 1400;
  var OCR_WIDTH_MAX = 2400;
  var PDF_OCR_PAGE_CAP = 12;          // OCR is slow; be honest rather than hang

  function CancelledError() { this.name = 'CancelledError'; this.message = 'Cancelled'; }
  CancelledError.prototype = Object.create(Error.prototype);

  function check(token) { if (token && token.cancelled) throw new CancelledError(); }

  /* --------------------------------------------------------- validation -- */

  function validate(file) {
    if (!file) return 'No file was received.';
    if (file.size === 0) return 'That file is empty.';
    if (file.size > MAX_BYTES) {
      return 'That file is ' + (file.size / 1048576).toFixed(1) + ' MB. The limit is 25 MB so the browser does not run out of memory.';
    }
    var name = (file.name || '').toLowerCase();
    var isPdf = file.type === 'application/pdf' || /\.pdf$/.test(name);
    var isImg = /^image\//.test(file.type) || /\.(png|jpe?g|webp|bmp|gif|tiff?)$/.test(name);
    if (!isPdf && !isImg) return 'Lens reads PDFs and images. “' + (file.name || 'that file') + '” is neither.';
    return null;
  }

  function kind(file) {
    var name = (file.name || '').toLowerCase();
    return (file.type === 'application/pdf' || /\.pdf$/.test(name)) ? 'pdf' : 'image';
  }

  /* ------------------------------------------------- PDF layout rebuild -- */

  function median(arr) {
    if (!arr.length) return 0;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  /** Group positioned glyph runs into visual lines. */
  function itemsToLines(items) {
    var rows = [], i;
    for (i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it.str || !it.str.trim()) continue;
      var tr = it.transform;
      var size = Math.abs(tr[3]) || Math.hypot(tr[2], tr[3]) || 10;
      var y = tr[5], x = tr[4];
      var tol = Math.max(2, size * 0.45);

      var row = null;
      for (var r = rows.length - 1; r >= Math.max(0, rows.length - 6); r--) {
        if (Math.abs(rows[r].y - y) <= tol) { row = rows[r]; break; }
      }
      if (!row) { row = { y: y, size: size, parts: [] }; rows.push(row); }
      row.size = Math.max(row.size, size);
      row.parts.push({ x: x, w: it.width || (it.str.length * size * 0.5), s: it.str, size: size });
    }

    rows.sort(function (a, b) { return b.y - a.y; });     // PDF y grows upward
    var lines = [];
    for (i = 0; i < rows.length; i++) {
      var parts = rows[i].parts.sort(function (a, b) { return a.x - b.x; });
      var text = '', prevEnd = null, minX = Infinity, maxX = -Infinity;
      for (var p = 0; p < parts.length; p++) {
        var seg = parts[p];
        if (prevEnd !== null) {
          var gap = seg.x - prevEnd;
          if (gap > seg.size * 0.22 && !/\s$/.test(text) && !/^\s/.test(seg.s)) text += ' ';
        }
        text += seg.s;
        prevEnd = seg.x + seg.w;
        if (seg.x < minX) minX = seg.x;
        if (prevEnd > maxX) maxX = prevEnd;
      }
      text = text.replace(/\s+/g, ' ').trim();
      if (text) lines.push({ text: text, y: rows[i].y, size: rows[i].size, x0: minX, x1: maxX, width: maxX - minX });
    }
    return lines;
  }

  /** Decide, per line, whether it is a heading, and clump lines into paragraphs. */
  function linesToBlocks(lines, pageNo) {
    if (!lines.length) return [];

    var sizes = lines.map(function (l) { return l.size; });
    var widths = lines.map(function (l) { return l.width; });
    var medSize = median(sizes) || 10;
    var medWidth = median(widths) || 1;

    var gaps = [];
    for (var i = 1; i < lines.length; i++) gaps.push(Math.abs(lines[i - 1].y - lines[i].y));
    var medGap = median(gaps.filter(function (g) { return g > 0.5; })) || medSize * 1.2;

    function isHeadingLine(l) {
      var t = l.text;
      if (t.length > 110) return false;
      var big = l.size > medSize * 1.14;
      var numbered = /^(\d+(\.\d+)*[.)]?|[IVXLC]+\.|Chapter\s|Section\s|Appendix\s|Part\s)/i.test(t);
      var noStop = !/[.:;,]$/.test(t) || /:$/.test(t);
      var caps = t === t.toUpperCase() && /[A-Z]{3}/.test(t) && t.length < 70;
      var titleish = /^([A-Z][^\s]*)(\s+[A-Z0-9][^\s]*){0,9}$/.test(t) && t.split(/\s+/).length <= 10;
      var shortLine = l.width < medWidth * 0.72;
      if (big && noStop && t.length < 90) return true;
      if (caps) return true;
      if (numbered && shortLine && noStop && t.length < 80) return true;
      if (titleish && shortLine && noStop && t.split(/\s+/).length >= 2) return true;
      return false;
    }

    var blocks = [], buf = [], bufIsHead = false;

    function flush() {
      if (!buf.length) return;
      var joined = '';
      for (var k = 0; k < buf.length; k++) {
        var t = buf[k];
        if (!joined) { joined = t; continue; }
        if (/[A-Za-z]-$/.test(joined) && /^[a-z]/.test(t)) joined = joined.slice(0, -1) + t;  // de-hyphenate
        else joined += ' ' + t;
      }
      blocks.push({ type: bufIsHead ? 'heading' : 'paragraph', text: joined.trim(), page: pageNo });
      buf = []; bufIsHead = false;
    }

    for (var j = 0; j < lines.length; j++) {
      var line = lines[j];
      var head = isHeadingLine(line);
      var gap = j ? Math.abs(lines[j - 1].y - line.y) : 0;
      var prev = j ? lines[j - 1] : null;

      var newBlock =
        head || bufIsHead ||
        (j > 0 && gap > medGap * 1.55) ||
        /^[•●▪◦*•\-–]\s/.test(line.text) ||
        (prev && /[.!?:]$/.test(prev.text) && prev.width < medWidth * 0.82) ||
        (prev && Math.abs(line.size - prev.size) > medSize * 0.3);

      if (newBlock) flush();
      buf.push(line.text);
      bufIsHead = head;
      if (head) flush();
    }
    flush();
    return blocks;
  }

  /* ------------------------------------------------------------- canvas -- */

  function makeCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }

  /**
   * Luminance conversion + percentile contrast stretch. Cheap, and it is the
   * single change that most improves Tesseract's output on phone photos.
   */
  function preprocess(canvas) {
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    var img;
    try { img = ctx.getImageData(0, 0, canvas.width, canvas.height); }
    catch (e) { return false; }                     // tainted canvas — skip, do not crash

    var d = img.data, hist = new Uint32Array(256), i, g;
    for (i = 0; i < d.length; i += 4) {
      g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
      d[i] = d[i + 1] = d[i + 2] = g;
      hist[g]++;
    }
    var total = d.length / 4, lowCut = total * 0.02, highCut = total * 0.02, acc = 0, lo = 0, hi = 255;
    for (i = 0; i < 256; i++) { acc += hist[i]; if (acc >= lowCut) { lo = i; break; } }
    acc = 0;
    for (i = 255; i >= 0; i--) { acc += hist[i]; if (acc >= highCut) { hi = i; break; } }
    if (hi - lo < 24) return true;                  // already flat; stretching would only add noise

    var scale = 255 / (hi - lo);
    var lut = new Uint8Array(256);
    for (i = 0; i < 256; i++) lut[i] = Math.max(0, Math.min(255, Math.round((i - lo) * scale)));
    for (i = 0; i < d.length; i += 4) { g = lut[d[i]]; d[i] = d[i + 1] = d[i + 2] = g; }
    ctx.putImageData(img, 0, 0);
    return true;
  }

  function loadImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var im = new Image();
      im.onload = function () { URL.revokeObjectURL(url); resolve(im); };
      im.onerror = function () { URL.revokeObjectURL(url); reject(new Error('That image could not be decoded. It may be corrupt or in a format this browser does not support.')); };
      im.src = url;
    });
  }

  /* ---------------------------------------------------------------- OCR -- */

  var _worker = null;
  function ocrWorker(onLog) {
    if (_worker) return Promise.resolve(_worker);
    if (!global.Tesseract) return Promise.reject(new Error('The OCR library did not load. Check your connection and reload — Lens fetches Tesseract.js from a CDN on first use.'));
    return Promise.resolve(global.Tesseract.createWorker('eng', 1, {
      logger: function (m) { if (onLog) onLog(m); }
    })).then(function (w) { _worker = w; return w; });
  }

  function releaseWorker() {
    if (_worker) { try { _worker.terminate(); } catch (e) {} _worker = null; }
  }

  /** OCR one canvas, returning plain text plus mean confidence. */
  function ocrCanvas(canvas, onProgress, token) {
    return ocrWorker(function (m) {
      if (m && m.status === 'recognizing text' && onProgress) onProgress(m.progress || 0);
    }).then(function (w) {
      check(token);
      return w.recognize(canvas);
    }).then(function (res) {
      var data = res.data || {};
      return { text: data.text || '', confidence: typeof data.confidence === 'number' ? data.confidence : null };
    });
  }

  /** OCR text has no geometry, so paragraphs come from blank lines. */
  function ocrTextToBlocks(text, pageNo) {
    var chunks = text.replace(/\r/g, '').split(/\n\s*\n+/);
    var blocks = [];
    for (var i = 0; i < chunks.length; i++) {
      var lines = chunks[i].split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
      if (!lines.length) continue;
      var joined = '';
      for (var k = 0; k < lines.length; k++) {
        if (!joined) { joined = lines[k]; continue; }
        if (/[A-Za-z]-$/.test(joined) && /^[a-z]/.test(lines[k])) joined = joined.slice(0, -1) + lines[k];
        else joined += ' ' + lines[k];
      }
      joined = joined.replace(/\s+/g, ' ').trim();
      if (joined.replace(/[^A-Za-z0-9]/g, '').length < 2) continue;
      var isHead = joined.length < 70 && !/[.!?]$/.test(joined) &&
                   (joined === joined.toUpperCase() ? /[A-Z]{3}/.test(joined) : /^(\d+(\.\d+)*[.)]?\s|Chapter |Section )/i.test(joined));
      blocks.push({ type: isHead ? 'heading' : 'paragraph', text: joined, page: pageNo });
    }
    return blocks;
  }

  /* ------------------------------------------------------------ drivers -- */

  function extractImage(file, report, token) {
    var meta = { source: 'ocr', pages: 1, preprocessed: false, engine: 'Tesseract.js (eng)' };
    return loadImage(file).then(function (im) {
      check(token);
      var scale = 1;
      if (im.width < OCR_WIDTH_MIN) scale = OCR_WIDTH_MIN / im.width;
      if (im.width * scale > OCR_WIDTH_MAX) scale = OCR_WIDTH_MAX / im.width;
      var c = makeCanvas(im.width * scale, im.height * scale);
      var ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(im, 0, 0, c.width, c.height);
      meta.preprocessed = preprocess(c);
      meta.dimensions = im.width + '×' + im.height;
      report('extract', 0.15, 'Reading the image with OCR');
      return ocrCanvas(c, function (p) { report('extract', 0.15 + p * 0.8, 'Reading the image with OCR'); }, token);
    }).then(function (res) {
      meta.confidence = res.confidence;
      var blocks = ocrTextToBlocks(res.text, 1);
      return { blocks: blocks, meta: meta };
    });
  }

  function extractPDF(file, report, token) {
    if (!global.pdfjsLib) return Promise.reject(new Error('The PDF library did not load. Check your connection and reload — Lens fetches PDF.js from a CDN.'));
    global.pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

    var meta = { source: 'pdf', pages: 0, engine: 'PDF.js text layer' };
    var doc = null;

    return file.arrayBuffer().then(function (buf) {
      check(token);
      report('extract', 0.05, 'Opening the PDF');
      return global.pdfjsLib.getDocument({ data: buf, isEvalSupported: false, disableFontFace: true }).promise;
    }).catch(function (e) {
      var msg = String(e && e.message || e);
      if (/password/i.test(msg)) throw new Error('That PDF is password-protected. Remove the password and try again.');
      throw new Error('That PDF could not be opened — it may be corrupt or not really a PDF.');
    }).then(function (d) {
      doc = d;
      meta.pages = d.numPages;
      var blocks = [], chars = 0;
      var chain = Promise.resolve();

      for (var p = 1; p <= d.numPages; p++) {
        (function (pageNo) {
          chain = chain.then(function () {
            check(token);
            report('extract', 0.05 + 0.85 * ((pageNo - 1) / d.numPages), 'Extracting page ' + pageNo + ' of ' + d.numPages);
            return d.getPage(pageNo);
          }).then(function (page) {
            return page.getTextContent({ normalizeWhitespace: true, disableCombineTextItems: false });
          }).then(function (tc) {
            var lines = itemsToLines(tc.items || []);
            var pageBlocks = linesToBlocks(lines, pageNo);
            for (var b = 0; b < pageBlocks.length; b++) chars += pageBlocks[b].text.length;
            blocks = blocks.concat(pageBlocks);
          });
        })(p);
      }
      return chain.then(function () { return { blocks: blocks, chars: chars, doc: d }; });
    }).then(function (r) {
      // A text layer of a few characters per page means this is a scan.
      var perPage = r.chars / Math.max(1, meta.pages);
      if (perPage >= 90) {
        meta.charsPerPage = Math.round(perPage);
        return { blocks: r.blocks, meta: meta };
      }
      meta.source = 'ocr';
      meta.engine = 'PDF.js render → Tesseract.js (eng)';
      meta.fallback = true;
      meta.preprocessed = true;
      return ocrPdfPages(r.doc, meta, report, token);
    }).then(function (out) {
      if (doc) { try { doc.destroy(); } catch (e) {} }
      return out;
    }, function (err) {
      if (doc) { try { doc.destroy(); } catch (e) {} }
      throw err;
    });
  }

  /** Scanned-PDF path: rasterise each page, then OCR the bitmap. */
  function ocrPdfPages(doc, meta, report, token) {
    var pages = Math.min(doc.numPages, PDF_OCR_PAGE_CAP);
    meta.ocrPages = pages;
    meta.truncated = pages < doc.numPages;
    var blocks = [], confs = [];
    var chain = Promise.resolve();

    for (var p = 1; p <= pages; p++) {
      (function (pageNo) {
        chain = chain.then(function () {
          check(token);
          report('extract', 0.08 + 0.88 * ((pageNo - 1) / pages),
            'No text layer found — running OCR on page ' + pageNo + ' of ' + pages);
          return doc.getPage(pageNo);
        }).then(function (page) {
          var base = page.getViewport({ scale: 1 });
          var scale = Math.min(2.6, Math.max(1.4, OCR_WIDTH_MIN / base.width));
          var vp = page.getViewport({ scale: scale });
          var c = makeCanvas(vp.width, vp.height);
          var ctx = c.getContext('2d', { willReadFrequently: true });
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
          return page.render({ canvasContext: ctx, viewport: vp }).promise.then(function () {
            preprocess(c);
            return ocrCanvas(c, function (pr) {
              report('extract', 0.08 + 0.88 * ((pageNo - 1 + pr) / pages),
                'Running OCR on page ' + pageNo + ' of ' + pages);
            }, token);
          });
        }).then(function (res) {
          if (typeof res.confidence === 'number') confs.push(res.confidence);
          blocks = blocks.concat(ocrTextToBlocks(res.text, pageNo));
        });
      })(p);
    }

    return chain.then(function () {
      meta.confidence = confs.length ? confs.reduce(function (a, b) { return a + b; }, 0) / confs.length : null;
      return { blocks: blocks, meta: meta };
    });
  }

  /**
   * extract(file, report, token) → { blocks, meta }
   *   report(stage, fraction, label) is called continuously so the UI never
   *   shows an unexplained spinner.
   */
  function extract(file, report, token) {
    var err = validate(file);
    if (err) return Promise.reject(new Error(err));
    report('read', 0.02, 'Reading ' + file.name);
    var run = kind(file) === 'pdf' ? extractPDF : extractImage;
    return run(file, report, token).then(function (out) {
      var real = 0;
      for (var i = 0; i < out.blocks.length; i++) real += out.blocks[i].text.replace(/\s/g, '').length;
      if (real < 40) {
        throw new Error(out.meta.source === 'ocr'
          ? 'OCR found almost no legible text. If this is a photo, try better lighting, a straight-on angle, and at least 300 DPI.'
          : 'No readable text was found in that PDF.');
      }
      out.meta.file = { name: file.name, size: file.size, type: file.type || kind(file) };
      return out;
    });
  }

  global.Lens = global.Lens || {};
  global.Lens.Extractor = {
    extract: extract, validate: validate, kind: kind,
    releaseWorker: releaseWorker, CancelledError: CancelledError,
    // exported so the layout rebuild can be unit-tested without a browser
    _itemsToLines: itemsToLines, _linesToBlocks: linesToBlocks, _ocrTextToBlocks: ocrTextToBlocks
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.Lens.Extractor;

})(typeof window !== 'undefined' ? window : globalThis);
