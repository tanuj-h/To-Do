// ----- Cloud sync (Supabase) -----
// Everything that talks to Supabase lives here: signing in and out, and
// keeping your account's tasks in the cloud.
//
// script.js owns the tasks on screen and on this device. When you change a
// task it notes it in `unsynced` and calls scheduleFlush(); this file sends
// those changes up, brings the cloud's copy down (applyCloudTasks), and
// tells script.js who's signed in (onAccountChange).

// The connection to Supabase, or null if the library couldn't load (for
// example when offline). Guest mode works either way.
const cloud =
  window.supabase && typeof SUPABASE_URL === "string"
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
        auth: {
          // Where the sign-in is kept; index.html checks the same place
          storageKey: AUTH_STORAGE_KEY,
          // Google sends back a one-time code, rather than putting sign-in
          // tokens in the address bar
          flowType: "pkce",
        },
      })
    : null;

const FLUSH_DELAY_MS = 400; // wait this long after a change, so quick edits go up together
const RETRY_MIN_MS = 2000; // first retry after a failed sync...
const RETRY_MAX_MS = 60000; // ...then doubling each time, up to this
const SIGN_OUT_WAIT_MS = 5000; // how long signing out waits for changes to finish sending
const TASK_COLUMNS = "id, text, done, due_date, completed_at, created_at";

let syncUserId = null; // whose tasks are being synced, or null when not syncing
let flushTimer = null;
let retryTimer = null;
let retryDelay = RETRY_MIN_MS;
let flushing = null; // the save in progress, if any
let syncing = null; // the full sync in progress, if any

// ----- Tasks <-> database rows -----

const toRow = (t) => ({
  id: t.id,
  text: Array.from(t.text).slice(0, 500).join(""), // the database's limit
  done: t.done,
  due_date: t.date,
  completed_at: t.completedAt,
  created_at: t.createdAt,
});

const fromRow = (r) => ({
  id: r.id,
  text: r.text,
  done: r.done,
  date: r.due_date,
  completedAt: r.completed_at ? new Date(r.completed_at).toISOString() : null,
  createdAt: new Date(r.created_at).toISOString(),
});

// ----- Syncing -----

// Starts keeping this account's tasks in step with the cloud
function startCloudSync(userId) {
  if (!cloud || syncUserId === userId) return;
  syncUserId = userId;
  retryDelay = RETRY_MIN_MS;
  syncNow();
}

function stopCloudSync() {
  syncUserId = null;
  clearTimeout(flushTimer);
  clearTimeout(retryTimer);
}

// Brings this device and the cloud up to date: guest tasks join the account,
// waiting changes go up, then the latest comes down. Resolves true if it all
// worked; if not, it tries again a little later.
function syncNow() {
  if (!cloud || !syncUserId) return Promise.resolve(false);
  if (!syncing) {
    syncing = (async () => {
      try {
        return (await uploadGuestTasks()) && (await flushPending()) && (await pullFromCloud());
      } catch {
        return false;
      }
    })().then((ok) => {
      syncing = null;
      if (ok) retryDelay = RETRY_MIN_MS;
      else scheduleRetry();
      return ok;
    });
  }
  return syncing;
}

function scheduleRetry() {
  if (!syncUserId) return;
  clearTimeout(retryTimer);
  retryTimer = setTimeout(syncNow, retryDelay);
  retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
}

// script.js calls this after every change while signed in
function scheduleFlush() {
  if (!syncUserId) return; // not syncing yet: startCloudSync sends everything waiting
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flushPending, FLUSH_DELAY_MS);
}

// Sends waiting changes now. Resolves true once nothing is left waiting.
function flushPending() {
  clearTimeout(flushTimer);
  if (!cloud || !syncUserId) return Promise.resolve(false);
  if (!flushing) {
    flushing = sendUnsynced()
      .catch(() => false)
      .then((ok) => {
        flushing = null;
        if (!ok) scheduleRetry();
        return ok;
      });
  }
  return flushing;
}

