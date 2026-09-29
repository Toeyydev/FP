import { googleAccessToken } from "@/lib/google-calendar";
import type { DrivePermission } from "@/lib/certificates/access";

// Where an attester's signature image lives, and how a file is known to be theirs.
//
// A signature image is the one asset in this system that is worth stealing and the only
// one that is reusable: whoever holds it can put a person's hand on anything. So it is
// kept apart from everything else — its own private folder, never the job-sheet tree the
// guides read — and a file is matched to a person by a marker written on it, never by
// what it is called.
//
// Filenames are the wrong key here for the same reason they were wrong for certificates,
// only worse. Drive lets two files in one folder share a name, and a name is the one
// thing a person can change by accident. If the answer to "whose signature is this"
// comes from a filename, then renaming a file reassigns somebody's handwriting.
//
// Identity is therefore three things on the file itself:
//
//   the signature record id   which row in this database the file belongs to
//   the environment           so staging and production never find each other's images
//   the version               so a replacement is a different file, not a new revision
//
// and a version's file is NEVER written to again. Registering a new signature makes a
// new row, a new version and a new file. Nothing is overwritten, so a certificate filed
// against version 1 can still be checked against the bytes version 1 was registered with,
// years after version 4 replaced it.

export const SIGNATURE_MARKER = {
  signatureId: "folkopsSignatureId",
  userId: "folkopsSignatureUserId",
  version: "folkopsSignatureVersion",
  environment: "folkopsEnvironment",
  sha256: "folkopsSignatureSha256",
} as const;

export class DuplicateSignatureFile extends Error {
  constructor(public signatureId: string, public fileIds: string[]) {
    super(`${fileIds.length} signature files in Drive for ${signatureId}: ${fileIds.join(", ")}`);
    this.name = "DuplicateSignatureFile";
  }
}

export type SignatureFile = {
  id: string;
  name: string;
  link: string;
  signatureId: string | null;
  userId: string | null;
  version: number | null;
  sha256: string | null;
};

export type PutSignatureInput = {
  signatureId: string;
  userId: string;
  version: number;
  environment: string;
  sha256: string;
  name: string;
  bytes: Buffer;
  folderPath: string[];
};

export type SignatureDrive = {
  /** The file for this signature record, if one was already written. */
  find(o: { signatureId: string; environment: string; folderPath: string[] }): Promise<SignatureFile[]>;
  /** Write it. Only ever a NEW file — there is no update path, by construction. */
  create(o: PutSignatureInput): Promise<SignatureFile>;
  read(o: { fileId: string }): Promise<Buffer | null>;
  /** Who can see it, straight from Drive. `null` when the list could not be read. */
  permissions(o: { fileId: string }): Promise<DrivePermission[] | null>;
  folderId(o: { folderPath: string[] }): Promise<string | null>;
  /** The account these calls are made as. It owns what it creates, so it is allowed. */
  accountEmail(): Promise<string | null>;
  /** Put a file out of the way. Used when what was written is not what was sent. */
  quarantine(o: { fileId: string; reason: string; signatureId: string; at: string }): Promise<void>;
};

// ── The real one ─────────────────────────────────────────────────────────────

const api = "https://www.googleapis.com/drive/v3";
const uploadApi = "https://www.googleapis.com/upload/drive/v3";
const FIELDS = "id,name,webViewLink,appProperties";
const esc = (v: string) => v.replace(/'/g, "\\'");

type RawFile = { id: string; name?: string; webViewLink?: string; appProperties?: Record<string, string> };
const shape = (f: RawFile): SignatureFile => ({
  id: f.id,
  name: f.name ?? "",
  link: f.webViewLink ?? `https://drive.google.com/file/d/${f.id}/view`,
  signatureId: f.appProperties?.[SIGNATURE_MARKER.signatureId] || null,
  userId: f.appProperties?.[SIGNATURE_MARKER.userId] || null,
  version: Number(f.appProperties?.[SIGNATURE_MARKER.version] ?? "") || null,
  sha256: f.appProperties?.[SIGNATURE_MARKER.sha256] || null,
});

async function bearer(refreshToken: string): Promise<string> {
  const token = await googleAccessToken(refreshToken);
  if (!token) throw new Error("drive-auth: could not refresh Google token (reconnect needed)");
  return token;
}

async function folder(token: string, path: string[]): Promise<string | undefined> {
  let parent: string | undefined;
  for (const name of path) {
    const q = [`name = '${esc(name)}'`, "mimeType = 'application/vnd.google-apps.folder'", "trashed = false"];
    if (parent) q.push(`'${parent}' in parents`);
    const r = await fetch(`${api}/files?q=${encodeURIComponent(q.join(" and "))}&fields=files(id)&spaces=drive`, { headers: { authorization: `Bearer ${token}` } });
    const j = (await r.json().catch(() => ({}))) as { files?: { id?: string }[] };
    if (j.files?.[0]?.id) { parent = j.files[0].id; continue; }
    const cr = await fetch(`${api}/files?fields=id`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: parent ? [parent] : undefined }),
    });
    const cj = (await cr.json().catch(() => ({}))) as { id?: string };
    if (!cr.ok || !cj.id) throw new Error(`drive-folder ${cr.status}`);
    parent = cj.id;
  }
  return parent;
}

