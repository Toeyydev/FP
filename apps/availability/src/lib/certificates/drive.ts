import { googleAccessToken } from "@/lib/google-calendar";

// Filing a certificate in Drive, by a marker on the file rather than by its name.
//
// The obvious way to make an upload idempotent is to use a fixed filename and let the
// second upload replace the first. Drive does not work that way: **two files in one
// folder may have the same name**, and `lib/google-drive.saveBufferToDrive` resolves that
// by updating the newest match and trashing the rest. For a job sheet that is fine. For
// an accounting document it is not — a same-named file from a test environment, or from
// a certificate that was withdrawn and reissued, would be silently overwritten or thrown
// away, and the hash on the record would describe bytes that are no longer there.
//
// So every certificate file carries `appProperties` naming the certificate it is, the
// payload it was rendered from, and the environment that made it. Those are what is
// searched on. A name is a label for humans; this is the identity.
//
// Finding two files with the same marker is not something to resolve by picking one.
// It means something already went wrong, and choosing a file at that point is choosing
// which version of the truth to record. It fails, loudly, with both ids.

export const MARKER = {
  certificateId: "folkopsCertificateId",
  certificateNo: "folkopsCertificateNo",
  payloadHash: "folkopsPayloadHash",
  environment: "folkopsEnvironment",
  /**
   * Which attempt wrote these bytes.
   *
   * The database decides who owns an upload, but the file is written outside that
   * decision — so after the write the file is asked whose it is. A request that was
   * fenced out mid-flight can still have had its bytes land, and if the token on the
   * file is not this request's, somebody else's document is sitting there and this one
   * must not be recorded against it.
   */
  attemptToken: "folkopsAttemptToken",
} as const;

/** Written on a file that failed its read-back, so the next attempt ignores it. */
export const FORENSIC = {
  certificateId: "folkopsQuarantinedCertificateId",
  attemptToken: "folkopsQuarantinedAttemptToken",
  at: "folkopsQuarantinedAt",
  reason: "folkopsQuarantineReason",
} as const;

/**
 * Which deployment made a file.
 *
 * A staging run and production can be pointed at the same Drive account, and without
 * this they would find each other's files and overwrite them. Derived from whatever the
 * platform sets, and "development" when nothing does.
 */
export function certificateEnvironment(): string {
  return (process.env.FOLKOPS_ENV || process.env.RAILWAY_ENVIRONMENT_NAME || process.env.NODE_ENV || "development").trim();
}

export class DuplicateCertificateFile extends Error {
  constructor(public certificateId: string, public fileIds: string[]) {
    super(`duplicate certificate files in Drive for ${certificateId}: ${fileIds.join(", ")}`);
    this.name = "DuplicateCertificateFile";
  }
}

export type CertificateFile = { id: string; name: string; link: string; attemptToken?: string | null };

export type PutInput = {
  certificateId: string;
  certificateNo: string;
  payloadHash: string;
  environment: string;
  name: string;
  bytes: Buffer;
  folderPath: string[];
  /** The upload lease this write belongs to. Read back off the file afterwards. */
  attemptToken: string;
};

/** Everything the certificate workflow needs from a file store, so tests can supply one. */
export type CertificateDrive = {
  /** Files carrying this certificate's marker, in this environment. Never name-matched. */
  find(o: { certificateId: string; environment: string; folderPath: string[] }): Promise<CertificateFile[]>;
  /** Create the file, or replace the bytes of the one that is already this certificate's. */
  put(o: PutInput): Promise<CertificateFile>;
  /** Read the filed bytes back, to hash what is actually there. */
  read(o: { fileId: string }): Promise<Buffer | null>;
  /** Move a file that should not be trusted out of the way, and say why on the file. */
  quarantine(o: { fileId: string; reason: string; folderPath: string[]; certificateId: string; attemptToken: string; at: string }): Promise<void>;
};

// ── The real one ─────────────────────────────────────────────────────────────

const api = "https://www.googleapis.com/drive/v3";
const upload = "https://www.googleapis.com/upload/drive/v3";
const linkOf = (id: string, webViewLink?: string) => webViewLink ?? `https://drive.google.com/file/d/${id}/view`;

async function bearer(refreshToken: string): Promise<string> {
  const token = await googleAccessToken(refreshToken);
  if (!token) throw new Error("drive-auth: could not refresh Google token (reconnect needed)");
  return token;
}

