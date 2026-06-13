import { googleEnabled, googleAccessToken } from "@/lib/google-calendar";

// Save documents to Google Drive using the SAME OAuth connection as Calendar
// (a per-user refresh token with the drive.file scope). Files are owned by the
// connected Google account (e.g. admin@folkpaths.com). No service account, so no
// org-policy/key hurdles. Drive is "available" whenever Google OAuth is configured.
export const googleDriveEnabled = googleEnabled;

// Find a folder this app created (drive.file scope) by name under an optional
// parent, creating it if missing.
async function findOrCreateFolder(token: string, name: string, parentId?: string): Promise<string> {
  const safe = name.replace(/'/g, "\\'");
  const q = [`name = '${safe}'`, "mimeType = 'application/vnd.google-apps.folder'", "trashed = false"];
  if (parentId) q.push(`'${parentId}' in parents`);
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q.join(" and "))}&fields=files(id)&spaces=drive`;
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const j = await r.json().catch(() => ({}));
  if (j.files?.[0]?.id) return j.files[0].id as string;
  const cr = await fetch("https://www.googleapis.com/drive/v3/files?fields=id", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: parentId ? [parentId] : undefined }),
  });
  const cj = await cr.json().catch(() => ({}));
  if (!cr.ok || !cj.id) throw new Error(`drive-folder ${cr.status}: ${JSON.stringify(cj).slice(0, 160)}`);
  return cj.id as string;
}

// Upload HTML, converting it to a native Google Doc, into the nested folderPath
// of the connected account's Drive. Returns the file id + a shareable link.
export async function saveHtmlToDrive(opts: { refreshToken: string; name: string; html: string; folderPath: string[] }): Promise<{ id: string; link: string }> {
  const token = await googleAccessToken(opts.refreshToken);
  if (!token) throw new Error("drive-auth: could not refresh Google token (reconnect needed)");
  let parent: string | undefined;
  for (const seg of opts.folderPath) parent = await findOrCreateFolder(token, seg, parent);
  const meta = { name: opts.name, mimeType: "application/vnd.google-apps.document", parents: parent ? [parent] : undefined };
  const boundary = `folkpaths-${Math.random().toString(36).slice(2)}`;
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
    `--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${opts.html}\r\n--${boundary}--`;
  const r = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": `multipart/related; boundary=${boundary}` }, body,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.id) throw new Error(`drive-upload ${r.status}: ${JSON.stringify(j).slice(0, 160)}`);
  return { id: j.id as string, link: (j.webViewLink as string) ?? `https://docs.google.com/document/d/${j.id}/edit` };
}


// Upload raw bytes (e.g. a PDF rendered in the browser) to the connected account's
// Drive without any conversion. `base64` is the file content base64-encoded.
// Find an existing file (any type) by exact name in a folder, so a re-save can
// replace it instead of creating a duplicate. drive.file scope sees app-created files.
async function findFileInFolder(token: string, name: string, parentId?: string): Promise<string | null> {
  const safe = name.replace(/'/g, "\\'");
  const q = [`name = '${safe}'`, "mimeType != 'application/vnd.google-apps.folder'", "trashed = false"];
  if (parentId) q.push(`'${parentId}' in parents`);
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q.join(" and "))}&fields=files(id)&spaces=drive&orderBy=modifiedTime desc`;
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const j = await r.json().catch(() => ({}));
  return j.files?.[0]?.id ?? null;
}

export async function saveBufferToDrive(opts: { refreshToken: string; name: string; base64: string; mimeType: string; folderPath: string[] }): Promise<{ id: string; link: string }> {
  const token = await googleAccessToken(opts.refreshToken);
  if (!token) throw new Error("drive-auth: could not refresh Google token (reconnect needed)");
  let parent: string | undefined;
  for (const seg of opts.folderPath) parent = await findOrCreateFolder(token, seg, parent);

  // Replace mode: if a same-named file already exists in this folder, update its
  // bytes in place (no duplicate) and keep the same Drive link.
  const existingId = await findFileInFolder(token, opts.name, parent);
  if (existingId) {
    const ur = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=media&fields=id,webViewLink`, {
      method: "PATCH", headers: { authorization: `Bearer ${token}`, "content-type": opts.mimeType }, body: Buffer.from(opts.base64, "base64"),
    });
    const uj = await ur.json().catch(() => ({}));
    if (ur.ok && uj.id) return { id: uj.id as string, link: (uj.webViewLink as string) ?? `https://drive.google.com/file/d/${uj.id}/view` };
    // if the update failed, fall through and create a fresh file
  }

  const meta = { name: opts.name, parents: parent ? [parent] : undefined };
  const boundary = `folkpaths-${Math.random().toString(36).slice(2)}`;
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
    `--${boundary}\r\nContent-Type: ${opts.mimeType}\r\nContent-Transfer-Encoding: base64\r\n\r\n${opts.base64}\r\n--${boundary}--`;
  const r = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": `multipart/related; boundary=${boundary}` }, body,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.id) throw new Error(`drive-upload ${r.status}: ${JSON.stringify(j).slice(0, 160)}`);
  return { id: j.id as string, link: (j.webViewLink as string) ?? `https://drive.google.com/file/d/${j.id}/view` };
}
