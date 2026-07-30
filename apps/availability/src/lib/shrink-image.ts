// Client-side image downscale for uploads. Big phone photos (3–8 MB) are the
// slow path for document + e-slip uploads (server → DB); shrinking to
// ~1600px JPEG before sending cuts upload time and DB storage many-fold.
// Non-images (PDFs) pass through untouched; if anything fails we return the
// original so an upload never breaks because of compression.
export async function shrinkImage(file: File, max = 1600, quality = 0.82): Promise<Blob> {
  if (!file.type.startsWith("image/")) return file; // PDFs etc. upload as-is
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) return file;
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const ctx = c.getContext("2d"); if (!ctx) return file;
  ctx.drawImage(bmp, 0, 0, w, h);
  const blob = await new Promise<Blob | null>((res) => c.toBlob(res, "image/jpeg", quality));
  return blob && blob.size < file.size ? blob : file;
}

// Rename a shrunk image to .jpg (its new encoding); leave anything else alone.
export function shrunkName(original: string, blob: Blob): string {
  return blob.type === "image/jpeg" ? original.replace(/\.[^.]+$/, "") + ".jpg" : original;
}