async function sendUnsynced() {
  const userId = syncUserId;
  while (unsynced.saved.size || unsynced.deleted.size) {
    // What's waiting right now; anything changed meanwhile goes next round
    const saving = [...unsynced.saved];
    const deleting = [...unsynced.deleted];

    const rows = saving.map(([id]) => taskById(id)).filter(Boolean).map(toRow);
    if (rows.length) {
      const { error } = await cloud.from("todos").upsert(rows);
      if (error) return false;
    }
    if (deleting.length) {
      const { error } = await cloud.from("todos").delete().in("id", deleting);
      if (error) return false;
    }
    if (syncUserId !== userId) return false; // signed out meanwhile

    // Sent: no longer waiting, unless changed again since
    for (const [id, version] of saving) {
      if (unsynced.saved.get(id) === version) unsynced.saved.delete(id);
    }
    for (const id of deleting) unsynced.deleted.delete(id);
    saveTasks();
  }
  return true;
}

// Fetches the account's tasks and hands them to the page
async function pullFromCloud() {
  const userId = syncUserId;
  for (let attempt = 0; attempt < 3; attempt++) {
    const changesBefore = changeCount;
    const { data, error } = await cloud.from("todos").select(TASK_COLUMNS);
    if (error || syncUserId !== userId) return false;
    // Something changed here while that was loading: fetch again, so the
    // older copy from the cloud doesn't undo it
    if (changeCount !== changesBefore) continue;
    applyCloudTasks(data.map(fromRow), new Set([...unsynced.saved.keys(), ...unsynced.deleted]));
    return true;
  }
  return false;
}

// The first time you sign in on a device, its guest tasks join your account.
// It never overwrites a task the account already has.
async function uploadGuestTasks() {
  const guestTasks = readGuestTasks();
  if (!guestTasks.length) return true;

  const userId = syncUserId;
  const { error } = await cloud
    .from("todos")
    .upsert(guestTasks.map(toRow), { onConflict: "id", ignoreDuplicates: true });
  if (error || syncUserId !== userId) return false;

  clearGuestTasks();
  const n = guestTasks.length;
  showToast(`Added ${n} task${n === 1 ? "" : "s"} from this device to your account`);
  return true;
}

// Catch up when the connection comes back, or when you come back to this tab
window.addEventListener("online", () => syncNow());
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) syncNow();
});

// ----- Signing in and out -----

// Sends the browser to Google, which sends it back to this page signed in.
// Returns { error } if that couldn't start (for example when offline).
async function signInWithGoogle() {
  if (!cloud) return { error: new Error("Supabase is unavailable") };
  const { error } = await cloud.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: location.origin + location.pathname },
  });
  return { error };
}

// Forgets the sign-in on this device without asking Supabase
function forgetSignInLocally() {
  stopCloudSync();
  cloud?.auth.stopAutoRefresh();
  try {
    localStorage.removeItem(AUTH_STORAGE_KEY);
    localStorage.removeItem(`${AUTH_STORAGE_KEY}-code-verifier`);
  } catch {}
  onAccountChange(null);
}

// Signs out on this device only; your other devices stay signed in
async function signOutOfCloud() {
  // Last chance to send changes. If everything is safely up, this device's
  // copy of your tasks is removed; if not (say, offline), it's kept until
  // you sign in here again.
  const timeUp = new Promise((resolve) => setTimeout(resolve, SIGN_OUT_WAIT_MS, false));
  const allSent = await Promise.race([flushPending(), timeUp]);
  stopCloudSync();
  if (allSent) clearCloudCache();

  if (!cloud) return forgetSignInLocally();
  const { error } = await cloud.auth.signOut({ scope: "local" });
  // Couldn't reach Supabase (for example when offline): sign out here anyway
  if (error) forgetSignInLocally();
}

// Tell the page who's signed in, then start or stop syncing: once now, and
// again whenever it changes
if (cloud) {
  cloud.auth.onAuthStateChange((event, session) => {
    // Supabase recommends doing the work outside this callback
    setTimeout(() => {
      const user = session?.user ?? null;
      if (!user) stopCloudSync();
      onAccountChange(user);
      if (user) startCloudSync(user.id);
    }, 0);
  });
} else {
  onCloudUnavailable();
}
