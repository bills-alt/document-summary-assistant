/* ============================================================================
 * summarize.js — the ranking engine.
 *
 * Everything here is written from scratch: no NLP library, no API call, no
 * model download. The pipeline is a fairly classical extractive summariser,
 * assembled from parts that each do one job well:
 *
 *   segment()  sentence boundaries, abbreviation-aware, offsets preserved
 *   stem()     compact suffix stripper (Porter stage 1 + a few extras)
 *   tfidf()    term weights, treating each sentence as a document
 *   textRank() PageRank over a sentence-similarity graph
 *   features() positional, structural and lexical cues
 *   select()   Maximal Marginal Relevance, so the summary is not redundant
 *
 * The reason for the hybrid: TextRank alone loves long central sentences and
 * ignores the lead bias that almost every real document has. TF-IDF alone
 * loves rare words. Position alone is dumb but surprisingly hard to beat.
 * Blending the three, then de-duplicating with MMR, is what makes the result
 * hold up on documents as different as a research paper and a scanned receipt.
 *
 * Exposed as window.Lens.Summarizer — no modules, so the app also works when
 * index.html is opened straight off the filesystem.
 * ========================================================================== */
(function (global) {
  'use strict';

  /* ---------------------------------------------------------------- data -- */

  var STOPWORDS = ('a,about,above,after,again,against,all,am,an,and,any,are,arent,as,at,be,because,been,' +
    'before,being,below,between,both,but,by,cant,cannot,could,couldnt,did,didnt,do,does,doesnt,doing,dont,' +
    'down,during,each,few,for,from,further,had,hadnt,has,hasnt,have,havent,having,he,hed,hes,her,here,hers,' +
    'herself,him,himself,his,how,i,id,im,ive,if,in,into,is,isnt,it,its,itself,lets,me,more,most,mustnt,my,' +
    'myself,no,nor,not,of,off,on,once,only,or,other,ought,our,ours,ourselves,out,over,own,same,shant,she,' +
    'should,shouldnt,so,some,such,than,that,thats,the,their,theirs,them,themselves,then,there,theres,these,' +
    'they,theyd,theyll,theyre,theyve,this,those,through,to,too,under,until,up,very,was,wasnt,we,wed,were,' +
    'weve,werent,what,whats,when,where,which,while,who,whos,whom,why,with,wont,would,wouldnt,you,youd,' +
    'youll,youre,youve,your,yours,yourself,yourselves,also,may,might,must,shall,upon,within,among,per,via,' +
    'thus,hence,however,therefore,moreover,furthermore,although,though,whereas,while,since,unless,whether,' +
    'one,two,three,many,much,several,various,etc,ie,eg,et,al,fig,figure,table,page,pp,vol,no').split(',');

  var STOP = Object.create(null);
  for (var si = 0; si < STOPWORDS.length; si++) STOP[STOPWORDS[si]] = true;

  /* Abbreviations that end in a period but not a sentence. */
  var ABBREV = ('mr,mrs,ms,dr,prof,sr,jr,st,mt,rev,hon,gen,col,capt,lt,sgt,vs,etc,inc,ltd,co,corp,dept,' +
    'univ,est,fig,figs,eq,eqs,ref,refs,vol,no,pp,ch,sec,approx,min,max,avg,e.g,i.e,cf,al,ca,viz,resp,' +
    'jan,feb,mar,apr,jun,jul,aug,sep,sept,oct,nov,dec,mon,tue,wed,thu,fri,sat,sun,' +
    'u.s,u.k,a.m,p.m,ph.d,m.d,b.a,m.a,b.sc,m.sc').split(',');
  var ABBR = Object.create(null);
  for (var ai = 0; ai < ABBREV.length; ai++) ABBR[ABBREV[ai]] = true;

  /* Sentences that announce a conclusion deserve a nudge. */
  var CUE_UP = [
    'in conclusion', 'in summary', 'to summarise', 'to summarize', 'we conclude', 'this paper',
    'this report', 'this document', 'the aim', 'the purpose', 'the goal', 'we propose', 'we present',
    'we found', 'the results show', 'results indicate', 'findings suggest', 'key finding', 'importantly',
    'in short', 'overall', 'the main', 'significantly', 'demonstrates that', 'concludes that',
    'is defined as', 'is required', 'must be', 'recommend'
  ];
  var CUE_DOWN = [
    'for example', 'for instance', 'as shown in', 'see figure', 'see table', 'as mentioned',
    'et al.', 'copyright', 'all rights reserved', 'terms and conditions', 'click here'
  ];

  /* ------------------------------------------------------------ utilities -- */

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /** Min–max normalise an array into 0..1. Flat arrays become all-0.5. */
  function normalise(arr) {
    var lo = Infinity, hi = -Infinity, i;
    for (i = 0; i < arr.length; i++) { if (arr[i] < lo) lo = arr[i]; if (arr[i] > hi) hi = arr[i]; }
    var span = hi - lo;
    var out = new Array(arr.length);
    for (i = 0; i < arr.length; i++) out[i] = span > 1e-9 ? (arr[i] - lo) / span : 0.5;
    return out;
  }

  /**
   * Compact suffix stripper. Not a full Porter implementation — a full one
   * costs ~200 lines and buys almost nothing at sentence-ranking granularity.
   * The goal is only that "analyse/analysis/analysed/analysing" collide.
   */
  function stem(w) {
    if (w.length < 4) return w;
    var s = w;
    if (/(ss|us|is)$/.test(s)) { /* keep */ }
    else if (/ies$/.test(s) && s.length > 4) s = s.slice(0, -3) + 'y';
    else if (/(ches|shes|xes|ses|zes)$/.test(s)) s = s.slice(0, -2);
    else if (/s$/.test(s)) s = s.slice(0, -1);

    if (/(ational)$/.test(s)) s = s.slice(0, -7) + 'ate';
    else if (/(tional)$/.test(s)) s = s.slice(0, -6) + 'tion';
    else if (/(ization|isation)$/.test(s)) s = s.slice(0, -7) + 'ize';
    else if (/(fulness|ousness|iveness)$/.test(s)) s = s.slice(0, -4);
    else if (/(ement|ment)$/.test(s) && s.length > 7) s = s.replace(/e?ment$/, '');
    else if (/(ing)$/.test(s) && s.length > 5) { s = s.slice(0, -3); if (/[^aeiou]{2}$/.test(s) && !/(ll|ss|ff)$/.test(s)) s = s.slice(0, -1); }
    else if (/(edly|ed)$/.test(s) && s.length > 4) s = s.replace(/edly$|ed$/, '');
    else if (/(ly)$/.test(s) && s.length > 4) s = s.slice(0, -2);
    if (/(ance|ence|able|ible|ity|ive|ise|ize|ate)$/.test(s) && s.length > 6) s = s.replace(/(ance|ence|able|ible|ity|ive|ise|ize|ate)$/, '');
    if (s.length > 3 && /e$/.test(s) && !/[aeiou]e$/.test(s)) s = s.slice(0, -1);
    return s.length >= 2 ? s : w;
  }

  function tokenise(text) {
    var raw = text.toLowerCase().replace(/[‘’]/g, "'").match(/[a-z][a-z'\-]*[a-z]|[a-z]/g);
    if (!raw) return [];
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var w = raw[i].replace(/'/g, '');
      if (w.length < 2 || STOP[w]) continue;
      out.push(stem(w));
    }
    return out;
  }

  /* ----------------------------------------------------- 1. segmentation -- */

  /**
   * Split a block of text into sentences while remembering exactly where each
   * one started, so the UI can point back at the source. Handles abbreviations,
   * decimals, ellipses, initials and quoted/parenthesised terminators.
   */
  function splitSentences(text, offset) {
    var out = [], start = 0, i = 0, n = text.length;
    while (i < n) {
      var c = text[i];
      if (c === '.' || c === '!' || c === '?' || c === '…') {
        // swallow runs like "?!" or "..."
        var j = i;
        while (j + 1 < n && '.!?…'.indexOf(text[j + 1]) >= 0) j++;
        // trailing closing quotes / brackets belong to this sentence
        while (j + 1 < n && '"”’)]'.indexOf(text[j + 1]) >= 0) j++;

        var next = text[j + 1];
        var after = text.slice(j + 1, j + 3);
        var isEnd = true;

        if (c === '.') {
          var before = text.slice(Math.max(0, i - 12), i);
          var lastWord = (before.match(/[A-Za-z.]+$/) || [''])[0].toLowerCase();
          if (ABBR[lastWord] || ABBR[lastWord.replace(/\./g, '')]) isEnd = false;
          if (/^[A-Za-z]$/.test(before.slice(-1)) && /^[A-Z]/.test(after.trim())) {
            // "J. Smith" — a single capital letter before the dot is an initial
            if (before.length >= 2 && /[\s(]/.test(before.slice(-2, -1))) isEnd = false;
          }
          if (/\d$/.test(before) && /^\d/.test(next || '')) isEnd = false;   // 3.14
        }
        if (isEnd) {
          if (next === undefined) { isEnd = true; }
          else if (!/[\s]/.test(next)) isEnd = false;                        // no space after
          else {
            var rest = text.slice(j + 1).replace(/^\s+/, '');
            if (rest && !/^[A-Z0-9"'“(\[•\-—]/.test(rest)) isEnd = false;
          }
        }
        if (isEnd) {
          var raw = text.slice(start, j + 1);
          var trimmed = raw.trim();
          if (trimmed.length) {
            out.push({ text: trimmed, start: offset + start + (raw.length - raw.replace(/^\s+/, '').length) });
          }
          start = j + 1;
        }
        i = j + 1;
        continue;
      }
      i++;
    }
    var tail = text.slice(start).trim();
    if (tail.length) out.push({ text: tail, start: offset + start + (text.slice(start).length - text.slice(start).replace(/^\s+/, '').length) });
    return out;
  }

  /**
   * Turn the extraction result (an ordered list of blocks, each tagged as a
   * heading or a paragraph, each knowing its page) into a flat sentence list.
   */
  function segment(blocks) {
    var sentences = [], headings = [], cursor = 0;
    for (var b = 0; b < blocks.length; b++) {
      var blk = blocks[b];
      var txt = (blk.text || '').replace(/\s+/g, ' ').trim();
      if (!txt) { cursor += 1; continue; }
      if (blk.type === 'heading') {
        headings.push({ text: txt, page: blk.page, block: b });
        cursor += txt.length + 1;
        continue;
      }
      var parts = splitSentences(txt, cursor);
      for (var p = 0; p < parts.length; p++) {
        var t = parts[p].text;
        if (t.replace(/[^A-Za-z0-9]/g, '').length < 3) continue;   // junk / page numbers
        sentences.push({
          i: sentences.length,
          text: t,
          page: blk.page || 1,
          block: b,
          posInBlock: p,
          blockLen: parts.length,
          charStart: parts[p].start
        });
      }
      cursor += txt.length + 1;
    }
    return { sentences: sentences, headings: headings };
  }

  /* ------------------------------------------------------------- 2. tfidf -- */

  function buildVectors(sentences) {
    var N = sentences.length || 1;
    var df = Object.create(null), tfs = new Array(sentences.length), i, k;

    for (i = 0; i < sentences.length; i++) {
      var toks = tokenise(sentences[i].text);
      sentences[i].tokens = toks;
      var tf = Object.create(null), seen = Object.create(null);
      for (k = 0; k < toks.length; k++) {
        tf[toks[k]] = (tf[toks[k]] || 0) + 1;
        if (!seen[toks[k]]) { seen[toks[k]] = true; df[toks[k]] = (df[toks[k]] || 0) + 1; }
      }
      tfs[i] = tf;
    }

    var vecs = new Array(sentences.length), norms = new Array(sentences.length);
    for (i = 0; i < sentences.length; i++) {
      var v = Object.create(null), sum = 0;
      for (var t in tfs[i]) {
        // sublinear tf damps the effect of one word repeated many times
        var w = (1 + Math.log(tfs[i][t])) * Math.log(1 + N / (df[t] || 1));
        v[t] = w; sum += w * w;
      }
      vecs[i] = v; norms[i] = Math.sqrt(sum) || 1e-9;
    }
    return { vecs: vecs, norms: norms, df: df, N: N };
  }

  function cosine(a, b, na, nb) {
    var dot = 0, small = a, big = b;
    // iterate the smaller map
    if (Object.keys(a).length > Object.keys(b).length) { small = b; big = a; }
    for (var t in small) { if (big[t] !== undefined) dot += small[t] * big[t]; }
    return dot / (na * nb);
  }

  /* ---------------------------------------------------------- 3. textrank -- */

  /**
   * PageRank over the sentence-similarity graph. Edges below `floor` are cut
   * so that long documents do not degenerate into a fully-connected graph
   * where every node has the same rank.
   */
  function textRank(vecs, norms, opts) {
    var n = vecs.length;
    if (n === 0) return [];
    if (n === 1) return [1];

    var floor = opts.floor, damp = opts.damping, iters = opts.iterations, i, j;

    /* Building the graph naively is n^2 cosine calls — 720,000 of them on a
     * 40-page report. Instead, invert the index: two sentences can only be
     * similar if they share a term, so walk each term's posting list and
     * accumulate the dot products that actually exist. Terms appearing in more
     * than 40% of sentences are skipped — their IDF is near zero, so they add
     * cost without adding signal. */
    var postings = Object.create(null);
    for (i = 0; i < n; i++) {
      for (var t in vecs[i]) (postings[t] || (postings[t] = [])).push(i);
    }
    var cap = Math.max(3, Math.floor(n * 0.4));
    var acc = new Array(n);
    for (i = 0; i < n; i++) acc[i] = new Map();

    for (var term in postings) {
      var pl = postings[term];
      if (pl.length < 2 || pl.length > cap) continue;
      for (var a = 0; a < pl.length; a++) {
        var ia = pl[a], wa = vecs[ia][term], m = acc[ia];
        for (var b = a + 1; b < pl.length; b++) {
          var ib = pl[b];
          m.set(ib, (m.get(ib) || 0) + wa * vecs[ib][term]);
        }
      }
    }

    var adj = new Array(n), degree = new Float64Array(n);
    for (i = 0; i < n; i++) adj[i] = [];
    for (i = 0; i < n; i++) {
      acc[i].forEach(function (dot, k) {
        var sim = dot / (norms[i] * norms[k]);
        if (sim > floor) {
          adj[i].push({ j: k, w: sim });
          adj[k].push({ j: i, w: sim });
          degree[i] += sim; degree[k] += sim;
        }
      });
      acc[i] = null;
    }

    var rank = new Float64Array(n), next = new Float64Array(n);
    for (i = 0; i < n; i++) rank[i] = 1 / n;

    for (var it = 0; it < iters; it++) {
      var dangling = 0;
      for (i = 0; i < n; i++) if (degree[i] === 0) dangling += rank[i];
      for (i = 0; i < n; i++) next[i] = (1 - damp) / n + damp * dangling / n;
      for (i = 0; i < n; i++) {
        if (degree[i] === 0) continue;
        var share = damp * rank[i] / degree[i];
        var list = adj[i];
        for (var e = 0; e < list.length; e++) next[list[e].j] += share * list[e].w;
      }
      var delta = 0;
      for (i = 0; i < n; i++) { delta += Math.abs(next[i] - rank[i]); rank[i] = next[i]; }
      if (delta < 1e-6) break;
    }
    return Array.prototype.slice.call(rank);
  }

  /* ---------------------------------------------------------- 4. features -- */

  function featureScores(sentences, headings, docTerms) {
    var n = sentences.length;
    var pos = new Array(n), cue = new Array(n), len = new Array(n),
        head = new Array(n), num = new Array(n), tfidfMass = new Array(n);

    // Terms that appear in headings and in the first block carry the topic.
    var topicSet = Object.create(null), h;
    for (h = 0; h < headings.length; h++) {
      var ht = tokenise(headings[h].text);
      for (var q = 0; q < ht.length; q++) topicSet[ht[q]] = (topicSet[ht[q]] || 0) + 1;
    }
    // Fallback when a document has no headings at all: use the opening block.
    if (headings.length === 0 && n) {
      var lead = tokenise(sentences[0].text + ' ' + (sentences[1] ? sentences[1].text : ''));
      for (var q2 = 0; q2 < lead.length; q2++) topicSet[lead[q2]] = 1;
    }

    for (var i = 0; i < n; i++) {
      var s = sentences[i], low = s.text.toLowerCase(), toks = s.tokens || [];

      // (a) position — a decaying lead bias, plus a small bump for the last
      //     sentence of the document (conclusions) and of each paragraph.
      var rel = n > 1 ? i / (n - 1) : 0;
      var leadBias = Math.exp(-2.4 * rel);
      var tailBias = rel > 0.93 ? 0.35 : 0;
      var paraLead = s.posInBlock === 0 ? 0.22 : 0;
      pos[i] = leadBias + tailBias + paraLead;

      // (b) cue phrases
      var c = 0, k;
      for (k = 0; k < CUE_UP.length; k++) if (low.indexOf(CUE_UP[k]) >= 0) { c += 1; break; }
      for (k = 0; k < CUE_DOWN.length; k++) if (low.indexOf(CUE_DOWN[k]) >= 0) { c -= 1.1; break; }
      if (/^[•\-–—*]/.test(s.text)) c += 0.25;          // bullet lines are often claims
      if (/\?\s*$/.test(s.text)) c -= 0.4;
      cue[i] = c;

      // (c) length — reward the 12-32 word band, punish fragments and monsters
      var words = s.text.split(/\s+/).length;
      s.words = words;
      len[i] = words < 5 ? -1.2 : words < 9 ? -0.35 : words <= 34 ? 0.45 : words <= 48 ? 0 : -0.6;

      // (d) overlap with heading / topic vocabulary
      var hit = 0;
      for (k = 0; k < toks.length; k++) if (topicSet[toks[k]]) hit++;
      head[i] = toks.length ? hit / Math.sqrt(toks.length) : 0;

      // (e) hard evidence — figures, percentages, dates, money
      num[i] = /\d/.test(s.text) ? (/(\d+(\.\d+)?\s?%|[$£€₹]\s?\d|\b(19|20)\d{2}\b)/.test(s.text) ? 0.45 : 0.2) : 0;

      // (f) how much of the document's overall term mass this sentence carries
      var mass = 0;
      for (k = 0; k < toks.length; k++) mass += docTerms[toks[k]] || 0;
      tfidfMass[i] = toks.length ? mass / Math.sqrt(toks.length) : 0;
    }

    return {
      pos: normalise(pos), cue: normalise(cue), len: normalise(len),
      head: normalise(head), num: normalise(num), mass: normalise(tfidfMass)
    };
  }

  /* -------------------------------------------------------------- 5. MMR -- */

  /**
   * Maximal Marginal Relevance. Greedily take the best remaining sentence,
   * discounted by how similar it already is to what has been chosen. Without
   * this step a summary of a repetitive document says the same thing 5 times.
   */
  function mmrSelect(order, scores, vecs, norms, want, lambda) {
    var pool = order.slice(), chosen = [], i;
    // maxSim[k] = similarity of pool[k] to its closest already-chosen sentence.
    // Maintaining it incrementally turns MMR from O(want^2 x pool) into
    // O(want x pool), which is the difference between a 10-second dial and an
    // instant one on a 40-page document.
    var maxSim = new Float64Array(pool.length);

    while (chosen.length < want && pool.length) {
      var bestIdx = 0, bestVal = -Infinity;
      for (i = 0; i < pool.length; i++) {
        var cand = pool[i];
        var adjacent = 0;
        for (var c = 0; c < chosen.length; c++) {
          var d = Math.abs(cand - chosen[c]);
          if (d <= 1) { adjacent = 0.13; break; }
          if (d === 2 && adjacent < 0.05) adjacent = 0.05;
        }
        var val = lambda * scores[cand] - (1 - lambda) * maxSim[i] - adjacent;
        if (val > bestVal) { bestVal = val; bestIdx = i; }
      }
      var pick = pool[bestIdx];
      chosen.push(pick);
      pool.splice(bestIdx, 1);
      // shift the parallel similarity array to match the splice
      for (i = bestIdx; i < pool.length; i++) maxSim[i] = maxSim[i + 1];
      // refresh only against the sentence just chosen
      for (i = 0; i < pool.length; i++) {
        var sim = cosine(vecs[pool[i]], vecs[pick], norms[pool[i]], norms[pick]);
        if (sim > maxSim[i]) maxSim[i] = sim;
      }
    }
    return chosen;
  }

  /* ------------------------------------------------------- 6. key phrases -- */

  function keyPhrases(sentences, df, N, limit) {
    var cand = Object.create(null), i, k;

    for (i = 0; i < sentences.length; i++) {
      var words = sentences[i].text.toLowerCase()
        .replace(/[^a-z0-9\s\-]/g, ' ').split(/\s+/).filter(Boolean);
      for (k = 0; k < words.length; k++) {
        for (var g = 1; g <= 3 && k + g <= words.length; g++) {
          var gram = words.slice(k, k + g);
          // A phrase is only a phrase if none of its parts is a function word:
          // "urban heat island" survives, "consistently the ones" does not.
          if (gram.some(function (w) { return STOP[w] || STOP[stem(w)] || w.length < 3 || /^\d+$/.test(w); })) continue;
          var key = gram.join(' ');
          if (key.length < 4) continue;
          var rec = cand[key] || (cand[key] = { n: 0, g: g, stems: gram.map(stem).join(' ') });
          rec.n++;
        }
      }
    }

    var scored = [];
    for (var key2 in cand) {
      var r = cand[key2];
      if (r.n < 2 && r.g === 1) continue;
      if (r.n < 2 && r.g > 1) continue;
      var headStem = stem(key2.split(' ')[0]);
      var idf = Math.log(1 + N / ((df[headStem] || 1)));
      // Multi-word phrases are more informative; frequency is damped.
      scored.push({ text: key2, n: r.n, stems: r.stems, score: (1 + Math.log(r.n)) * idf * (1 + 0.55 * (r.g - 1)) });
    }
    scored.sort(function (a, b) { return b.score - a.score; });

    // Drop phrases fully contained in a higher-ranked one ("neural" vs "neural network").
    var out = [];
    for (i = 0; i < scored.length && out.length < limit; i++) {
      var dup = false;
      for (k = 0; k < out.length; k++) {
        if (out[k].stems.indexOf(scored[i].stems) >= 0 || scored[i].stems.indexOf(out[k].stems) >= 0) { dup = true; break; }
      }
      if (!dup) out.push(scored[i]);
    }
    return out.map(function (p) {
      return { text: p.text.replace(/\b\w/g, function (m) { return m.toUpperCase(); }), count: p.n, score: p.score };
    });
  }

  /* --------------------------------------------------------------- 7. api -- */

  var DEFAULTS = {
    damping: 0.85,
    iterations: 40,
    floor: 0.055,
    lambda: 0.72,
    weights: { rank: 0.32, pos: 0.17, mass: 0.16, head: 0.13, cue: 0.11, len: 0.07, num: 0.04 }
  };

  /**
   * analyse(blocks) — the expensive half. Runs once per document.
   * Returns everything that does not depend on the chosen summary length.
   */
  function analyse(blocks, options) {
    var o = Object.assign({}, DEFAULTS, options || {});
    var seg = segment(blocks);
    var sentences = seg.sentences;

    if (!sentences.length) {
      return { sentences: [], headings: seg.headings, scores: [], phrases: [], vecs: [], norms: [], empty: true };
    }

    var built = buildVectors(sentences);

    // Document-level term weight: how strongly each term characterises the doc.
    var docTerms = Object.create(null);
    for (var t in built.df) docTerms[t] = Math.log(1 + built.N / built.df[t]) * Math.log(1 + built.df[t]);

    var rank = normalise(textRank(built.vecs, built.norms, o));
    var f = featureScores(sentences, seg.headings, docTerms);
    var w = o.weights;

    var scores = new Array(sentences.length);
    for (var i = 0; i < sentences.length; i++) {
      scores[i] = w.rank * rank[i] + w.pos * f.pos[i] + w.mass * f.mass[i] +
                  w.head * f.head[i] + w.cue * f.cue[i] + w.len * f.len[i] + w.num * f.num[i];
      sentences[i].score = scores[i];
      sentences[i].rankScore = rank[i];
    }
    var norm = normalise(scores);
    for (i = 0; i < sentences.length; i++) sentences[i].heat = norm[i];

    return {
      sentences: sentences,
      headings: seg.headings,
      scores: norm,
      vecs: built.vecs,
      norms: built.norms,
      df: built.df,
      N: built.N,
      phrases: keyPhrases(sentences, built.df, built.N, 14),
      options: o,
      empty: false
    };
  }

  /**
   * summarise(model, ratio) — the cheap half. Re-run every time the focal dial
   * moves, which is why the dial can feel instant even on a 200-page PDF.
   * `ratio` is the fraction of sentences to keep (0.02 … 0.6).
   */
  function summarise(model, ratio) {
    if (!model || model.empty) return { picked: [], ratio: ratio, count: 0 };
    var n = model.sentences.length;
    var want = clamp(Math.round(n * ratio), Math.min(1, n), n);
    if (n > 3) want = Math.max(want, 2);

    var order = [];
    for (var i = 0; i < n; i++) order.push(i);
    order.sort(function (a, b) { return model.scores[b] - model.scores[a]; });

    // Only the top slice is worth feeding to MMR — this keeps it O(want × pool).
    var poolSize = Math.min(n, Math.max(Math.round(want * 2.5), want + 30), want + 220);
    var picked = mmrSelect(order.slice(0, poolSize), model.scores, model.vecs, model.norms, want, model.options.lambda);

    picked.sort(function (a, b) { return a - b; });          // restore reading order
    return { picked: picked, ratio: want / n, count: want, total: n };
  }

  global.Lens = global.Lens || {};
  global.Lens.Summarizer = {
    analyse: analyse,
    summarise: summarise,
    // exported for the analyser and for the headless test harness
    tokenise: tokenise,
    stem: stem,
    cosine: cosine,
    normalise: normalise,
    splitSentences: splitSentences,
    STOP: STOP,
    DEFAULTS: DEFAULTS
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = global.Lens.Summarizer;

})(typeof window !== 'undefined' ? window : globalThis);