async function folder(token: string, path: string[]): Promise<string | undefined> {
  let parent: string | undefined;
  for (const name of path) {
    const safe = name.replace(/'/g, "\\'");
    const q = [`name = '${safe}'`, "mimeType = 'application/vnd.google-apps.folder'", "trashed = false"];
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

const esc = (v: string) => v.replace(/'/g, "\\'");

export function googleCertificateDrive(refreshToken: string): CertificateDrive {
  return {
    async find({ certificateId, environment, folderPath }) {
      const token = await bearer(refreshToken);
      const parent = await folder(token, folderPath);
      const q = [
        `appProperties has { key='${MARKER.certificateId}' and value='${esc(certificateId)}' }`,
        `appProperties has { key='${MARKER.environment}' and value='${esc(environment)}' }`,
        "trashed = false",
      ];
      if (parent) q.push(`'${parent}' in parents`);
      const r = await fetch(`${api}/files?q=${encodeURIComponent(q.join(" and "))}&fields=files(id,name,webViewLink,appProperties)&spaces=drive`, { headers: { authorization: `Bearer ${token}` } });
      const j = (await r.json().catch(() => ({}))) as { files?: { id: string; name?: string; webViewLink?: string; appProperties?: Record<string, string> }[] };
      return (j.files ?? []).map((f) => ({ id: f.id, name: f.name ?? "", link: linkOf(f.id, f.webViewLink), attemptToken: f.appProperties?.[MARKER.attemptToken] ?? null }));
    },

    async put(o) {
      const token = await bearer(refreshToken);
      const parent = await folder(token, o.folderPath);
      const found = await this.find({ certificateId: o.certificateId, environment: o.environment, folderPath: o.folderPath });
      if (found.length > 1) throw new DuplicateCertificateFile(o.certificateId, found.map((f) => f.id));

      const appProperties = {
        [MARKER.certificateId]: o.certificateId,
        [MARKER.certificateNo]: o.certificateNo,
        [MARKER.payloadHash]: o.payloadHash,
        [MARKER.environment]: o.environment,
        [MARKER.attemptToken]: o.attemptToken,
      };

      if (found.length === 1) {
        // Same file, new bytes. The id and the link do not move, so a record written
        // before the last attempt failed still points at the right document.
        const ur = await fetch(`${upload}/files/${found[0].id}?uploadType=media&fields=id,name,webViewLink`, {
          method: "PATCH", headers: { authorization: `Bearer ${token}`, "content-type": "application/pdf" }, body: new Uint8Array(o.bytes),
        });
        const uj = (await ur.json().catch(() => ({}))) as { id?: string; name?: string; webViewLink?: string };
        if (!ur.ok || !uj.id) throw new Error(`drive-upload ${ur.status}`);
        await fetch(`${api}/files/${found[0].id}`, {
          method: "PATCH", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ name: o.name, appProperties }),
        }).catch(() => {});
        return { id: uj.id, name: uj.name ?? o.name, link: linkOf(uj.id, uj.webViewLink), attemptToken: o.attemptToken };
      }

      const meta = { name: o.name, parents: parent ? [parent] : undefined, appProperties };
      const boundary = `folkpaths-cert-${Math.random().toString(36).slice(2)}`;
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`, "utf8"),
        o.bytes,
        Buffer.from(`\r\n--${boundary}--`, "utf8"),
      ]);
      const r = await fetch(`${upload}/files?uploadType=multipart&fields=id,name,webViewLink`, {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": `multipart/related; boundary=${boundary}` }, body: new Uint8Array(body),
      });
      const j = (await r.json().catch(() => ({}))) as { id?: string; name?: string; webViewLink?: string };
      if (!r.ok || !j.id) throw new Error(`drive-upload ${r.status}`);
      return { id: j.id, name: j.name ?? o.name, link: linkOf(j.id, j.webViewLink), attemptToken: o.attemptToken };
    },

    async read({ fileId }) {
      const token = await bearer(refreshToken);
      const r = await fetch(`${api}/files/${fileId}?alt=media`, { headers: { authorization: `Bearer ${token}` } });
      if (!r.ok) return null;
      return Buffer.from(await r.arrayBuffer());
    },

    async quarantine({ fileId, reason, folderPath, certificateId, attemptToken, at }) {
      const token = await bearer(refreshToken);
      // Kept, not deleted. A file whose bytes did not match is evidence of something,
      // and the person who has to work out what needs it to still exist.
      const parent = await folder(token, [...folderPath, "Quarantine"]);
      const current = await fetch(`${api}/files/${fileId}?fields=parents,name`, { headers: { authorization: `Bearer ${token}` } });
      const cj = (await current.json().catch(() => ({}))) as { parents?: string[]; name?: string };
      const params = new URLSearchParams();
      if (parent) params.set("addParents", parent);
      if (cj.parents?.length) params.set("removeParents", cj.parents.join(","));
      await fetch(`${api}/files/${fileId}?${params.toString()}`, {
        method: "PATCH", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          name: `QUARANTINED ${cj.name ?? fileId}`,
          // The live marker goes, so a retry does not find this file and update it —
          // but what it WAS is written down. A file moved aside with nothing on it is a
          // mystery for whoever finds it; this one says which certificate and which
          // attempt put it there, and when.
          appProperties: {
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
  };
}
