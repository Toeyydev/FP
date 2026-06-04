"use client";

import { signOut } from "next-auth/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useLang } from "@/components/Providers";
import { SLOTS } from "@/lib/slots";
import {
  DOW, MON, addDays, addMonths, currentSlotIdx, mkey, parseYMD,
  sameDay, todayD, uniq, weekStart, ymd,
} from "@/lib/dates";

type Role = "guide" | "operator";
type Job = { tour: string; pax: number | null; note: string | null };
type Ref = {
  guides: { guideId: string; displayName: string }[];
  tours: { id: string; name: string; time: string }[];
};
type AvMap = Record<string, Record<string, Record<number, boolean[]>>>; // mkey -> gid -> day -> [10]
type AsMap = Record<string, Record<string, Record<number, Record<number, Job>>>>; // mkey -> gid -> day -> idx -> Job

const EMPTY: boolean[] = Array(SLOTS.length).fill(false);

function visibleMonths(role: Role, view: string, anchor: Date): string[] {
  if (view === "year") {
    const y = anchor.getFullYear();
    return Array.from({ length: 12 }, (_, m) => mkey(new Date(y, m, 1)));
  }
  if (role === "guide" && view === "week") {
    const ws = weekStart(anchor);
    return uniq([mkey(ws), mkey(addDays(ws, 6))]);
  }
  return [mkey(anchor)];
}

