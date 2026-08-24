# Approach

*(200 words)*

I built Lens as a static, zero-dependency browser app: no backend, no API key,
no build step. The submission guidelines ask for minimal dependencies and no
committed packages, and summarisation is one of the few AI-shaped problems that
genuinely does not need a server — so the whole pipeline runs on-device, which
also means a reviewer's document is never uploaded anywhere.

Text extraction rebuilds structure rather than dumping strings. PDF.js returns
positioned glyph runs; I regroup them into lines by y-position, into paragraphs
by comparing vertical gaps to the page median, and detect headings from relative
font size and numbering. Images are contrast-stretched before Tesseract sees
them. A PDF with no text layer is rasterised and sent through OCR automatically.

The ranker is written from scratch: TF-IDF vectors, PageRank over a sentence
similarity graph built through an inverted index, positional and cue-phrase
features, then Maximal Marginal Relevance to remove redundancy.

The interface treats summary length as a continuous focal length rather than
three buttons, and makes the result checkable — every sentence links to its
source, and a spine map shows which parts of the document the summary drew from.
