/* ============================================================================
 * analyze.js — the "Improvement Suggestions" engine.
 *
 * The brief asks for improvement suggestions but does not say of what, so this
 * module answers the most useful reading: given the document we just parsed,
 * what would make it clearer? Nine checks run over the extracted text. Each one
 * reports a measurement, a verdict, and — the part that matters — a specific
 * instruction, usually quoting the offending sentence back at the writer.
 *
 * A tenth check grades the extraction itself, because on a bad scan the honest
 * answer is "fix the scan", not "shorten your sentences".
 *
 * window.Lens.Analyzer
 * ========================================================================== */
(function (global) {
  'use strict';

  var S = (global.Lens && global.Lens.Summarizer) ||
          (typeof require !== 'undefined' ? require('./summarize.js') : null);

  var HEDGES = ['very', 'really', 'quite', 'rather', 'somewhat', 'basically', 'actually',
    'essentially', 'literally', 'fairly', 'pretty much', 'sort of', 'kind of', 'a bit',
    'in order to', 'due to the fact that', 'it should be noted that', 'it is important to note',
    'needless to say', 'at this point in time', 'for all intents and purposes', 'as a matter of fact'];

  var BE = ['is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'get', 'gets', 'got'];

  /* ---------- syllables: the noisy half of every readability formula ------ */
  function syllables(word) {
    var w = word.toLowerCase().replace(/[^a-z]/g, '');
    if (!w) return 0;
    if (w.length <= 3) return 1;
    w = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '');
    var m = w.match(/[aeiouy]{1,2}/g);
    return m ? m.length : 1;
  }

  function pct(a, b) { return b ? Math.round((a / b) * 1000) / 10 : 0; }
  /* Document text is embedded into suggestion HTML, so escape it here. */
  function esc(t) {
    return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function clip(t, n) {
    t = String(t).replace(/\s+/g, ' ').trim();
    return esc(t.length > n ? t.slice(0, n - 1) + '…' : t);
  }

  /* ------------------------------------------------------------ the checks -- */

  function run(model, meta) {
    var out = [], sents = model.sentences || [], n = sents.length;
    if (!n) {
      return {
        score: 0, grade: 'no text',
        note: 'No readable sentences were recovered, so there is nothing to audit yet.',
        items: [{
          level: 'warn', icon: '!', title: 'Nothing to analyse',
          body: 'Text extraction returned no usable sentences.',
          fix: 'Try a higher-resolution scan, or a PDF that contains a real text layer.',
          metric: '0', unit: 'sentences'
        }],
        stats: {}
      };
    }

    var i, k, words = 0, syl = 0, allWords = [], lengths = [];
    for (i = 0; i < n; i++) {
      var ws = sents[i].text.split(/\s+/).filter(Boolean);
      lengths.push(ws.length);
      words += ws.length;
      for (k = 0; k < ws.length; k++) { syl += syllables(ws[k]); allWords.push(ws[k].toLowerCase().replace(/[^a-z']/g, '')); }
    }
    var avgLen = words / n;
    var variance = lengths.reduce(function (a, l) { return a + Math.pow(l - avgLen, 2); }, 0) / n;
    var sd = Math.sqrt(variance);

    /* 1 ─ Flesch Reading Ease ------------------------------------------- */
    var flesch = 206.835 - 1.015 * (words / n) - 84.6 * (syl / Math.max(words, 1));
    flesch = Math.max(0, Math.min(100, Math.round(flesch)));
    var fkGrade = Math.max(1, Math.round(0.39 * (words / n) + 11.8 * (syl / Math.max(words, 1)) - 15.59));
    var fLevel = flesch >= 60 ? 'good' : flesch >= 40 ? 'notice' : 'warn';
    out.push({
      level: fLevel, icon: '◍', title: 'Reading ease',
      body: flesch >= 60
        ? 'Plain enough that a general reader gets through it without re-reading.'
        : flesch >= 40
          ? 'Reads like a professional or academic text — fine for a specialist audience, heavy for anyone else.'
          : 'Dense. Long sentences and long words are compounding each other.',
      fix: flesch >= 60
        ? 'Nothing to change here.'
        : 'Target the <b>' + Math.min(6, Math.max(2, Math.round(n * 0.05))) + ' longest sentences</b> first — splitting those moves this score more than rewording anything else.',
      metric: String(flesch), unit: 'Flesch · grade ' + fkGrade,
      weight: 1.3, norm: flesch / 100
    });

    /* 2 ─ Sentence length -------------------------------------------------- */
    var longOnes = [];
    for (i = 0; i < n; i++) if (lengths[i] > 35) longOnes.push({ i: i, w: lengths[i], t: sents[i].text });
    longOnes.sort(function (a, b) { return b.w - a.w; });
    var longShare = pct(longOnes.length, n);
    var lLevel = longShare < 8 ? 'good' : longShare < 20 ? 'notice' : 'warn';
    out.push({
      level: lLevel, icon: '⟷', title: 'Sentence length',
      body: 'Average ' + avgLen.toFixed(1) + ' words. ' + longOnes.length + ' of ' + n +
            ' sentences run past 35 words' + (longOnes.length ? ', the longest at ' + longOnes[0].w + '.' : '.'),
      fix: longOnes.length
        ? 'Start with p.' + sents[longOnes[0].i].page + ': “<b>' + clip(longOnes[0].t, 90) + '</b>” — find its second verb and cut there.'
        : 'Sentence lengths are already in a comfortable band.',
      metric: avgLen.toFixed(1), unit: 'words / sentence',
      weight: 1.1, norm: 1 - Math.min(1, longShare / 30)
    });

    /* 3 ─ Rhythm ----------------------------------------------------------- */
    var rLevel = sd >= 7 ? 'good' : sd >= 4.5 ? 'notice' : 'warn';
    out.push({
      level: rLevel, icon: '∿', title: 'Rhythm',
      body: sd >= 7
        ? 'Sentence lengths vary well, which is what stops prose sounding mechanical.'
        : 'Sentences are unusually uniform in length, which flattens the prose and makes emphasis hard to hear.',
      fix: sd >= 7 ? 'Nothing to change here.'
        : 'Drop a deliberate <b>short sentence</b> after each long one. Contrast is what creates emphasis.',
      metric: sd.toFixed(1), unit: 'length σ',
      weight: 0.7, norm: Math.min(1, sd / 9)
    });

    /* 4 ─ Passive voice ---------------------------------------------------- */
    var passive = [], pRe = new RegExp('\\b(' + BE.join('|') + ')\\b\\s+(\\w+ly\\s+)?(\\w+(ed|en|wn|ne|nt))\\b', 'i');
    for (i = 0; i < n; i++) if (pRe.test(sents[i].text)) passive.push(i);
    var passShare = pct(passive.length, n);
    var pLevel = passShare < 15 ? 'good' : passShare < 30 ? 'notice' : 'warn';
    out.push({
      level: pLevel, icon: '⇄', title: 'Passive voice',
      body: passive.length + ' of ' + n + ' sentences (' + passShare + '%) look passive. Passive constructions hide who did the thing.',
      fix: passive.length && passShare >= 15
        ? 'Rewrite p.' + sents[passive[0]].page + ': “<b>' + clip(sents[passive[0]].text, 90) + '</b>” so the actor comes first.'
        : 'Active voice is already dominant.',
      metric: passShare + '%', unit: 'of sentences',
      weight: 1.0, norm: 1 - Math.min(1, passShare / 40)
    });

    /* 5 ─ Hedges and filler ------------------------------------------------ */
    var full = sents.map(function (s) { return s.text; }).join(' ').toLowerCase();
    var hedgeHits = [], total = 0;
    for (i = 0; i < HEDGES.length; i++) {
      var re = new RegExp('\\b' + HEDGES[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g');
      var m = full.match(re);
      if (m) { hedgeHits.push({ w: HEDGES[i], c: m.length }); total += m.length; }
    }
    hedgeHits.sort(function (a, b) { return b.c - a.c; });
    var per100 = words ? (total / words) * 100 : 0;
    var hLevel = per100 < 0.6 ? 'good' : per100 < 1.4 ? 'notice' : 'warn';
    out.push({
      level: hLevel, icon: '✂', title: 'Filler and hedging',
      body: total ? total + ' hedge words across the document — most often ' +
            hedgeHits.slice(0, 3).map(function (h) { return '“' + h.w + '” ×' + h.c; }).join(', ') + '.'
          : 'No common hedges or intensifiers found.',
      fix: total && per100 >= 0.6
        ? 'Delete them. “<b>' + hedgeHits[0].w + '</b>” can be removed ' + hedgeHits[0].c + ' times without changing a single meaning.'
        : 'The prose is already lean.',
      metric: per100.toFixed(2), unit: 'per 100 words',
      weight: 0.8, norm: 1 - Math.min(1, per100 / 2)
    });

    /* 6 ─ Redundancy ------------------------------------------------------- */
    var dupPairs = [];
    if (model.vecs && model.vecs.length === n && S) {
      for (i = 0; i < n; i++) {
        for (k = i + 1; k < Math.min(n, i + 45); k++) {
          var sim = S.cosine(model.vecs[i], model.vecs[k], model.norms[i], model.norms[k]);
          if (sim > 0.62 && lengths[i] > 6 && lengths[k] > 6) dupPairs.push({ a: i, b: k, s: sim });
        }
      }
    }
    dupPairs.sort(function (x, y) { return y.s - x.s; });
    var dLevel = dupPairs.length === 0 ? 'good' : dupPairs.length < 4 ? 'notice' : 'warn';
    out.push({
      level: dLevel, icon: '⧉', title: 'Repetition',
      body: dupPairs.length
        ? dupPairs.length + ' near-duplicate sentence pair' + (dupPairs.length === 1 ? '' : 's') +
          ' found (cosine > 0.62 on their term vectors).'
        : 'No sentence repeats another closely enough to be worth merging.',
      fix: dupPairs.length
        ? 'Sentences ' + (dupPairs[0].a + 1) + ' and ' + (dupPairs[0].b + 1) + ' are <b>' +
          Math.round(dupPairs[0].s * 100) + '% similar</b> — “' + clip(sents[dupPairs[0].a].text, 70) + '” Merge or cut one.'
        : 'Nothing to merge.',
      metric: String(dupPairs.length), unit: 'duplicate pairs',
      weight: 0.9, norm: 1 - Math.min(1, dupPairs.length / 8)
    });

    /* 7 ─ Structure -------------------------------------------------------- */
    var heads = (model.headings || []).length;
    var per1000 = words ? (heads / words) * 1000 : 0;
    var stLevel = heads === 0 ? (words > 400 ? 'warn' : 'notice') : per1000 >= 1.2 ? 'good' : 'notice';
    out.push({
      level: stLevel, icon: '☰', title: 'Structure',
      body: heads
        ? heads + ' heading' + (heads === 1 ? '' : 's') + ' detected for ' + words + ' words — roughly one every ' +
          Math.round(words / heads) + ' words.'
        : 'No headings were detected in the layout.',
      fix: heads === 0
        ? 'Add a heading every <b>300–400 words</b>. Readers scan before they read; without headings there is nothing to scan.'
        : per1000 >= 1.2 ? 'Signposting is doing its job.'
          : 'Sections are long. Consider a subheading inside the <b>longest</b> one.',
      metric: String(heads), unit: 'headings',
      weight: 0.8, norm: heads === 0 ? (words > 400 ? 0.15 : 0.6) : Math.min(1, per1000 / 1.5)
    });

    /* 8 ─ Vocabulary richness --------------------------------------------- */
    var uniq = Object.create(null), content = 0;
    for (i = 0; i < allWords.length; i++) {
      var w2 = allWords[i];
      if (!w2 || (S && S.STOP[w2])) continue;
      content++; uniq[w2] = 1;
    }
    var ttr = content ? Object.keys(uniq).length / content : 0;
    var vLevel = ttr >= 0.55 ? 'good' : ttr >= 0.38 ? 'notice' : 'warn';
    out.push({
      level: vLevel, icon: '◈', title: 'Vocabulary range',
      body: Object.keys(uniq).length + ' distinct content words out of ' + content +
            ' — a type-token ratio of ' + ttr.toFixed(2) + '.',
      fix: ttr >= 0.55 ? 'Good spread; the document is not leaning on a handful of words.'
        : 'A narrow ratio usually means the same few nouns are repeating. Watch for it when you next revise.',
      metric: ttr.toFixed(2), unit: 'type-token ratio',
      weight: 0.6, norm: Math.min(1, ttr / 0.6)
    });

    /* 9 ─ Extraction quality ---------------------------------------------- */
    var joined = full;
    var garbage = (joined.match(/[^\sa-z0-9.,;:!?'"()\[\]{}%$€£₹@#&*+/\\<>=~^|`\-–—…°]/g) || []).length;
    var garbageShare = pct(garbage, Math.max(joined.length, 1));
    var conf = meta && typeof meta.confidence === 'number' ? meta.confidence : null;
    var xLevel, xBody, xFix, xMetric, xUnit, xNorm;

    if (meta && meta.source === 'ocr') {
      xLevel = conf === null ? 'notice' : conf >= 85 ? 'good' : conf >= 70 ? 'notice' : 'warn';
      xBody = 'Text came from OCR at ' + (conf === null ? 'unknown' : conf.toFixed(1) + '%') +
              ' mean character confidence' + (meta.preprocessed ? ', after automatic contrast and threshold repair.' : '.');
      xFix = (conf !== null && conf < 85)
        ? 'Re-scan at <b>300 DPI or higher</b>, straighten the page, and avoid photographing at an angle. Everything downstream inherits these errors.'
        : 'Recognition quality is high enough to trust the summary.';
      xMetric = conf === null ? '—' : conf.toFixed(0) + '%'; xUnit = 'OCR confidence';
      xNorm = conf === null ? 0.6 : Math.min(1, conf / 92);
    } else {
      xLevel = garbageShare < 0.35 ? 'good' : garbageShare < 1.2 ? 'notice' : 'warn';
      xBody = 'Text came from the PDF text layer. ' +
              (garbageShare < 0.35 ? 'Character stream is clean.' : garbageShare.toFixed(2) + '% of characters are unexpected symbols, which usually means an embedded font with a broken encoding map.');
      xFix = garbageShare < 0.35 ? 'Extraction is sound.'
        : 'If the summary reads oddly, re-export the PDF <b>with fonts embedded</b>, or run it through OCR instead of the text layer.';
      xMetric = garbageShare.toFixed(2) + '%'; xUnit = 'anomalous chars';
      xNorm = 1 - Math.min(1, garbageShare / 2);
    }
    out.push({ level: xLevel, icon: '⌁', title: 'Extraction quality', body: xBody, fix: xFix, metric: xMetric, unit: xUnit, weight: 1.2, norm: xNorm });

    /* ---------- overall health ------------------------------------------ */
    var num = 0, den = 0;
    for (i = 0; i < out.length; i++) { num += out[i].norm * out[i].weight; den += out[i].weight; }
    var score = Math.round((num / den) * 100);
    var grade = score >= 82 ? 'excellent' : score >= 68 ? 'solid' : score >= 52 ? 'workable' : score >= 35 ? 'needs work' : 'rough';

    var worst = out.slice().sort(function (a, b) { return a.norm * a.weight - b.norm * b.weight; })[0];
    var note = score >= 82
      ? 'This document is in good shape across every check.'
      : 'The single biggest win here is <b>' + worst.title.toLowerCase() + '</b>.';

    // Order the cards so the problems are on top.
    var rank = { warn: 0, notice: 1, good: 2 };
    out.sort(function (a, b) { return rank[a.level] - rank[b.level] || (a.norm * a.weight) - (b.norm * b.weight); });

    return {
      score: score, grade: grade, note: note, items: out,
      stats: {
        words: words, sentences: n, avgLen: avgLen, flesch: flesch, fkGrade: fkGrade,
        passive: passShare, headings: heads, ttr: ttr, readMins: Math.max(1, Math.round(words / 225))
      }
    };
  }

  global.Lens = global.Lens || {};
  global.Lens.Analyzer = { run: run, syllables: syllables, esc: esc };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.Lens.Analyzer;

})(typeof window !== 'undefined' ? window : globalThis);
