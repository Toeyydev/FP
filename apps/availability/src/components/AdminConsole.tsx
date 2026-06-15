"use client";

import { useCallback, useEffect, useState } from "react";
import { AuthHeader } from "@/components/AuthHeader";
import { useLang } from "@/components/Providers";

type Account = { id: string; guideId: string | null; displayName: string; email: string; role: string; state: string; claimedAt: string | null; lineLinked?: boolean; lineId?: string | null; lineLinkCode?: string | null };
type Req = { id: string; name: string; nickname: string | null; phone: string | null; email: string; believedGuideId: string | null; createdAt: string };
type Data = { accounts: Account[]; requests: Req[]; isAdmin: boolean; lineOaUrl: string | null };

function lineInvite(name: string, code: string, oaUrl: string | null) {
  return `Hi ${name}! To get Folkpaths job offers & job sheets on LINE:\n` +
    `1) Add our Folkpaths Official Account${oaUrl ? `: ${oaUrl}` : " (search our OA)"}\n` +
    `2) Send this code in the chat: ${code}\n` +
    `You'll get a "✓ Connected" reply. 🙏`;
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
  const [lineCodes, setLineCodes] = useState<Record<string, string>>({}); // userId -> freshly generated code
  const [copiedId, setCopiedId] = useState("");

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
      <AuthHeader backHref="/" />
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
                      <tr key={rq.id}>
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
                          <button className="btn sm primary" onClick={() => act({ action: "approveRequest", requestId: rq.id, ...(sel ? { guideUserId: sel } : {}) }, rq.name)}>{t("approve")}</button>{" "}
                          <button className="btn sm danger" onClick={() => act({ action: "rejectRequest", requestId: rq.id })}>{t("reject")}</button>
                        </td>
                      </tr>
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
                                  navigator.clipboard?.writeText(lineInvite(g.displayName, code, data.lineOaUrl));
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
  );
}
