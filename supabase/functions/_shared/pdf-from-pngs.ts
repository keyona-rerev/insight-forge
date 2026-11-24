// pdf-from-pngs.ts - assemble a multi-page PDF from already-validated PNG
// slides, LOSSLESSLY. Used for LinkedIn carousel (document) posts: the pages
// of the published PDF must be pixel-identical to the slide images the owner
// reviewed and approved, so the PDF embeds each slide's own compressed
// pixels instead of re-rendering or re-encoding anything.
//
// How: a PNG's IDAT chunks concatenate into one zlib stream of filtered
// scanlines. A PDF image XObject with /Filter /FlateDecode and PNG
// prediction (/Predictor 15) decodes that exact same stream. So we lift the
// IDAT bytes verbatim - no decode, no re-encode, no quality loss. This is
// the same embedding trick img2pdf uses.
//
// Constraint (enforced here, produced by the worker's flatten step): slides
// must be 8-bit RGB (PNG color type 2, bit depth 8, non-interlaced). RGBA
// would need a separate /SMask and palette images need /Indexed - both are
// rejected rather than handled, because the renderer always flattens slides
// onto an opaque background first.

export interface PdfSlideImage {
  width: number;   // px
  height: number;  // px
  idat: Uint8Array; // the concatenated IDAT zlib stream (filtered scanlines)
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// Pull the embeddable image out of a complete PNG file. Throws on anything
// outside the strict slide profile; callers validate fully BEFORE this (see
// decodeAndValidatePng in visual-logic.ts) - this is the embedder's own
// fail-closed guard, not the security boundary.
export function extractSlideImage(png: Uint8Array): PdfSlideImage {
  if (png.length < 33) throw new Error("png too small");
  for (let i = 0; i < 8; i++) if (png[i] !== PNG_SIG[i]) throw new Error("not a png");
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  // IHDR is always the first chunk: length(4) type(4) then data.
  if (String.fromCharCode(png[12], png[13], png[14], png[15]) !== "IHDR") throw new Error("png missing IHDR");
  const width = dv.getUint32(16);
  const height = dv.getUint32(20);
  const bitDepth = png[24];
  const colorType = png[25];
  const interlace = png[28];
  if (bitDepth !== 8) throw new Error(`slide png bit depth ${bitDepth} != 8`);
  if (colorType !== 2) throw new Error(`slide png color type ${colorType} != 2 (RGB) - slides must be flattened to opaque RGB first`);
  if (interlace !== 0) throw new Error("slide png is interlaced");
  // Walk chunks, concatenating IDAT. (CRCs were already verified upstream by
  // decodeAndValidatePng; bounds here keep this safe standalone.)
  const parts: Uint8Array[] = [];
  let total = 0;
  let pos = 8;
  let sawIend = false;
  while (pos + 8 <= png.length) {
    const ln = dv.getUint32(pos);
    if (pos + 12 + ln > png.length) throw new Error("png truncated chunk");
    const typ = String.fromCharCode(png[pos + 4], png[pos + 5], png[pos + 6], png[pos + 7]);
    if (typ === "IDAT") {
      parts.push(png.subarray(pos + 8, pos + 8 + ln));
      total += ln;
    } else if (typ === "IEND") { sawIend = true; break; }
    pos += 12 + ln;
  }
  if (!sawIend) throw new Error("png missing IEND");
  if (!parts.length) throw new Error("png has no IDAT");
  const idat = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { idat.set(p, o); o += p.length; }
  return { width, height, idat };
}

// Points per pixel: CSS 96dpi onto PDF's 72dpi point grid.
const PT_PER_PX = 72 / 96;

function fmt(n: number): string {
  // PDF numbers: no trailing zeros, no exponent notation.
  return (Math.round(n * 1000) / 1000).toString();
}

// Build the PDF. One page per slide, in order; first page is the cover
// (LinkedIn shows it as the carousel's first card).
export function buildPdfFromSlides(slides: PdfSlideImage[]): Uint8Array {
  if (!slides.length) throw new Error("no slides");
  const chunks: Uint8Array[] = [];
  const offsets: number[] = []; // byte offset of each object, 1-based ids
  let len = 0;
  const pushStr = (s: string) => {
    const b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
    chunks.push(b); len += b.length;
  };
  const pushBin = (b: Uint8Array) => { chunks.push(b); len += b.length; };

  pushStr("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");

  const n = slides.length;
  // Object ids: 1 catalog, 2 pages, then per slide i: 3+3i page, 4+3i image, 5+3i content.
  const pageObjId = (i: number) => 3 + 3 * i;
  const imgObjId = (i: number) => 4 + 3 * i;
  const contentObjId = (i: number) => 5 + 3 * i;
  const totalObjs = 2 + 3 * n;

  const beginObj = (id: number) => { offsets[id] = len; pushStr(`${id} 0 obj\n`); };
  const endObj = () => pushStr("endobj\n");

  beginObj(1);
  pushStr("<< /Type /Catalog /Pages 2 0 R >>\n");
  endObj();

  beginObj(2);
  pushStr(`<< /Type /Pages /Count ${n} /Kids [${slides.map((_, i) => `${pageObjId(i)} 0 R`).join(" ")}] >>\n`);
  endObj();

  for (let i = 0; i < n; i++) {
    const s = slides[i];
    const wPt = s.width * PT_PER_PX;
    const hPt = s.height * PT_PER_PX;

    beginObj(pageObjId(i));
    pushStr(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmt(wPt)} ${fmt(hPt)}] ` +
      `/Resources << /XObject << /Im0 ${imgObjId(i)} 0 R >> /ProcSet [/PDF /ImageC] >> ` +
      `/Contents ${contentObjId(i)} 0 R >>\n`);
    endObj();

    beginObj(imgObjId(i));
    pushStr(`<< /Type /XObject /Subtype /Image /Width ${s.width} /Height ${s.height} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode ` +
      `/DecodeParms << /Predictor 15 /Colors 3 /BitsPerComponent 8 /Columns ${s.width} >> ` +
      `/Length ${s.idat.length} >>\nstream\n`);
    pushBin(s.idat);
    pushStr("\nendstream\n");
    endObj();

    const content = `q ${fmt(wPt)} 0 0 ${fmt(hPt)} 0 0 cm /Im0 Do Q\n`;
    beginObj(contentObjId(i));
    pushStr(`<< /Length ${content.length} >>\nstream\n${content}endstream\n`);
    endObj();
  }

  const xrefStart = len;
  pushStr(`xref\n0 ${totalObjs + 1}\n`);
  pushStr("0000000000 65535 f \n");
  for (let id = 1; id <= totalObjs; id++) {
    pushStr(`${offsets[id].toString().padStart(10, "0")} 00000 n \n`);
  }
  pushStr(`trailer\n<< /Size ${totalObjs + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);

  const out = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
