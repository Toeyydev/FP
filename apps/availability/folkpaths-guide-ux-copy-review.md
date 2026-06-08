# Folkpaths Guide App — UX Copy Review (EN + TH)

**App:** guide.folkpaths.com — guide availability & job dispatch board
**Scope:** review existing copy across the app, both languages
**Tone target:** friendly, warm, professional
**Priority flagged by you:** make the availability boxes clearer (Red = Busy, Green = Available, Grey = Day Off)

> Note: I can only see the login screen of the app from outside (everything else is behind sign-in). The copy below for the inner screens is written against the standard pattern for a guide dispatch board. Paste me any real on-screen strings and I'll tighten these to match exactly.

---

## 1. Availability boxes (your priority)

### The core problem
Right now the three states are carried by **colour alone** — red, green, grey. Two issues:

1. **Colour without a word is ambiguous.** A guide glancing quickly can't be sure red means "I'm busy" vs "blocked/error". Red also reads as a warning, which can feel negative for something as normal as "already booked".
2. **Colour alone is not accessible.** Roughly 1 in 12 men have some red–green colour blindness — for them red and green boxes can look almost identical. Every state needs a **word and/or an icon**, not just a colour.

### Recommended fix
Give each box a short label **and** an icon, keep the colour as reinforcement, and add a one-line legend at the top.

| State | Colour | Icon | English label | Thai label |
|-------|--------|------|---------------|------------|
| Available | Green | ✓ check | **Available** | **ว่าง** |
| Busy | Red | • dot / briefcase | **Busy** | **ไม่ว่าง** |
| Day off | Grey | – dash / moon | **Day off** | **วันหยุด** |

### Legend copy (place above the calendar)

**English:** `Tap a day to set your availability`
**Thai:** `แตะที่วันเพื่อตั้งสถานะของคุณ`

Legend row:

`🟢 Available  ·  🔴 Busy  ·  ⚪ Day off`
`🟢 ว่าง  ·  🔴 ไม่ว่าง  ·  ⚪ วันหยุด`

### One thing to decide: what does red really mean?
"Busy" is slightly fuzzy. On a dispatch board, red usually means one of two different things — pick the one that's true and label it precisely:

| If red means… | Better English label | Better Thai label | Why |
|---------------|---------------------|-------------------|-----|
| Already has a job that day | **Booked** | **มีงานแล้ว** | Tells the guide *why* they're unavailable, and reads positively |
| Personally unavailable (not a job) | **Unavailable** / **Busy** | **ไม่ว่าง** | Neutral, covers personal reasons |

My recommendation: if the red box is driven by an assigned job, use **Booked / มีงานแล้ว** — it's clearer and feels good (work came in) rather than a red "stop" signal.

### Status toggle / confirmation copy
When a guide taps a day:

| Element | English | Thai |
|---------|---------|------|
| Set available | Marked available | ตั้งเป็น "ว่าง" แล้ว |
| Set day off | Marked as day off | ตั้งเป็น "วันหยุด" แล้ว |
| Confirm day off on a booked day | You have a job on this day. Set it as a day off anyway? | วันนี้คุณมีงานอยู่ ต้องการตั้งเป็นวันหยุดหรือไม่? |
| Buttons | Set day off / Keep job | ตั้งวันหยุด / เก็บงานไว้ |

---

## 2. Login / sign-up

| Element | English (recommended) | Thai |
|---------|----------------------|------|
| Screen intro | Welcome back. Sign in to see your jobs. | ยินดีต้อนรับกลับมา เข้าสู่ระบบเพื่อดูงานของคุณ |
| Email field | Email | อีเมล |
| Password field | Password | รหัสผ่าน |
| Remember me | Keep me signed in | จดจำการเข้าสู่ระบบ |
| Sign-in button | Sign in | เข้าสู่ระบบ |
| Forgot password | Forgot your password? | ลืมรหัสผ่าน? |
| Sign-up prompt | New here? Create an account | ยังไม่มีบัญชี? สมัครสมาชิก |
| Wrong credentials error | We couldn't find that email and password combination. Check and try again. | อีเมลหรือรหัสผ่านไม่ถูกต้อง กรุณาตรวจสอบแล้วลองอีกครั้ง |
| Empty field error | Please enter your email. / Please enter your password. | กรุณากรอกอีเมล / กรุณากรอกรหัสผ่าน |

Small note: "Remember me" → "Keep me signed in" tells the user the actual outcome (stays logged in), which is clearer.

---

## 3. Onboarding (first sign-in)

Keep it to one idea per screen. Three short steps:

