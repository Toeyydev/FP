"use client";
// The operational side of a job's company advances (Phase 1D): what an operator or admin may
// DO, next to the ledger table the job sheet prints. Guides and accountants get no controls
// here — the accountant approves refunds from components/RefundReview on Payments → Advances.
//
// Every figure here comes from the server — advanceSummary per advance and returnSummary per
// return (lib/advances) — never added up again on the client. Every action calls its route,
// and the server decides: these controls only appear for the roles the routes allow, and are
// disabled while ADVANCE_WRITES_FROZEN is on, but a hidden button is never the security.
import { useMemo, useState } from "react";

export type OpsAdvance = {
  id: string; advanceNo: string; amount: number; outstanding: number; status: string | null; problems?: string[];
  allowedCategories?: string[]; used?: number; returned?: number; deducted?: number; drift?: number; purpose?: string | null;
  advanceDate?: string; peakSync?: { status: string; documentNo: string | null } | null;
  peakLink?: string | null;
  settlements?: { entryId: string; amount: number; jobNo: string | null; onThisJob: boolean; peakSync: { status: string; documentNo: string | null } | null; peakLink: string | null }[];
};
type PeakState = { status: string; documentNo: string | null } | null | undefined;
/** One movement's PEAK state, in words: a linked document, what the sender did, or nothing yet. */
const peakWords = (link: string | null | undefined, sync: PeakState) =>
  link ? `linked ${link}` : sync?.status === "POSTED" ? `posted ${sync.documentNo ?? ""}`.trim() : sync ? `not in PEAK yet (${sync.status.toLowerCase()})` : "not in PEAK yet";
export type OpsLine = { index: number; identity: string; description: string; amount: number; category: string | null; advanceId: string | null; settled: boolean; settledBy: string | null };
export type OpsRefund = {
  id: string; refundNo: string; amount: number; status: string; reason: string; recordedById: string;
  approvedById: string | null; paidAt: string | Date | null; bankRef: string | null; slipUrl: string | null; voidReason: string | null;
};
export type OpsReturn = {
  id: string; receiptNo: string; amount: number; status: string; receivedDate: string; txRef?: string | null; bankRef?: string | null; slipUrl: string | null;
  allocated: number; unallocated: number; refunded?: number; available?: number; problems?: string[];
  advanceId?: string | null; jobSheetId?: string | null; refunds?: OpsRefund[]; peakSync?: { status: string; documentNo: string | null } | null;
  peakLink?: string | null;
};
export type OpsData = {
  advances: OpsAdvance[]; returns: OpsReturn[]; lines?: OpsLine[]; jobSheetId?: string | null; sheetVersion?: string | null; frozen: boolean;
};

