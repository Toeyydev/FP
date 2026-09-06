"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { AuthHeader } from "@/components/AuthHeader";
import { OperatorNav } from "@/components/OperatorNav";
import { useLang } from "@/components/Providers";

type Account = { id: string; guideId: string | null; displayName: string; email: string; role: string; state: string; claimedAt: string | null; lineLinked?: boolean; lineId?: string | null; lineLinkCode?: string | null };
type ReqDoc = { id: string; kind: string; mimeType: string; size: number };
type Req = {
  id: string; name: string; nickname: string | null; phone: string | null; email: string;
  believedGuideId: string | null; createdAt: string;
  // Present only on applications from FolkOPS Mobile; the older web sign-up has none.
  fullNameThai?: string | null; fullNameEnglish?: string | null;
  licenseNo?: string | null; licenseExpiry?: string | null;
  preferredLanguage?: string | null; privacyVersion?: string | null; privacyConsentAt?: string | null;
  nationalIdMasked?: string; bankName?: string; bankAccountName?: string; bankAccountNoMasked?: string;
  // Flags only — the list never carries what the applicant declared.
  hasHealthInfo?: boolean; hasEmergencyInstructions?: boolean;
  documents?: ReqDoc[];
};

/** The full application, fetched one at a time from the gated detail endpoint.
 *  This is the only shape that ever holds decrypted health information. */
type ReqDetail = Req & {
  medicalConditionStatus?: string | null;
  medicalConditionDetails?: string | null;
  emergencyInstructions?: string | null;
};
type LineContact = { id: string; displayName: string | null; pictureUrl: string | null; suggestedGuideId: string | null };
type Data = { accounts: Account[]; requests: Req[]; isAdmin: boolean; lineOaUrl: string | null; lineLoginEnabled?: boolean; lineContacts?: LineContact[] };

function lineInvite(name: string, code: string, oaUrl: string | null, connectLink: string | null) {
  if (connectLink) {
    return `Hi ${name}! Connect Folkpaths to your LINE in one tap:\n${connectLink}\n\nOpen the link, tap "Allow", and you're done — you'll get job offers & job sheets on LINE. 🙏`;
  }
  return `Hi ${name}! To get Folkpaths job offers & job sheets on LINE:\n` +
    `1) Add our Folkpaths Official Account${oaUrl ? `: ${oaUrl}` : " (search our OA)"}\n` +
    `2) Send this code in the chat: ${code}\n` +
    `You'll get a "✓ Connected" reply. 🙏`;
}

/** A mobile application carries the extra fields; a legacy web sign-up does not. */
function hasApplication(rq: Req): boolean {
  return Boolean(rq.fullNameThai || rq.fullNameEnglish || rq.licenseNo || (rq.documents?.length ?? 0) > 0);
}

const DOC_LABEL: Record<string, string> = {
  ID_CARD: "ID card",
  GUIDE_LICENSE: "Guide licence",
  BANK_BOOK: "Bank book",
};

/** The application, shown only when the operator asks for it.
 *  Sensitive values arrive already masked from the API — the console never holds
 *  a full national ID or account number. The real documents open one at a time
 *  through the gated endpoint, which audits each view. */
