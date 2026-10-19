import { googleEnabled, googleAccessToken } from "@/lib/google-calendar";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";

// Save documents to Google Drive using the SAME OAuth connection as Calendar
// (a per-user refresh token with the drive.file scope). Files are owned by the
// connected Google account (e.g. admin@folkpaths.com). No service account, so no
// org-policy/key hurdles. Drive is "available" whenever Google OAuth is configured.
export const googleDriveEnabled = googleEnabled;

// Every job sheet and e-slip belongs in ONE place — the Folkpaths company Drive —
// no matter which operator is signed in. Resolve that single account's refresh
// token here so all Drive saves land in the same Drive. Resolution order:
//   1. the account pinned by FOLKPATHS_DRIVE_EMAIL (the canonical company Drive),
//   2. the acting operator's OWN connection (preserves the behaviour that worked
//      before centralising — never a regression),
//   3. the earliest connection (typically the owner's Folkpaths account).
// Returns null only when no Google account is connected at all.
export async function folkpathsDriveToken(actingUserId?: string): Promise<string | null> {
  const want = process.env.FOLKPATHS_DRIVE_EMAIL?.trim().toLowerCase();
  const conns = await prisma.googleCalendar.findMany({ orderBy: { connectedAt: "asc" } }).catch(() => []);
  if (!conns.length) return null;
  const chosen =
    (want && conns.find((c) => c.email?.toLowerCase() === want)) ||
    (actingUserId && conns.find((c) => c.userId === actingUserId)) ||
    conns[0];
  return chosen.refreshToken ? decrypt(chosen.refreshToken) : null;
}

// The Folkpaths company Shared Drive — the source of truth for company documents (job sheet
// PDFs first), written by the service account (lib/drive-service-account). Configured, never
// hard-coded: FOLKPATHS_SHARED_DRIVE_ID is the Shared Drive's id (the part after
// /drive/folders/ when the Shared Drive itself is open in Drive). Null when unset: a caller
// that must file in the Shared Drive then refuses rather than fall back to a My Drive.
export function folkpathsSharedDriveId(): string | null {
  const id = (process.env.FOLKPATHS_SHARED_DRIVE_ID ?? "").trim();
  return /^[A-Za-z0-9_-]{10,}$/.test(id) ? id : null;
}

// Query-string options every files.* call needs to see or write inside a Shared Drive.
// Without supportsAllDrives Drive answers 404 for anything in a Shared Drive; a files.list
// without corpora=drive + driveId + includeItemsFromAllDrives searches My Drive only.
export function sharedDriveParams(driveId: string | undefined, kind: "list" | "write"): string {
  if (!driveId) return "";
  return kind === "list"
    ? `&supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=drive&driveId=${encodeURIComponent(driveId)}`
    : "&supportsAllDrives=true";
}

// Accounting / partner accounts that must be able to SEE every job sheet + e-slip.
// Comma-separated in FOLKPATHS_DRIVE_SHARE (e.g. "account@folkpaths.com"). They get
// reader access to the TOP-LEVEL company folders, so all files inside are visible.
const SHARE_EMAILS = (process.env.FOLKPATHS_DRIVE_SHARE || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
const sharedFolders = new Set<string>(); // per-process cache — share each folder once

async function shareFolderWith(token: string, folderId: string): Promise<void> {
  for (const email of SHARE_EMAILS) {
    const cacheKey = `${folderId}:${email}`;
    if (sharedFolders.has(cacheKey)) continue;
    try {
      const r = await fetch(`https://www.googleapis.com/drive/v3/files/${folderId}/permissions?sendNotificationEmail=false&fields=id`, {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ role: "reader", type: "user", emailAddress: email }),
      });
      if (r.ok) sharedFolders.add(cacheKey); // only cache on success, so a failure retries next save
    } catch { /* best-effort */ }
  }
}

