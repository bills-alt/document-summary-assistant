# Lens — Document Summary Assistant

Upload a PDF or a scanned image. Lens extracts the text, ranks every sentence in
it, and gives you a **focal length dial** instead of three summary buttons: turn
it down and the document collapses to its thesis, turn it up and the supporting
detail comes back into focus. Every sentence in the summary links back to the
page it came from.

Everything runs in the browser. No server, no upload, no API key.

Live app: https://bills-alt.github.io/document-summary-assistant/
Repository: https://github.com/bills-alt/document-summary-assistant

---

## Why it looks like this

Most summarisers present the summary as an oracle: a paragraph appears, and you
either trust it or you don't. Two decisions push against that.

**Summarisation is a zoom level, not a setting.** Short / medium / long are three
arbitrary stops on a continuous axis. Lens exposes the axis. The dial has nine
positions from *Glance* (2% of sentences) to *Near-full* (55%), and moving it
re-selects instantly because the expensive work — building the sentence graph —
already happened once at load.

**A summary should be checkable.** Every sentence shown is a real sentence from
the document, and clicking it scrolls the source pane to that exact spot and
flashes it. The *document spine* in the sidebar draws one cell per sentence in
reading order, shaded by relevance, gold where the current focal length selected
it — so you can see at a glance whether the summary is drawing from the whole
document or only from its first page.

---

## Features

| Requirement | What Lens does |
|---|---|
| Document upload | Drag-and-drop **and** file picker; PDF, PNG, JPG, WEBP, BMP, TIFF; validated for type, size and emptiness before anything runs |
| PDF parsing with formatting | Glyph runs are regrouped into lines by y-position, ordered by x, spaced by measured gaps, then clumped into paragraphs by comparing each vertical gap to the page median. Headings are detected from relative font height, numbering and line width, and are reused as topic signal by the ranker |
| OCR | Tesseract.js, after the bitmap is upscaled to a sane working width, converted to luminance and contrast-stretched between its own 2nd and 98th percentiles. Mean character confidence is reported back to the user |
| Scanned PDFs | A PDF whose text layer yields under ~90 characters per page is treated as a scan: pages are rasterised and sent down the OCR path automatically |
| Summary generation | Hybrid extractive ranker — TextRank + TF-IDF + positional, structural and lexical features — de-duplicated with Maximal Marginal Relevance |
| Length options | Nine-stop focal dial plus Short / Medium / Long presets and ← → keyboard control |
| Key points | Top-ranked sentences as *main ideas*; TF-IDF-weighted n-gram *key terms* with duplicate-substring suppression |
| Improvement suggestions | Nine checks — reading ease, sentence length, rhythm, passive voice, hedging, repetition, structure, vocabulary range, extraction quality — each with a measurement and a specific instruction, plus a weighted health score |
| Error handling | Every failure mode has its own message: wrong type, oversized, empty, encrypted PDF, corrupt PDF, undecodable image, CDN failure, OCR that finds nothing |
| Loading states | Five named stages with a live progress bar; long OCR runs report page-by-page and can be cancelled |
| UI/UX | Two themes, responsive from 360 px up, keyboard shortcuts, ARIA roles, reduced-motion and print stylesheets |
| Hosting | Static files — deploy by dragging the folder onto Netlify |

---

## How the ranking engine works

`js/summarize.js`, written from scratch — no NLP library, no model download.

1. **Segment.** An abbreviation-aware sentence splitter that survives `Dr.`,
   `e.g.`, `3.14`, `U.S.`, initials, and quotes closing after the full stop. Each
   sentence keeps its character offset so the UI can point back at it.
2. **Vectorise.** Tokenise → drop stopwords → stem with a compact suffix
   stripper → sublinear TF × IDF, treating each sentence as a document.
3. **TextRank.** PageRank over the sentence-similarity graph. The graph is built
   through an inverted index rather than an n² sweep — two sentences can only be
   similar if they share a term — which took a 1,200-sentence document from
   2.4 s to 0.22 s.
4. **Features.** Positional lead bias with a decay curve, a conclusion bump,
   paragraph-opening bonus, cue phrases (`in conclusion`, `we found`) up and
   (`for example`, `see figure`) down, a length sweet spot, overlap with heading
   vocabulary, and presence of hard evidence — percentages, money, years.
5. **Blend.** All components min–max normalised, then a weighted sum.
6. **Select.** Maximal Marginal Relevance with an adjacency penalty, so the
   summary is not five restatements of the same idea or three consecutive
   sentences from the opening paragraph. MMR keeps a running per-candidate
   maximum similarity instead of rescanning the chosen set, which is what makes
   dragging the dial feel continuous.
7. **Reorder.** Selected sentences are returned to document order so the summary
   reads as prose.

**Why hybrid?** TextRank alone favours long, central sentences and ignores the
lead bias almost every real document has. TF-IDF alone favours rare words.
Position alone is crude but hard to beat. Blending the three and then
de-duplicating is what holds up across a research paper *and* a scanned receipt.

---

## Project structure

```
index.html        markup, view states, CDN + source script tags
style.css         design tokens, layout, two themes, responsive rules
summarize.js      segmentation, TF-IDF, TextRank, features, MMR, keyphrases
analyze.js        the nine improvement checks and the health score
extract.js        PDF layout rebuild, image preprocessing, OCR, fallbacks
app.js            state, rendering, progress, exports, keyboard
sample.js         bundled demo document
APPROACH.md       the 200-word write-up
LICENSE
README.md
```

Flat by design — the app is ten files with no build step, so a folder tree would
add navigation without adding clarity. Each file owns one stage of the pipeline.

No `package.json`, no `node_modules`, no build step, no bundler, no framework.
Two libraries load from a CDN at runtime — **PDF.js** for the text layer and
**Tesseract.js** for OCR — because writing a PDF parser or an OCR engine is not
what this assignment is testing.

---

## Running it

**Locally.** Clone and open `index.html` in a browser. It works from `file://` —
the scripts are classic `<script>` tags rather than ES modules precisely so that
it does.

If you prefer a server:

```bash
python3 -m http.server 8000     # then open http://localhost:8000
```

**Deploying.** It is a static site, so any static host works.

- **Netlify** — drag the project folder onto <https://app.netlify.com/drop>.
- **Vercel** — `vercel` in the project root; framework preset *Other*.
- **GitHub Pages** — repository *Settings → Pages → Deploy from branch → main / root*.

---

## Limitations, stated honestly

- The summary is **extractive**: it selects the document's own sentences rather
  than writing new ones. That is a deliberate trade — it cannot hallucinate, and
  every claim is traceable — but it will not paraphrase.
- OCR on a scanned PDF is capped at the first 12 pages. Tesseract takes several
  seconds per page in a browser tab, and hanging for two minutes is worse than
  saying so.
- English only. The stopword list, stemmer, cue phrases and readability formula
  are English-specific, and the OCR worker loads the `eng` model.
- The stemmer is a compact suffix stripper, not full Porter. At sentence-ranking
  granularity the difference does not show up.
- Files are capped at 25 MB so a browser tab does not run out of memory.

---

## Credits

Built by **Harini Ramadurai**.
[PDF.js](https://mozilla.github.io/pdf.js/) (Apache-2.0) · [Tesseract.js](https://tesseract.projectnaptha.com/) (Apache-2.0) ·
type set in Fraunces, Inter and JetBrains Mono. Licensed MIT — see `LICENSE`.