function ApplicationDetail({ rq }: { rq: ReqDetail }) {
  const field = (label: string, value: React.ReactNode) => (
    <div style={{ display: "flex", gap: 8, fontSize: 12.5, padding: "2px 0" }}>
      <span style={{ color: "var(--ink-soft)", minWidth: 132 }}>{label}</span>
      <span>{value || "—"}</span>
    </div>
  );
  const expiry = rq.licenseExpiry ? new Date(rq.licenseExpiry) : null;
  const lapsed = expiry ? expiry.getTime() < Date.now() : false;
  return (
    <div style={{ padding: "10px 14px", background: "#f7f9f8", borderTop: "1px solid var(--line)" }}>
      <div style={{ display: "grid", gap: 18, gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
        <div>
          {field("Name (Thai)", rq.fullNameThai)}
          {field("Name (English)", rq.fullNameEnglish)}
          {field("National ID", rq.nationalIdMasked)}
          {field("Licence no.", rq.licenseNo)}
          {field("Licence expiry", expiry
            ? <span style={lapsed ? { color: "var(--danger)", fontWeight: 700 } : undefined}>
                {expiry.toISOString().slice(0, 10)}{lapsed ? " · expired" : ""}
              </span>
            : null)}
        </div>
        <div>
          {field("Bank", rq.bankName)}
          {field("Account name", rq.bankAccountName)}
          {field("Account no.", rq.bankAccountNoMasked)}
          {field("Language", rq.preferredLanguage === "th" ? "ไทย" : rq.preferredLanguage === "en" ? "English" : null)}
          {field("Privacy notice", rq.privacyConsentAt
            ? `${rq.privacyVersion ?? "accepted"} · ${new Date(rq.privacyConsentAt).toISOString().slice(0, 10)}`
            : null)}
        </div>
      </div>
      <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--line)" }}>
        <div style={{ fontSize: 11.5, color: "var(--ink-soft)", textTransform: "uppercase", letterSpacing: ".06em", fontWeight: 700, marginBottom: 4 }}>
          Health &amp; emergency · ข้อมูลสุขภาพและกรณีฉุกเฉิน
        </div>
        {rq.medicalConditionStatus === "HAS_CONDITION" ? (
          <>
            <div style={{ fontSize: 13, fontWeight: 700, color: "var(--danger)" }}>
              Medical condition disclosed · แจ้งโรคประจำตัว
            </div>
            <div style={{ fontSize: 12.5, marginTop: 2, whiteSpace: "pre-wrap" }}>{rq.medicalConditionDetails || "—"}</div>
          </>
        ) : rq.medicalConditionStatus === "NONE" ? (
          <div style={{ fontSize: 13 }}>No known medical conditions · ไม่มีโรคประจำตัว</div>
        ) : (
          <div style={{ fontSize: 12.5, color: "var(--ink-soft)" }}>not provided · ไม่ได้ระบุ</div>
        )}
        {rq.emergencyInstructions && (
          <div style={{ marginTop: 6 }}>
            <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>Emergency instructions · คำแนะนำกรณีฉุกเฉิน</div>
            <div style={{ fontSize: 12.5, whiteSpace: "pre-wrap" }}>{rq.emergencyInstructions}</div>
          </div>
        )}
      </div>

      <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ fontSize: 11.5, color: "var(--ink-soft)", textTransform: "uppercase", letterSpacing: ".06em", fontWeight: 700 }}>Documents</span>
        {(rq.documents ?? []).length === 0 ? (
          <span style={{ fontSize: 12.5, color: "var(--ink-soft)" }}>none attached</span>
        ) : (rq.documents ?? []).map((d) => (
          <a key={d.id} className="btn sm" href={`/api/admin/request-document/${d.id}`} target="_blank" rel="noreferrer">
            {DOC_LABEL[d.kind] ?? d.kind} · {Math.round(d.size / 1024)} KB
          </a>
        ))}
      </div>
    </div>
  );
}

