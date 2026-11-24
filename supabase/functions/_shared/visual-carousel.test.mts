// Run: node --experimental-strip-types --test supabase/functions/_shared/visual-carousel.test.mts
// Carousel (LinkedIn document post) path: enqueue binds the carousel
// contract, completion validates + uploads per-slide PNGs and assembles the
// PDF from those exact bytes, and every contract breach fails closed.
import test from "node:test"; import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
(globalThis as any).Deno = { env: { get: (_k: string) => undefined } };
const { requestDraftVisual } = await import("./visual-enqueue.ts");
const { completeVisualJob } = await import("./visual-logic.ts");
const { CAROUSEL_CANVAS, CAROUSEL_MIN_SLIDES, CAROUSEL_MAX_SLIDES } = await import("./visual-prompt.ts");

const USER = "11111111-1111-1111-1111-111111111111";

function fakeDb(drafts: Record<string, any>) {
  const visuals: Record<string, any> = {};
  const jobs: Record<string, any> = {};
  const uploads: { path: string; bytes: Uint8Array }[] = [];
  let n = 0;
  return {
    visuals, jobs, uploads,
    async getDraft(id: string) { return drafts[id] ?? null; },
    async getProfileVisualConfig(_u: string) { return { business_name: "Acme", business_description: "Estate planning", visual_studio_config: null, visual_design_rules: null }; },
    async findGeneratingVisual(draftId: string) { return Object.values(visuals).find((v: any) => v.draft_id === draftId && v.status === "generating") ?? null; },
    async insertVisual(row: any) { const v = { id: `vis-${++n}`, ...row }; visuals[v.id] = v; return v; },
    async getVisual(id: string) { return visuals[id] ?? null; },
    async updateVisualWhere(id: string, filter: any, fields: any) {
      const v = visuals[id]; if (!v) return null;
      for (const [k, val] of Object.entries(filter)) if (v[k] !== val) return null;
      Object.assign(v, fields); return v;
    },
    async updateJobWhere(id: string, filter: any, fields: any) {
      const j = jobs[id]; if (!j) return null;
      for (const [k, val] of Object.entries(filter)) if (j[k] !== val) return null;
      Object.assign(j, fields); return j;
    },
    async uploadVisualPng(path: string, bytes: Uint8Array) { uploads.push({ path, bytes }); return { url: `https://store.example/${path}` }; },
    async uploadVisualPdf(path: string, bytes: Uint8Array) { uploads.push({ path, bytes }); return { url: `https://store.example/${path}` }; },
    async getDraftPublishState(_id: string) { return null; },
    async getAutomationConfig(_k: string) { return null; },
  } as any;
}

function fakeEnqueue() {
  const calls: any[] = [];
  const fn = async (_db: any, args: any) => { calls.push(args); return { jobId: `job-${calls.length}`, requestId: `r${calls.length}`, created: true }; };
  return { fn, calls };
}

// 8-bit RGB PNG (color type 2), filter-0 scanlines - the shape the worker's
// flatten step posts for every slide.
function png(w: number, h: number, fill = 0): string {
  const crcT = new Uint32Array(256);
  for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[i] = c >>> 0; }
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w * 3; x++) raw[y * (w * 3 + 1) + 1 + x] = (x + y + fill) & 255; }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}

function rgbaPng(w: number, h: number): string {
  const crcT = new Uint32Array(256);
  for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[i] = c >>> 0; }
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}

const DRAFT = { id: "d1", user_id: USER, title: "Wills are not enough", body: "A will goes through probate.", seed_insight: "Trusts avoid probate.", platform: "linkedin" };
const slideHtml = (i: number) => `<!DOCTYPE html><html><head></head><body><h1>Slide ${i}</h1></body></html>`;

