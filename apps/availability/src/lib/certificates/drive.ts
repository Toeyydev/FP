import { googleAccessToken } from "@/lib/google-calendar";
import type { DrivePermission } from "@/lib/certificates/access";

// Filing a certificate in Drive: one file per attempt, and the winner is never written
// to again.
//
// Two earlier shapes of this were wrong in the same way. Keying on a filename was wrong
// because Drive lets two files in one folder share a name. Keying on a marker and
// letting every attempt update that one file was wrong for a subtler reason: a write to
// Drive happens outside the database's decision about who owns the upload, so an attempt
// that was fenced out can still have its bytes land afterwards — including after the
// document has been linked and is already standing in for a receipt. No lease prevents
// that, because the call was in the air before the lease lapsed.
//
// So no file is ever shared between attempts. Each attempt writes its own, marked TEMP
// and carrying its own token, and an attempt may only ever touch a file with its own
// token on it.
//
// And the document is never a file that was written to. Promoting the TEMP file in place
// looked right and was not: a media upload that started while the file was still TEMP
// can arrive after the promotion and rewrite the document. Checking the state before
// writing does not help — the request was sent before the state changed — and a content
// restriction applied afterwards does not cancel a call already in the air.
//
// So once an attempt's TEMP bytes have been read back and hashed, those verified bytes
// are written to a BRAND NEW file, which becomes the document. Nothing has ever held
// that file id, so nothing can be on its way to it.
//
//   TEMP         one attempt's candidate. Only that attempt may replace its bytes.
//   ACTIVE       the document. Created once from verified bytes; never written again.
//   RETIRED      a TEMP whose bytes became the document. Kept as the trail.
//   QUARANTINED  a candidate that lost, or one whose bytes did not read back.

export const MARKER = {
  certificateId: "folkopsCertificateId",
  certificateNo: "folkopsCertificateNo",
  payloadHash: "folkopsPayloadHash",
  environment: "folkopsEnvironment",
  attemptToken: "folkopsAttemptToken",
  fileState: "folkopsFileState",
} as const;

/** Written on a file that lost or failed, so what it was is not lost with it. */
export const FORENSIC = {
  certificateId: "folkopsQuarantinedCertificateId",
  attemptToken: "folkopsQuarantinedAttemptToken",
  at: "folkopsQuarantinedAt",
  reason: "folkopsQuarantineReason",
} as const;

export type FileState = "TEMP" | "ACTIVE" | "RETIRED" | "QUARANTINED";

export function certificateEnvironment(): string {
  return (process.env.FOLKOPS_ENV || process.env.RAILWAY_ENVIRONMENT_NAME || process.env.NODE_ENV || "development").trim();
}

export class DuplicateCertificateFile extends Error {
  constructor(public certificateId: string, public state: FileState, public fileIds: string[]) {
    super(`${fileIds.length} ${state} files in Drive for ${certificateId}: ${fileIds.join(", ")}`);
    this.name = "DuplicateCertificateFile";
  }
}

export type CertificateFile = {
  id: string;
  name: string;
  link: string;
  attemptToken: string | null;
  state: FileState | null;
  /** Drive's own view of the bytes, kept alongside our SHA-256 rather than instead of it. */
  revisionId?: string | null;
  md5?: string | null;
  readOnly?: boolean;
};

export type PutAttemptInput = {
  certificateId: string;
  certificateNo: string;
  payloadHash: string;
  environment: string;
  attemptToken: string;
  name: string;
  bytes: Buffer;
  folderPath: string[];
};

export type CertificateDrive = {
  /** This attempt's own candidate file, if it already made one. */
  findAttempt(o: { certificateId: string; environment: string; attemptToken: string; folderPath: string[] }): Promise<CertificateFile[]>;
  /** Every file in any state for this certificate, so losers can be cleaned up. */
  findAll(o: { certificateId: string; environment: string; folderPath: string[] }): Promise<CertificateFile[]>;
  /** The document, if one has been settled on. */
  findActive(o: { certificateId: string; environment: string; folderPath: string[] }): Promise<CertificateFile[]>;
  /** This attempt's ACTIVE candidate, if it already made one. */
  findActiveByAttempt(o: { certificateId: string; environment: string; attemptToken: string; folderPath: string[] }): Promise<CertificateFile[]>;
  /** Write this attempt's candidate. Only ever its own TEMP file. */
  putAttempt(o: PutAttemptInput): Promise<CertificateFile>;
  /**
   * Create the document, as a NEW file, from bytes that have already been read back and
   * checked. There is no update path: this file id has never existed before, so nothing
   * can be in flight towards it.
   */
  createActive(o: PutAttemptInput): Promise<CertificateFile>;
  /** Move a TEMP aside once its bytes have become the document. */
  retire(o: { fileId: string; certificateId: string; attemptToken: string; at: string; reason: string }): Promise<void>;
  read(o: { fileId: string }): Promise<Buffer | null>;
  /**
   * Who can see this file, straight from Drive. `null` when the list could not be read —
   * which the caller must treat as a refusal, not as an empty list. "Nobody else can see
   * it" and "we could not find out" are different answers.
   */
  permissions(o: { fileId: string }): Promise<DrivePermission[] | null>;
  /** The folder itself, so the question can be asked of the tree and not only the leaf. */
  folderId(o: { folderPath: string[] }): Promise<string | null>;
  /** The account these calls are made as. It owns what it creates, so it is allowed. */
  accountEmail(): Promise<string | null>;
  quarantine(o: { fileId: string; reason: string; certificateId: string; attemptToken: string; at: string }): Promise<void>;
};