// Find a folder this app created (drive.file scope) by name under an optional
// parent, creating it if missing. Top-level company folders are shared with the
// accounting account(s) so they can see all job sheets + e-slips.
//
// With a sharedDriveId the folders live in that Shared Drive: a top-level folder's parent is
// the Shared Drive itself, and every lookup and create carries the Shared Drive options.
// Access there comes from Shared Drive membership, so no per-folder sharing is added.
async function findOrCreateFolder(token: string, name: string, parentId?: string, sharedDriveId?: string): Promise<string> {
  const safe = name.replace(/'/g, "\\'");
  const parent = parentId ?? sharedDriveId;
  const q = [`name = '${safe}'`, "mimeType = 'application/vnd.google-apps.folder'", "trashed = false"];
  if (parent) q.push(`'${parent}' in parents`);
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q.join(" and "))}&fields=files(id)${sharedDriveId ? sharedDriveParams(sharedDriveId, "list") : "&spaces=drive"}`;
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const j = (await r.json().catch(() => ({}))) as { files?: { id?: string }[] };
  let id: string;
  if (j.files?.[0]?.id) id = j.files[0].id;
  else {
    const cr = await fetch(`https://www.googleapis.com/drive/v3/files?fields=id${sharedDriveParams(sharedDriveId, "write")}`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: parent ? [parent] : undefined }),
    });
    const cj = (await cr.json().catch(() => ({}))) as { id?: string };
    if (!cr.ok || !cj.id) throw new Error(`drive-folder ${cr.status}: ${JSON.stringify(cj).slice(0, 160)}`);
    id = cj.id;
  }
  // Give the accounting account(s) reader access to the top-level company folders
  // ("Folkpaths Job Sheets" / "Folkpaths E-slips"), so every file inside is visible.
  if (!parentId && !sharedDriveId && SHARE_EMAILS.length) await shareFolderWith(token, id);
  return id;
}

// Upload HTML, converting it to a native Google Doc, into the nested folderPath
// of the connected account's Drive. Returns the file id + a shareable link.
export async function saveHtmlToDrive(opts: { refreshToken: string; name: string; html: string; folderPath: string[] }): Promise<{ id: string; link: string }> {
  const token = await googleAccessToken(opts.refreshToken);
  if (!token) throw new Error("drive-auth: could not refresh Google token (reconnect needed)");
  let parent: string | undefined;
  for (const seg of opts.folderPath) parent = await findOrCreateFolder(token, seg, parent);
  // Resave should replace, not pile up: trash any existing same-named copies first.
  for (const d of await findFilesInFolder(token, opts.name, parent)) await trashFile(token, d);
  const meta = { name: opts.name, mimeType: "application/vnd.google-apps.document", parents: parent ? [parent] : undefined };
  const boundary = `folkpaths-${Math.random().toString(36).slice(2)}`;
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
    `--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${opts.html}\r\n--${boundary}--`;
  const r = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": `multipart/related; boundary=${boundary}` }, body,
  });
  const j = (await r.json().catch(() => ({}))) as { id?: string; webViewLink?: string };
  if (!r.ok || !j.id) throw new Error(`drive-upload ${r.status}: ${JSON.stringify(j).slice(0, 160)}`);
  return { id: j.id, link: j.webViewLink ?? `https://docs.google.com/document/d/${j.id}/edit` };
}


// Upload raw bytes (e.g. a PDF rendered in the browser) to the connected account's
// Drive without any conversion. `base64` is the file content base64-encoded.
// Find an existing file (any type) by exact name in a folder, so a re-save can
// replace it instead of creating a duplicate. drive.file scope sees app-created files.
async function findFilesInFolder(token: string, name: string, parentId?: string, sharedDriveId?: string): Promise<string[]> {
  const safe = name.replace(/'/g, "\\'");
  const q = [`name = '${safe}'`, "mimeType != 'application/vnd.google-apps.folder'", "trashed = false"];
  if (parentId) q.push(`'${parentId}' in parents`);
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q.join(" and "))}&fields=files(id)${sharedDriveId ? sharedDriveParams(sharedDriveId, "list") : "&spaces=drive"}&orderBy=modifiedTime desc`;
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const j = (await r.json().catch(() => ({}))) as { files?: { id: string }[] };
  return (j.files ?? []).map((f) => f.id);
}

async function trashFile(token: string, id: string, sharedDriveId?: string): Promise<void> {
  await fetch(`https://www.googleapis.com/drive/v3/files/${id}${sharedDriveId ? "?supportsAllDrives=true" : ""}`, {
    method: "PATCH", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ trashed: true }),
  }).catch(() => {});
}

