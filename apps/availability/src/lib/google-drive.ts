import crypto from "node:crypto";

// Save documents to Google Drive via a Google Workspace SERVICE ACCOUNT with
// domain-wide delegation, impersonating GOOGLE_DRIVE_SUBJECT (admin@folkpaths.com)
// so files are owned by that account. No interactive OAuth, works headless.
// Set on Railway:
//   GOOGLE_SA_EMAIL          service-account email (…@…iam.gserviceaccount.com)
//   GOOGLE_SA_PRIVATE_KEY    the SA private key (PEM; literal \n are converted)
//   GOOGLE_DRIVE_SUBJECT     admin@folkpaths.com (the Workspace user to impersonate)
//   GOOGLE_DRIVE_ROOT_FOLDER_ID  (optional) parent folder to nest everything under
const SA_EMAIL = process.env.GOOGLE_SA_EMAIL;
const SA_KEY = process.env.GOOGLE_SA_PRIVATE_KEY?.replace(/\\n/g, "\n");
const SUBJECT = process.env.GOOGLE_DRIVE_SUBJECT;
const ROOT = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID || undefined;

export const googleDriveEnabled = Boolean(SA_EMAIL && SA_KEY && SUBJECT);

const b64url = (buf: Buffer | string) =>
  Buffer.from(buf).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

// Sign a JWT for the service account and exchange it for an access token that
// acts as the impersonated Workspace user.
async function getAccessToken(): Promise<string> {
  if (!googleDriveEnabled) throw new Error("drive-not-configured");
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({
    iss: SA_EMAIL, sub: SUBJECT, scope: "https://www.googleapis.com/auth/drive",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  }));
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(`${header}.${claim}`);
  const sig = b64url(signer.sign(SA_KEY!));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${header}.${claim}.${sig}` }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error(`drive-auth ${res.status}: ${JSON.stringify(j).slice(0, 160)}`);
  return j.access_token as string;
}

// Find a folder by name under an optional parent, creating it if missing.
async function findOrCreateFolder(token: string, name: string, parentId?: string): Promise<string> {
  const safe = name.replace(/'/g, "\\'");
  const q = [`name = '${safe}'`, "mimeType = 'application/vnd.google-apps.folder'", "trashed = false"];
  if (parentId) q.push(`'${parentId}' in parents`);
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q.join(" and "))}&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true`;
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const j = await r.json().catch(() => ({}));
  if (j.files?.[0]?.id) return j.files[0].id as string;
  const cr = await fetch("https://www.googleapis.com/drive/v3/files?fields=id&supportsAllDrives=true", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: parentId ? [parentId] : undefined }),
  });
  const cj = await cr.json().catch(() => ({}));
  if (!cr.ok || !cj.id) throw new Error(`drive-folder ${cr.status}: ${JSON.stringify(cj).slice(0, 160)}`);
  return cj.id as string;
}

// Upload HTML, converting it to a native Google Doc, into the nested folderPath.
// Returns the file id + a shareable webViewLink.
export async function saveHtmlToDrive(opts: { name: string; html: string; folderPath: string[] }): Promise<{ id: string; link: string }> {
  const token = await getAccessToken();
  let parent = ROOT;
  for (const seg of opts.folderPath) parent = await findOrCreateFolder(token, seg, parent);
  const meta = { name: opts.name, mimeType: "application/vnd.google-apps.document", parents: parent ? [parent] : undefined };
  const boundary = `folkpaths-${b64url(crypto.randomBytes(12))}`;
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
    `--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${opts.html}\r\n--${boundary}--`;
  const r = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink&supportsAllDrives=true", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": `multipart/related; boundary=${boundary}` }, body,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.id) throw new Error(`drive-upload ${r.status}: ${JSON.stringify(j).slice(0, 160)}`);
  return { id: j.id as string, link: (j.webViewLink as string) ?? `https://docs.google.com/document/d/${j.id}/edit` };
}
