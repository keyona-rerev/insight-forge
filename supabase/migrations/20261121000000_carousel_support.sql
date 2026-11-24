-- Opt-in LinkedIn carousel support.
--
-- formats.render_kind marks a format as a carousel ('carousel') or a standard
-- post ('standard', the default). Every existing and new format is 'standard'
-- unless the owner deliberately switches it in Strategy > Formats - the
-- launch-pack prompt rule already keeps install-time AI from proposing
-- carousel formats, and this column makes the code path deterministic rather
-- than prompt-driven.
--
-- draft_visuals gains the carousel assets: the assembled slide PDF that
-- publishes as the LinkedIn document post (pdf_url), its page_count, and
-- slide_image_urls (the per-slide PNGs Review shows before approval; the PDF
-- is assembled from these exact images, so preview and published pages are
-- the same pixels).

ALTER TABLE public.formats
  ADD COLUMN IF NOT EXISTS render_kind text NOT NULL DEFAULT 'standard';

ALTER TABLE public.formats
  DROP CONSTRAINT IF EXISTS formats_render_kind_check;

ALTER TABLE public.formats
  ADD CONSTRAINT formats_render_kind_check CHECK (render_kind IN ('standard', 'carousel'));

ALTER TABLE public.draft_visuals
  ADD COLUMN IF NOT EXISTS pdf_url text,
  ADD COLUMN IF NOT EXISTS page_count integer,
  ADD COLUMN IF NOT EXISTS slide_image_urls jsonb;