// ── The real one ─────────────────────────────────────────────────────────────

const api = "https://www.googleapis.com/drive/v3";
const uploadApi = "https://www.googleapis.com/upload/drive/v3";
const FIELDS = "id,name,webViewLink,appProperties,headRevisionId,md5Checksum,contentRestrictions";
const linkOf = (id: string, webViewLink?: string) => webViewLink ?? `https://drive.google.com/file/d/${id}/view`;
const esc = (v: string) => v.replace(/'/g, "\\'");

type RawFile = {
  id: string; name?: string; webViewLink?: string; appProperties?: Record<string, string>;
  headRevisionId?: string; md5Checksum?: string; contentRestrictions?: { readOnly?: boolean }[];
};
const shape = (f: RawFile): CertificateFile => ({
  id: f.id, name: f.name ?? "", link: linkOf(f.id, f.webViewLink),
  attemptToken: f.appProperties?.[MARKER.attemptToken] || null,
  state: (f.appProperties?.[MARKER.fileState] as FileState) || null,
  revisionId: f.headRevisionId ?? null,
  md5: f.md5Checksum ?? null,
  readOnly: f.contentRestrictions?.[0]?.readOnly ?? false,
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

export function googleCertificateDrive(refreshToken: string): CertificateDrive {
  const search = async (folderPath: string[], clauses: string[]): Promise<CertificateFile[]> => {
    const token = await bearer(refreshToken);
    const parent = await folder(token, folderPath);
    const q = [...clauses, "trashed = false"];
    if (parent) q.push(`'${parent}' in parents`);
    const r = await fetch(`${api}/files?q=${encodeURIComponent(q.join(" and "))}&fields=files(${FIELDS})&spaces=drive`, { headers: { authorization: `Bearer ${token}` } });
    const j = (await r.json().catch(() => ({}))) as { files?: RawFile[] };
    return (j.files ?? []).map(shape);
  };
  const has = (key: string, value: string) => `appProperties has { key='${key}' and value='${esc(value)}' }`;

  const createFile = async (o: PutAttemptInput, state: FileState): Promise<CertificateFile> => {
    const token = await bearer(refreshToken);
    const parent = await folder(token, o.folderPath);
    const appProperties = {
      [MARKER.certificateId]: o.certificateId,
      [MARKER.certificateNo]: o.certificateNo,
      [MARKER.payloadHash]: o.payloadHash,
      [MARKER.environment]: o.environment,
      [MARKER.attemptToken]: o.attemptToken,
      [MARKER.fileState]: state,
    };
    const meta: Record<string, unknown> = { name: o.name, parents: parent ? [parent] : undefined, appProperties };
    // Asked for at creation, so the document is locked from the moment it exists rather
    // than a round trip later. Where the account refuses it, the hash still decides.
    if (state === "ACTIVE") meta.contentRestrictions = [{ readOnly: true, reason: "Certificate in lieu of a receipt — settled accounting document" }];
    const boundary = `folkpaths-cert-${Math.random().toString(36).slice(2)}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`, "utf8"),
      o.bytes,
      Buffer.from(`\r\n--${boundary}--`, "utf8"),
    ]);
    const r = await fetch(`${uploadApi}/files?uploadType=multipart&fields=${FIELDS}`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": `multipart/related; boundary=${boundary}` }, body: new Uint8Array(body),
    });
    const j = (await r.json().catch(() => ({}))) as RawFile;
    if (!r.ok || !j.id) {
      if (state !== "ACTIVE") throw new Error(`drive-upload ${r.status}`);
      // Some accounts refuse content restrictions outright. The state marker is what
      // this relies on; the lock was only ever a second line.
      delete meta.contentRestrictions;
      const b2 = `folkpaths-cert-${Math.random().toString(36).slice(2)}`;
      const body2 = Buffer.concat([
        Buffer.from(`--${b2}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b2}\r\nContent-Type: application/pdf\r\n\r\n`, "utf8"),
        o.bytes,
        Buffer.from(`\r\n--${b2}--`, "utf8"),
      ]);
      const r2 = await fetch(`${uploadApi}/files?uploadType=multipart&fields=${FIELDS}`, {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": `multipart/related; boundary=${b2}` }, body: new Uint8Array(body2),
      });
      const j2 = (await r2.json().catch(() => ({}))) as RawFile;
      if (!r2.ok || !j2.id) throw new Error(`drive-upload ${r2.status}`);
      return shape({ ...j2, appProperties });
    }
    return shape({ ...j, appProperties });
  };

  return {
    findAll: ({ certificateId, environment, folderPath }) =>
      search(folderPath, [has(MARKER.certificateId, certificateId), has(MARKER.environment, environment)]),

    findActive: ({ certificateId, environment, folderPath }) =>
      search(folderPath, [has(MARKER.certificateId, certificateId), has(MARKER.environment, environment), has(MARKER.fileState, "ACTIVE")]),

    findAttempt: ({ certificateId, environment, attemptToken, folderPath }) =>
      search(folderPath, [has(MARKER.certificateId, certificateId), has(MARKER.environment, environment), has(MARKER.attemptToken, attemptToken), has(MARKER.fileState, "TEMP")]),

    findActiveByAttempt: ({ certificateId, environment, attemptToken, folderPath }) =>
      search(folderPath, [has(MARKER.certificateId, certificateId), has(MARKER.environment, environment), has(MARKER.attemptToken, attemptToken), has(MARKER.fileState, "ACTIVE")]),

    async putAttempt(o) {
      const token = await bearer(refreshToken);
      const mine = await this.findAttempt({ certificateId: o.certificateId, environment: o.environment, attemptToken: o.attemptToken, folderPath: o.folderPath });
      if (mine.length > 1) throw new DuplicateCertificateFile(o.certificateId, "TEMP", mine.map((f) => f.id));
      if (mine.length === 1) {
        if (mine[0].state !== "TEMP") throw new Error("drive-immutable: only a TEMP candidate is ever written to");
        const ur = await fetch(`${uploadApi}/files/${mine[0].id}?uploadType=media&fields=${FIELDS}`, {
          method: "PATCH", headers: { authorization: `Bearer ${token}`, "content-type": "application/pdf" }, body: new Uint8Array(o.bytes),
        });
        const uj = (await ur.json().catch(() => ({}))) as RawFile;
        if (!ur.ok || !uj.id) throw new Error(`drive-upload ${ur.status}`);
        return shape(uj);
      }
      return createFile(o, "TEMP");
    },

    /** A new file every time. There is no update path, by construction. */
    createActive: (o) => createFile(o, "ACTIVE"),

    async retire({ fileId, certificateId, attemptToken, at, reason }) {
      const token = await bearer(refreshToken);
      const current = await fetch(`${api}/files/${fileId}?fields=name`, { headers: { authorization: `Bearer ${token}` } });
      const cj = (await current.json().catch(() => ({}))) as { name?: string };
      await fetch(`${api}/files/${fileId}`, {
        method: "PATCH", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          name: `RETIRED ${cj.name ?? fileId}`,
          appProperties: {
            [MARKER.fileState]: "RETIRED",
            [MARKER.certificateId]: "",
            [MARKER.attemptToken]: "",
            [FORENSIC.certificateId]: certificateId,
            [FORENSIC.attemptToken]: attemptToken,
            [FORENSIC.at]: at,
            [FORENSIC.reason]: reason.slice(0, 120),
          },
        }),
      });
    },

    async permissions({ fileId }) {
      const token = await bearer(refreshToken);
      // Inherited grants are asked for explicitly: a file is exactly as private as the
      // folder above it, and a list that showed only what was set on the file itself
      // would call a file in a shared folder private.
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

    async read({ fileId }) {
      const token = await bearer(refreshToken);
      const r = await fetch(`${api}/files/${fileId}?alt=media`, { headers: { authorization: `Bearer ${token}` } });
      if (!r.ok) return null;
      return Buffer.from(await r.arrayBuffer());
    },

    async quarantine({ fileId, reason, certificateId, attemptToken, at }) {
      const token = await bearer(refreshToken);
      // A content restriction would stop the rename, so it is lifted first.
      await fetch(`${api}/files/${fileId}`, {
        method: "PATCH", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ contentRestrictions: [{ readOnly: false }] }),
      }).catch(() => {});
      const current = await fetch(`${api}/files/${fileId}?fields=name`, { headers: { authorization: `Bearer ${token}` } });
      const cj = (await current.json().catch(() => ({}))) as { name?: string };
      await fetch(`${api}/files/${fileId}`, {
        method: "PATCH", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          name: `QUARANTINED ${cj.name ?? fileId}`,
          // The live markers go, so nothing finds this again as a candidate or as the
          // document — but what it was is written down beside them.
          appProperties: {
            [MARKER.certificateId]: "",
            [MARKER.attemptToken]: "",
            [MARKER.fileState]: "QUARANTINED",
            [FORENSIC.certificateId]: certificateId,
            [FORENSIC.attemptToken]: attemptToken,
            [FORENSIC.at]: at,
            [FORENSIC.reason]: reason.slice(0, 120),
          },
        }),
      });
    },
  };
}
