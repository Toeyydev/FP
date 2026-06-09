"use client";

import { signOut } from "next-auth/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useLang } from "@/components/Providers";
import GuideWelcome from "@/components/GuideWelcome";
import AvailabilityLegend from "@/components/AvailabilityLegend";
import { SLOTS } from "@/lib/slots";
import { guidesNeeded, SPLIT_AT } from "@/lib/capacity";
import { gcalUrl } from "@/lib/gcal";
import {
  DOW, MON, addDays, addMonths, currentSlotIdx, mkey, parseYMD,
  sameDay, todayD, uniq, weekStart, ymd,
} from "@/lib/dates";

type Role = "guide" | "operator";
type Job = { tour: string; pax: number | null; note: string | null };
type Ref = {
  guides: { guideId: string; displayName: string }[];
  tours: { id: string; name: string; time: string; durationMin?: number | null }[];
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

function urlB64ToUint8(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const b64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

export default function AppClient({
  role, guideId, displayName,
}: { role: Role; isAdmin?: boolean; guideId: string | null; displayName: string }) {
  const { t, lang, setLang } = useLang();
  const [view, setView] = useState<string>(role === "guide" ? "schedule" : "day");
  // Allow ?view=week deep-links (e.g. the mobile bottom-nav "Availability" tab).
  useEffect(() => {
    const v = new URLSearchParams(window.location.search).get("view");
    if (v && ["schedule", "week", "month", "year", "day"].includes(v)) setView(v);
  }, []);
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
  const [offers, setOffers] = useState<{ id: string; tourName: string; date: string; time: string; pax: number | null; note: string | null; meetingPoint: string | null }[]>([]);
  const [schedule, setSchedule] = useState<{ date: string; slotIdx: number; time: string; tourId: string; tourName: string; pax: number | null; note: string | null; meetingPoint: string | null; durationMin: number | null; checkinState: string | null }[]>([]);
  const [reportFor, setReportFor] = useState<{ date: string; slotIdx: number; tourName: string; pax: number | null } | null>(null);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [lFrom, setLFrom] = useState(""); const [lTo, setLTo] = useState(""); const [lReason, setLReason] = useState("");
  const [myLeaves, setMyLeaves] = useState<{ id: string; fromDate: string; toDate: string; status: string }[]>([]);
  const [opLeaves, setOpLeaves] = useState<{ guideId: string; fromDate: string; toDate: string; status: string }[]>([]);
  const [payDue, setPayDue] = useState<{ pending: number; approved: number }>({ pending: 0, approved: 0 });
  const [rNoShow, setRNoShow] = useState("0");
  const [rLeft, setRLeft] = useState("0");
  const [rComment, setRComment] = useState("");
  const [profileGate, setProfileGate] = useState<{ complete: boolean; missing: string[] }>({ complete: true, missing: [] });
  const [alertsOn, setAlertsOn] = useState(true); // hide banner until we know
  const [installed, setInstalled] = useState(true); // home-screen install state
  const [showNotif, setShowNotif] = useState(false);
  // assign-form state lives here (not in a child) so a poll re-render never wipes it
  const [fTour, setFTour] = useState("");
  const [fPax, setFPax] = useState("");
  const [fNote, setFNote] = useState("");
  // dedicated "new job offer" form state
  const [oDate, setODate] = useState("");
  const [oSlot, setOSlot] = useState(0);
  const [oDur, setODur] = useState("3"); // tour duration in hours
  const [oGuide, setOGuide] = useState(""); // "" = all available; or a specific guideId

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
  // signed up / accepted a job, an offer expired). Operators get a chime on a NEW
  // notification (e.g. a sign-up) so they can approve anytime the app is open.
  const seenNotifRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    const f = () => fetch("/api/notifications", { cache: "no-store" }).then((r) => r.json()).then((d) => {
      setNotif(d);
      if (role === "operator") {
        const ids: string[] = (d.items ?? []).map((i: { id: string }) => i.id);
        if (seenNotifRef.current && ids.some((id) => !seenNotifRef.current!.has(id))) playChime();
        seenNotifRef.current = new Set(ids);
      }
    }).catch(() => {});
    f();
    const id = window.setInterval(f, 15000);
    return () => window.clearInterval(id);
  }, [role]);

  // Guide: must complete account details before setting availability.
  useEffect(() => {
    if (role !== "guide") return;
    fetch("/api/profile/status", { cache: "no-store" }).then((r) => r.json()).then(setProfileGate).catch(() => {});
  }, [role]);

  // Are home-screen alerts already on for this device? (guides + operators)
  useEffect(() => {
    if (!role) return;
    const supported = typeof window !== "undefined" && "Notification" in window && "PushManager" in window && "serviceWorker" in navigator;
    setAlertsOn(!supported || Notification.permission === "granted");
    const standalone = window.matchMedia?.("(display-mode: standalone)").matches
      || (window.navigator as unknown as { standalone?: boolean }).standalone === true;
    setInstalled(Boolean(standalone));
  }, [role]);

  async function enableAlerts() {
    try {
      if (!("Notification" in window) || !("PushManager" in window) || !("serviceWorker" in navigator)) {
        toast(t("alertsNeedInstall")); return;
      }
      const perm = await Notification.requestPermission();
      if (perm !== "granted") { toast(t("alertsDenied")); return; }
      const { key } = await fetch("/api/push/subscribe").then((r) => r.json());
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(key) as unknown as BufferSource });
      await fetch("/api/push/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subscription: sub.toJSON() }) });
      setAlertsOn(true);
      toast(t("alertsOn"));
    } catch { toast(t("alertsNeedInstall")); }
  }

  // Guide: load their upcoming confirmed tours (schedule).
  useEffect(() => {
    if (role !== "guide") return;
    const f = () => fetch("/api/schedule", { cache: "no-store" }).then((r) => r.json()).then((d) => setSchedule(d.items ?? [])).catch(() => {});
    f();
    const id = window.setInterval(f, 15000);
    return () => window.clearInterval(id);
  }, [role]);

  // A short chime when a new job offer arrives (Web Audio — no asset needed).
  const audioCtxRef = useRef<AudioContext | null>(null);
  const seenOffersRef = useRef<Set<string> | null>(null);
  // Presence heartbeat — tell the server we're online while the app is open.
  useEffect(() => {
    if (!role) return;
    const ping = () => { fetch("/api/presence/ping", { method: "POST" }).catch(() => {}); };
    ping();
    const id = window.setInterval(() => { if (!document.hidden) ping(); }, 60000);
    return () => window.clearInterval(id);
  }, [role]);

  // Browsers block sound until the user interacts — unlock on the first tap.
  useEffect(() => {
    if (!role) return;
    const unlock = () => {
      try {
        const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!audioCtxRef.current) audioCtxRef.current = new AC();
        audioCtxRef.current.resume();
      } catch { /* ignore */ }
      window.removeEventListener("pointerdown", unlock);
    };
    window.addEventListener("pointerdown", unlock);
    return () => window.removeEventListener("pointerdown", unlock);
  }, [role]);
  function playChime() {
    try {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!audioCtxRef.current) audioCtxRef.current = new AC();
      const ctx = audioCtxRef.current;
      if (ctx.state === "suspended") ctx.resume();
      [0, 0.18].forEach((delay, i) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.connect(g); g.connect(ctx.destination);
        o.type = "sine"; o.frequency.value = i === 0 ? 784 : 1047; // G5 then C6
        const start = ctx.currentTime + delay;
        g.gain.setValueAtTime(0.0001, start);
        g.gain.exponentialRampToValueAtTime(0.35, start + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, start + 0.32);
        o.start(start); o.stop(start + 0.34);
      });
    } catch { /* ignore (autoplay not unlocked yet) */ }
  }

  // Guide: poll open job offers they can Accept/Deny in-app — chime on a new one.
  const loadOffers = useCallback(() => {
    if (role !== "guide") return;
    fetch("/api/offers/mine", { cache: "no-store" }).then((r) => r.json()).then((d) => {
      const ofs = (d.offers ?? []) as { id: string; tourName: string; date: string; time: string; pax: number | null; note: string | null; meetingPoint: string | null }[];
      setOffers(ofs);
      const ids = new Set(ofs.map((o) => o.id));
      if (seenOffersRef.current && ofs.some((o) => !seenOffersRef.current!.has(o.id))) playChime();
      seenOffersRef.current = ids;
    }).catch(() => {});
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

  // Slots where a guide has two tours whose time ranges OVERLAP (double-booked).
  // Uses each tour's duration so a 4h tour at 13:30 conflicts with one at 15:00.
  const conflictSlots = (gid: string, d: Date): Set<number> => {
    const asg = getAssign(gid, d);
    const iv = Object.keys(asg).map((k) => {
      const i = Number(k); const [h, m] = (SLOTS[i]?.start ?? "00:00").split(":").map(Number);
      const start = h * 60 + m; const dur = tourById[asg[i].tour]?.durationMin ?? 180;
      return { i, start, end: start + dur };
    });
    const bad = new Set<number>();
    for (let a = 0; a < iv.length; a++) for (let b = a + 1; b < iv.length; b++)
      if (iv[a].start < iv[b].end && iv[b].start < iv[a].end) { bad.add(iv[a].i); bad.add(iv[b].i); }
    return bad;
  };
  const isBlocked = (d: Date): boolean => blockedDates.has(ymd(d));

  // ---- mutations ----
  // Availability auto-saves on every tap; saveState drives the Save bar so the
  // guide always sees that their changes are stored.
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  async function putAvail(d: Date, slots: boolean[]) {
    if (!profileGate.complete) { toast(t("completeProfileFirst")); return; }
    setSaveState("saving");
    try {
      await fetch("/api/availability", {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ date: ymd(d), slots }),
      });
      await load();
      setSaveState("saved");
    } catch { setSaveState("idle"); }
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
    if (fPax && Number(fPax) > 50) { toast(t("offerPaxMax")); return; }
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
    setODate(ymd(anchor)); setOSlot(0); setODur("3"); setOGuide("");
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
    if (fPax && Number(fPax) > 50) { toast(t("offerPaxMax")); return; }
    const durMin = oDur && Number(oDur) > 0 ? Math.round(Number(oDur) * 60) : undefined;
    const r = await fetch("/api/offers", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tourId: fTour, date: oDate, slotIdx: oSlot, durationMin: durMin, pax: fPax ? Number(fPax) : undefined, note: fNote.trim() || undefined, guideId: oGuide || undefined }),
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
  // Render a notification as clean rows: bold header, plain rows, and a financial
  // sub-card for any money lines (Net guide fee highlighted). Emojis stripped.
  function notifCard(i: { id: string; message: string; createdAt: string }): ReactNode {
    const lines = i.message
      .replace(/[\p{Extended_Pictographic}─-╿]/gu, "") // emoji + box-drawing
      .split("\n").map((s) => s.trim()).filter(Boolean);
    const money = lines.filter((l) => l.includes("฿"));
    const text = lines.filter((l) => !l.includes("฿"));
    const head = text[0] ?? "";
    const rows = text.slice(1);
    return (
      <div key={i.id} className="notif-card">
        {head && <div className="nc-head">{head}</div>}
        {rows.map((r, n) => <div key={n} className="nc-row">{r}</div>)}
        {money.length > 0 && (
          <div className="nc-money">
            {money.map((m, n) => {
              const mt = m.match(/^(.*?)(฿\s?-?[\d,.]+)\s*$/);
              const label = (mt ? mt[1] : m).replace(/[·•\s]+$/, "").trim();
              const amount = mt ? mt[2] : "";
              const net = /net|guide fee|รับ|ค่าตอบแทน/i.test(label);
              return <div key={n} className={`nc-money-row${net ? " net" : ""}`}><span>{label}</span><span>{amount}</span></div>;
            })}
          </div>
        )}
        <div className="nc-time">{new Date(i.createdAt).toLocaleString()}</div>
      </div>
    );
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
  // Capture GPS (best-effort) and record a lifecycle check-in for a tour.
  async function doCheckin(s: { date: string; slotIdx: number }, type: "ARRIVE" | "START" | "COMPLETE") {
    const refresh = () => fetch("/api/schedule", { cache: "no-store" }).then((r) => r.json()).then((d) => setSchedule(d.items ?? [])).catch(() => {});
    const post = (lat?: number, lng?: number, accuracyM?: number) =>
      fetch("/api/checkin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ date: s.date, slotIdx: s.slotIdx, type, lat, lng, accuracyM }) })
        .then((r) => r.ok ? refresh() : toast(t("errGeneric")));
    if (typeof navigator !== "undefined" && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (p) => post(p.coords.latitude, p.coords.longitude, Math.round(p.coords.accuracy)),
        () => post(), { enableHighAccuracy: true, timeout: 8000 },
      );
    } else { await post(); }
  }
  const CHECK_NEXT: Record<string, { type: "ARRIVE" | "START" | "COMPLETE"; label: string } | null> = {
    none: { type: "ARRIVE", label: t("checkIn") },
    ARRIVE: { type: "START", label: t("startTour") },
    START: { type: "COMPLETE", label: t("completeTour") },
    COMPLETE: null,
  };
  // Check-in opens 90 min before the tour (prevents starting/completing days early).
  const tourStartMs = (date: string, time: string) => {
    const [y, mo, d] = date.split("-").map(Number); const [h, m] = (time || "00:00").split(":").map(Number);
    return Date.UTC(y, mo - 1, d, h, m) - 7 * 3600 * 1000;
  };
  const checkInOpen = (date: string, time: string) => Date.now() >= tourStartMs(date, time) - 90 * 60 * 1000;
  // Whether to show the lifecycle action: ARRIVE is time-gated; once started, always.
  const showAction = (s: { date: string; time: string; checkinState: string | null }, next: { type: string } | null) =>
    !!next && (next.type !== "ARRIVE" || checkInOpen(s.date, s.time));
  function openReport(s: { date: string; slotIdx: number; tourName: string; pax: number | null }) {
    setRNoShow("0"); setRLeft("0"); setRComment(""); setReportFor(s);
  }
  async function submitReport() {
    if (!reportFor) return;
    const r = await fetch("/api/report", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ date: reportFor.date, slotIdx: reportFor.slotIdx, bookedPax: reportFor.pax ?? undefined, noShow: Number(rNoShow) || 0, leftEarly: Number(rLeft) || 0, comments: rComment.trim() || undefined }),
    });
    if (r.ok) { setReportFor(null); toast(t("reportSubmitted")); fetch("/api/schedule", { cache: "no-store" }).then((x) => x.json()).then((d) => setSchedule(d.items ?? [])); }
    else toast(t("errGeneric"));
  }

  const loadLeaves = useCallback(() => {
    if (role !== "guide") return;
    fetch("/api/leave", { cache: "no-store" }).then((r) => r.json()).then((d) => setMyLeaves(d.leaves ?? [])).catch(() => {});
  }, [role]);
  useEffect(() => { loadLeaves(); }, [loadLeaves]);
  useEffect(() => {
    if (role !== "operator") return;
    fetch("/api/leave?view=ops", { cache: "no-store" }).then((r) => r.json()).then((d) => setOpLeaves((d.leaves ?? []).filter((l: { status: string }) => l.status === "APPROVED"))).catch(() => {});
  }, [role]);
  useEffect(() => {
    if (role !== "guide") return;
    fetch("/api/pay", { cache: "no-store" }).then((r) => r.json()).then((d) => setPayDue({ pending: d.totals?.pending ?? 0, approved: d.totals?.approved ?? 0 })).catch(() => {});
  }, [role]);
  const onLeave = (gid: string, dateStr: string) => opLeaves.some((l) => l.guideId === gid && l.fromDate <= dateStr && l.toDate >= dateStr);
  async function submitLeave() {
    if (!lFrom || !lTo) { toast(t("pickDates")); return; }
    const r = await fetch("/api/leave", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fromDate: lFrom, toDate: lTo, reason: lReason.trim() || undefined }) });
    if (r.ok) { setLeaveOpen(false); setLFrom(""); setLTo(""); setLReason(""); toast(t("leaveRequested")); loadLeaves(); }
    else toast(t("errGeneric"));
  }

  // The 7:30 AM answer — the imminent tour, front and centre.
  function nextTourHero(): ReactNode {
    const s = schedule.find((x) => x.checkinState !== "COMPLETE");
    if (!s) return null;
    const [y, mo, d] = s.date.split("-").map(Number);
    const [h, m] = (s.time || "00:00").split(":").map(Number);
    const startMs = Date.UTC(y, mo - 1, d, h, m) - 7 * 3600 * 1000;
    const diff = startMs - Date.now();
    let when: string;
    if (s.checkinState === "START") when = t("inProgress");
    else if (diff <= 0) when = t("startingNow");
    else { const mins = Math.round(diff / 60000); when = mins < 60 ? t("startsIn").replace("{x}", `${mins}m`) : t("startsIn").replace("{x}", `${Math.floor(mins / 60)}h ${mins % 60}m`); }
    const next = CHECK_NEXT[s.checkinState ?? "none"];
    const fmt = (x: string) => new Date(`${x}T00:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
    return (
      <section className="nexttour">
        <div className="nt-kicker">{t("nextTour")} · {when}</div>
        <h2>{s.tourName}</h2>
        <div className="nt-meta">🕐 {fmt(s.date)} · {s.time}{s.pax != null ? ` · 👥 ${s.pax} ${t("guests")}` : ""}</div>
        {s.meetingPoint && <div className="nt-meet">📍 {s.meetingPoint} <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(s.meetingPoint)}`} target="_blank" rel="noreferrer">{t("openMap")}</a></div>}
        <div className="nt-meet"><a href={gcalUrl({ title: `Folkpaths — ${s.tourName}`, date: s.date, slotIdx: s.slotIdx, durationMin: s.durationMin, location: s.meetingPoint ?? undefined, details: `${s.pax != null ? `${s.pax} pax · ` : ""}Folkpaths tour` })} target="_blank" rel="noreferrer">{t("addToCalendar")}</a></div>
        {showAction(s, next) && next && <button className="btn primary nt-action" onClick={() => next.type === "COMPLETE" ? openReport(s) : doCheckin(s, next.type)}>{next.label}</button>}
        {next && next.type === "ARRIVE" && !checkInOpen(s.date, s.time) && <div className="nt-locked">🔒 {t("checkInOpens")} {s.time}</div>}
      </section>
    );
  }

  function guideSchedule(): ReactNode {
    const fmt = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
    return (
      <>
        <div className="panel-head"><h2>{t("myTours")}</h2><span className="hint">{t("scheduleHint")}</span></div>
        <div style={{ padding: 14 }}>
          {schedule.length === 0 ? <div className="op-empty">{t("noUpcoming")}</div> : schedule.map((s, i) => {
            const next = CHECK_NEXT[s.checkinState ?? "none"];
            return (
            <div key={i} className="sched-card" style={{ cursor: "default" }}>
              <div className="sched-when"><b>{fmt(s.date)}</b><span>{s.time}</span></div>
              <div className="sched-mid">
                <b>{s.tourName}</b>
                <div className="sched-sub">{s.pax != null ? `👥 ${s.pax} pax` : ""}{s.note ? ` · 📝 ${s.note}` : ""}</div>
                {s.meetingPoint && <div className="sched-meet">📍 {s.meetingPoint} <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(s.meetingPoint)}`} target="_blank" rel="noreferrer">{t("openMap")}</a></div>}
                <div className="sched-meet"><a href={gcalUrl({ title: `Folkpaths — ${s.tourName}`, date: s.date, slotIdx: s.slotIdx, durationMin: s.durationMin, location: s.meetingPoint ?? undefined, details: `${s.pax != null ? `${s.pax} pax · ` : ""}Folkpaths tour` })} target="_blank" rel="noreferrer">{t("addToCalendar")}</a></div>
                {s.checkinState && <div className="sched-state">{s.checkinState === "ARRIVE" ? `✓ ${t("checkedIn")}` : s.checkinState === "START" ? `● ${t("inProgress")}` : `✓ ${t("tourDone")}`}</div>}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
                {showAction(s, next) && next && <button className="btn sm primary" onClick={() => next.type === "COMPLETE" ? openReport(s) : doCheckin(s, next.type)}>{next.label}</button>}
                {next && next.type === "ARRIVE" && !checkInOpen(s.date, s.time) && <span style={{ fontSize: 11, color: "var(--ink-soft)", fontWeight: 600 }}>{t("checkInOpens")} {s.time}</span>}
                <div style={{ display: "flex", gap: 6 }}>
                  <a className="btn sm" href={`/job-sheet?guideId=${guideId}&date=${s.date}&slotIdx=${s.slotIdx}`}>📄</a>
                  {!s.checkinState && <button className="btn sm danger" onClick={() => cancelTour(s)}>{t("cancelTour")}</button>}
                </div>
              </div>
            </div>
            );
          })}
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
            <button className="btn sm" onClick={() => setLeaveOpen(true)}>{t("requestLeave")}</button>
          </div>
        </div>
        <AvailabilityLegend />
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
        <div className="savebar">
          <span className="savebar-status">
            {saveState === "saving" ? t("saving") : `${t("allSaved")} ✓`}
          </span>
          <button className="btn primary" disabled={saveState === "saving"}
            onClick={async () => { setSaveState("saving"); await load(); setSaveState("saved"); toast(t("saved")); }}>
            {t("saveChanges")}
          </button>
        </div>
      </>
    );
  }

  function guideMonth(): ReactNode {
    const gid = guideId!;
    return (
      <>
        <div className="panel-head"><h2>{t("myMonth")}</h2><span className="hint">{t("monthHint")}</span></div>
        <AvailabilityLegend />
        {calendar({
          onClick: (d) => { if (!isBlocked(d)) setModal({ kind: "dayedit", date: ymd(d) }); },
          tint: (d) => (isBlocked(d) ? "repeating-linear-gradient(45deg,#fbe6e2,#fbe6e2 5px,#f5d5cf 5px,#f5d5cf 10px)" : undefined),
          cell: (d) => {
            if (isBlocked(d)) return <><div className="dn">{d.getDate()}</div><div className="blk" style={{ marginTop: "auto" }}>🚫 {t("blocked")}</div></>;
            const avd = getAvail(gid, d) ?? EMPTY; const asg = getAssign(gid, d);
            const busyN = SLOTS.filter((s) => avd[s.idx] && !asg[s.idx]).length; const na = Object.keys(asg).length;
            const dayOff = busyN === SLOTS.length && na === 0; // whole day blocked off
            return (
              <>
                <div className="dn">{d.getDate()}</div>
                {dayOff ? (
                  <div className="dayoff-block">{t("dayOff")}</div>
                ) : (
                  <>
                    <div className="fillbar"><i style={{ width: `${(busyN / SLOTS.length) * 100}%`, background: "#e07a6b" }} /></div>
                    <div className="meta"><span style={busyN ? { color: "#b23b2e", fontWeight: 700 } : undefined}>{busyN ? `${busyN} ${t("busy").toLowerCase()}` : "—"}</span>{na ? <span className="asg">{na}</span> : null}</div>
                  </>
                )}
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
    // Count GUIDES (not slots) for the day:
    //   available = has ≥1 open slot · assigned = has a job ·
    //   busy = some slots busy but not the whole day · day off = whole day blocked.
    let availGuides = 0, assignGuides = 0, busyGuides = 0, dayOffGuides = 0, conflictTot = 0;
    for (const g of guides) {
      const avd = getAvail(g.guideId, d) ?? EMPTY; const asg = getAssign(g.guideId, d);
      let busySlots = 0, free = 0;
      for (let i = 0; i < SLOTS.length; i++) { if (asg[i]) continue; if (avd[i]) busySlots++; else free++; }
      const assignedN = Object.keys(asg).length;
      const dayOff = busySlots === SLOTS.length && assignedN === 0; // whole day blocked → day off
      if (!blocked && free > 0) availGuides++;
      if (assignedN > 0) assignGuides++;
      if (busySlots > 0 && !dayOff) busyGuides++;
      if (dayOff) dayOffGuides++;
      if (conflictSlots(g.guideId, d).size) conflictTot++;
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
          <div className="stat g"><b>{availGuides}</b><span>{t("guidesAvailable")}</span></div>
          <div className="stat a"><b>{assignGuides}</b><span>{t("assigned")}</span></div>
          <div className="stat"><b>{busyGuides}</b><span>{t("busy")}</span></div>
          <div className="stat"><b>{dayOffGuides}</b><span>{t("dayOff")}</span></div>
          {conflictTot > 0 && <div className="stat c"><b>⚠ {conflictTot}</b><span>{t("conflicts")}</span></div>}
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
                  const conf = conflictSlots(g.guideId, d);
                  const leave = onLeave(g.guideId, ymd(d));
                  return (
                    <tr key={g.guideId}>
                      <td className="gname"><span className="gid">{g.guideId}</span>{g.displayName}{leave && <span className="leave-badge">{t("onLeave")}</span>}</td>
                      {SLOTS.map((s) => {
                        const a = asg[s.idx]; const nm = isToday && s.idx === nowIdx ? " now" : "";
                        if (a) { const c = conf.has(s.idx); return <td key={s.idx} className={`cell assigned${c ? " conflict" : ""}${nm}`} title={c ? t("conflictWarn") : (tourById[a.tour]?.name || a.tour)} onClick={() => { if (!blocked) openAssign(g.guideId, s.idx, ymd(d)); }}><span className="ttag">{c ? "⚠ " : ""}{a.tour}</span></td>; }
                        if (leave) return <td key={s.idx} className={`cell leave${nm}`} title={t("onLeave")} />;
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
            <div><label className="fl">{t("sendTo")}</label>
              <select value={oGuide} onChange={(e) => setOGuide(e.target.value)}>
                <option value="">{t("allAvailableGuides")}</option>
                {(ref?.guides ?? []).map((g) => <option key={g.guideId} value={g.guideId}>{g.guideId} · {g.displayName}</option>)}
              </select>
            </div>
            <div><label className="fl">{t("paxOpt")}</label><input type="number" min={1} max={50} value={fPax} onChange={(e) => setFPax(e.target.value)} placeholder="e.g. 4" /></div>
            <div><label className="fl">{t("noteOpt")}</label><input value={fNote} onChange={(e) => setFNote(e.target.value)} placeholder="Bokun / GYG booking no." /></div>
            {Number(fPax) >= SPLIT_AT && (
              <div style={{ marginTop: 4, fontWeight: 600, fontSize: 12.5, color: "var(--danger)" }}>
                ⚠ {fPax} pax — this is a {guidesNeeded(Number(fPax))}-guide tour. Offer, then assign {guidesNeeded(Number(fPax)) - 1} more.
              </div>
            )}
            <div className="offeravail" style={{ marginTop: 4, fontWeight: 600, color: (oGuide || avail > 0) ? "var(--green, #1a7f37)" : "var(--red, #c0392b)" }}>
              {oGuide ? `📨 ${t("offerToOne")}` : avail > 0 ? `✅ ${avail} ${t("guidesAvailable")}` : `⚠️ ${t("offerNoCandidates")}`}
            </div>
          </div>
          <div className="mfoot">
            <button className="btn ghost" onClick={() => setModal(null)}>{t("cancel")}</button>
            <button className="btn primary" disabled={!oGuide && avail === 0} onClick={doOfferForm}>📣 {t("sendOffer")}</button>
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
        <button className="iconbtn" style={{ position: "relative" }} onClick={openNotif} type="button" title={t("notifications")} aria-label={t("notifications")}>
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" /></svg>
          {notif.unread > 0 && <span className="navbadge">{notif.unread}</span>}
        </button>
        <nav className="topnav">
          {role === "guide" && <a className="navlink" href="/pay">{t("payNav")}</a>}
          {role === "guide" && <a className="navlink" href="/profile">{t("myDetails")}</a>}
          {role === "operator" && <a className="navlink" href="/dashboard">{t("dashboardNav")}</a>}
          {role === "operator" && <a className="navlink" href="/jobs">{t("jobsNav")}</a>}
          {role === "operator" && <a className="navlink" href="/bookings">{t("bookings")}</a>}
          {role === "operator" && <a className="navlink" href="/payments">{t("paymentsNav")}</a>}
          {role === "operator" && <a className="navlink" href="/reports">{t("reportsNav")}</a>}
          {role === "operator" && <a className="navlink" href="/pay">{t("approvalsNav")}</a>}
          {role === "operator" && <a className="navlink" href="/tour-log">{t("tourLogNav")}</a>}
          {role === "operator" && <a className="navlink" href="/guides">{t("guidesNav")}</a>}
          {role === "operator" && <a className="navlink" href="/meeting-points">{t("meetingPtsNav")}</a>}
          {role === "operator" && <a className="navlink" href="/product-map">{t("productMapNav")}</a>}
          {role === "operator" && (
            <a className="navlink" href="/admin" style={{ position: "relative" }}>
              {t("accountsTitle")}
              {pendingCount > 0 && <span className="navbadge" title={`${pendingCount} pending sign-up(s)`}>{pendingCount}</span>}
            </a>
          )}
        </nav>
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

      {/* Active-tour reminder: appears the moment a guide checks in / starts, and
          stays until they mark the tour done. */}
      {role === "guide" && (() => {
        const active = schedule.find((s) => s.checkinState === "ARRIVE" || s.checkinState === "START");
        if (!active) return null;
        return (
          <div className="active-tour" role="alert">
            <span className="at-dot" />
            <div className="at-text">
              <b>{t("tourInProgress")}</b>
              <span>{active.tourName} · {active.time}. {t("markDoneWhenEnds")}</span>
            </div>
            <button className="btn primary at-btn" onClick={() => openReport(active)}>{t("completeTour")}</button>
          </div>
        );
      })()}

      {role === "guide" && <GuideWelcome />}

      {!alertsOn && (
        <section className="setup-card">
          <div className="setup-head"><b>{role === "operator" ? t("setupTitleOps") : t("setupTitle")}</b><span>{role === "operator" ? t("setupSubOps") : t("setupSub")}</span></div>
          <ol className="setup-steps">
            <li className={installed ? "done" : ""}>
              <span className="num">{installed ? "✓" : "1"}</span>
              <div className="txt"><b>{t("stepInstall")}</b><div className="how">{t("stepInstallHow")}</div></div>
            </li>
            <li>
              <span className="num">2</span>
              <div className="txt">
                <b>{t("stepAlerts")}</b><div className="how">{t("stepAlertsHow")}</div>
                <button className="btn primary sm" style={{ marginTop: 8 }} onClick={enableAlerts}>{t("alertsEnable")}</button>
              </div>
            </li>
          </ol>
        </section>
      )}

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
                <b className="offer-tour">{o.tourName}</b>
                <dl className="offer-data">
                  <div><dt>{t("ofDate")}</dt><dd>{new Date(`${o.date}T00:00:00`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}</dd></div>
                  <div><dt>{t("ofTime")}</dt><dd>{o.time}</dd></div>
                  {o.pax != null && <div><dt>{t("ofPax")}</dt><dd>{o.pax} pax</dd></div>}
                  {o.meetingPoint && <div><dt>{t("ofMeet")}</dt><dd>{o.meetingPoint}</dd></div>}
                  {o.note && <div><dt>{t("ofRef")}</dt><dd>{o.note}</dd></div>}
                </dl>
              </div>
              <div className="offer-actions">
                <button className="btn sm primary" onClick={() => respondOffer(o.id, "accept")}>✅ {t("accept")}</button>
                <button className="btn sm ghost" onClick={() => respondOffer(o.id, "deny")}>{t("deny")}</button>
              </div>
            </div>
          ))}
        </section>
      )}

      {role === "guide" && view === "schedule" && nextTourHero()}
      {role === "guide" && view === "schedule" && (payDue.pending > 0 || payDue.approved > 0) && (
        <a className="needsyou" href="/pay">
          <span><b>฿{(payDue.pending + payDue.approved).toLocaleString()}</b> {t("paymentDue")}</span>
          <span className="ny-arrow">{payDue.approved > 0 ? `฿${payDue.approved.toLocaleString()} ${t("approvedLc")} · ` : ""}{t("viewPay")} ›</span>
        </a>
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
              {notif.items.length ? notif.items.map((i) => notifCard(i)) : <div className="op-empty">{t("noNotifications")}</div>}
            </div>
            <div className="mfoot notif-foot">
              {notif.items.length > 0 && <button className="btn ghost notif-btn" onClick={clearNotif}>{t("clearAll")}</button>}
              <button className="btn dark notif-btn" onClick={() => setShowNotif(false)}>{t("close")}</button>
            </div>
          </div>
        </div>
      )}

      {reportFor && (
        <div className="scrim show" onClick={(e) => { if (e.target === e.currentTarget) setReportFor(null); }}>
          <div className="modal" style={{ maxWidth: 420 }}>
            <div style={{ padding: "18px 20px" }}>
              <h3 style={{ margin: "0 0 2px" }}>{t("endTourReport")}</h3>
              <p className="sub" style={{ color: "var(--ink-soft)", fontSize: 13, margin: "0 0 14px" }}>{reportFor.tourName} · {reportFor.pax ?? 0} {t("guestsBooked")}</p>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <label className="fld" style={{ marginTop: 0 }}><span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "var(--ink-soft)" }}>{t("noShowLabel")}</span>
                  <input type="number" min={0} value={rNoShow} onChange={(e) => setRNoShow(e.target.value)} /></label>
                <label className="fld" style={{ marginTop: 0 }}><span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "var(--ink-soft)" }}>{t("leftEarlyLabel")}</span>
                  <input type="number" min={0} value={rLeft} onChange={(e) => setRLeft(e.target.value)} /></label>
              </div>
              <label className="fld"><span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "var(--ink-soft)" }}>{t("incidentsLabel")}</span>
                <input value={rComment} onChange={(e) => setRComment(e.target.value)} placeholder={t("incidentsHint")} /></label>
              <div style={{ fontSize: 12.5, color: "var(--ink-soft)", marginTop: 10 }}>✓ {t("completedShown")}: <b style={{ color: "var(--ink)" }}>{Math.max(0, (reportFor.pax ?? 0) - (Number(rNoShow) || 0) - (Number(rLeft) || 0))}</b> · {t("payNotAffected")}</div>
            </div>
            <div className="mfoot">
              <button className="btn" onClick={() => setReportFor(null)}>{t("cancel")}</button>
              <button className="btn primary" onClick={submitReport}>{t("submitComplete")}</button>
            </div>
          </div>
        </div>
      )}

      {leaveOpen && (
        <div className="scrim show" onClick={(e) => { if (e.target === e.currentTarget) setLeaveOpen(false); }}>
          <div className="modal" style={{ maxWidth: 400 }}>
            <div style={{ padding: "18px 20px" }}>
              <h3 style={{ margin: "0 0 12px" }}>🏖 {t("requestLeave")}</h3>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <label className="fld" style={{ marginTop: 0 }}><label>{t("from")}</label><input type="date" value={lFrom} onChange={(e) => setLFrom(e.target.value)} /></label>
                <label className="fld" style={{ marginTop: 0 }}><label>{t("to")}</label><input type="date" value={lTo} onChange={(e) => setLTo(e.target.value)} /></label>
              </div>
              <div className="fld"><label>{t("reasonOpt")}</label><input value={lReason} onChange={(e) => setLReason(e.target.value)} placeholder={t("reasonHint")} /></div>
              {myLeaves.length > 0 && <div style={{ marginTop: 12, fontSize: 12.5, color: "var(--ink-soft)" }}>{myLeaves.slice(0, 4).map((l) => <div key={l.id}>{l.fromDate}{l.toDate !== l.fromDate ? `–${l.toDate}` : ""} · <b style={{ color: l.status === "APPROVED" ? "var(--green)" : l.status === "REJECTED" ? "var(--danger)" : "var(--ink-soft)" }}>{l.status.toLowerCase()}</b></div>)}</div>}
            </div>
            <div className="mfoot">
              <button className="btn" onClick={() => setLeaveOpen(false)}>{t("cancel")}</button>
              <button className="btn primary" onClick={submitLeave}>{t("submitRequest")}</button>
            </div>
          </div>
        </div>
      )}

      <div className={`toast ${toastMsg ? "show" : ""}`}>{toastMsg}</div>
    </div>
  );
}
