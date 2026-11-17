# My To-Do List

A to-do list for planning your days and weeks and tracking how much you get done. You can use it as a guest, or sign in with Google to keep your tasks in sync across your devices.

**Live site:** https://to-do-blond-omega.vercel.app/

## Features

**Planning**
- Lists by date: **Today, Tomorrow, This Week, Next Week** and **This Month**. A task appears in every list its date falls into.
- A calendar for picking or changing a task's date.
- Overdue tasks stay in view and are marked.
- Lists roll over on their own when the day changes.

**Progress**
- A gauge for the list you're viewing, plus bars for today, this week and this month.
- Colours shift from red through amber to green as you finish tasks.

**Accounts and sync**
- **Continue as guest:** tasks are saved in your browser only.
- **Sign in with Google:** tasks are saved to the cloud and appear on all your devices.
- Changes show up instantly on your other devices.
- Works offline: changes sync automatically when you're back online.
- The first time you sign in on a device, any guest tasks there join your account.
- A dot on your avatar shows the sync status: green when synced, blue while saving, amber when offline.
- **Delete account** from the avatar menu, after typing `delete` to confirm. It removes your account and all its tasks.

**Design**
- Light and dark themes.
- Smooth animations throughout, such as the strike-through on ticked tasks, gliding reorders, rolling counters and sliding lists.
- Works on phones: swipe between lists, and the calendar opens as a bottom sheet.

**Limits**
- Up to 250 tasks per account.
- Up to 500 characters per task.

## How it's built

- Plain HTML, CSS and JavaScript, with no framework and no build step.
- Hosted on [Vercel](https://vercel.com).
- [Supabase](https://supabase.com) provides Google sign-in, the Postgres database and live updates. Row-level security means each account can only read and change its own tasks.

| File | What it does |
|---|---|
| `index.html` | The page: the sign-in card and the to-do list |
| `style.css` | All styling and animations |
| `script.js` | Everything on screen: lists, progress, the calendar, sign-in screens, account menu |
| `sync.js` | Everything that talks to Supabase: sign-in, saving, loading, live updates |
| `config.js` | Supabase project URL and publishable key (safe to be public) |
| `privacy.html`, `terms.html` | Privacy policy and terms of service |

## Running it locally

Google sign-in needs the site served over `http://`, so opening `index.html` directly from disk won't work. Use any local server. For example, the VS Code **Live Server** extension serves the site at `http://127.0.0.1:5500`, which is already an allowed sign-in address in Supabase.

Guest mode works without any setup.

## History

See [CHANGELOG.md](CHANGELOG.md) for how the project developed, phase by phase.