async function enqueueCarousel(db: any, q: any) {
  const r = await requestDraftVisual(db, {} as any, q.fn, { authUserId: USER, draftId: "d1", renderKind: "carousel" });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  const a = q.calls[0];
  const job = { id: "job-1", user_id: USER, status: "completing", path: "interactive",
    input_snapshot: { kind: "interactive", interactiveKind: "draft-visual", context: a.context } };
  db.jobs["job-1"] = job;
  return { a, job };
}

function goodSlides(w: number, h: number, count: number) {
  return {
    output: { visual_type: "carousel", slides: Array.from({ length: count }, (_, i) => slideHtml(i + 1)) },
    slidesPngBase64: Array.from({ length: count }, (_, i) => png(w, h, i)),
  };
}

test("enqueue carousel: binds render_kind, deck canvas, carousel prompts", async () => {
  const db = fakeDb({ d1: DRAFT }); const q = fakeEnqueue();
  const { a } = await enqueueCarousel(db, q);
  assert.equal(a.context.render_kind, "carousel");
  assert.equal(a.context.canvas.w, CAROUSEL_CANVAS.width);
  assert.equal(a.context.canvas.h, CAROUSEL_CANVAS.height);
  assert.match(a.prompt, /carousel/i);
  assert.match(a.system, /LinkedIn carousel/);
  assert.match(a.system, /"slides"/);
  assert.ok(a.context.visual_id && a.context.source_hash);
});

test("enqueue standard: render_kind defaults to standard, legacy canvas", async () => {
  const db = fakeDb({ d1: DRAFT }); const q = fakeEnqueue();
  const r = await requestDraftVisual(db, {} as any, q.fn, { authUserId: USER, draftId: "d1" });
  assert.equal(r.status, 202);
  assert.equal(q.calls[0].context.render_kind, "standard");
  assert.notEqual(q.calls[0].context.canvas.w, CAROUSEL_CANVAS.width);
});

test("round trip: slides complete ready with pdf + per-slide uploads from the SAME bytes", async () => {
  const db = fakeDb({ d1: DRAFT }); const q = fakeEnqueue();
  const { a } = await enqueueCarousel(db, q);
  const { output, slidesPngBase64 } = goodSlides(a.context.canvas.w, a.context.canvas.h, 4);
  const r = await completeVisualJob(db, { jobId: "job-1", job: db.jobs["job-1"], output, slidesPngBase64, now: new Date() });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const v = db.visuals[a.context.visual_id];
  assert.equal(v.status, "ready");
  assert.equal(v.visual_type, "carousel");
  assert.equal(v.page_count, 4);
  assert.equal(v.slide_image_urls.length, 4);
  assert.equal(v.pdf_url, `https://store.example/${USER}/${a.context.visual_id}/carousel.pdf`);
  assert.equal(v.image_url, `https://store.example/${USER}/${a.context.visual_id}/slide_1.png`); // cover
  assert.equal(v.canvas_width, CAROUSEL_CANVAS.width);
  // Upload set: 4 slide PNGs + 1 PDF.
  assert.deepEqual(db.uploads.map((u: any) => u.path.split("/").pop()),
    ["slide_1.png", "slide_2.png", "slide_3.png", "slide_4.png", "carousel.pdf"]);
  // The PDF embeds the exact uploaded slide bytes: re-extract and compare.
  const pdfUp = db.uploads.find((u: any) => u.path.endsWith(".pdf"));
  assert.ok(Buffer.from(pdfUp.bytes).subarray(0, 5).toString() === "%PDF-");
  assert.match(Buffer.from(pdfUp.bytes).toString("latin1"), /\/Count 4/);
  // Each slide upload is byte-identical to what the worker posted.
  for (let i = 0; i < 4; i++) {
    assert.equal(Buffer.from(db.uploads[i].bytes).toString("base64"), slidesPngBase64[i]);
  }
  assert.equal(db.jobs["job-1"].status, "completed");
  assert.equal(db.jobs["job-1"].result.text, v.pdf_url);
});

