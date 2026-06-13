# Folkpaths app — UX copy review

Goal: review + rewrite, whole app, EN + TH, professional tone that reads human (not AI-generated).
Based on the real strings in `src/lib/i18n.ts` plus the in-app notification messages.

The starting point is good — the Thai is natural, not machine-translated, and most labels are clear.
This is polish, focused on the things that make copy *feel* AI-written, plus one real brand bug.

---

## 0. Fix first — the brand name is inconsistent (not AI-related, but it matters most)

The company and the install/manifest say **Folkpaths** (with an s), but the in-app copy says
**"Folkpath"** everywhere: `kicker`, `welcomeTitle`, the LINE hints, the install steps. Pick one —
it should be **Folkpaths** — and make it consistent. Nothing reads less professional than a brand
that can't spell its own name the same way twice.

| Key | Now | →  |
|---|---|---|
| `kicker` | Folkpath Operations | Folkpaths Operations |
| `welcomeTitle` | Welcome to Folkpath | Welcome to Folkpaths |
| `lineConnectHint` | the Folkpath LINE Official Account | the Folkpaths LINE Official Account |
| `alertsNeedInstall` / `stepInstall` | add Folkpath to your Home Screen | add Folkpaths to your Home Screen |
| TH equivalents | …Folkpath… | …Folkpaths… |

---

## The 4 tells that make copy "feel AI" — and the rule for each

1. **Em-dash habit.** AI sprinkles "—" everywhere. Humans use a period or a comma. Keep em-dashes for
   genuine asides; turn the rest into full stops.
2. **Emoji as punctuation.** ✅ / 🆕 / ⚠️ leading a sentence reads like a bot. Status *icons* in the UI
   are fine; emoji *inside the sentence* are not, especially in a professional tone.
3. **Cheerleader voice.** "let's go", "we'll send work your way", "You got the job!". Warm is good;
   peppy is AI. Aim for calm and matter-of-fact.
4. **Over-reassurance.** Explaining the obvious or padding with comfort ("don't worry", "just"). Trust
   the user; say the thing once.

---

## High-impact rewrites (EN + TH)

| Key | Now → New (EN) | Now → New (TH) |
|---|---|---|
| `welcomeGotIt` | Got it — let's go → **Got it** | เข้าใจแล้ว — เริ่มเลย → **เข้าใจแล้ว** |
| `signInSub` | Welcome back — sign in to see your jobs… → **Welcome back. Sign in to see your jobs and set your availability.** | (already clean; keep) |
| `offerAccepted` | ✅ You got the job! It's in your schedule. → **You've got the job. It's in your schedule.** | ✅ คุณได้รับงานแล้ว! อยู่ในตารางของคุณ → **คุณได้รับงานแล้ว อยู่ในตารางของคุณ** |
| `alertsOn` | ✅ Job alerts are on for this device → **Job alerts are on for this device** | ✅ เปิดการแจ้งเตือนงานบนเครื่องนี้แล้ว → **เปิดการแจ้งเตือนงานบนเครื่องนี้แล้ว** |
| `noUpcoming` | No tours yet. …we'll send work your way. → **No tours yet. Keep your availability up to date and you'll be offered work as it comes in.** | ยังไม่มีทัวร์ อัปเดตเวลาว่างของคุณไว้ แล้วเราจะส่งงานไปให้ → **ยังไม่มีทัวร์ อัปเดตเวลาว่างไว้ แล้วระบบจะเสนองานให้เมื่อมีเข้ามา** |
| `tourCancelled` | …Cancelled by mistake? It comes back as an offer — just re-accept it. → **Tour cancelled. The operator has been notified. If this was a mistake, it returns as an offer you can accept again.** | …หากยกเลิกผิด งานจะกลับมาเป็นข้อเสนอ รับงานใหม่ได้เลย → **ยกเลิกทัวร์แล้ว แจ้งผู้ดูแลเรียบร้อย หากยกเลิกผิด งานจะกลับมาเป็นข้อเสนอให้รับได้อีกครั้ง** |
| `setupSub` | 2 quick steps — do once → **Two quick steps, done once** | 2 ขั้นตอน ทำครั้งเดียว → (keep — already clean) |
| `lineConnected` | LINE connected ✓ → **LINE connected** (the ✓ icon is in the UI already) | เชื่อมต่อ LINE แล้ว ✓ → **เชื่อมต่อ LINE แล้ว** |
| `calConnected` | Connected ✓ → **Connected** | เชื่อมต่อแล้ว ✓ → **เชื่อมต่อแล้ว** |
| `conflictWarn` | ⚠ Double-booked — overlaps another tour → **Double-booked: overlaps another tour** | ⚠ จองซ้อน — เวลาทับกับอีกทัวร์ → **จองซ้อน: เวลาทับกับอีกทัวร์** |
| `offerDenied` | Declined — thanks for letting us know. → **Declined. Thanks for letting us know.** | ปฏิเสธแล้ว — ขอบคุณที่แจ้ง → **ปฏิเสธแล้ว ขอบคุณที่แจ้ง** |

Notes:
- Keep the warmth in `noUpcoming`/`signInSub` — just drop the em-dash and the "your way" idiom.
- `deny: "Pass"` is a nice human touch — keep it.

---

## In-app notification messages (currently the most "AI" copy)

These live in code (`src/lib/booking-import.ts`), not i18n, and lean hard on emoji.

| Now | New (EN) |
|---|---|
| `✅ Booking {ref} (+2) auto-combined into G-025's job…` | **Booking {ref} (+2) added to G-025's job on {date} — now {n} guests.** |
| `⚠️ Late booking {ref} … would put {guide} over 10 …` | **Booking {ref} (+4) for {date} puts {guide} over 10 guests. Held — split it across guides.** |
| `🆕 Late booking {ref} … matches a slot already split…` | **Booking {ref} for {date} matches a slot already split across {n} guides. Assign it manually.** |
| `Your tour on {date} now has {n} guests — a new booking was added.` | **A booking was added to your {date} tour. You now have {n} guests.** |

(One em-dash per message at most; lead with the subject, not an emoji.)

---

## House style — so new copy stays human + professional (EN + TH)

- **One full stop, not a dash.** Two short sentences beat one dash-spliced sentence.
- **No emoji inside sentences.** Use the UI's own icons/colours for status.
- **State, don't cheer.** "You've got the job." not "✅ You got the job!".
- **Say it once.** Cut "just", "don't worry", and explanations of the obvious.
- **Thai: keep it concise-polite, not stiff.** Drop redundant "ของคุณ" where context is clear; avoid
  literal renderings of English idioms.
- **Buttons = the action.** "Send offer", "Assign", "Save changes" — verb first, no fluff.
- **Numbers as numerals** (10 guests, 2 steps), times as `08:30`.