export function googleSignatureDrive(refreshToken: string): SignatureDrive {
  return {
    async find({ signatureId, environment, folderPath }) {
      const token = await bearer(refreshToken);
      const parent = await folder(token, folderPath);
      const q = [
        `appProperties has { key='${SIGNATURE_MARKER.signatureId}' and value='${esc(signatureId)}' }`,
        `appProperties has { key='${SIGNATURE_MARKER.environment}' and value='${esc(environment)}' }`,
        "trashed = false",
      ];
      if (parent) q.push(`'${parent}' in parents`);
      const r = await fetch(`${api}/files?q=${encodeURIComponent(q.join(" and "))}&fields=files(${FIELDS})&spaces=drive`, { headers: { authorization: `Bearer ${token}` } });
      const j = (await r.json().catch(() => ({}))) as { files?: RawFile[] };
      return (j.files ?? []).map(shape);
    },

    async create(o) {
      const token = await bearer(refreshToken);
      const parent = await folder(token, o.folderPath);
      const appProperties = {
        [SIGNATURE_MARKER.signatureId]: o.signatureId,
        [SIGNATURE_MARKER.userId]: o.userId,
        [SIGNATURE_MARKER.version]: String(o.version),
        [SIGNATURE_MARKER.environment]: o.environment,
        [SIGNATURE_MARKER.sha256]: o.sha256,
      };
      const meta: Record<string, unknown> = { name: o.name, parents: parent ? [parent] : undefined, appProperties };
      const boundary = `folkpaths-sig-${Math.random().toString(36).slice(2)}`;
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: image/png\r\n\r\n`, "utf8"),
        o.bytes,
        Buffer.from(`\r\n--${boundary}--`, "utf8"),
      ]);
      const r = await fetch(`${uploadApi}/files?uploadType=multipart&fields=${FIELDS}`, {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": `multipart/related; boundary=${boundary}` }, body: new Uint8Array(body),
      });
      const j = (await r.json().catch(() => ({}))) as RawFile;
      if (!r.ok || !j.id) throw new Error(`drive-upload ${r.status}`);
      return shape({ ...j, appProperties });
    },

    async read({ fileId }) {
      const token = await bearer(refreshToken);
      const r = await fetch(`${api}/files/${fileId}?alt=media`, { headers: { authorization: `Bearer ${token}` } });
      if (!r.ok) return null;
      return Buffer.from(await r.arrayBuffer());
    },

    async permissions({ fileId }) {
      const token = await bearer(refreshToken);
      const r = await fetch(`${api}/files/${fileId}/permissions?fields=permissions(id,type,role,emailAddress,domain,allowFileDiscovery,deleted,permissionDetails)&supportsAllDrives=true&pageSize=100`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!r.ok) return null;
      const j = (await r.json().catch(() => null)) as { permissions?: DrivePermission[] } | null;
      return j?.permissions ?? null;
    },

    async folderId({ folderPath }) {
      const token = await bearer(refreshToken);
      return (await folder(token, folderPath)) ?? null;
    },

    async accountEmail() {
      const token = await bearer(refreshToken);
      const r = await fetch(`${api}/about?fields=user(emailAddress)`, { headers: { authorization: `Bearer ${token}` } });
      if (!r.ok) return null;
      const j = (await r.json().catch(() => null)) as { user?: { emailAddress?: string } } | null;
      return j?.user?.emailAddress ?? null;
    },

    async quarantine({ fileId, reason, signatureId, at }) {
      const token = await bearer(refreshToken);
      const current = await fetch(`${api}/files/${fileId}?fields=name`, { headers: { authorization: `Bearer ${token}` } });
      const cj = (await current.json().catch(() => ({}))) as { name?: string };
      await fetch(`${api}/files/${fileId}`, {
        method: "PATCH", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          name: `QUARANTINED ${cj.name ?? fileId}`,
          // The live markers go, so nothing finds this again as anybody's signature, and
          // what it was is written down beside them.
          appProperties: {
            [SIGNATURE_MARKER.signatureId]: "",
            [SIGNATURE_MARKER.userId]: "",
            folkopsQuarantinedSignatureId: signatureId,
            folkopsQuarantinedAt: at,
            folkopsQuarantineReason: reason.slice(0, 120),
          },
        }),
      });
    },
  };
}