test("contract: wrong output keys refused", async () => {
  const db = fakeDb({ d1: DRAFT }); const q = fakeEnqueue();
  const { a } = await enqueueCarousel(db, q);
  const r = await completeVisualJob(db, { jobId: "job-1", job: db.jobs["job-1"],
    output: { visual_type: "carousel", slides: [slideHtml(1), slideHtml(2), slideHtml(3)], html: "x" },
    slidesPngBase64: [png(a.context.canvas.w, a.context.canvas.h), png(a.context.canvas.w, a.context.canvas.h), png(a.context.canvas.w, a.context.canvas.h)],
    now: new Date() });
  assert.equal(r.status, 422);
  assert.equal(db.visuals[a.context.visual_id].status, "error");
});

test("contract: too few / too many slides refused", async () => {
  for (const count of [CAROUSEL_MIN_SLIDES - 1, CAROUSEL_MAX_SLIDES + 1]) {
    const db = fakeDb({ d1: DRAFT }); const q = fakeEnqueue();
    const { a } = await enqueueCarousel(db, q);
    const { output, slidesPngBase64 } = goodSlides(a.context.canvas.w, a.context.canvas.h, count);
    const r = await completeVisualJob(db, { jobId: "job-1", job: db.jobs["job-1"], output, slidesPngBase64, now: new Date() });
    assert.equal(r.status, 422, `count ${count}`);
    assert.equal(db.visuals[a.context.visual_id].status, "error");
  }
});

test("contract: rendered slide count must match html slide count", async () => {
  const db = fakeDb({ d1: DRAFT }); const q = fakeEnqueue();
  const { a } = await enqueueCarousel(db, q);
  const { output } = goodSlides(a.context.canvas.w, a.context.canvas.h, 3);
  const r = await completeVisualJob(db, { jobId: "job-1", job: db.jobs["job-1"], output,
    slidesPngBase64: [png(a.context.canvas.w, a.context.canvas.h), png(a.context.canvas.w, a.context.canvas.h)], now: new Date() });
  assert.equal(r.status, 422);
  assert.match(r.body.error, /count/);
});

test("contract: a slide with alpha (not flattened) is refused", async () => {
  const db = fakeDb({ d1: DRAFT }); const q = fakeEnqueue();
  const { a } = await enqueueCarousel(db, q);
  const { output, slidesPngBase64 } = goodSlides(a.context.canvas.w, a.context.canvas.h, 3);
  slidesPngBase64[1] = rgbaPng(a.context.canvas.w, a.context.canvas.h);
  const r = await completeVisualJob(db, { jobId: "job-1", job: db.jobs["job-1"], output, slidesPngBase64, now: new Date() });
  assert.equal(r.status, 422);
  assert.match(r.body.error, /slide 2/);
});

test("contract: wrong slide dimensions refused per slide", async () => {
  const db = fakeDb({ d1: DRAFT }); const q = fakeEnqueue();
  const { a } = await enqueueCarousel(db, q);
  const { output, slidesPngBase64 } = goodSlides(a.context.canvas.w, a.context.canvas.h, 3);
  slidesPngBase64[2] = png(100, 100);
  const r = await completeVisualJob(db, { jobId: "job-1", job: db.jobs["job-1"], output, slidesPngBase64, now: new Date() });
  assert.equal(r.status, 422);
  assert.match(r.body.error, /slide 3/);
});

test("round trip: carousel draft edited mid-flight is refused as stale", async () => {
  const db = fakeDb({ d1: { ...DRAFT } }); const q = fakeEnqueue();
  const { a } = await enqueueCarousel(db, q);
  (await db.getDraft("d1")).body = "Edited after the job was queued.";
  const { output, slidesPngBase64 } = goodSlides(a.context.canvas.w, a.context.canvas.h, 3);
  const r = await completeVisualJob(db, { jobId: "job-1", job: db.jobs["job-1"], output, slidesPngBase64, now: new Date() });
  assert.equal(r.status, 422);
  assert.equal(db.visuals[a.context.visual_id].status, "error");
});