| Step | English | Thai |
|------|---------|------|
| 1 — Set availability | Tell us the days you can work. Green = available, red = busy, grey = day off. | บอกเราว่าคุณทำงานวันไหนได้ ว่าง = เขียว, ไม่ว่าง = แดง, วันหยุด = เทา |
| 2 — Get jobs | When a job matches your free days, we'll send it to you. | เมื่อมีงานตรงกับวันที่คุณว่าง เราจะส่งงานไปให้คุณ |
| 3 — Accept fast | Tap Accept to take a job. First to accept gets it. | แตะ "รับงาน" เพื่อรับงาน ใครรับก่อนได้ก่อน |
| Finish button | Got it, let's go | เข้าใจแล้ว เริ่มเลย |

---

## 4. Job dispatch / accept

| Element | English | Thai |
|---------|---------|------|
| New job heading | New job for you | มีงานใหม่สำหรับคุณ |
| Accept button | Accept job | รับงาน |
| Decline button | Pass | ปฏิเสธ |
| Accepted toast | You've got this job. Details are in My jobs. | คุณได้รับงานนี้แล้ว ดูรายละเอียดใน "งานของฉัน" |
| Already taken | This job was just taken by another guide. | งานนี้ถูกไกด์คนอื่นรับไปแล้ว |
| Decline confirm | Pass on this job? It'll be offered to other guides. | ปฏิเสธงานนี้? งานจะถูกส่งให้ไกด์คนอื่น |

Note: "Pass" is softer than "Decline/Reject" and keeps the relationship warm — declining a job shouldn't feel like a penalty.

---

## 5. Notifications

| Trigger | English | Thai |
|---------|---------|------|
| New job offer | New job: {tour} on {date}. Tap to view. | งานใหม่: {tour} วันที่ {date} แตะเพื่อดู |
| Job confirmed | You're confirmed for {tour} on {date}. | ยืนยันแล้ว: {tour} วันที่ {date} |
| Reminder | Tomorrow: {tour} at {time}. Meeting point: {place}. | พรุ่งนี้: {tour} เวลา {time} จุดนัดพบ: {place} |
| Job cancelled | {tour} on {date} has been cancelled. | {tour} วันที่ {date} ถูกยกเลิกแล้ว |
| Availability reminder | You haven't set your availability for next week yet. | คุณยังไม่ได้ตั้งวันว่างสำหรับสัปดาห์หน้า |

---

## 6. Empty states

| Screen | English | Thai |
|--------|---------|------|
| No jobs yet | No jobs yet. Keep your availability up to date and we'll send work your way. | ยังไม่มีงาน อัปเดตวันว่างของคุณไว้ แล้วเราจะส่งงานไปให้ |
| No availability set | Your calendar is empty. Tap any day to mark when you can work. | ปฏิทินของคุณยังว่างอยู่ แตะที่วันใดก็ได้เพื่อตั้งวันที่คุณทำงานได้ |
| No notifications | You're all caught up. | คุณดูครบทุกอย่างแล้ว |

---

## 7. Errors & confirmations

| Situation | English | Thai |
|-----------|---------|------|
| No internet | You're offline. We'll sync your changes when you're back online. | คุณออฟไลน์อยู่ เราจะซิงก์ข้อมูลให้เมื่อกลับมาออนไลน์ |
| Generic save error | Something went wrong saving that. Try again. | บันทึกไม่สำเร็จ กรุณาลองอีกครั้ง |
| Session expired | You've been signed out. Please sign in again. | ระบบออกจากบัญชีแล้ว กรุณาเข้าสู่ระบบอีกครั้ง |
| Sign-out confirm | Sign out of Folkpaths? | ออกจากระบบ Folkpaths? |
| Sign-out buttons | Sign out / Stay signed in | ออกจากระบบ / อยู่ต่อ |

---

## Outsider's view — what I'd improve beyond wording

1. **Never rely on colour alone.** This is the single biggest fix. Add a word + icon to every availability box (above). It helps colour-blind guides, and it helps everyone glancing at a busy month.
2. **Decide red = "Booked" vs "Busy" and be consistent everywhere** — calendar, notifications, legend. One word, one meaning, app-wide. Mixed terms ("busy" in one place, "unavailable" in another) erode trust.
3. **Bilingual consistency.** Keep one Thai term per concept. e.g. always "ว่าง / ไม่ว่าง / วันหยุด" — don't switch between "ไม่ว่าง" and "ติดงาน" in different screens.
4. **Buttons should name the action, not "OK/Cancel".** "Set day off / Keep job" beats "Yes / No" — the guide reads the button and knows exactly what happens.
5. **Positive framing for normal events.** Being booked is good news. Lead with the benefit ("You've got this job") rather than a red stop colour with no words.
6. **Language toggle visible on every screen,** not just login — guides may switch mid-task.
