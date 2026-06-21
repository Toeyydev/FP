# Working on Folkpaths from your phone 📱

Your code lives on GitHub (`Toeyydev/FP`) and Railway auto-deploys the `main`
branch. That pipeline is what lets you make changes from anywhere — describe what
you want in plain language, it gets pushed to `main`, and **guide.folkpaths.com
updates automatically in ~2 minutes**.

---

## ✅ Recommended: Claude Code on the web

Same assistant you already work with, but in a browser — no Mac needed.

1. On your phone, open **claude.ai/code** and sign in with your Claude account.
2. **Connect GitHub** → authorize → pick the **`Toeyydev/FP`** repo.
3. Type what you want in plain words
   (e.g. *"on Payments, rename Outstanding to Pending"*).
   It spins up a cloud machine, makes the change, and **pushes to `main`** (or
   opens a pull request you approve).
4. Railway **auto-deploys** — the live site updates on its own.
5. **Add claude.ai to your Home Screen** so it opens like an app
   (Safari: Share → Add to Home Screen / Chrome: ⋮ → Add to Home screen).

You never touch code — just describe the change, exactly like in the desktop chat.

## 🟦 Alternative: Cursor Background Agents

Cursor can run **cloud agents** on the `Toeyydev/FP` repo and you can start/monitor
them from its **web** interface (and Slack). They push changes → Railway deploys.
Capable, but the Claude Code web flow above is simpler and it's the same assistant.

---

## ⚠️ Keep in mind

- **Secrets stay in Railway.** Never paste `LINE_*`, `BOKUN_*`, `GOOGLE_*`,
  `PEAK_*`, `AUTH_SECRET`, etc. into any chat — phone or desktop. Code changes
  don't need them.
- **Small things from the phone** (wording, labels, quick UI, small fixes) are
  easy. **Bigger or risky changes** are safer on desktop, where the live database
  can be checked before and after.
- **How to confirm a deploy landed:** open
  `https://guide.folkpaths.com/api/version` — when it shows the new commit, the
  change is live. If a page still looks old, close and reopen the app once (it
  caches).