const CATEGORIES = [
  { key: "entrance", label: "Entrance tickets" },
  { key: "meal", label: "Meals" },
  { key: "transport", label: "Transport" },
  { key: "other", label: "Other (needs a reason)" },
] as const;
const MIN_OTHER_REASON = 8;
const thb = (n: number) => `฿${(n ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const STATUS: Record<string, string> = { OPEN: "Open", IN_USE: "In use", RETURN_DUE: "Return due", SETTLED: "Settled", VOID: "Void" };
const RET_STATUS: Record<string, string> = { CLAIMED: "Waiting to be checked", VERIFIED: "Confirmed in the bank", REJECTED: "Rejected", VOIDED: "Voided" };
const REF_STATUS: Record<string, string> = { RECORDED: "Recorded", APPROVED: "Approved", PAID: "Paid", VOIDED: "Voided" };

type Post = (url: string, body: unknown) => Promise<{ ok: boolean; status: number; data: Record<string, unknown> }>;
const post: Post = async (url, body) => {
  const r = await fetch(url, body instanceof FormData ? { method: "POST", body } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { ok: r.ok, status: r.status, data: (await r.json().catch(() => ({}))) as Record<string, unknown> };
};
/** A refusal in the server's own words — never a raw error. */
export const explain = (status: number, d: Record<string, unknown>) =>
  status === 503 ? "Advance writes are currently frozen — nothing was changed."
  : status === 403 ? "Your role cannot do that."
  : (Array.isArray(d.reasons) && d.reasons.length ? (d.reasons as string[]).join(" · ") : String(d.detail ?? d.error ?? `Not done (HTTP ${status})`));

export default function AdvanceOperations(props: {
  data: OpsData; guideId: string; role: string | null; userId: string | null; approved: boolean; saved: boolean;
  onChanged: () => Promise<void>; setMsg: (m: string) => void;
}) {
  const { data, role, userId, approved, saved, onChanged, setMsg } = props;
  const ops = role === "OPERATOR" || role === "ADMIN";
  // The accountant approves refunds on Payments → Advances (components/RefundReview), with the
  // evidence gathered there — never from the operational job sheet (owner policy: least privilege).
  const accountant = false;
  const frozen = data.frozen;
  const [busy, setBusy] = useState(false);
  const run = async (label: string, url: string, body: unknown) => {
    setBusy(true); setMsg("");
    try {
      const r = await post(url, body);
      if (!r.ok) { setMsg(explain(r.status, r.data)); await onChanged(); return null; }
      setMsg(r.data.replayed ? `${label} — already done; the earlier result was kept ✓` : `${label} ✓`);
      await onChanged();
      return r.data;
    } finally { setBusy(false); }
  };
  const live = data.advances.filter((a) => a.status !== "VOID");
  const lines = data.lines ?? [];
  const awaiting = lines.filter((l) => !l.advanceId && !l.settled);
  const allSettled = live.length > 0 && live.every((a) => a.outstanding === 0);

  return (
    <div className="no-print js-advance-ops" style={{ marginTop: 10, display: "grid", gap: 10 }}>
      {frozen && <div className="js-advance-frozen" role="status" style={{ padding: "8px 12px", borderRadius: 8, background: "var(--warn-bg,#fbf4e4)", border: "1px solid var(--warn-line,#e2c27a)", fontSize: 12.5 }}>
        <b>Advance writes are currently frozen.</b> Everything below is read-only until the advance workflow is switched on.
      </div>}
      {data.advances.map((a) => (
        <AdvanceCard key={a.id} a={a} lines={lines.filter((l) => l.advanceId === a.id)} data={data} ops={ops} frozen={frozen} busy={busy} approved={approved} saved={saved} run={run} />
      ))}
      {awaiting.length > 0 && (
        <div className="js-advance-awaiting" style={{ padding: "8px 12px", border: "1px dashed var(--line)", borderRadius: 8, fontSize: 12.5 }}>
          <b>Marked Company Advance, not settleable yet</b> — confirm the payer and link each row to an advance on this job:
          <ul style={{ margin: "4px 0 0 18px" }}>{awaiting.map((l) => <li key={l.index}>{l.description || `Row ${l.index + 1}`} · {l.category ?? "no category"} · {thb(l.amount)}</li>)}</ul>
        </div>
      )}
      {data.returns.length > 0 && <div style={{ fontWeight: 700, fontSize: 13 }}>Returns for this job <small style={{ fontWeight: 500, color: "var(--ink-soft)" }}>เงินทดรองที่ไกด์โอนคืน</small></div>}
      {data.returns.map((r) => (
        <ReturnCard key={r.id} r={r} guideId={props.guideId} jobAdvances={live} jobSheetId={data.jobSheetId ?? null} ops={ops} accountant={accountant} userId={userId} frozen={frozen} busy={busy} run={run}
          excess={r.status === "VERIFIED" && (r.unallocated ?? 0) > 0 && allSettled} />
      ))}
    </div>
  );
}

function AdvanceCard({ a, lines, data, ops, frozen, busy, approved, saved, run }: {
  a: OpsAdvance; lines: OpsLine[]; data: OpsData; ops: boolean; frozen: boolean; busy: boolean; approved: boolean; saved: boolean;
  run: (label: string, url: string, body: unknown) => Promise<Record<string, unknown> | null>;
}) {
  const [editing, setEditing] = useState(false);
  const [cats, setCats] = useState<string[]>(a.allowedCategories ?? ["entrance"]);
  const [reason, setReason] = useState("");
  const [picked, setPicked] = useState<number[]>([]);
  const settleable = lines.filter((l) => !l.settled);
  const chosen = settleable.filter((l) => picked.includes(l.index));
  const preview = chosen.reduce((s, l) => s + l.amount, 0);
  const otherTurnedOn = cats.includes("other") && !(a.allowedCategories ?? []).includes("other");
  const problem = a.status === null || (a.drift ?? 0) !== 0 || (a.problems?.length ?? 0) > 0;
  const canWrite = ops && !frozen && a.status !== "VOID";

  return (
    <div className="js-adv-card" data-advance={a.advanceNo} style={{ border: "1px solid var(--line)", borderRadius: 10, padding: "10px 12px", background: "var(--surface,#fff)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8, alignItems: "baseline" }}>
        <div><span className="mono" style={{ fontWeight: 700 }}>{a.advanceNo}</span> <span className={`badge${a.status === "SETTLED" ? " active" : a.status === "VOID" ? " muted" : " pending"}`}>{a.status ? STATUS[a.status] ?? a.status : "Needs review"}</span>
          {a.purpose ? <span style={{ fontSize: 11.5, color: "var(--ink-soft)" }}> · {a.purpose}</span> : null}
</div>
        <div className="js-adv-figures" style={{ fontSize: 12.5, fontVariantNumeric: "tabular-nums" }}>
          Issued {thb(a.amount)} · Used {thb(a.used ?? 0)} · Returned {thb(a.returned ?? 0)}{(a.deducted ?? 0) > 0 ? ` · Deducted ${thb(a.deducted ?? 0)}` : ""} · <b>Outstanding {thb(a.outstanding)}</b>
        </div>
      </div>
      {/* Phase 1E: each money movement's PEAK state and the amount a document for it must carry.
          Linking an existing document happens on Payments → Advances (admin); nothing is created here. */}
      {ops && <div className="js-adv-peak" style={{ marginTop: 4, fontSize: 11.5, color: "var(--ink-soft)" }}>
        PEAK · issue {thb(a.amount)}: {peakWords(a.peakLink, a.peakSync)}
        {(a.settlements ?? []).map((st) => (
          <span key={st.entryId} className="js-adv-peak-settlement"> · settlement {st.onThisJob ? "on this job" : st.jobNo ?? ""} {thb(st.amount)}: {peakWords(st.peakLink, st.peakSync)}</span>
        ))}
      </div>}
      {problem && <div className="js-adv-problem" role="alert" style={{ marginTop: 6, color: "var(--danger,#b3402f)", fontSize: 12.5 }}>
        This advance's ledger does not add up ({[...(a.problems ?? []), (a.drift ?? 0) !== 0 ? `counter off by ${thb(a.drift ?? 0)}` : ""].filter(Boolean).join(", ")}). Nothing can be settled or allocated against it until it is checked.
      </div>}
      <div style={{ marginTop: 6, fontSize: 12.5 }}>
        May pay for: <span className="js-adv-categories">{(a.allowedCategories ?? ["entrance"]).join(", ")}</span>
        {canWrite && !editing && <button className="btn sm js-adv-edit-categories" style={{ marginLeft: 8 }} disabled={busy} onClick={() => { setCats(a.allowedCategories ?? ["entrance"]); setReason(""); setEditing(true); }}>Edit</button>}
      </div>
      {editing && (
        <div className="js-adv-category-form" style={{ marginTop: 6, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", fontSize: 12.5 }}>
          {CATEGORIES.map((c) => (
            <label key={c.key} style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <input type="checkbox" value={c.key} checked={cats.includes(c.key)} onChange={(e) => setCats((x) => (e.target.checked ? [...x, c.key] : x.filter((y) => y !== c.key)))} />{c.label}
            </label>
          ))}
          {otherTurnedOn && <input className="js-adv-other-reason" placeholder="Why may this advance pay for other costs?" value={reason} onChange={(e) => setReason(e.target.value)} style={{ minWidth: 260 }} />}
          <button className="btn sm primary js-adv-save-categories" disabled={busy || !cats.length || (otherTurnedOn && reason.trim().length < MIN_OTHER_REASON)}
            onClick={async () => { if (await run(`${a.advanceNo}: categories saved`, `/api/advances/${a.id}/categories`, { allowedCategories: cats, otherReason: otherTurnedOn ? reason.trim() : null })) setEditing(false); }}>Save</button>
          <button className="btn sm" onClick={() => setEditing(false)}>Cancel</button>
        </div>
      )}
      {lines.length > 0 && (
        <table className="js-adv-lines" style={{ marginTop: 8, fontSize: 12.5, width: "100%" }}>
          <thead><tr><th style={{ width: 28 }} /><th style={{ textAlign: "left" }}>Row</th><th>Category</th><th style={{ textAlign: "right" }}>Amount</th><th style={{ textAlign: "left" }}>State</th></tr></thead>
          <tbody>{lines.map((l) => (
            <tr key={l.index} data-row={l.index}>
              <td>{!l.settled && canWrite && <input type="checkbox" className="js-adv-pick" checked={picked.includes(l.index)} onChange={(e) => setPicked((x) => (e.target.checked ? [...x, l.index] : x.filter((y) => y !== l.index)))} />}</td>
              <td>{l.description || `Row ${l.index + 1}`}</td>
              <td style={{ textAlign: "center" }}>{l.category ?? "—"}</td>
              <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{thb(l.amount)}</td>
              <td>{l.settled ? `Settled (${l.settledBy})` : "Confirmed · linked · not settled"}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {canWrite && settleable.length > 0 && (
        <div style={{ marginTop: 6, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 12.5 }}>
          <button className="btn sm js-adv-settle" disabled={busy || !chosen.length || !approved || !saved || !data.jobSheetId || !data.sheetVersion || problem}
            title={!approved ? "Approve the job sheet first" : undefined}
            onClick={async () => {
              if (!confirm(`Settle ${thb(preview)} of ${a.advanceNo} with ${chosen.length} row(s)? The server checks every row and works out the amount.`)) return;
              const r = await run(`Settled to ${a.advanceNo}`, `/api/advances/${a.id}/settle-expenses`, { jobSheetId: data.jobSheetId, sheetVersion: data.sheetVersion, lines: chosen.map((l) => ({ index: l.index, identity: l.identity })) });
              if (r) setPicked([]);
            }}>Settle selected {chosen.length ? `(${thb(preview)})` : ""} to {a.advanceNo}</button>
          {!approved && <span style={{ color: "var(--ink-soft)" }}>The job sheet must be approved before settling.</span>}
        </div>
      )}
    </div>
  );
}

/** One return, with what may be done to it — shared by the job sheet and the Advances page. */
export function ReturnCard({ r, guideId, jobAdvances, jobSheetId, ops, accountant, userId, frozen, busy, run, excess }: {
  r: OpsReturn; guideId: string; jobAdvances: OpsAdvance[]; jobSheetId: string | null; ops: boolean; accountant: boolean; userId: string | null;
  frozen: boolean; busy: boolean; excess: boolean; run: (label: string, url: string, body: unknown) => Promise<Record<string, unknown> | null>;
}) {
  const [mode, setMode] = useState<null | "verify" | "allocate" | "void" | "refund" | "link">(null);
  const [text, setText] = useState("");
  const [amount, setAmount] = useState("");
  const [target, setTarget] = useState("");
  const [others, setOthers] = useState<OpsAdvance[] | null>(null);
  const [key, setKey] = useState("");
  const canWrite = ops && !frozen;
  const available = r.available ?? r.unallocated;
  const candidates = useMemo(() => {
    const all = [...jobAdvances, ...(others ?? []).filter((o) => !jobAdvances.some((j) => j.id === o.id))];
    return all.filter((a) => a.status !== "VOID" && a.status !== null && a.outstanding > 0);
  }, [jobAdvances, others]);
  const tgt = candidates.find((a) => a.id === target);
  const maxAlloc = tgt ? Math.min(available, tgt.outstanding) : 0;
  const open = async (m: typeof mode) => {
    setMode(m); setText(""); setAmount(""); setTarget(""); setKey(`alloc-${r.id}-${Math.random().toString(36).slice(2, 10)}`);
    if (m === "allocate" && others === null) {
      const res = await fetch(`/api/advances?guideId=${encodeURIComponent(guideId)}&status=open`).then((x) => x.json()).catch(() => ({}));
      setOthers(((res.advances ?? []) as OpsAdvance[]));
    }
  };
  return (
    <div className="js-return-card" data-receipt={r.receiptNo} style={{ border: "1px solid var(--line)", borderRadius: 10, padding: "10px 12px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div><span className="mono" style={{ fontWeight: 700 }}>{r.receiptNo}</span> <span className="badge">{RET_STATUS[r.status] ?? r.status}</span>
          <span style={{ fontSize: 11.5, color: "var(--ink-soft)" }}> · {r.receivedDate}{(r.bankRef ?? r.txRef) ? ` · ${r.bankRef ?? r.txRef}` : ""}{r.advanceId ? ` · for ${jobAdvances.find((a) => a.id === r.advanceId)?.advanceNo ?? "another advance"}` : " · not linked to an advance"}</span>
          {r.slipUrl ? <> · <a href={r.slipUrl} target="_blank" rel="noopener noreferrer">📎 Slip</a></> : null}</div>
        <div className="js-return-figures" style={{ fontSize: 12.5, fontVariantNumeric: "tabular-nums" }}>
          Amount {thb(r.amount)} · Allocated {thb(r.allocated)} · Refunded {thb(r.refunded ?? 0)} · <b>Unallocated {thb(r.unallocated)}</b>{available !== r.unallocated ? ` (free ${thb(available)})` : ""}
        </div>
      </div>
      {ops && r.status === "VERIFIED" && (
        <div className="js-return-peak" style={{ marginTop: 4, fontSize: 11.5, color: "var(--ink-soft)" }}>
          PEAK · return {thb(r.allocated)} allocated to advances{(r.refunded ?? 0) > 0 ? ` (not the ${thb(r.refunded ?? 0)} refunded to the guide)` : ""}: {peakWords(r.peakLink, r.peakSync)}
        </div>
      )}
      {(r.problems?.length ?? 0) > 0 && <div role="alert" style={{ color: "var(--danger,#b3402f)", fontSize: 12.5, marginTop: 4 }}>This return's books do not add up ({r.problems!.join(", ")}) — nothing more can be done with it until it is checked.</div>}
      {excess && (
        <div className="js-excess-return" style={{ marginTop: 6, padding: "6px 10px", borderRadius: 8, background: "var(--warn-bg,#fbf4e4)", fontSize: 12.5 }}>
          <b>Excess return / เงินคืนเกินที่ต้องคืน</b> — {thb(r.unallocated)} came back beyond what this job owed. Allocate it to another advance of this guide, or record a refund to the guide. It is never moved anywhere by itself.
        </div>
      )}
      {canWrite && (
        <div style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
          {(r.status === "CLAIMED" || r.status === "VERIFIED") && r.allocated === 0 && <button className="btn sm js-return-link" disabled={busy} onClick={() => open("link")}>Link to advance</button>}
          {r.status === "CLAIMED" && <button className="btn sm js-return-verify" disabled={busy} onClick={() => open("verify")}>Verify</button>}
          {r.status === "VERIFIED" && available > 0 && <button className="btn sm js-return-allocate" disabled={busy} onClick={() => open("allocate")}>Allocate</button>}
          {r.status === "VERIFIED" && available > 0 && <button className="btn sm js-refund-record" disabled={busy} onClick={() => open("refund")}>Record refund to guide</button>}
          {(r.status === "CLAIMED" || r.status === "VERIFIED") && r.allocated === 0 && (r.refunded ?? 0) === 0 && <button className="btn sm js-return-void" disabled={busy} onClick={() => open("void")}>Void</button>}
        </div>
      )}
      {mode === "link" && (
        <div className="js-return-form" style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <select className="js-return-link-target" value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">— not linked —</option>
            {jobAdvances.map((a) => <option key={a.id} value={a.id}>{a.advanceNo}</option>)}
          </select>
          <button className="btn sm primary" disabled={busy} onClick={async () => { if (await run(`${r.receiptNo} linked`, `/api/advances/returns/${r.id}/link`, { advanceId: target || null, jobSheetId: target ? null : jobSheetId })) setMode(null); }}>Save link</button>
          <button className="btn sm" onClick={() => setMode(null)}>Cancel</button>
        </div>
      )}
      {mode === "verify" && (
        <div className="js-return-form" style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <input className="js-return-bankref" placeholder="Company bank statement reference" value={text} onChange={(e) => setText(e.target.value)} style={{ minWidth: 240 }} />
          <button className="btn sm primary" disabled={busy || text.trim().length < 4} onClick={async () => { if (await run(`${r.receiptNo} verified`, `/api/advances/returns/${r.id}/verify`, { bankRef: text.trim() })) setMode(null); }}>Confirm it arrived</button>
          <button className="btn sm" onClick={() => setMode(null)}>Cancel</button>
        </div>
      )}
      {mode === "allocate" && (
        <div className="js-return-form" style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", fontSize: 12.5 }}>
          <select className="js-return-alloc-target" value={target} onChange={(e) => { setTarget(e.target.value); const t = candidates.find((a) => a.id === e.target.value); setAmount(t ? String(Math.min(available, t.outstanding)) : ""); }}>
            <option value="">— choose an advance —</option>
            {candidates.map((a) => <option key={a.id} value={a.id}>{a.advanceNo} · outstanding {thb(a.outstanding)}</option>)}
          </select>
          {tgt && <span className="js-return-alloc-caps">Return free {thb(available)} · advance outstanding {thb(tgt.outstanding)} · at most <b>{thb(maxAlloc)}</b></span>}
          <input className="js-return-alloc-amount" type="number" min={0.01} step="0.01" max={maxAlloc || undefined} value={amount} onChange={(e) => setAmount(e.target.value)} style={{ width: 110 }} />
          <button className="btn sm primary" disabled={busy || !tgt || !(Number(amount) > 0) || Number(amount) > maxAlloc}
            onClick={async () => { if (await run(`${r.receiptNo}: ${thb(Number(amount))} allocated to ${tgt!.advanceNo}`, `/api/advances/returns/${r.id}/allocate`, { requestKey: key, allocations: [{ advanceId: tgt!.id, amount: Number(amount) }] })) setMode(null); }}>Allocate</button>
          <button className="btn sm" onClick={() => setMode(null)}>Cancel</button>
        </div>
      )}
      {mode === "void" && (
        <div className="js-return-form" style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
          <input placeholder="Why is this return being voided?" value={text} onChange={(e) => setText(e.target.value)} style={{ minWidth: 260 }} />
          <button className="btn sm danger" disabled={busy || text.trim().length < 5} onClick={async () => { if (await run(`${r.receiptNo} voided`, `/api/advances/returns/${r.id}/void`, { reason: text.trim() })) setMode(null); }}>Void return</button>
          <button className="btn sm" onClick={() => setMode(null)}>Cancel</button>
        </div>
      )}
      {mode === "refund" && (
        <div className="js-return-form" style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", fontSize: 12.5 }}>
          <input className="js-refund-amount" type="number" min={0.01} step="0.01" max={available} placeholder={`at most ${available}`} value={amount} onChange={(e) => setAmount(e.target.value)} style={{ width: 110 }} />
          <input className="js-refund-reason" placeholder="Why is this paid back to the guide?" value={text} onChange={(e) => setText(e.target.value)} style={{ minWidth: 240 }} />
          <button className="btn sm primary js-refund-record-submit" disabled={busy || !(Number(amount) > 0) || Number(amount) > available || text.trim().length < 8}
            onClick={async () => { if (await run(`Refund recorded — another person must approve it`, `/api/advances/returns/${r.id}/refunds`, { amount: Number(amount), reason: text.trim() })) setMode(null); }}>Record refund</button>
          <button className="btn sm" onClick={() => setMode(null)}>Cancel</button>
        </div>
      )}
      {(r.refunds ?? []).length > 0 && (
        <div style={{ marginTop: 8, display: "grid", gap: 4 }}>
          <div style={{ fontSize: 12, fontWeight: 700 }}>Refunds to the guide <small style={{ fontWeight: 500, color: "var(--ink-soft)" }}>(not a guide payment)</small></div>
          {(r.refunds ?? []).map((f) => <RefundRow key={f.id} f={f} ops={ops} accountant={accountant} userId={userId} frozen={frozen} busy={busy} run={run} />)}
        </div>
      )}
    </div>
  );
}

export function RefundRow({ f, ops, accountant, userId, frozen, busy, run }: {
  f: OpsRefund; ops: boolean; accountant: boolean; userId: string | null; frozen: boolean; busy: boolean;
  run: (label: string, url: string, body: unknown) => Promise<Record<string, unknown> | null>;
}) {
  const [mode, setMode] = useState<null | "pay" | "void">(null);
  const [bankRef, setBankRef] = useState("");
  const [paidAt, setPaidAt] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [reason, setReason] = useState("");
  const mine = !!userId && userId === f.recordedById;
  const canApprove = (ops || accountant) && !frozen && f.status === "RECORDED";
  return (
    <div className="js-refund-row" data-refund={f.refundNo} data-status={f.status} style={{ fontSize: 12.5, padding: "6px 8px", border: "1px solid var(--line)", borderRadius: 8 }}>
      <span className="mono">{f.refundNo}</span> · {thb(f.amount)} · <span className={`badge${f.status === "PAID" ? " active" : f.status === "VOIDED" ? " muted" : " pending"} js-refund-status`}>{REF_STATUS[f.status] ?? f.status}</span>
      <span style={{ color: "var(--ink-soft)" }}> · {f.reason}{f.bankRef ? ` · ${f.bankRef}` : ""}{f.voidReason ? ` · voided: ${f.voidReason}` : ""}</span>
      {f.slipUrl ? <> · <a href={f.slipUrl} target="_blank" rel="noopener noreferrer" className="js-refund-slip">📎 Slip</a></> : null}
      <div style={{ marginTop: 4, display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        {canApprove && (mine
          ? <span className="js-refund-own" style={{ color: "var(--ink-soft)" }}>You recorded this refund — another person must approve it.</span>
          : <button className="btn sm js-refund-approve" disabled={busy} onClick={() => run(`${f.refundNo} approved`, `/api/advances/refunds/${f.id}/approve`, {})}>Approve</button>)}
        {ops && !frozen && f.status === "APPROVED" && <button className="btn sm js-refund-pay" disabled={busy} onClick={() => { setMode("pay"); setPaidAt(new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 16)); }}>Record payment</button>}
        {ops && !frozen && (f.status === "RECORDED" || f.status === "APPROVED") && <button className="btn sm js-refund-void" disabled={busy} onClick={() => setMode("void")}>Void</button>}
      </div>
      {mode === "pay" && (
        <div className="js-refund-pay-form" style={{ marginTop: 4, display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <input type="datetime-local" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />
          <input className="js-refund-bankref" placeholder="Bank reference of the transfer" value={bankRef} onChange={(e) => setBankRef(e.target.value)} />
          <label className="btn sm" style={{ cursor: "pointer" }}>{file ? `📎 ${file.name.slice(0, 18)}` : "📎 Slip"}<input className="js-refund-file" type="file" accept="image/*,application/pdf" hidden onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
          <button className="btn sm primary js-refund-pay-submit" disabled={busy || bankRef.trim().length < 4 || !paidAt}
            onClick={async () => {
              const fd = new FormData();
              fd.append("paidAt", new Date(`${paidAt}:00+07:00`).toISOString()); fd.append("bankRef", bankRef.trim());
              if (file) fd.append("file", file);
              if (await run(`${f.refundNo} paid`, `/api/advances/refunds/${f.id}/pay`, fd)) setMode(null);
            }}>Mark paid</button>
          <button className="btn sm" onClick={() => setMode(null)}>Cancel</button>
        </div>
      )}
      {mode === "void" && (
        <div style={{ marginTop: 4, display: "flex", gap: 6 }}>
          <input placeholder="Why will this refund not be paid?" value={reason} onChange={(e) => setReason(e.target.value)} style={{ minWidth: 240 }} />
          <button className="btn sm danger js-refund-void-submit" disabled={busy || reason.trim().length < 5} onClick={async () => { if (await run(`${f.refundNo} voided`, `/api/advances/refunds/${f.id}/void`, { reason: reason.trim() })) setMode(null); }}>Void refund</button>
          <button className="btn sm" onClick={() => setMode(null)}>Cancel</button>
        </div>
      )}
    </div>
  );
}
