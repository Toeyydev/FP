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
  const [flash, setFlash] = useState<{ who: string; code: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [showOp, setShowOp] = useState(false);
  const [opEmail, setOpEmail] = useState(""); const [opName, setOpName] = useState("");
  const [link, setLink] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const r = await fetch("/api/admin", { cache: "no-store" });
    if (r.ok) setData(await r.json());
  }, []);
  useEffect(() => { load(); }, [load]);

  async function act(body: unknown, who?: string) {
    const r = await post(body);
    if (r.ok && r.data.code) { setFlash({ who: who ?? "", code: r.data.code }); setCopied(false); }
    await load();
  }

  if (!data) return <div className="wrap"><AuthHeader backHref="/" /><section className="panel"><div className="op-empty">…</div></section></div>;

  const guides = data.accounts.filter((a) => a.role === "GUIDE");
  const ops = data.accounts.filter((a) => a.role !== "GUIDE");
  const linkTargets = guides.filter((g) => g.state !== "ACTIVE");

  const badge = (s: string) => <span className={`badge ${s.toLowerCase()}`}>{s}</span>;

  const acctRow = (a: Account) => (
    <tr key={a.id}>
      <td>{a.guideId && <span className="gid">{a.guideId}</span>}{a.displayName}</td>
      <td style={{ color: "var(--ink-soft)" }}>{a.email}</td>
      <td>{a.role}</td>
      <td>{badge(a.state)}</td>
      <td style={{ textAlign: "right" }}>
        {a.state !== "ACTIVE" && a.state !== "SUSPENDED" && (
          <button className="btn sm" onClick={() => act({ action: "issueInvite", userId: a.id }, `${a.guideId ?? a.role} · ${a.displayName}`)}>
            {a.state === "INVITED" ? t("reissue") : t("issueInvite")}
          </button>
        )}{" "}
        {a.state === "ACTIVE" && <button className="btn sm danger" onClick={() => act({ action: "setSuspended", userId: a.id, suspend: true })}>{t("suspend")}</button>}
        {a.state === "SUSPENDED" && <button className="btn sm" onClick={() => act({ action: "setSuspended", userId: a.id, suspend: false })}>{t("reactivate")}</button>}
      </td>
    </tr>
  );

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
          <span>{flash.who}: <code>{flash.code}</code> <span style={{ opacity: .7 }}>(relay out-of-band — single use)</span></span>
          <button className="btn sm" onClick={() => { navigator.clipboard?.writeText(flash.code); setCopied(true); }}>{copied ? t("copied") : t("copyCode")}</button>
        </div>
      )}

      <section className="panel">
        <div className="panel-head"><h2>{t("accountsTitle")}</h2>
          {tab === "invites" && data.isAdmin && (
            <div className="head-tools"><button className="btn sm" onClick={() => setShowOp((s) => !s)}>{t("inviteOperatorBtn")}</button></div>
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
                <thead><tr><th>Name</th><th>Nickname</th><th>Email</th><th>Link to guide</th><th /></tr></thead>
                <tbody>
                  {data.requests.map((rq) => {
                    const auto = linkTargets.find((g) => g.email.toLowerCase() === rq.email.toLowerCase());
                    const sel = link[rq.id] ?? auto?.id ?? "";
                    return (
                      <tr key={rq.id}>
                        <td>{rq.name}</td>
                        <td>{rq.nickname ?? "—"}</td>
                        <td style={{ color: "var(--ink-soft)" }}>{rq.email}</td>
                        <td>
                          <select value={sel} onChange={(e) => setLink({ ...link, [rq.id]: e.target.value })} style={{ padding: "6px 8px", borderRadius: 8, border: `1.5px solid ${auto && sel === auto.id ? "var(--green-line)" : "var(--line-strong)"}`, background: "var(--paper)" }}>
                            <option value="">— select guide —</option>
                            {linkTargets.map((g) => <option key={g.id} value={g.id}>{g.guideId} · {g.displayName}</option>)}
                          </select>
                          {auto && sel === auto.id && <div className="fieldhelp" style={{ color: "var(--green)" }}>✓ auto-matched by email</div>}
                        </td>
                        <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                          <button className="btn sm primary" disabled={!sel} onClick={() => act({ action: "approveRequest", requestId: rq.id, guideUserId: sel }, `${rq.name}`)}>{t("approve")}</button>{" "}
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
