// Carousel-aware media resolver for the publish path.
//
// A draft whose format is render_kind='carousel' publishes to LinkedIn as a
// DOCUMENT post (the swipeable carousel): the media is the assembled slide
// PDF (draft_visuals.pdf_url), NEVER the single graphic and NEVER text-only.
// Anything else keeps the established single-image behavior.
//
// render_kind lives on the format (a deliberate owner choice in Strategy >
// Formats) and defaults to 'standard' - a format without the column read, or
// with any unexpected value, resolves to 'standard' so existing drafts are
// byte-identical in behavior. This is a deterministic code decision, never
// inferred from format names or prompt text.

// deno-lint-ignore no-explicit-any
export interface DraftMedia {
  renderKind: "standard" | "carousel";
  // Present only for standard drafts with a ready visual.
  imageUrl?: string;
  // Present only for carousel drafts with a ready, assembled slide PDF.
  documentUrl?: string;
}

// deno-lint-ignore no-explicit-any
export async function getDraftMedia(supabase: any, draft: { id: string; format_id?: string | null }): Promise<DraftMedia> {
  let renderKind: "standard" | "carousel" = "standard";
  if (draft.format_id) {
    const { data: fmt } = await supabase
      .from("formats")
      .select("render_kind")
      .eq("id", draft.format_id)
      .maybeSingle();
    if (fmt?.render_kind === "carousel") renderKind = "carousel";
  }

  if (renderKind === "carousel") {
    const { data } = await supabase
      .from("draft_visuals")
      .select("pdf_url")
      .eq("draft_id", draft.id)
      .eq("status", "ready")
      .not("pdf_url", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    // Deliberately NO imageUrl here: a LinkedIn document post cannot carry
    // images alongside the PDF, and attaching the cover image instead of the
    // PDF would silently downgrade the carousel to a single-image post.
    return { renderKind, documentUrl: data?.pdf_url ?? undefined };
  }

  const { data } = await supabase
    .from("draft_visuals")
    .select("image_url")
    .eq("draft_id", draft.id)
    .eq("status", "ready")
    .not("image_url", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return { renderKind, imageUrl: data?.image_url ?? undefined };
}