export default function AppClient({
  role, guideId, displayName,
}: { role: Role; isAdmin?: boolean; guideId: string | null; displayName: string }) {
  const { t, lang, setLang } = useLang();
  const [view, setView] = useState<string>(role === "guide" ? "schedule" : "day");
  const [anchor, setAnchor] = useState<Date>(() => todayD());
  const [ref, setRef] = useState<Ref | null>(null);
  const [av, setAv] = useState<AvMap>({});
  const [as, setAs] = useState<AsMap>({});
  const [clock, setClock] = useState("");
  const [changed, setChanged] = useState(false);
  const [toastMsg, setToastMsg] = useState("");
  const [modal, setModal] = useState<
    | { kind: "assign"; gid: string; idx: number; date: string }
    | { kind: "dayedit"; date: string }
    | { kind: "newoffer" }
    | null
  >(null);
  const [q, setQ] = useState("");
  const [onlyAvail, setOnlyAvail] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [blockedDates, setBlockedDates] = useState<Set<string>>(new Set());
  const [notif, setNotif] = useState<{ unread: number; items: { id: string; message: string; readAt: string | null; createdAt: string }[] }>({ unread: 0, items: [] });
  const [offers, setOffers] = useState<{ id: string; tourName: string; date: string; time: string; pax: number | null; note: string | null }[]>([]);
  const [schedule, setSchedule] = useState<{ date: string; slotIdx: number; time: string; tourId: string; tourName: string; pax: number | null; note: string | null }[]>([]);
  const [profileGate, setProfileGate] = useState<{ complete: boolean; missing: string[] }>({ complete: true, missing: [] });
  const [showNotif, setShowNotif] = useState(false);
  // assign-form state lives here (not in a child) so a poll re-render never wipes it
  const [fTour, setFTour] = useState("");
  const [fPax, setFPax] = useState("");
  const [fNote, setFNote] = useState("");
  // dedicated "new job offer" form state
  const [oDate, setODate] = useState("");
  const [oSlot, setOSlot] = useState(0);
  const [oDur, setODur] = useState("3"); // tour duration in hours

  const tourById = useMemo(
    () => Object.fromEntries((ref?.tours ?? []).map((x) => [x.id, x])),
    [ref],
  );

  useEffect(() => {
    fetch("/api/reference", { cache: "no-store" }).then((r) => r.json()).then(setRef).catch(() => {});
  }, []);

  const toast = useCallback((m: string) => {
    setToastMsg(m);
    window.setTimeout(() => setToastMsg(""), 2200);
  }, []);

  // ---- data loading + polling ----
  const lastSlice = useRef("");
  const load = useCallback(async () => {
    const months = visibleMonths(role, view, anchor);
    try {
      const [avRes, asRes] = await Promise.all([
        Promise.all(months.map((m) => fetch(`/api/availability?month=${m}`, { cache: "no-store" }).then((r) => r.json()))),
        Promise.all(months.map((m) => fetch(`/api/assignments?month=${m}`, { cache: "no-store" }).then((r) => r.json()))),
      ]);
      const nextAv: AvMap = {}, nextAs: AsMap = {};
      months.forEach((m, i) => { nextAv[m] = avRes[i] || {}; nextAs[m] = asRes[i] || {}; });
      const slice = JSON.stringify([nextAv, nextAs]);
      if (lastSlice.current && slice !== lastSlice.current) setChanged(true);
      lastSlice.current = slice;
      setAv((prev) => ({ ...prev, ...nextAv }));
      setAs((prev) => ({ ...prev, ...nextAs }));
      const blk = await fetch("/api/blocked", { cache: "no-store" }).then((r) => r.json()).catch(() => []);
      setBlockedDates(new Set(Array.isArray(blk) ? blk.map((x: { date: string }) => x.date) : []));
    } catch {
      /* keep last good data */
    }
  }, [role, view, anchor]);

  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => { setChanged(false); load(); }, [load]);

  useEffect(() => {
    const tick = () => {
      const d = new Date();
      setClock(`${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`);
    };
    tick();
    const id = window.setInterval(() => { loadRef.current(); tick(); }, 5000);
    return () => window.clearInterval(id);
  }, []);

  // Operator/admin: poll the pending sign-up count for the Accounts badge.
  useEffect(() => {
    if (role !== "operator") return;
    const fetchCount = () => fetch("/api/admin/pending-count", { cache: "no-store" })
      .then((r) => r.json()).then((d) => setPendingCount(d.count ?? 0)).catch(() => {});
    fetchCount();
    const id = window.setInterval(fetchCount, 15000);
    return () => window.clearInterval(id);
  }, [role]);

  // Poll notifications — guides (date blocked, offers) and operators (a guide
  // accepted a job, an offer expired).
  useEffect(() => {
    const f = () => fetch("/api/notifications", { cache: "no-store" }).then((r) => r.json()).then(setNotif).catch(() => {});
    f();
    const id = window.setInterval(f, 15000);
    return () => window.clearInterval(id);
  }, [role]);

  // Guide: must complete account details before setting availability.
  useEffect(() => {
    if (role !== "guide") return;
    fetch("/api/profile/status", { cache: "no-store" }).then((r) => r.json()).then(setProfileGate).catch(() => {});
  }, [role]);

  // Guide: load their upcoming confirmed tours (schedule).
  useEffect(() => {
    if (role !== "guide") return;
    const f = () => fetch("/api/schedule", { cache: "no-store" }).then((r) => r.json()).then((d) => setSchedule(d.items ?? [])).catch(() => {});
    f();
    const id = window.setInterval(f, 30000);
    return () => window.clearInterval(id);
  }, [role]);

  // Guide: poll open job offers they can Accept/Deny in-app.
  const loadOffers = useCallback(() => {
    if (role !== "guide") return;
    fetch("/api/offers/mine", { cache: "no-store" }).then((r) => r.json()).then((d) => setOffers(d.offers ?? [])).catch(() => {});
  }, [role]);
  useEffect(() => {
    if (role !== "guide") return;
    loadOffers();
    const id = window.setInterval(loadOffers, 15000);
    return () => window.clearInterval(id);
  }, [role, loadOffers]);

  async function respondOffer(offerId: string, action: "accept" | "deny") {
    const r = await fetch("/api/offers/mine", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ offerId, action }) });
    const d = await r.json().catch(() => ({}));
    if (action === "accept") {
      if (r.ok) toast(t("offerAccepted"));
      else toast(d.reason === "taken" ? t("offerTaken") : d.reason === "expired" ? t("offerExpired") : t("errGeneric"));
    } else {
      toast(t("offerDenied"));
    }
    setOffers((os) => os.filter((o) => o.id !== offerId));
    loadOffers();
    await load();
  }

  // ---- accessors ----
  const getAvail = (gid: string, d: Date): boolean[] | null => av[mkey(d)]?.[gid]?.[d.getDate()] ?? null;
  const getAssign = (gid: string, d: Date): Record<number, Job> => as[mkey(d)]?.[gid]?.[d.getDate()] ?? {};
  const isBlocked = (d: Date): boolean => blockedDates.has(ymd(d));

  // ---- mutations ----
  async function putAvail(d: Date, slots: boolean[]) {
    if (!profileGate.complete) { toast(t("completeProfileFirst")); return; }
    await fetch("/api/availability", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ date: ymd(d), slots }),
    });
    await load();
  }
  const toggleSlot = (d: Date, idx: number) => {
    const cur = (getAvail(guideId!, d) ?? EMPTY).slice();
    cur[idx] = !cur[idx];
    return putAvail(d, cur);
  };
  const setDayAll = (d: Date, val: boolean) => {
    const asg = getAssign(guideId!, d);
    const cur = getAvail(guideId!, d) ?? EMPTY;
    return putAvail(d, SLOTS.map((s) => (asg[s.idx] ? cur[s.idx] : val)));
  };
  async function weekBulk(val: boolean) {
    const ws = weekStart(anchor);
    for (let i = 0; i < 7; i++) {
      const d = addDays(ws, i);
      const asg = getAssign(guideId!, d);
      const cur = getAvail(guideId!, d) ?? EMPTY;
      await fetch("/api/availability", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ date: ymd(d), slots: SLOTS.map((s) => (asg[s.idx] ? cur[s.idx] : val)) }),
      });
    }
    await load();
    toast(val ? t("weekAllFree") : t("weekCleared"));
  }
  async function doAssign() {
    if (modal?.kind !== "assign") return;
    await fetch("/api/assignments", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ guideId: modal.gid, date: modal.date, slotIdx: modal.idx, tourId: fTour, pax: fPax ? Number(fPax) : null, note: fNote.trim() || null }),
    });
    await load();
    const name = ref?.guides.find((g) => g.guideId === modal.gid)?.displayName ?? modal.gid;
    toast(`${t("assignBtn")} → ${name}`);
    setModal(null);
  }
  // Broadcast this slot as a job offer to every available guide (first to Accept wins).
  async function doOffer() {
    if (modal?.kind !== "assign") return;
    if (!fTour) { toast(t("tour")); return; }
    if (fPax && Number(fPax) > 10) { toast(t("offerPaxMax")); return; }
    const r = await fetch("/api/offers", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tourId: fTour, date: modal.date, slotIdx: modal.idx, pax: fPax ? Number(fPax) : undefined, note: fNote.trim() || undefined }),
    });
    const j = await r.json().catch(() => ({}));
    setModal(null);
    if (!r.ok) { toast(t("errGeneric")); return; }
    if (!j.candidates) { toast(t("offerNoCandidates")); return; }
    toast(`${t("offerSent")}: ${j.candidates} · LINE ${j.lineSent}`);
    await load();
  }
  async function doUnassign(gid: string, idx: number, date: string) {
    await fetch("/api/assignments", {
      method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ guideId: gid, date, slotIdx: idx }),
    });
    await load();
    toast(t("slotFreed"));
    setModal(null);
  }
  function openAssign(gid: string, idx: number, date: string) {
    setFTour(ref?.tours[0]?.id ?? "");
    setFPax(""); setFNote("");
    setModal({ kind: "assign", gid, idx, date });
  }
  function openNewOffer() {
    setFTour(ref?.tours[0]?.id ?? "");
    setFPax(""); setFNote("");
    setODate(ymd(anchor)); setOSlot(0); setODur("3");
    setModal({ kind: "newoffer" });
  }
  // How many guides are free for a date+slot (client-side preview before sending).
  function availCountFor(dateStr: string, slotIdx: number): number {
    const d = new Date(`${dateStr}T00:00:00`);
    if (isBlocked(d)) return 0;
    return (ref?.guides ?? []).filter((g) => {
      const avd = getAvail(g.guideId, d) ?? EMPTY;
      const asg = getAssign(g.guideId, d);
      return !avd[slotIdx] && !asg[slotIdx];
    }).length;
  }
  // "10:00–13:00" preview for the offer form (start slot + duration hours).
  function timeRange(slotIdx: number, hoursStr: string): string {
    const start = SLOTS[slotIdx]?.start ?? "";
    const hrs = Number(hoursStr);
    if (!start || !hrs || hrs <= 0) return start || "—";
    const [h, m] = start.split(":").map(Number);
    const total = h * 60 + m + Math.round(hrs * 60);
    const eh = Math.floor(total / 60) % 24, em = total % 60;
    return `${start}–${String(eh).padStart(2, "0")}:${String(em).padStart(2, "0")}`;
  }
  async function doOfferForm() {
    if (!fTour) { toast(t("tour")); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(oDate)) { toast(t("pickDate")); return; }
    if (fPax && Number(fPax) > 10) { toast(t("offerPaxMax")); return; }
    const durMin = oDur && Number(oDur) > 0 ? Math.round(Number(oDur) * 60) : undefined;
    const r = await fetch("/api/offers", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tourId: fTour, date: oDate, slotIdx: oSlot, durationMin: durMin, pax: fPax ? Number(fPax) : undefined, note: fNote.trim() || undefined }),
    });
    const j = await r.json().catch(() => ({}));
    setModal(null);
    if (!r.ok) { toast(t("errGeneric")); return; }
    if (!j.candidates) { toast(t("offerNoCandidates")); return; }
    toast(`${t("offerSent")}: ${j.candidates} · LINE ${j.lineSent}`);
    await load();
  }
  async function toggleBlock(d: Date) {
    const date = ymd(d);
    if (blockedDates.has(date)) {
      await fetch("/api/blocked", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ date }) });
    } else {
      const reason = window.prompt(`Block ${date} for everyone — optional reason:`) ?? undefined;
      const r = await fetch("/api/blocked", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ date, reason: reason || undefined }) });
      const j = await r.json().catch(() => ({}));
      toast(j.notified ? `Blocked · ${j.notified} guide(s) notified` : "Date blocked");
    }
    await load();
  }
  async function openNotif() {
    setShowNotif(true);
    await fetch("/api/notifications", { method: "POST" });
    setNotif((n) => ({ unread: 0, items: n.items.map((i) => ({ ...i, readAt: i.readAt || new Date().toISOString() })) }));
  }
  async function clearNotif() {
    await fetch("/api/notifications", { method: "DELETE" });
    setNotif({ unread: 0, items: [] });
  }

  // ---- navigation ----
  function navBy(dir: number) {
    if (view === "schedule") return; // flat list — no period navigation
    if (role === "guide") {
      if (view === "week") setAnchor(addDays(weekStart(anchor), dir * 7));
      else if (view === "month") setAnchor(addMonths(anchor, dir));
      else setAnchor(new Date(anchor.getFullYear() + dir, 0, 1));
    } else {
      if (view === "day") setAnchor(addDays(anchor, dir));
      else if (view === "month") setAnchor(addMonths(anchor, dir));
      else setAnchor(new Date(anchor.getFullYear() + dir, 0, 1));
    }
  }
  function periodLabel() {
    if (view === "schedule") return "";
    if (role === "guide") {
      if (view === "week") {
        const ws = weekStart(anchor), we = addDays(ws, 6);
        return `${ws.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} – ${we.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`;
      }
      if (view === "month") return `${MON[anchor.getMonth()]} ${anchor.getFullYear()}`;
      return String(anchor.getFullYear());
    }
    if (view === "day") return anchor.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
    if (view === "year") return String(anchor.getFullYear());
    return `${MON[anchor.getMonth()]} ${anchor.getFullYear()}`;
  }

  // ---- inline render helpers (plain functions → no remount on poll) ----
  function calendar(opts: { cell: (d: Date) => ReactNode; onClick: (d: Date) => void; extraClass?: string; tint?: (d: Date) => string | undefined }): ReactNode {
    const y = anchor.getFullYear(), mo = anchor.getMonth(); const today = todayD();
    const first = new Date(y, mo, 1); const lead = (first.getDay() + 6) % 7; const dim = new Date(y, mo + 1, 0).getDate();
    return (
      <div className={`cal ${opts.extraClass || ""}`}>
        <div className="dow">{DOW.map((x) => <span key={x}>{x}</span>)}</div>
        <div className="grid">
          {Array.from({ length: lead }, (_, i) => <div key={`o${i}`} className="cell-day out" />)}
          {Array.from({ length: dim }, (_, k) => {
            const dn = k + 1; const d = new Date(y, mo, dn); const isT = sameDay(d, today); const bg = opts.tint?.(d);
            return (
              <div key={dn} className={`cell-day${isT ? " today" : ""}`} style={bg ? { background: bg } : undefined} onClick={() => opts.onClick(d)}>
                {opts.cell(d)}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  async function cancelTour(s: { date: string; slotIdx: number; tourName: string }) {
    const reason = window.prompt(t("cancelReasonPrompt"));
    if (reason === null) return; // dismissed
    const r = await fetch("/api/schedule", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ date: s.date, slotIdx: s.slotIdx, reason: reason || undefined }) });
    if (!r.ok) { toast(t("errGeneric")); return; }
    setSchedule((sc) => sc.filter((x) => !(x.date === s.date && x.slotIdx === s.slotIdx)));
    toast(t("tourCancelled"));
    await load();
  }
  function guideSchedule(): ReactNode {
    const fmt = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
    return (
      <>
        <div className="panel-head"><h2>{t("myTours")}</h2><span className="hint">{t("scheduleHint")}</span></div>
        <div style={{ padding: 14 }}>
          {schedule.length === 0 ? <div className="op-empty">{t("noUpcoming")}</div> : schedule.map((s, i) => (
            <div key={i} className="sched-card" style={{ cursor: "default" }}>
              <div className="sched-when"><b>{fmt(s.date)}</b><span>{s.time}</span></div>
              <div className="sched-mid"><b>{s.tourName}</b><div className="sched-sub">{s.pax != null ? `👥 ${s.pax} pax` : ""}{s.note ? ` · 📝 ${s.note}` : ""}</div></div>
              <div style={{ display: "flex", gap: 6 }}>
                <a className="btn sm" href={`/job-sheet?guideId=${guideId}&date=${s.date}&slotIdx=${s.slotIdx}`}>📄</a>
                <button className="btn sm danger" onClick={() => cancelTour(s)}>{t("cancelTour")}</button>
              </div>
            </div>
          ))}
        </div>
      </>
    );
  }
  function guideWeek(): ReactNode {
    const gid = guideId!; const ws = weekStart(anchor); const today = todayD(); const nowIdx = currentSlotIdx();
    return (
      <>
        <div className="panel-head">
          <h2>{t("myWeek")}</h2><span className="hint">{t("weekHint")}</span>
          <div className="head-tools">
            <button className="btn sm" onClick={() => weekBulk(true)}>{t("busyWeek")}</button>
            <button className="btn sm ghost" onClick={() => weekBulk(false)}>{t("clearWeek")}</button>
          </div>
        </div>
        <div className="weekwrap">
          {Array.from({ length: 7 }, (_, i) => {
            const d = addDays(ws, i); const avd = getAvail(gid, d) ?? EMPTY; const asg = getAssign(gid, d); const isToday = sameDay(d, today); const blocked = isBlocked(d);
            return (
              <div className="weekrow" key={i}>
                <div className={`daylab ${isToday ? "today" : ""}`}>
                  <b>{DOW[i]}</b><small>{d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</small>
                </div>
                <div className="pills">
                  {blocked ? <span className="pill blocked">🚫 {t("blocked")}</span> : (<>
                    {SLOTS.map((s) => {
                      const a = asg[s.idx];
                      if (a) return <a key={s.idx} className="pill assigned" title={t("jobSheet")} href={`/job-sheet?guideId=${guideId}&date=${ymd(d)}&slotIdx=${s.idx}`}>🔒 {a.tour} 📄</a>;
                      const busy = !!avd[s.idx]; const nm = isToday && s.idx === nowIdx ? " now" : "";
                      return <span key={s.idx} className={`pill ${busy ? "busy" : ""}${nm}`} onClick={() => toggleSlot(d, s.idx)}>{s.start}</span>;
                    })}
                    <button className="allbtn" onClick={() => {
                      const asg2 = getAssign(gid, d); const cur = getAvail(gid, d) ?? EMPTY;
                      // toggle day-off: if any slot is still free, mark the whole day busy; else clear
                      setDayAll(d, SLOTS.some((s) => !asg2[s.idx] && !cur[s.idx]));
                    }}>{t("dayOff")}</button>
                  </>)}
                </div>
              </div>
            );
          })}
        </div>
      </>
    );
  }

  function guideMonth(): ReactNode {
    const gid = guideId!;
    return (
      <>
        <div className="panel-head"><h2>{t("myMonth")}</h2><span className="hint">{t("monthHint")}</span></div>
        {calendar({
          onClick: (d) => { if (!isBlocked(d)) setModal({ kind: "dayedit", date: ymd(d) }); },
          tint: (d) => (isBlocked(d) ? "repeating-linear-gradient(45deg,#fbe6e2,#fbe6e2 5px,#f5d5cf 5px,#f5d5cf 10px)" : undefined),
          cell: (d) => {
            if (isBlocked(d)) return <><div className="dn">{d.getDate()}</div><div className="blk" style={{ marginTop: "auto" }}>🚫 {t("blocked")}</div></>;
            const avd = getAvail(gid, d) ?? EMPTY; const asg = getAssign(gid, d);
            const busyN = SLOTS.filter((s) => avd[s.idx] && !asg[s.idx]).length; const na = Object.keys(asg).length;
            return (
              <>
                <div className="dn">{d.getDate()}</div>
                <div className="fillbar"><i style={{ width: `${(busyN / SLOTS.length) * 100}%`, background: "#e07a6b" }} /></div>
                <div className="meta"><span style={busyN ? { color: "#b23b2e", fontWeight: 700 } : undefined}>{busyN ? `${busyN} ${t("busy").toLowerCase()}` : "—"}</span>{na ? <span className="asg">{na}🔒</span> : null}</div>
              </>
            );
          },
        })}
      </>
    );
  }

  function guideYear(): ReactNode {
    const gid = guideId!; const y = anchor.getFullYear(); const today = todayD();
    return (
      <>
        <div className="panel-head"><h2>{t("myYear")}</h2><span className="hint">{t("yearHint")}</span></div>
        <div className="year">
          {Array.from({ length: 12 }, (_, mo) => {
            const first = new Date(y, mo, 1); const lead = (first.getDay() + 6) % 7; const dim = new Date(y, mo + 1, 0).getDate();
            return (
              <div className="ymini" key={mo} onClick={() => { setAnchor(new Date(y, mo, 1)); setView("month"); }}>
                <h4>{MON[mo]}</h4>
                <div className="ygrid">
                  {Array.from({ length: lead }, (_, i) => <span key={`o${i}`} className="yd out" />)}
                  {Array.from({ length: dim }, (_, k) => {
                    const dn = k + 1; const d = new Date(y, mo, dn);
                    const avd = getAvail(gid, d) ?? EMPTY; const asg = getAssign(gid, d);
                    const busyN = SLOTS.filter((s) => avd[s.idx] && !asg[s.idx]).length; const na = Object.keys(asg).length;
                    let bg = "var(--grey-bg)";
                    if (na) bg = "var(--assign)"; else if (busyN) bg = `rgba(178,59,46,${0.2 + 0.6 * busyN / SLOTS.length})`;
                    return <span key={dn} className="yd" style={{ background: bg, boxShadow: sameDay(d, today) ? "0 0 0 1.5px var(--accent)" : undefined }} />;
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </>
    );
  }

  function opDay(): ReactNode {
    const d = anchor; const nowIdx = currentSlotIdx(); const isToday = sameDay(d, todayD()); const guides = ref?.guides ?? []; const blocked = isBlocked(d);
    let availNow = 0, assignTot = 0, busyTot = 0;
    for (const g of guides) {
      const avd = getAvail(g.guideId, d) ?? EMPTY; const asg = getAssign(g.guideId, d);
      for (let i = 0; i < SLOTS.length; i++) { if (asg[i]) continue; if (avd[i]) busyTot++; else availNow++; }
      assignTot += Object.keys(asg).length;
    }
    const ql = q.toLowerCase();
    const rows = guides.filter((g) => {
      if (ql && !g.displayName.toLowerCase().includes(ql) && !g.guideId.toLowerCase().includes(ql)) return false;
      if (onlyAvail) {
        const avd = getAvail(g.guideId, d) ?? EMPTY; // "only with busy"
        if (!avd.some(Boolean)) return false;
      }
      return true;
    });
    return (
      <>
        <div className="panel-head"><h2>{t("rosterDay")}</h2>
          <span className="hint">{d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</span>
          <div className="head-tools">
            <button className="btn sm primary" onClick={openNewOffer}>➕ {t("newOffer")}</button>
            <button className={`btn sm ${blocked ? "" : "danger"}`} onClick={() => toggleBlock(d)}>{blocked ? t("unblockDay") : t("blockDay")}</button>
          </div>
        </div>
        {blocked && <div className="blockbanner">🚫 {t("dayBlocked")}</div>}
        <div className="op-toolbar">
          <div className="stat g"><b>{availNow}</b><span>{t("freeSlots")}</span></div>
          <div className="stat a"><b>{assignTot}</b><span>{t("assigned")}</span></div>
          <div className="stat"><b>{busyTot}</b><span>{t("guidesPosted")}</span></div>
          <input className="search" placeholder={t("searchGuide")} value={q} onChange={(e) => setQ(e.target.value)} />
          <label style={{ fontSize: 12.5, fontWeight: 600, display: "flex", gap: 5, alignItems: "center" }}>
            <input type="checkbox" checked={onlyAvail} onChange={(e) => setOnlyAvail(e.target.checked)} /> {t("onlyAvail")}
          </label>
          <div className="legend">
            <span><i className="lg" />{t("legendFree")}</span>
            <span><i className="lo" />{t("legendOccupied")}</span>
            <span><i className="la" />{t("legendAssigned")}</span>
          </div>
        </div>
        <div className="grid-scroll">
          {rows.length ? (
            <table className="grid">
              <thead>
                <tr><th className="gname">Guide</th>{SLOTS.map((s) => <th key={s.idx} className={isToday && s.idx === nowIdx ? "now" : ""}>{s.start}</th>)}</tr>
              </thead>
              <tbody>
                {rows.map((g) => {
                  const avd = getAvail(g.guideId, d) ?? EMPTY; const asg = getAssign(g.guideId, d);
                  return (
                    <tr key={g.guideId}>
                      <td className="gname"><span className="gid">{g.guideId}</span>{g.displayName}</td>
                      {SLOTS.map((s) => {
                        const a = asg[s.idx]; const nm = isToday && s.idx === nowIdx ? " now" : "";
                        if (a) return <td key={s.idx} className={`cell assigned${nm}`} title={tourById[a.tour]?.name || a.tour} onClick={() => { if (!blocked) openAssign(g.guideId, s.idx, ymd(d)); }}><span className="ttag">{a.tour}</span></td>;
                        if (avd[s.idx]) return <td key={s.idx} className={`cell busy${nm}`} title={t("busy")} />;
                        return <td key={s.idx} className={`cell on${nm}`} title="Available — click to assign" onClick={() => { if (!blocked) openAssign(g.guideId, s.idx, ymd(d)); }} />;
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : <div className="op-empty">{t("noGuides")}</div>}
        </div>
      </>
    );
  }

  function opMonth(): ReactNode {
    const guides = ref?.guides ?? [];
    return (
      <>
        <div className="panel-head"><h2>{t("capacityMonth")}</h2><span className="hint">{t("capacityHint")}</span></div>
        {calendar({
          extraClass: "heat",
          tint: (d) => {
            if (isBlocked(d)) return "repeating-linear-gradient(45deg,#fbe6e2,#fbe6e2 5px,#f5d5cf 5px,#f5d5cf 10px)";
            let g = 0;
            for (const x of guides) { const avd = getAvail(x.guideId, d) ?? EMPTY; const asg = getAssign(x.guideId, d); if (SLOTS.some((s) => !avd[s.idx] && !asg[s.idx])) g++; }
            return g ? `rgba(31,157,87,${0.08 + 0.5 * Math.min(g, 15) / 15})` : undefined;
          },
          onClick: (d) => { setAnchor(d); setView("day"); },
          cell: (d) => {
            let g = 0, a = 0;
            for (const x of guides) {
              const avd = getAvail(x.guideId, d) ?? EMPTY; const asg = getAssign(x.guideId, d);
              if (SLOTS.some((s) => !avd[s.idx] && !asg[s.idx])) g++; a += Object.keys(asg).length;
            }
            return (
              <>
                <div className="dn">{d.getDate()}</div>
                <div className="heatval" style={{ color: g ? "var(--green)" : "var(--grey)" }}>{g || "—"}<small>{g ? t("guides") : ""}</small></div>
                {a ? <div className="meta"><span className="asg">{a}🔒</span></div> : null}
              </>
            );
          },
        })}
      </>
    );
  }

  // ============ OPERATOR: YEAR (12-month overview, next-year planning) ============
  function opYear(): ReactNode {
    const y = anchor.getFullYear();
    const guides = ref?.guides ?? [];
    return (
      <>
        <div className="panel-head"><h2>{t("capacityMonth")} · {y}</h2><span className="hint">{t("capacityHint")}</span></div>
        <div className="year">
          {Array.from({ length: 12 }, (_, mo) => {
            const mk = mkey(new Date(y, mo, 1));
            const avMonth = av[mk] || {}; const asMonth = as[mk] || {};
            let guidesOff = 0, assignedTot = 0;
            for (const g of guides) {
              const days = avMonth[g.guideId] || {};
              if (Object.values(days).some((arr) => arr.some(Boolean))) guidesOff++; // marked busy / day off
              const ad = asMonth[g.guideId] || {};
              for (const day of Object.values(ad)) assignedTot += Object.keys(day).length;
            }
            return (
              <div className="ymini" key={mo} onClick={() => { setAnchor(new Date(y, mo, 1)); setView("month"); }}>
                <h4>{MON[mo]}</h4>
                <div className="heatval" style={{ textAlign: "center", color: guidesOff ? "#b23b2e" : "var(--grey)" }}>
                  {guidesOff || "—"}<small>{guidesOff ? t("busy").toLowerCase() : ""}</small>
                </div>
                {assignedTot ? <div className="meta" style={{ justifyContent: "center" }}><span className="asg">{assignedTot}🔒</span></div> : null}
              </div>
            );
          })}
        </div>
      </>
    );
  }

  function modalBody(): ReactNode {
    if (!modal) return null;
    if (modal.kind === "dayedit") {
      const gid = guideId!; const d = parseYMD(modal.date);
      const avd = getAvail(gid, d) ?? EMPTY; const asg = getAssign(gid, d);
      return (
        <>
          <h3>{d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}</h3>
          <div className="mctx">{t("dayEditHint")}</div>
          <div className="mbody"><div className="dayedit">
            {SLOTS.map((s) => {
              const a = asg[s.idx];
              if (a) return <span key={s.idx} className="pill assigned">🔒 {s.start} · {a.tour}</span>;
              return <span key={s.idx} className={`pill ${avd[s.idx] ? "busy" : ""}`} onClick={() => toggleSlot(d, s.idx)}>{s.label}</span>;
            })}
          </div></div>
          <div className="mfoot">
            <button className="btn ghost" onClick={() => setDayAll(d, false)}>{t("clearDay")}</button>
            <button className="btn danger" onClick={() => setDayAll(d, true)}>{t("dayOff")}</button>
            <button className="btn dark" onClick={() => setModal(null)}>{t("done")}</button>
          </div>
        </>
      );
    }
    if (modal.kind === "newoffer") {
      const avail = availCountFor(oDate, oSlot);
      return (
        <>
          <h3>📣 {t("newOffer")}</h3>
          <div className="mctx">{t("newOfferHint")}</div>
          <div className="mbody">
            <div><label className="fl">{t("dateLabel")}</label>
              <input type="date" value={oDate} onChange={(e) => setODate(e.target.value)} />
            </div>
            <div><label className="fl">{t("timeSlot")}</label>
              <select value={oSlot} onChange={(e) => setOSlot(Number(e.target.value))}>
                {SLOTS.map((s) => <option key={s.idx} value={s.idx}>{s.start}</option>)}
              </select>
            </div>
            <div><label className="fl">{t("durationHrs")}</label>
              <input type="number" min={0} step={0.5} value={oDur} onChange={(e) => setODur(e.target.value)} placeholder="e.g. 3" />
              <div className="fieldhelp">{t("offerEnds")}: {timeRange(oSlot, oDur)}</div>
            </div>
            <div><label className="fl">{t("tour")}</label>
              <select value={fTour} onChange={(e) => setFTour(e.target.value)}>
                {(ref?.tours ?? []).map((x) => <option key={x.id} value={x.id}>{x.id} · {x.name} ({x.time})</option>)}
              </select>
            </div>
            <div><label className="fl">{t("paxOpt")}</label><input type="number" min={1} max={10} value={fPax} onChange={(e) => setFPax(e.target.value)} placeholder="e.g. 4" /></div>
            <div><label className="fl">{t("noteOpt")}</label><input value={fNote} onChange={(e) => setFNote(e.target.value)} placeholder="Bokun / GYG booking no." /></div>
            <div className="offeravail" style={{ marginTop: 4, fontWeight: 600, color: avail ? "var(--green, #1a7f37)" : "var(--red, #c0392b)" }}>
              {avail > 0 ? `✅ ${avail} ${t("guidesAvailable")}` : `⚠️ ${t("offerNoCandidates")}`}
            </div>
          </div>
          <div className="mfoot">
            <button className="btn ghost" onClick={() => setModal(null)}>{t("cancel")}</button>
            <button className="btn primary" disabled={avail === 0} onClick={doOfferForm}>📣 {t("sendOffer")}</button>
          </div>
        </>
      );
    }
    // assign
    const d = parseYMD(modal.date); const slot = SLOTS[modal.idx];
    const existing = getAssign(modal.gid, d)[modal.idx];
    const guideName = ref?.guides.find((g) => g.guideId === modal.gid)?.displayName ?? modal.gid;
    const ctx = `${guideName} · ${slot.label} · ${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`;
    if (existing) {
      const tt = tourById[existing.tour];
      return (
        <>
          <h3>{t("jobAssigned")}</h3>
          <div className="mctx">{ctx}</div>
          <div className="mbody"><div className="assigned-note">
            <b>{existing.tour}</b> — {tt?.name ?? ""}
            {existing.pax != null ? <><br />{t("pax")}: {existing.pax}</> : null}
            {existing.note ? <><br />{t("note")}: {existing.note}</> : null}
          </div></div>
          <div className="mfoot">
            <button className="btn danger" onClick={() => doUnassign(modal.gid, modal.idx, modal.date)}>{t("unassign")}</button>
            <a className="btn primary" href={`/job-sheet?guideId=${encodeURIComponent(modal.gid)}&date=${modal.date}&slotIdx=${modal.idx}`}>📄 {t("jobSheet")}</a>
            <button className="btn dark" onClick={() => setModal(null)}>{t("close")}</button>
          </div>
        </>
      );
    }
    return (
      <>
        <h3>{t("assignJob")}</h3>
        <div className="mctx">{ctx}</div>
        <div className="mbody">
          <div><label className="fl">{t("tour")}</label>
            <select value={fTour} onChange={(e) => setFTour(e.target.value)}>
              {(ref?.tours ?? []).map((x) => <option key={x.id} value={x.id}>{x.id} · {x.name} ({x.time})</option>)}
            </select>
          </div>
          <div><label className="fl">{t("paxOpt")}</label><input type="number" min={0} value={fPax} onChange={(e) => setFPax(e.target.value)} placeholder="e.g. 4" /></div>
          <div><label className="fl">{t("noteOpt")}</label><input value={fNote} onChange={(e) => setFNote(e.target.value)} placeholder="Bokun / GYG booking no." /></div>
        </div>
        <div className="mfoot">
          <button className="btn ghost" onClick={() => setModal(null)}>{t("cancel")}</button>
          <button className="btn" onClick={doOffer}>📣 {t("offerBtn")}</button>
          <button className="btn primary" onClick={doAssign}>{t("assignBtn")}</button>
        </div>
      </>
    );
  }

  const tabs: [string, string][] = role === "guide"
    ? [["schedule", t("schedule")], ["week", t("week")], ["month", t("month")], ["year", t("year")]]
    : [["day", t("day")], ["month", t("month")], ["year", t("year")]];

  return (
    <div className="wrap">
      <header className="app">
        <div className="brand"><div className="kicker">{t("kicker")}</div><h1>{t("appTitle")}</h1></div>
        <div className="spacer" />
        <div className="live"><span className="dot" /><span>{changed ? `${t("updated")} ${clock}` : `${t("live")} · ${clock}`}</span></div>
        <button className="btn sm ghost" onClick={() => setLang(lang === "en" ? "th" : "en")}>{lang === "en" ? "ไทย" : "EN"}</button>
        <button className="btn sm" style={{ position: "relative" }} onClick={openNotif} type="button" title={t("notifications")}>🔔{notif.unread > 0 && <span className="navbadge">{notif.unread}</span>}</button>
        {role === "guide" && <a className="btn sm" href="/profile">{t("myDetails")}</a>}
        {role === "operator" && <a className="btn sm" href="/jobs">🧭 {t("jobsNav")}</a>}
        {role === "operator" && <a className="btn sm" href="/bookings">📥 {t("bookings")}</a>}
        {role === "operator" && (
          <a className="btn sm" href="/admin" style={{ position: "relative" }}>
            {t("accountsTitle")}
            {pendingCount > 0 && <span className="navbadge" title={`${pendingCount} pending sign-up(s)`}>{pendingCount}</span>}
          </a>
        )}
        <div className="chip">
          <div className="who"><small>{role === "guide" ? t("signedInGuide") : t("signedInOperator")}</small><span>{role === "guide" ? displayName : t("operations")}</span></div>
          <button className="btn sm ghost" onClick={async () => { await fetch("/api/session/logout", { method: "POST" }); signOut({ callbackUrl: "/start" }); }} type="button">{t("signOut")}</button>
        </div>
      </header>

      <div id="appBar">
        <div className="vtabs">
          {tabs.map(([v, label]) => <button key={v} className={`vtab ${v === view ? "active" : ""}`} onClick={() => setView(v)}>{label}</button>)}
        </div>
        <div className="nav">
          <button className="btn ico-btn" onClick={() => navBy(-1)}>‹</button>
          <span className="period">{periodLabel()}</span>
          <button className="btn ico-btn" onClick={() => navBy(1)}>›</button>
          <button className="btn sm" onClick={() => setAnchor(todayD())}>{t("today")}</button>
        </div>
      </div>

      {role === "guide" && !profileGate.complete && (
        <section className="profile-gate">
          <div>
            <b>📝 {t("completeProfileTitle")}</b>
            <div style={{ fontSize: 13, marginTop: 4 }}>{t("completeProfileBody")}{profileGate.missing.length ? ` (${t("missing")}: ${profileGate.missing.join(", ")})` : ""}</div>
          </div>
          <a className="btn primary" href="/profile">{t("myDetails")}</a>
        </section>
      )}

      {role === "guide" && offers.length > 0 && (
        <section className="offers-banner">
          <h3>🧭 {t("jobOffers")} ({offers.length})</h3>
          {offers.map((o) => (
            <div key={o.id} className="offer-card">
              <div className="offer-info">
                <b>{o.tourName}</b>
                <div className="offer-meta">{o.date} · {o.time}{o.pax != null ? ` · ${o.pax} pax` : ""}{o.note ? ` · ${o.note}` : ""}</div>
              </div>
              <div className="offer-actions">
                <button className="btn sm primary" onClick={() => respondOffer(o.id, "accept")}>✅ {t("accept")}</button>
                <button className="btn sm ghost" onClick={() => respondOffer(o.id, "deny")}>{t("deny")}</button>
              </div>
            </div>
          ))}
        </section>
      )}

      <section className="panel">
        {role === "guide"
          ? (view === "schedule" ? guideSchedule() : view === "week" ? guideWeek() : view === "month" ? guideMonth() : guideYear())
          : (view === "day" ? opDay() : view === "month" ? opMonth() : opYear())}
      </section>

      <div className="footnote">{t("footnote1")}<br />{t("footnote2")}</div>

      {modal && (
        <div className="scrim show" onClick={(e) => { if (e.target === e.currentTarget) setModal(null); }}>
          <div className="modal">{modalBody()}</div>
        </div>
      )}

      {showNotif && (
        <div className="scrim show" onClick={(e) => { if (e.target === e.currentTarget) setShowNotif(false); }}>
          <div className="modal">
            <h3>{t("notifications")}</h3>
            <div className="mbody">
              {notif.items.length ? notif.items.map((i) => (
                <div key={i.id} className="assigned-note" style={{ background: "var(--grey-bg)", borderColor: "var(--line)" }}>
                  {i.message}<br /><small style={{ color: "var(--ink-soft)" }}>{new Date(i.createdAt).toLocaleString()}</small>
                </div>
              )) : <div className="op-empty">{t("noNotifications")}</div>}
            </div>
            <div className="mfoot">
              {notif.items.length > 0 && <button className="btn ghost" onClick={clearNotif}>{t("clearAll")}</button>}
              <button className="btn dark" onClick={() => setShowNotif(false)}>{t("close")}</button>
            </div>
          </div>
        </div>
      )}

      <div className={`toast ${toastMsg ? "show" : ""}`}>{toastMsg}</div>
    </div>
  );
}
