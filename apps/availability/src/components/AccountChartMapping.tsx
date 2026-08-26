"use client";

import { useCallback, useEffect, useState } from "react";

// Account chart mapping card on Accounting → PEAK sync.
//
// The operator picks a real PEAK account per FolkOPS category. Nothing here posts:
// it reads PEAK's chart (read-only) and writes only our own mapping table.
//
// Codes are never typed from memory or inferred from an account's name — the
// dropdown is populated from PEAK, and a category counts as mapped only once it
// carries a code that came from that list.

type PeakAccount = { code: string; name: string; nameEn?: string };
type Row = {
  key: string; label: string; th: string; example: string; scope: "FIXED" | "PER_JOB"; note: string | null;
  peakAccountCode: string | null; peakAccountName: string | null;
  status: "MAPPED" | "NOT_MAPPED" | "REVIEW_PER_JOB";
};

const STATUS_LABEL: Record<Row["status"], string> = {
  MAPPED: "Mapped",
  NOT_MAPPED: "Not mapped",
  REVIEW_PER_JOB: "Review per Job",
};

export default function AccountChartMapping({ canEdit }: { canEdit: boolean }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [ready, setReady] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const [accounts, setAccounts] = useState<PeakAccount[]>([]);
  const [accountsError, setAccountsError] = useState<string>("");
  const [accountsMeta, setAccountsMeta] = useState<{ arrayKey: string; rawCount: number; droppedNoCode: number; sampleKeys: string[] } | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({}); // category -> account code
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    const r = await fetch("/api/peak/account-map", { cache: "no-store" });
    if (!r.ok) { setRows([]); return; }
    const d = await r.json();
    setRows(d.categories);
    setReady(!!d.accountChartReady);
    setRemaining((d.missingRequired ?? []).length);
    setDraft(Object.fromEntries((d.categories as Row[]).map((c) => [c.key, c.peakAccountCode ?? ""])));
  }, []);

  useEffect(() => { load(); }, [load]);

  // The chart is fetched separately so a PEAK outage leaves the saved mapping
  // readable — the table still shows what is configured, just without new choices.
  useEffect(() => {
    fetch("/api/peak/accounts", { cache: "no-store" })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        setAccountsMeta(d.meta ?? null);
        if (r.ok && d.ok) setAccounts(d.accounts ?? []);
        else setAccountsError(d.error || "Could not load the PEAK chart of accounts.");
      })
      .catch(() => setAccountsError("Could not reach the server to load PEAK accounts."));
  }, []);

  const dirty = !!rows?.some((c) => c.scope === "FIXED" && (draft[c.key] ?? "") !== (c.peakAccountCode ?? ""));

  async function save() {
    if (!rows) return;
    setBusy(true); setMsg("");
    // Per-job categories are never sent — there is nothing to save and the server
    // rejects them.
    const mappings = rows.filter((c) => c.scope === "FIXED").map((c) => {
      const code = (draft[c.key] ?? "").trim();
      // Send the name that belongs to the chosen code, so the stored snapshot can
      // never drift from the code it labels.
      const acct = accounts.find((a) => a.code === code);
      return { folkopsCategory: c.key, peakAccountCode: code, peakAccountName: acct?.name ?? (code ? c.peakAccountName : null) };
    });
    const r = await fetch("/api/peak/account-map", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mappings }),
    });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setMsg(d.error === "forbidden" ? "Operator only." : d.error === "unknown-category" ? `Unknown category: ${d.detail}` : "Couldn't save the mappings."); return; }
    setMsg(d.accountChartReady ? "Mappings saved — account chart configured" : "Mappings saved");
    load();
  }

  const nameFor = (code: string) => accounts.find((a) => a.code === code)?.name ?? "";

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Account chart mapping</h2>
        <span className="hint">Map FolkOPS expense categories to PEAK accounts.</span>
        {rows && (
          <span style={{ marginLeft: "auto" }} className={`acct-ready ${ready ? "ok" : "warn"}`}>
            {ready ? "Account chart mapping configured" : `Account chart mapping not configured${remaining ? ` · ${remaining} mapping${remaining === 1 ? "" : "s"} remaining` : ""}`}
          </span>
        )}
      </div>

      {accountsError && (
        <div className="acct-warn-bar">
          <b>PEAK account list unavailable</b>
          <span>{accountsError} Saved mappings still work, and you can type an account code by hand in the meantime.</span>
          {accountsMeta && (
            <span style={{ display: "block", marginTop: 4 }}>
              PEAK returned <b>{accountsMeta.rawCount}</b> row(s) under <code>{accountsMeta.arrayKey}</code>
              {accountsMeta.sampleKeys.length ? <> · fields present: <code>{accountsMeta.sampleKeys.join(", ")}</code></> : null}
            </span>
          )}
        </div>
      )}

      {!rows ? (
        <div style={{ padding: 14 }}>{Array.from({ length: 4 }).map((_, i) => <div key={i} className="skel-row" />)}</div>
      ) : (
        <>
          <div className="grid-scroll" style={{ padding: "0 8px 4px" }}>
            <table className="acct-table">
              <thead><tr>
                <th style={{ width: 220 }}>FolkOPS Category</th>
                <th>Example</th>
                <th style={{ width: 300 }}>PEAK Account</th>
                <th style={{ width: 120 }}>Status</th>
              </tr></thead>
              <tbody>
                {rows.map((c) => {
                  const code = draft[c.key] ?? "";
                  // Live status from the DRAFT, so choosing an account flips the
                  // pill before saving rather than after a round trip.
                  const status: Row["status"] = c.scope === "PER_JOB" ? "REVIEW_PER_JOB" : code.trim() ? "MAPPED" : "NOT_MAPPED";
                  return (
                    <tr key={c.key}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{c.label}</div>
                        <div className="acct-sub">{c.th}</div>
                        {c.scope === "PER_JOB" && <div className="acct-code">Manual review required</div>}
                      </td>
                      <td className="acct-sub">{c.example}</td>
                      <td>
                        {c.scope === "PER_JOB" ? (
                          // A standing account here would be applied to every one-off
                          // cost this category exists to hold, so there is no control.
                          <div className="acct-sub">{c.note ?? "Select the PEAK account on the Job Sheet when this category is used."}</div>
                        ) : canEdit ? (
                          <>
                            <input
                              className="acct-input" list={`peak-accounts-${c.key}`} value={code} placeholder="Search code or name…"
                              onChange={(e) => setDraft((p) => ({ ...p, [c.key]: e.target.value }))}
                              aria-label={`PEAK account for ${c.label}`}
                            />
                            <datalist id={`peak-accounts-${c.key}`}>
                              {accounts.map((a) => <option key={a.code} value={a.code}>{a.code} — {a.name}</option>)}
                            </datalist>
                            <div className="acct-code">{code ? (nameFor(code) || c.peakAccountName || (accounts.length ? "account not in the PEAK list" : "typed manually — PEAK list unavailable")) : "Not mapped"}</div>
                          </>
                        ) : (
                          <div>{c.peakAccountCode ? `${c.peakAccountCode} — ${c.peakAccountName ?? ""}` : "—"}</div>
                        )}
                      </td>
                      <td>
                        <span className={`acct-pill ${status === "MAPPED" ? "ok" : "warn"}`}>{STATUS_LABEL[status]}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="acct-foot">
            <span className="acct-sub">
              Choose each account once here and every future Job Sheet uses it automatically. Other Tour Cost is the one
              exception — it covers too many different things to share a single account, so it is chosen on the Job Sheet.
            </span>
            {msg && <span className="acct-msg">{msg}</span>}
            {canEdit && <button className="btn primary" disabled={busy || !dirty} onClick={save}>{busy ? "Saving…" : "Save mappings"}</button>}
          </div>
        </>
      )}
    </section>
  );
}