// The connected account's My Drive (the admin@folkpaths.com OAuth connection, drive.file):
// e-slips, advance slips and every other My Drive flow. Never a Shared Drive — company
// documents in the Shared Drive go through the service account (lib/drive-service-account).
export async function saveBufferToDrive(opts: { refreshToken: string; name: string; base64: string; mimeType: string; folderPath: string[] }): Promise<{ id: string; link: string }> {
  const token = await googleAccessToken(opts.refreshToken);
  if (!token) throw new Error("drive-auth: could not refresh Google token (reconnect needed)");
  return saveBufferWithAccessToken(token, { name: opts.name, base64: opts.base64, mimeType: opts.mimeType, folderPath: opts.folderPath });
}

// The upload itself, for whoever holds the access token. With `sharedDriveId` the folderPath
// is found or created under that Shared Drive's root and every call carries the Shared Drive
// options; without it, the requests are the My Drive ones.
export async function saveBufferWithAccessToken(token: string, opts: { name: string; base64: string; mimeType: string; folderPath: string[]; sharedDriveId?: string }): Promise<{ id: string; link: string }> {
  const sd = opts.sharedDriveId;
  let parent: string | undefined;
  for (const seg of opts.folderPath) parent = await findOrCreateFolder(token, seg, parent, sd);

  // Replace mode: if same-named file(s) already exist in this folder, update the
  // newest in place (no duplicate, same link) and trash any older duplicates so a
  // re-save always overwrites the one canonical copy.
  const existing = await findFilesInFolder(token, opts.name, parent, sd);
  if (existing.length) {
    const [keep, ...dupes] = existing;
    for (const d of dupes) await trashFile(token, d, sd);
    const ur = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${keep}?uploadType=media&fields=id,webViewLink${sharedDriveParams(sd, "write")}`, {
      method: "PATCH", headers: { authorization: `Bearer ${token}`, "content-type": opts.mimeType }, body: Buffer.from(opts.base64, "base64"),
    });
    const uj = (await ur.json().catch(() => ({}))) as { id?: string; webViewLink?: string };
    if (ur.ok && uj.id) return { id: uj.id, link: uj.webViewLink ?? `https://drive.google.com/file/d/${uj.id}/view` };
    // if the update failed, fall through and create a fresh file
  }

  const meta = { name: opts.name, parents: parent ? [parent] : undefined };
  const boundary = `folkpaths-${Math.random().toString(36).slice(2)}`;
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
    `--${boundary}\r\nContent-Type: ${opts.mimeType}\r\nContent-Transfer-Encoding: base64\r\n\r\n${opts.base64}\r\n--${boundary}--`;
  const r = await fetch(`https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink${sharedDriveParams(sd, "write")}`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": `multipart/related; boundary=${boundary}` }, body,
  });
  // Typed where it is read: under the worker's stricter config an untyped `j`
  // is `unknown`, and the file only escaped that because nothing there imported it.
  const j = (await r.json().catch(() => ({}))) as { id?: string; webViewLink?: string };
  if (!r.ok || !j.id) throw new Error(`drive-upload ${r.status}: ${JSON.stringify(j).slice(0, 160)}`);
  return { id: j.id, link: j.webViewLink ?? `https://drive.google.com/file/d/${j.id}/view` };
}

/** The Drive file id inside a link this app stored ("…/file/d/<id>/view", "…?id=<id>"). */
export function driveFileIdOf(link: string | null | undefined): string | null {
  const m = (link ?? "").match(/\/(?:file\/)?d\/([A-Za-z0-9_-]{10,})/) ?? (link ?? "").match(/[?&]id=([A-Za-z0-9_-]{10,})/);
  return m ? m[1] : null;
}

/**
 * Read back a file this app saved to Drive (drive.file scope sees only those), as base64.
 * Null when the link is not a Drive file, the token cannot be refreshed, or Drive refuses.
 */
export async function downloadDriveFile(refreshToken: string, link: string): Promise<{ base64: string; mime: string; name: string } | null> {
  const id = driveFileIdOf(link);
  if (!id) return null;
  const token = await googleAccessToken(refreshToken);
  if (!token) return null;
  const meta = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?fields=mimeType,name`, { headers: { authorization: `Bearer ${token}` } }).catch(() => null);
  if (!meta?.ok) return null;
  const m = (await meta.json().catch(() => ({}))) as { mimeType?: string; name?: string };
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`, { headers: { authorization: `Bearer ${token}` } }).catch(() => null);
  if (!r?.ok) return null;
  const buf = Buffer.from(await r.arrayBuffer());
  return { base64: buf.toString("base64"), mime: m.mimeType || "application/octet-stream", name: m.name || id };
}
