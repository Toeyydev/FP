"use client";

import { useCallback, useEffect, useState } from "react";
import { AuthHeader } from "@/components/AuthHeader";
import { useLang } from "@/components/Providers";

type Account = { id: string; guideId: string | null; displayName: string; email: string; role: string; state: string; claimedAt: string | null };
type Req = { id: string; name: string; nickname: string | null; email: string; believedGuideId: string | null; createdAt: string };
type Data = { accounts: Account[]; requests: Req[]; isAdmin: boolean };

async function post(body: unknown) {
  const r = await fetch("/api/admin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { ok: r.ok, data: await r.json().catch(() => ({})) };
}

export default function AdminConsole() {
  const { t } = useLang();
  const [data, setData] = useState<Data | null>(null);
  const [tab, setTab] = useState<"invites" | "requests">("invites");
  const [flash, setFlash] = useState<{ msg: string; copy?: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [showOp, setShowOp] = useState(false);
  const [opEmail, setOpEmail] = useState(""); const [opName, setOpName] = useState("");

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
      <td>{a.role}</td>
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
                <button className="btn sm primary" onClick={async () => { await act({ action: "inviteOperator", email: opEmail, displayName: opName }, opEmail); setOpEmail(""); setOpName(""); setShowOp(false); }}>{t("inviteOperatorBtn")}</button>
              </div>
            )}
            <table className="acct-table">
              <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>State</th><th /></tr></thead>
              <tbody>{ops.map(acctRow)}{guides.map(acctRow)}</tbody>
            </table>
          </div>
        ) : (
          <div style={{ padding: 14 }}>
            {data.requests.length === 0 ? <div className="op-empty">{t("noRequests")}</div> : (
              <table className="acct-table">
                <thead><tr><th>Name</th><th>Nickname</th><th>Email</th><th /></tr></thead>
                <tbody>
                  {data.requests.map((rq) => {
                    return (
                      <tr key={rq.id}>
                        <td>{rq.name}</td>
                        <td>{rq.nickname ?? "—"}</td>
                        <td style={{ color: "var(--ink-soft)" }}>{rq.email}</td>
                        <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                          <button className="btn sm primary" onClick={() => act({ action: "approveRequest", requestId: rq.id }, rq.name)}>{t("approve")}</button>{" "}
                          <button className="btn sm danger" onClick={() => act({ action: "rejectRequest", requestId: rq.id })}>{t("reject")}</button>
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
