/* ============================================================================
 * app.js — state, rendering and everything the user actually touches.
 *
 * Design note: extraction is expensive and happens once; ranking is cheap and
 * happens on every move of the focal dial. Keeping those two apart is the whole
 * reason the dial can feel continuous on a long document — analyse() builds the
 * sentence graph, summarise() only re-selects from it.
 *
 * No framework. The app is a small state object plus render functions that read
 * from it, which at this size is less code than any alternative and has no
 * build step for a reviewer to run.
 * ========================================================================== */
(function () {
  'use strict';

  var Sum = window.Lens.Summarizer;
  var Ana = window.Lens.Analyzer;
  var Ext = window.Lens.Extractor;

  /* ---------------------------------------------------------------- dom -- */
  var $ = function (id) { return document.getElementById(id); };
  var el = {
    viewIntake: $('viewIntake'), viewLoading: $('viewLoading'), viewWork: $('viewWork'),
    dropzone: $('dropzone'), fileInput: $('fileInput'), dzError: $('dzError'), sampleBtn: $('sampleBtn'),
    loadingFile: $('loadingFile'), loadingStage: $('loadingStage'), loadingNote: $('loadingNote'),
    progressFill: $('progressFill'), progressBar: $('progressBar'), stageList: $('stageList'),
    cancelBtn: $('cancelBtn'),
    fileChip: $('fileChip'), fileMeta: $('fileMeta'),
    focal: $('focal'), focalName: $('focalName'), focalStat: $('focalStat'), dialTicks: $('dialTicks'),
    summaryOut: $('summaryOut'), ideasOut: $('ideasOut'), keyTerms: $('keyTerms'),
    suggestOut: $('suggestOut'), suggestBadge: $('suggestBadge'),
    sourceOut: $('sourceOut'), readerOut: $('readerOut'), readerPage: $('readerPage'),
    spine: $('spine'), vitals: $('vitals'),
    healthArc: $('healthArc'), healthScore: $('healthScore'), healthGrade: $('healthGrade'), healthNote: $('healthNote'),
    themeBtn: $('themeBtn'), resetBtn: $('resetBtn'), copyBtn: $('copyBtn'), exportBtn: $('exportBtn'),
    toast: $('toast')
  };

  /* -------------------------------------------------------------- state -- */
  var FOCALS = [
    { r: 0.020, name: 'Glance' },
    { r: 0.035, name: 'Précis' },
    { r: 0.060, name: 'Short' },
    { r: 0.090, name: 'Brief' },
    { r: 0.130, name: 'Medium' },
    { r: 0.190, name: 'Extended' },
    { r: 0.270, name: 'Long' },
    { r: 0.380, name: 'Detailed' },
    { r: 0.550, name: 'Near-full' }
  ];

  var state = {
    model: null, analysis: null, meta: null, blocks: null,
    focal: 5, picked: [], pickedSet: null, token: null, busy: false
  };

  var STAGES = ['read', 'extract', 'segment', 'rank', 'analyse'];
  var RANGE = { read: [0, .05], extract: [.05, .70], segment: [.70, .78], rank: [.78, .92], analyse: [.92, 1] };

  /* ------------------------------------------------------------ helpers -- */
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function bytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }
  var toastTimer;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    requestAnimationFrame(function () { el.toast.classList.add('is-on'); });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.toast.classList.remove('is-on');
      setTimeout(function () { el.toast.hidden = true; }, 300);
    }, 2600);
  }
  function show(view) {
    el.viewIntake.hidden = view !== 'intake';
    el.viewLoading.hidden = view !== 'loading';
    el.viewWork.hidden = view !== 'work';
    el.resetBtn.hidden = view !== 'work';
  }
  /* Give the browser a frame so the progress UI can actually paint. */
  function breathe() { return new Promise(function (r) { setTimeout(r, 16); }); }

  /* ------------------------------------------------------------- theme --- */
  function initTheme() {
    var saved = null;
    try { saved = localStorage.getItem('lens-theme'); } catch (e) {}
    var pref = saved || (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'paper' : 'dark');
    document.documentElement.setAttribute('data-theme', pref);
  }
  function toggleTheme() {
    var now = document.documentElement.getAttribute('data-theme') === 'paper' ? 'dark' : 'paper';
    document.documentElement.setAttribute('data-theme', now);
    try { localStorage.setItem('lens-theme', now); } catch (e) {}
    if (state.model) drawSpine();
  }

  /* ----------------------------------------------------------- progress -- */
  function setStage(stage) {
    var idx = STAGES.indexOf(stage);
    Array.prototype.forEach.call(el.stageList.children, function (li, i) {
      li.classList.toggle('is-now', i === idx);
      li.classList.toggle('is-done', i < idx);
    });
  }
  function report(stage, frac, label) {
    var r = RANGE[stage] || [0, 1];
    var pctv = Math.round((r[0] + (r[1] - r[0]) * Math.max(0, Math.min(1, frac))) * 100);
    el.progressFill.style.width = pctv + '%';
    el.progressBar.setAttribute('aria-valuenow', String(pctv));
    if (label) el.loadingStage.textContent = label;
    setStage(stage);
  }

  /* --------------------------------------------------------- the runner -- */
  function handleFile(file) {
    var problem = Ext.validate(file);
    if (problem) { showError(problem); return; }
    clearError();
    runPipeline(file, null);
  }

  function runPipeline(file, presetBlocks) {
    if (state.busy) return;
    state.busy = true;
    var token = { cancelled: false };
    state.token = token;

    el.loadingFile.textContent = file ? file.name : 'Sample document';
    el.loadingNote.textContent = file && Ext.kind(file) === 'image'
      ? 'OCR runs entirely on your machine, which is why it takes a moment. Nothing is uploaded.'
      : 'Everything below happens inside this browser tab — no server, no upload.';
    el.progressFill.style.width = '0%';
    setStage('read');
    show('loading');

    var step = presetBlocks
      ? Promise.resolve({ blocks: presetBlocks.blocks, meta: presetBlocks.meta })
      : Ext.extract(file, report, token);

    step.then(function (out) {
      if (token.cancelled) throw new Ext.CancelledError();
      state.blocks = out.blocks;
      state.meta = out.meta;
      report('segment', 0.4, 'Segmenting sentences');
      return breathe();
    }).then(function () {
      if (token.cancelled) throw new Ext.CancelledError();
      report('rank', 0.2, 'Building the sentence graph');
      return breathe();
    }).then(function () {
      if (token.cancelled) throw new Ext.CancelledError();
      state.model = Sum.analyse(state.blocks);
      if (!state.model.sentences.length) throw new Error('The text was read, but no complete sentences could be found in it.');
      report('rank', 1, 'Ranking ' + state.model.sentences.length + ' sentences');
      return breathe();
    }).then(function () {
      if (token.cancelled) throw new Ext.CancelledError();
      report('analyse', 0.4, 'Auditing the writing');
      state.analysis = Ana.run(state.model, state.meta);
      return breathe();
    }).then(function () {
      if (token.cancelled) throw new Ext.CancelledError();
      report('analyse', 1, 'Done');
      state.busy = false;
      Ext.releaseWorker();
      mount();
    }).catch(function (err) {
      state.busy = false;
      Ext.releaseWorker();
      if (err && err.name === 'CancelledError') { show('intake'); return; }
      console.error(err);
      show('intake');
      showError(err && err.message ? err.message : 'Something went wrong while reading that file.');
    });
  }

  function showError(msg) {
    el.dzError.innerHTML = esc(msg);
    el.dzError.hidden = false;
  }
  function clearError() { el.dzError.hidden = true; el.dzError.textContent = ''; }

  /* -------------------------------------------------------------- mount -- */
  function mount() {
    var m = state.meta, st = state.analysis.stats;
    el.fileChip.textContent = (m.file && m.file.name) || 'Sample document';
    el.fileChip.title = (m.file && m.file.name) || 'Sample document';
    el.fileMeta.textContent = [
      m.pages ? m.pages + (m.pages === 1 ? ' page' : ' pages') : null,
      st.words.toLocaleString() + ' words',
      m.file ? bytes(m.file.size) : null
    ].filter(Boolean).join(' · ');

    buildTicks();
    renderSource();
    renderPoints();
    renderSuggestions();
    renderVitals();
    renderHealth();
    applyFocal(state.focal);
    show('work');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* --------------------------------------------------------- focal dial -- */
  function buildTicks() {
    var h = '';
    for (var i = 1; i <= 9; i++) h += '<i' + (i <= state.focal ? ' class="on"' : '') + '></i>';
    el.dialTicks.innerHTML = h;
  }

  function applyFocal(f) {
    state.focal = f;
    el.focal.value = String(f);
    el.focal.style.setProperty('--fill', ((f - 1) / 8 * 100) + '%');
    buildTicks();

    var res = Sum.summarise(state.model, FOCALS[f - 1].r);
    state.picked = res.picked;
    state.pickedSet = Object.create(null);
    for (var i = 0; i < res.picked.length; i++) state.pickedSet[res.picked[i]] = true;

    el.focalName.textContent = FOCALS[f - 1].name;
    el.focalStat.textContent = '— ' + res.count + ' of ' + res.total + ' sentences · ' +
      Math.round(res.ratio * 100) + '% of the document · ~' +
      Math.max(1, Math.round(summaryWords() / 225)) + ' min read';

    Array.prototype.forEach.call(document.querySelectorAll('.preset'), function (b) {
      b.classList.toggle('is-on', Number(b.dataset.focal) === f);
    });

    renderSummary();
    markSource();
    drawSpine();
  }

  function summaryWords() {
    var w = 0;
    for (var i = 0; i < state.picked.length; i++) w += state.model.sentences[state.picked[i]].words || 0;
    return w;
  }

  /* ------------------------------------------------------- render: summary */
  function renderSummary() {
    var s = state.model.sentences, html = '', prevBlock = null;
    for (var i = 0; i < state.picked.length; i++) {
      var idx = state.picked[i], sn = s[idx];
      if (prevBlock !== null && sn.block !== prevBlock) html += '<div class="para-gap"></div>';
      prevBlock = sn.block;
      html += '<button type="button" class="s-sent" data-idx="' + idx + '">' +
                '<span class="s-rank">' + (i + 1) + '</span>' +
                esc(sn.text) +
                '<span class="s-page">p.' + sn.page + '</span>' +
              '</button>';
    }
    el.summaryOut.innerHTML = html ||
      '<p class="pane-intro">Nothing selected at this focal length.</p>';
  }

  /* -------------------------------------------------------- render: source */
  function sourceHTML() {
    var blocks = state.blocks, sents = state.model.sentences;
    var byBlock = Object.create(null), i;
    for (i = 0; i < sents.length; i++) {
      (byBlock[sents[i].block] || (byBlock[sents[i].block] = [])).push(i);
    }
    var html = '', lastPage = null;
    for (var b = 0; b < blocks.length; b++) {
      var blk = blocks[b];
      if (!blk.text) continue;
      if (blk.page && blk.page !== lastPage) {
        if (lastPage !== null) html += '<div class="src-page-break">page ' + blk.page + '</div>';
        lastPage = blk.page;
      }
      if (blk.type === 'heading') { html += '<h4 class="src-h">' + esc(blk.text) + '</h4>'; continue; }
      var list = byBlock[b];
      if (!list) { html += '<p class="src-p">' + esc(blk.text) + '</p>'; continue; }
      var inner = '';
      for (i = 0; i < list.length; i++) {
        inner += '<span class="src-s" id="src-' + list[i] + '" data-idx="' + list[i] + '">' +
                 esc(sents[list[i]].text) + '</span> ';
      }
      html += '<p class="src-p">' + inner + '</p>';
    }
    return html;
  }

  function renderSource() {
    var h = sourceHTML();
    el.sourceOut.innerHTML = h;
    el.readerOut.innerHTML = h.replace(/id="src-/g, 'id="rsrc-');
    el.readerPage.textContent = state.meta.pages ? state.meta.pages + ' pages' : '';
  }

  /** Shade the source by relevance, and mark what the current focal selected. */
  function markSource() {
    var sents = state.model.sentences;
    Array.prototype.forEach.call(document.querySelectorAll('.src-s'), function (node) {
      var i = Number(node.dataset.idx), heat = sents[i].heat;
      var lvl = state.pickedSet[i] ? 3 : heat > 0.62 ? 2 : heat > 0.42 ? 1 : 0;
      if (lvl) node.setAttribute('data-h', String(lvl)); else node.removeAttribute('data-h');
    });
  }

  /* -------------------------------------------------------- render: points */
  function renderPoints() {
    var s = state.model.sentences;
    var order = s.map(function (x) { return x.i; })
                 .sort(function (a, b) { return s[b].score - s[a].score; })
                 .slice(0, Math.min(4, s.length))
                 .sort(function (a, b) { return a - b; });
    el.ideasOut.innerHTML = order.map(function (i) {
      return '<li>' + esc(s[i].text) + '</li>';
    }).join('');

    var ph = state.model.phrases, max = ph.length ? ph[0].score : 1;
    el.keyTerms.innerHTML = ph.map(function (p) {
      var w = p.score > max * 0.66 ? 3 : p.score > max * 0.4 ? 2 : 1;
      return '<span class="chip" data-w="' + w + '"><b>' + esc(p.text) + '</b><i>×' + p.count + '</i></span>';
    }).join('') || '<span class="chip">Not enough repeated vocabulary to rank terms.</span>';
  }

  /* ---------------------------------------------------- render: suggestions */
  function renderSuggestions() {
    var a = state.analysis;
    var flagged = a.items.filter(function (x) { return x.level !== 'good'; }).length;
    el.suggestBadge.textContent = String(flagged);
    el.suggestOut.innerHTML = a.items.map(function (it) {
      return '<article class="sg" data-level="' + it.level + '">' +
        '<div class="sg-ico">' + esc(it.icon) + '</div>' +
        '<div class="sg-body"><h4>' + esc(it.title) + '</h4>' +
          '<p>' + esc(it.body) + '</p>' +
          '<p class="sg-fix">' + it.fix + '</p>' +
        '</div>' +
        '<div class="sg-metric">' + esc(it.metric) + '<small>' + esc(it.unit) + '</small></div>' +
      '</article>';
    }).join('');
  }

  /* -------------------------------------------------------- render: vitals */
  function renderVitals() {
    var m = state.meta, st = state.analysis.stats;
    var rows = [
      ['Pages', m.pages || 1],
      ['Words', st.words.toLocaleString()],
      ['Sentences', st.sentences],
      ['Read time', '~' + st.readMins + ' min'],
      ['Headings', st.headings],
      ['Source', m.source === 'ocr' ? (m.fallback ? 'OCR (scan)' : 'OCR') : 'PDF text']
    ];
    if (typeof m.confidence === 'number') rows.push(['OCR conf.', m.confidence.toFixed(1) + '%']);
    if (m.truncated) rows.push(['Note', 'first ' + m.ocrPages + ' pages']);
    el.vitals.innerHTML = rows.map(function (r) {
      return '<dt>' + esc(r[0]) + '</dt><dd>' + esc(String(r[1])) + '</dd>';
    }).join('');
  }

  /* -------------------------------------------------------- render: health */
  function renderHealth() {
    var a = state.analysis, C = 2 * Math.PI * 50;
    el.healthScore.textContent = String(a.score);
    el.healthGrade.textContent = a.grade;
    el.healthNote.innerHTML = a.note;
    var colour = a.score >= 75 ? 'var(--teal)' : a.score >= 50 ? 'var(--brass)' : 'var(--rose)';
    el.healthArc.style.stroke = colour;
    el.healthArc.style.strokeDasharray = C;
    requestAnimationFrame(function () {
      el.healthArc.style.strokeDashoffset = String(C * (1 - a.score / 100));
    });
  }

  /* --------------------------------------------------------- render: spine */
  /* A mosaic fingerprint: one cell per sentence, in reading order, brightness
     by relevance, gold outline for whatever the current focal length kept. */
  var spineGeom = null;
  function drawSpine() {
    var cv = el.spine, sents = state.model.sentences;
    var dpr = window.devicePixelRatio || 1;
    var w = cv.clientWidth || 232, h = cv.clientHeight || 168;
    cv.width = w * dpr; cv.height = h * dpr;
    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    var n = sents.length;
    var cell = Math.max(3, Math.min(15, Math.floor(Math.sqrt((w * h) / Math.max(n, 1)))));
    var gap = cell > 6 ? 2 : 1;
    var step = cell + gap;
    var cols = Math.max(1, Math.floor((w + gap) / step));
    var rowsNeeded = Math.ceil(n / cols);
    while (rowsNeeded * step - gap > h && cell > 2) {
      cell--; step = cell + gap; cols = Math.max(1, Math.floor((w + gap) / step));
      rowsNeeded = Math.ceil(n / cols);
    }
    var offX = Math.max(0, (w - (cols * step - gap)) / 2);
    var offY = Math.max(0, (h - (rowsNeeded * step - gap)) / 2);

    var css = getComputedStyle(document.documentElement);
    var brass = css.getPropertyValue('--brass').trim() || '#D9A441';
    var line = css.getPropertyValue('--line').trim() || '#262B36';

    spineGeom = { cell: cell, step: step, cols: cols, offX: offX, offY: offY, n: n };

    for (var i = 0; i < n; i++) {
      var cx = offX + (i % cols) * step;
      var cy = offY + Math.floor(i / cols) * step;
      var heat = sents[i].heat;
      if (state.pickedSet[i]) {
        ctx.fillStyle = brass;
        ctx.globalAlpha = 1;
      } else {
        ctx.fillStyle = brass;
        ctx.globalAlpha = 0.10 + heat * 0.42;
        if (heat < 0.25) { ctx.fillStyle = line; ctx.globalAlpha = 1; }
      }
      ctx.fillRect(cx, cy, cell, cell);
    }
    ctx.globalAlpha = 1;
  }

  function spineHit(ev) {
    if (!spineGeom) return -1;
    var r = el.spine.getBoundingClientRect();
    var x = ev.clientX - r.left - spineGeom.offX;
    var y = ev.clientY - r.top - spineGeom.offY;
    var c = Math.floor(x / spineGeom.step), rw = Math.floor(y / spineGeom.step);
    if (c < 0 || c >= spineGeom.cols || rw < 0) return -1;
    var idx = rw * spineGeom.cols + c;
    return idx >= 0 && idx < spineGeom.n ? idx : -1;
  }

  /* ------------------------------------------------------- click-to-source */
  function revealSentence(idx) {
    var wide = window.matchMedia('(min-width: 1241px)').matches;
    var target = null;
    if (wide) {
      target = document.getElementById('rsrc-' + idx);
      if (target) {
        var box = el.readerOut;
        box.scrollTo({ top: target.offsetTop - box.offsetTop - 90, behavior: 'smooth' });
      }
    } else {
      selectTab('source');
      target = document.getElementById('src-' + idx);
      if (target) {
        var box2 = el.sourceOut;
        box2.scrollTo({ top: target.offsetTop - box2.offsetTop - 60, behavior: 'smooth' });
      }
    }
    ['src-' + idx, 'rsrc-' + idx].forEach(function (id) {
      var nd = document.getElementById(id);
      if (!nd) return;
      nd.classList.remove('is-flash');
      void nd.offsetWidth;
      nd.classList.add('is-flash');
      setTimeout(function () { nd.classList.remove('is-flash'); }, 1700);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.s-sent'), function (b) {
      b.classList.toggle('is-active', Number(b.dataset.idx) === idx);
    });
  }

  /* --------------------------------------------------------------- tabs -- */
  function selectTab(name) {
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      var on = t.dataset.tab === name;
      t.classList.toggle('is-on', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    var map = { summary: 'paneSummary', points: 'panePoints', suggest: 'paneSuggest', source: 'paneSource' };
    Object.keys(map).forEach(function (k) { $(map[k]).classList.toggle('is-on', k === name); });
  }

  /* ------------------------------------------------------------- export -- */
  function buildMarkdown() {
    var m = state.meta, a = state.analysis, s = state.model.sentences;
    var name = (m.file && m.file.name) || 'Sample document';
    var L = [];
    L.push('# Summary — ' + name);
    L.push('');
    L.push('> Generated by Lens · ' + FOCALS[state.focal - 1].name + ' focal length · ' +
           state.picked.length + ' of ' + s.length + ' sentences (' +
           Math.round(state.picked.length / s.length * 100) + '%)');
    L.push('');
    L.push('## Summary');
    L.push('');
    for (var i = 0; i < state.picked.length; i++) L.push(s[state.picked[i]].text);
    L.push('');
    L.push('## Key terms');
    L.push('');
    L.push(state.model.phrases.map(function (p) { return p.text + ' (×' + p.count + ')'; }).join(' · '));
    L.push('');
    L.push('## Improvement suggestions');
    L.push('');
    a.items.forEach(function (it) {
      L.push('### ' + it.title + ' — ' + it.metric + ' ' + it.unit);
      L.push(it.body);
      L.push('*' + it.fix.replace(/<\/?b>/g, '**').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"') + '*');
      L.push('');
    });
    L.push('---');
    L.push('Document health: ' + a.score + '/100 (' + a.grade + ') · ' +
           a.stats.words + ' words · Flesch ' + a.stats.flesch + ' · source: ' +
           (m.source === 'ocr' ? 'OCR' : 'PDF text layer'));
    return L.join('\n');
  }

  function summaryText() {
    var s = state.model.sentences;
    return state.picked.map(function (i) { return s[i].text; }).join(' ');
  }

  function copySummary() {
    var txt = summaryText();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(function () { toast('Summary copied'); },
        function () { fallbackCopy(txt); });
    } else fallbackCopy(txt);
  }
  function fallbackCopy(txt) {
    var ta = document.createElement('textarea');
    ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('Summary copied'); }
    catch (e) { toast('Copy failed — select the text manually'); }
    document.body.removeChild(ta);
  }

  function exportMd() {
    var blob = new Blob([buildMarkdown()], { type: 'text/markdown;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    var base = ((state.meta.file && state.meta.file.name) || 'document').replace(/\.[^.]+$/, '');
    a.href = url; a.download = base + '.summary.md';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
    toast('Exported ' + a.download);
  }

  /* --------------------------------------------------------------- reset -- */
  function reset() {
    state.model = null; state.analysis = null; state.meta = null; state.blocks = null;
    state.picked = []; state.pickedSet = null;
    el.fileInput.value = '';
    clearError();
    show('intake');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* --------------------------------------------------------------- wiring */
  function wire() {
    // Upload
    el.dropzone.addEventListener('click', function () { el.fileInput.click(); });
    el.dropzone.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.fileInput.click(); }
    });
    el.fileInput.addEventListener('change', function (e) {
      if (e.target.files && e.target.files[0]) handleFile(e.target.files[0]);
    });

    ['dragenter', 'dragover'].forEach(function (ev) {
      el.dropzone.addEventListener(ev, function (e) { e.preventDefault(); el.dropzone.classList.add('is-drag'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      el.dropzone.addEventListener(ev, function (e) { e.preventDefault(); el.dropzone.classList.remove('is-drag'); });
    });
    el.dropzone.addEventListener('drop', function (e) {
      var dt = e.dataTransfer;
      if (!dt) return;
      var f = dt.files && dt.files[0];
      if (f) handleFile(f);
      else showError('That drop did not contain a file.');
    });
    // Stop the browser from navigating away when a file misses the dropzone.
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) { e.preventDefault(); });

    el.sampleBtn.addEventListener('click', function () {
      clearError();
      runPipeline(null, {
        blocks: window.Lens.SAMPLE.blocks,
        meta: { source: 'pdf', pages: 3, engine: 'bundled sample', file: { name: window.Lens.SAMPLE.name, size: window.Lens.SAMPLE.size, type: 'text/plain' } }
      });
    });

    el.cancelBtn.addEventListener('click', function () {
      if (state.token) state.token.cancelled = true;
      state.busy = false;
      Ext.releaseWorker();
      show('intake');
    });

    // Focal
    el.focal.addEventListener('input', function () { applyFocal(Number(el.focal.value)); });
    Array.prototype.forEach.call(document.querySelectorAll('.preset'), function (b) {
      b.addEventListener('click', function () { applyFocal(Number(b.dataset.focal)); });
    });

    // Tabs
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      t.addEventListener('click', function () { selectTab(t.dataset.tab); });
    });

    // Summary → source
    el.summaryOut.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.s-sent') : null;
      if (btn) revealSentence(Number(btn.dataset.idx));
    });

    // Spine → source
    el.spine.addEventListener('click', function (e) {
      var i = spineHit(e);
      if (i >= 0) revealSentence(i);
    });
    el.spine.addEventListener('mousemove', function (e) {
      var i = spineHit(e);
      el.spine.title = i >= 0
        ? 'Sentence ' + (i + 1) + ' · p.' + state.model.sentences[i].page + ' · ' +
          Math.round(state.model.sentences[i].heat * 100) + '% relevance\n' +
          state.model.sentences[i].text.slice(0, 120)
        : '';
    });

    // Chrome
    el.themeBtn.addEventListener('click', toggleTheme);
    el.resetBtn.addEventListener('click', reset);
    el.copyBtn.addEventListener('click', copySummary);
    el.exportBtn.addEventListener('click', exportMd);

    window.addEventListener('resize', function () { if (state.model) drawSpine(); });

    document.addEventListener('keydown', function (e) {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      var k = e.key.toLowerCase();
      if (k === 't') { toggleTheme(); return; }
      if (!state.model) return;
      if (k === 'n') { reset(); return; }
      if (k === 'c') { copySummary(); return; }
      if (e.key === 'ArrowLeft')  { e.preventDefault(); applyFocal(Math.max(1, state.focal - 1)); }
      if (e.key === 'ArrowRight') { e.preventDefault(); applyFocal(Math.min(9, state.focal + 1)); }
      if (k === '1') selectTab('summary');
      if (k === '2') selectTab('points');
      if (k === '3') selectTab('suggest');
    });
  }

  /* ----------------------------------------------------------------- go -- */
  initTheme();
  wire();
  show('intake');

})();