async function post(body: unknown) {
  const r = await fetch("/api/admin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { ok: r.ok, data: await r.json().catch(() => ({})) };
}

export default function AdminConsole() {
  const { t } = useLang();
  const [data, setData] = useState<Data | null>(null);
  const [tab, setTab] = useState<"invites" | "requests" | "line">("invites");
  const [flash, setFlash] = useState<{ msg: string; copy?: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [showOp, setShowOp] = useState(false);
  const [opEmail, setOpEmail] = useState("");
  const [opRole, setOpRole] = useState<"OPERATOR" | "ACCOUNTANT">("OPERATOR"); const [opName, setOpName] = useState("");
  const [linkSel, setLinkSel] = useState<Record<string, string>>({}); // requestId -> existing guide userId to link
  const [openReq, setOpenReq] = useState<Record<string, boolean>>({}); // requestId -> application details shown
  const [reqDetail, setReqDetail] = useState<Record<string, ReqDetail>>({}); // fetched on open, never preloaded

  // Health data is fetched only when an operator actually opens a record, so it
  // is never sitting in the page for every pending applicant at once.
  const openDetail = useCallback(async (id: string) => {
    setOpenReq((m) => ({ ...m, [id]: !m[id] }));
    if (reqDetail[id]) return;
    const r = await fetch(`/api/admin/request-detail/${id}`, { cache: "no-store" });
    if (!r.ok) return;
    const d = (await r.json()) as ReqDetail;
    setReqDetail((m) => ({ ...m, [id]: d }));
  }, [reqDetail]);
  const [lineCodes, setLineCodes] = useState<Record<string, string>>({}); // userId -> freshly generated code
  const [copiedId, setCopiedId] = useState("");
  const [contactSel, setContactSel] = useState<Record<string, string>>({}); // contactId -> chosen guide userId
  const [busyContact, setBusyContact] = useState("");
  const [backfilling, setBackfilling] = useState(false);
  const [reminding, setReminding] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch("/api/admin", { cache: "no-store" });
    if (r.ok) setData(await r.json());
  }, []);
  useEffect(() => { load(); }, [load]);

  async function act(body: unknown, who?: string) {
    const r = await post(body);
    if (r.ok && r.data.code) { setFlash({ msg: `Invite code for ${who ?? ""}: ${r.data.code} — relay out-of-band (single use)`, copy: r.data.code }); setCopied(false); }
    else if (r.ok && r.data.guideId) { setFlash({ msg: `Approved ${who ?? ""} — assigned ${r.data.guideId} and activated.` }); }
    else if (!r.ok) { setFlash({ msg: `Error: ${(r.data as { error?: string }).error ?? "failed"}` }); }
    await load();
  }

  if (!data) return <div className="wrap"><AuthHeader backHref="/" /><section className="panel"><div className="op-empty">…</div></section></div>;

  const guides = data.accounts.filter((a) => a.role === "GUIDE");
  const ops = data.accounts.filter((a) => a.role !== "GUIDE");

  const badge = (s: string) => <span className={`badge ${s.toLowerCase()}`}>{s}</span>;

  const acctRow = (a: Account) => (
    <tr key={a.id}>
      <td>{a.guideId && <span className="gid">{a.guideId}</span>}{a.displayName}</td>
      <td style={{ color: "var(--ink-soft)" }}>{a.email}</td>
      <td>{data.isAdmin && a.role !== "ADMIN"
        ? <select className="search" style={{ fontSize: 12, padding: "2px 6px", width: 130 }} value={a.role} onChange={(e) => act({ action: "setRole", userId: a.id, role: e.target.value }, `${a.displayName} → ${e.target.value}`)} title="Change this account's role">
            <option value="GUIDE">GUIDE</option>
            <option value="OPERATOR">OPERATOR</option>
            <option value="ACCOUNTANT">ACCOUNTANT</option>
          </select>
        : a.role}</td>
      <td>{badge(a.state)}</td>
      <td style={{ textAlign: "right" }}>
        {a.role === "GUIDE" && <a className="btn sm" href={`/profile?userId=${a.id}`}>{t("details")}</a>}{" "}
        {a.state !== "ACTIVE" && a.state !== "SUSPENDED" && (
          <button className="btn sm" onClick={() => act({ action: "issueInvite", userId: a.id }, `${a.guideId ?? a.role} · ${a.displayName}`)}>
            {a.state === "INVITED" ? t("reissue") : t("issueInvite")}
          </button>
        )}{" "}
        {a.state === "ACTIVE" && <button className="btn sm danger" onClick={() => act({ action: "setSuspended", userId: a.id, suspend: true })}>{t("suspend")}</button>}
        {a.state === "SUSPENDED" && <button className="btn sm" onClick={() => act({ action: "setSuspended", userId: a.id, suspend: false })}>{t("reactivate")}</button>}
        {a.role === "GUIDE" && (
          <>{" "}<button className="btn sm danger" onClick={() => {
            if (confirm(`Remove ${a.guideId ?? ""} ${a.displayName}?\n\nThis permanently deletes the account and all its availability, assignments and documents. This cannot be undone.`)) act({ action: "deleteGuide", userId: a.id });
          }}>Remove</button></>
        )}
      </td>
    </tr>
  );

  async function clearAllGuides() {
    const n = guides.length;
    if (n === 0) { setFlash({ msg: "No guides to remove." }); return; }
    if (!confirm(`Remove ALL ${n} guide accounts?\n\nThis permanently deletes every guide and all their availability, assignments and documents. Operators and tours are kept. The Guide Database stays — guides re-register and get fresh ids (G-001…) in sign-up order.`)) return;
    if (!confirm(`Final check: permanently remove ${n} guide(s)? This cannot be undone.`)) return;
    const r = await post({ action: "clearGuides" });
    if (r.ok) setFlash({ msg: `Removed ${r.data.count} guide(s). Roster is now blank — guides will self-register and be assigned G-001, G-002, … in sign-up order.` });
    else setFlash({ msg: `Error: ${(r.data as { error?: string }).error ?? "failed"}` });
    await load();
  }

  return (
    <div className="wrap">
      <AuthHeader home={false} />
      <div className="op-layout">
        <OperatorNav active="accounts" />
        <div className="op-main">
      <div id="appBar">
        <div className="subtabs">
          <button className={`subtab ${tab === "invites" ? "active" : ""}`} onClick={() => setTab("invites")}>{t("tabInvites")}</button>
          <button className={`subtab ${tab === "requests" ? "active" : ""}`} onClick={() => setTab("requests")}>{t("tabRequests")} ({data.requests.length})</button>
          <button className={`subtab ${tab === "line" ? "active" : ""}`} onClick={() => setTab("line")}>LINE ({guides.filter((g) => g.lineLinked).length}/{guides.length})</button>
        </div>
      </div>

      {flash && (
        <div className="codeflash">
          <span>{flash.msg}</span>
          {flash.copy && <button className="btn sm" onClick={() => { navigator.clipboard?.writeText(flash.copy!); setCopied(true); }}>{copied ? t("copied") : t("copyCode")}</button>}
        </div>
      )}

      <section className="panel">
        <div className="panel-head"><h2>{t("accountsTitle")}</h2>
          {tab === "invites" && data.isAdmin && (
            <div className="head-tools">
              <button className="btn sm" onClick={() => setShowOp((s) => !s)}>{t("inviteOperatorBtn")}</button>
              {guides.length > 0 && <button className="btn sm danger" onClick={clearAllGuides}>Remove all guides ({guides.length})</button>}
            </div>
          )}
        </div>

        {tab === "invites" ? (
          <div style={{ padding: 14 }}>
            {showOp && data.isAdmin && (
              <div className="op-toolbar" style={{ borderRadius: 12, border: "1.5px solid var(--line)", marginBottom: 12 }}>
                <input className="search" placeholder="operator@email" value={opEmail} onChange={(e) => setOpEmail(e.target.value)} />
                <input className="search" placeholder="Display name" value={opName} onChange={(e) => setOpName(e.target.value)} />
                <select className="search" style={{ flex: "none", width: 160 }} value={opRole} onChange={(e) => setOpRole(e.target.value as "OPERATOR" | "ACCOUNTANT")} title="Operator = full ops; Accountant = finance read-only + PEAK refs">
                  <option value="OPERATOR">Operator</option>
                  <option value="ACCOUNTANT">Accountant</option>
                </select>
                <button className="btn sm primary" onClick={async () => { await act({ action: "inviteOperator", email: opEmail, displayName: opName, role: opRole }, opEmail); setOpEmail(""); setOpName(""); setOpRole("OPERATOR"); setShowOp(false); }}>Send invite</button>
              </div>
            )}
            <table className="acct-table">
              <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>State</th><th /></tr></thead>
              <tbody>{ops.map(acctRow)}{guides.map(acctRow)}</tbody>
            </table>
          </div>
        ) : tab === "requests" ? (
          <div style={{ padding: 14 }}>
            {data.requests.length === 0 ? <div className="op-empty">{t("noRequests")}</div> : (
              <table className="acct-table">
                <thead><tr><th>Name</th><th>Nickname</th><th>Phone</th><th>Email</th><th>Link to guide</th><th /></tr></thead>
                <tbody>
                  {data.requests.map((rq) => {
                    // Existing (not-yet-active) guide records the operator can link this sign-up to.
                    const unclaimed = guides.filter((g) => g.state !== "ACTIVE");
                    const autoMatch = unclaimed.find((g) => g.email.toLowerCase() === rq.email.toLowerCase());
                    const sel = linkSel[rq.id] ?? "";
                    return (
                      <Fragment key={rq.id}>
                      <tr>
                        <td>{rq.name}</td>
                        <td>{rq.nickname ?? "—"}</td>
                        <td style={{ color: "var(--ink-soft)" }}>{rq.phone ?? "—"}</td>
                        <td style={{ color: "var(--ink-soft)" }}>{rq.email}</td>
                        <td>
                          <select className="search" style={{ minWidth: 170 }} value={sel} onChange={(e) => setLinkSel((m) => ({ ...m, [rq.id]: e.target.value }))}>
                            <option value="">{autoMatch ? `Auto → ${autoMatch.guideId} (${autoMatch.displayName})` : "Auto / new ID"}</option>
                            {unclaimed.map((g) => <option key={g.id} value={g.id}>{g.guideId} · {g.displayName}</option>)}
                          </select>
                        </td>
                        <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                          {hasApplication(rq) && (
                            <>
                              <button className="btn sm ghost" onClick={() => openDetail(rq.id)}>
                                {openReq[rq.id] ? "Hide details" : "Details"}
                              </button>{" "}
                            </>
                          )}
                          <button className="btn sm primary" onClick={() => act({ action: "approveRequest", requestId: rq.id, ...(sel ? { guideUserId: sel } : {}) }, rq.name)}>{t("approve")}</button>{" "}
                          <button className="btn sm danger" onClick={() => act({ action: "rejectRequest", requestId: rq.id })}>{t("reject")}</button>
                        </td>
                      </tr>
                      {openReq[rq.id] && (
                        <tr>
                          <td colSpan={6} style={{ padding: 0 }}>
                            {reqDetail[rq.id]
                              ? <ApplicationDetail rq={reqDetail[rq.id]} />
                              : <div className="op-empty" style={{ padding: 12 }}>Loading application…</div>}
                          </td>
                        </tr>
                      )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        ) : (
          <div style={{ padding: 14 }}>
            <div className="fieldhelp" style={{ marginBottom: 10 }}>
              Generate a guide&apos;s one-time code, then send them the invite. They add the Folkpaths LINE Official Account and send the code to connect. (Sending offers/sheets over LINE also needs <code>LINE_CHANNEL_ACCESS_TOKEN</code> set.)
            </div>

            {/* Hybrid follower-match: people who already added the OA, ready to connect in one click. */}
            {(() => {
              const contacts = data.lineContacts ?? [];
              const unlinkedGuides = guides.filter((g) => !g.lineLinked);
              return (
                <div style={{ marginBottom: 18, border: "1.5px solid var(--line)", borderRadius: 12, padding: 12, background: "var(--grey-bg)" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 8 }}>
                    <b style={{ fontSize: 14 }}>Added the OA — connect in one tap ({contacts.length})</b>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button className="btn sm" disabled={reminding || unlinkedGuides.length === 0} onClick={async () => {
                        setReminding(true);
                        const r = await post({ action: "lineRemindUnlinked" });
                        setReminding(false);
                        setFlash({ msg: r.ok ? `Reminded ${r.data?.count ?? 0} unlinked guide(s) — in-app + push${r.data?.emailed ? ` + ${r.data.emailed} email(s)` : ""}.` : "Couldn't send reminders." });
                      }}>{reminding ? "Sending…" : `Remind unlinked (${unlinkedGuides.length})`}</button>
                      <button className="btn sm" disabled={backfilling} onClick={async () => {
                        setBackfilling(true);
                        const r = await post({ action: "lineBackfill" });
                        setBackfilling(false);
                        setFlash({ msg: r.data?.forbidden
                          ? "Backfill needs a Verified/Premium LINE OA. New followers are still captured automatically."
                          : `Backfill done — checked ${r.data?.added ?? 0} follower(s).` });
                        await load();
                      }}>{backfilling ? "Scanning…" : "Backfill followers"}</button>
                    </div>
                  </div>
                  <div className="fieldhelp" style={{ marginBottom: 10 }}>
                    Anyone who adds the Folkpaths OA (or messages it) shows up here. Pick the matching guide — we pre-select our best guess — and tap Connect. No code needed on their side.
                  </div>
                  {contacts.length === 0 ? (
                    <div className="op-empty" style={{ fontSize: 13 }}>No unmatched followers. New ones appear here automatically.</div>
                  ) : (
                    <table className="acct-table">
                      <thead><tr><th>On LINE</th><th>Connect to guide</th><th /></tr></thead>
                      <tbody>
                        {contacts.map((c) => {
                          const sel = contactSel[c.id] ?? c.suggestedGuideId ?? "";
                          return (
                            <tr key={c.id}>
                              <td style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                {c.pictureUrl
                                  ? <img src={c.pictureUrl} alt="" width={28} height={28} style={{ borderRadius: "50%", objectFit: "cover" }} />
                                  : <span style={{ width: 28, height: 28, borderRadius: "50%", background: "var(--line)", display: "inline-block" }} />}
                                <span>{c.displayName || <span style={{ color: "var(--ink-soft)" }}>Unknown</span>}</span>
                              </td>
                              <td>
                                <select value={sel} onChange={(e) => setContactSel((m) => ({ ...m, [c.id]: e.target.value }))} style={{ maxWidth: 220 }}>
                                  <option value="">— pick a guide —</option>
                                  {unlinkedGuides.map((g) => (
                                    <option key={g.id} value={g.id}>{g.guideId ? `${g.guideId} · ` : ""}{g.displayName}{g.id === c.suggestedGuideId ? " (suggested)" : ""}</option>
                                  ))}
                                </select>
                              </td>
                              <td style={{ textAlign: "right" }}>
                                <button className="btn sm primary" disabled={!sel || busyContact === c.id} onClick={async () => {
                                  setBusyContact(c.id);
                                  const r = await post({ action: "lineLinkContact", contactId: c.id, guideUserId: sel });
                                  setBusyContact("");
                                  if (!r.ok) setFlash({ msg: `Couldn't connect: ${(r.data as { error?: string }).error ?? "failed"}` });
                                  await load();
                                }}>{busyContact === c.id ? "…" : "Connect"}</button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              );
            })()}

            {guides.length === 0 ? <div className="op-empty">{t("noGuides")}</div> : (
              <table className="acct-table">
                <thead><tr><th>Guide</th><th>LINE ID (ref)</th><th>Status</th><th /></tr></thead>
                <tbody>
                  {guides.map((g) => {
                    const code = lineCodes[g.id] ?? g.lineLinkCode ?? "";
                    return (
                      <tr key={g.id}>
                        <td>{g.guideId && <span className="gid">{g.guideId}</span>}{g.displayName}</td>
                        <td style={{ color: "var(--ink-soft)" }}>{g.lineId || "—"}</td>
                        <td>{g.lineLinked
                          ? <span className="badge active">✓ Linked</span>
                          : <span className="badge invited">Not linked</span>}</td>
                        <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                          {g.lineLinked ? <span style={{ color: "var(--ink-soft)", fontSize: 12 }}>connected</span> : (
                            <>
                              {code && <code style={{ marginRight: 8, fontWeight: 700 }}>{code}</code>}
                              <button className="btn sm" onClick={async () => {
                                const r = await post({ action: "lineCode", userId: g.id });
                                if (r.ok && r.data.code) setLineCodes((m) => ({ ...m, [g.id]: r.data.code }));
                              }}>{code ? "New code" : "Generate code"}</button>{" "}
                              {code && (
                                <button className="btn sm primary" onClick={() => {
                                  navigator.clipboard?.writeText(lineInvite(g.displayName, code, data.lineOaUrl, data.lineLoginEnabled && code ? `${window.location.origin}/api/line/login/start?token=${code}` : null));
                                  setCopiedId(g.id);
                                }}>{copiedId === g.id ? t("copied") : "Copy invite"}</button>
                              )}
                            </>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}
      </section>
        </div>
      </div>
    </div>
  );
}
