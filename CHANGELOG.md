# Changelog

How **My To-Do List** grew, phase by phase. Newest first.

Live site: https://to-do-blond-omega.vercel.app/

The site is plain HTML, CSS and JavaScript, with no framework and no build step. Since phase 5 it uses [Supabase](https://supabase.com) for sign-in and cloud storage.

---

## Phase 7: Account deletion (17 Nov 2026)

- **Delete account** option in the avatar menu.
- A confirmation popup where you have to type `delete` before the button works. It says how many tasks will be removed, and you can close it with Cancel, Escape or by clicking outside it.
- Deletes the account and all its tasks in one step, signs you out on every device, and shows a confirmation message.
- Database: a `delete_my_account()` function that only ever deletes the caller's own account. Signed-out visitors can't call it.
- The privacy policy now explains how to delete your account yourself.

## Phase 6: Open to everyone (17 Nov 2026)

- Google sign-in opened to any Google account (the Google OAuth app is published). Email sign-in is switched off.
- **Task limit:** each account can keep up to **250 tasks**. The database enforces it, and the site shows a clear message instead of adding more. Changes to existing tasks always save.
- New **Privacy Policy** (`privacy.html`) and **Terms of Service** (`terms.html`) pages, styled to match the site and linked from the sign-in card.
- A short note on the sign-in card explaining what signing in stores.
- Logo and favicon (`logo.png`), also used as the icon when the site is added to a phone's home screen.
- Message popup with a green tick for success and an amber "!" for warnings.

## Phase 5: Accounts and cloud sync (16–17 Nov 2026)

The site went from a single-device page to a multi-device app.

**Database (Supabase)**
- A `todos` table with row-level security, so each account can only read and change its own tasks.
- Live updates switched on for the table.

**Sign-in**
- New sign-in page with **Continue with Google** and **Continue as guest**, with animated cards and light/dark theme.
- Guest mode keeps tasks in the browser only, as before.
- The right screen (sign-in page or list) is picked before the page draws, so neither flashes up by mistake.
- Header shows a **Sign in** button for guests, or your Google photo when signed in. The photo opens a menu with your name, email and **Sign out**.

**Sync**
- Signed-in tasks save to the cloud about half a second after each change, and load on every device.
- Each device keeps a copy, so the list opens instantly and keeps working offline. Offline changes send automatically when you're back online.
- The first time you sign in on a device, its guest tasks are added to your account, without ever overwriting tasks already there.
- **Live updates:** changes from your other devices appear instantly. Ticks play the strike-through, new tasks fade in, deleted tasks fade out, then everything glides into place.
- A **sync dot** on your avatar shows the status: green when synced, pulsing blue while saving, amber when offline. The avatar menu says the same in words.

**Under the hood**
- Task IDs changed from numbers to random UUIDs, so tasks made on different devices never clash. Existing tasks were converted automatically and kept their order.
- Task text limited to 500 characters.
- Supabase settings live in `config.js`. All cloud code is in `sync.js`, and `script.js` handles what's on screen.
- The Supabase library is pinned to an exact version and checked with an integrity hash.
- Fixed a timestamp format that older Safari (iPhone) couldn't read.

## Phase 4: Phone layout (16 Nov 2026)

- Responsive design for phones (640px wide and narrower).
- The progress panel moves inside the list card as a compact strip with a mini ring, and taps open to the full panel.
- Swipe left and right to switch between lists.
- The calendar opens as a bottom sheet with the page dimmed behind it.
- Bigger touch targets for checkboxes and delete buttons, a round "+" add button, and dates under each task's name.
- Hover styles no longer stick after a tap on touch screens.

## Phase 3: Visual design and ambience (5 Nov 2026)

- Aurora background: soft coloured lights drifting behind frosted-glass cards, brightening while you work in the list.
- A slowly circling light around each card's edge.
- A ray of light runs around the add-task box when you click into it, followed by an aurora glow.
- Sparkle burst when you tick off a task.
- Tuned colour schemes: "pastel sunrise" for light mode, and a muted neon glow for dark mode.

## Phase 2: Lists, progress and motion (5 Nov 2026)

- Lists by date: **Today, Tomorrow, This Week, Next Week, This Month**. A task shows in every list its date falls into, and overdue tasks stay visible and are marked.
- Custom calendar for picking or changing a task's date.
- Lists roll over by themselves when the day changes.
- Progress panel: a gauge for the open list and bars for today, this week and this month, coloured from red through amber to green as you finish tasks.
- Smooth motion throughout:
  - an animated strike-through, then tasks glide to their new place;
  - sliding list switches with a glowing active tab;
  - rolling task counts and odometer-style percentages.
- Light and dark modes, remembered between visits.

## Phase 1: First version (5 Nov 2026)

- A simple single-page to-do list: add tasks, tick them off, delete them.
- Tasks saved in the browser (`localStorage`).
- Count of remaining tasks.
