// ----- Cloud sync (Supabase) -----
// Everything that talks to Supabase lives here: signing in and out, and
// keeping your account's tasks in the cloud and in step across devices.
//
// script.js owns the tasks on screen and on this device. When you change a
// task it notes it in `unsynced` and calls scheduleFlush(). This file sends
// those changes up, brings the cloud's copy down (applyCloudTasks), passes on
// live changes from your other devices (applyCloudChanges), and tells
// script.js who's signed in (onAccountChange) and how syncing is going
// (showSyncStatus).

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
const LIVE_BATCH_MS = 60; // live changes arriving this close together are shown together
const ECHO_WINDOW_MS = 10000; // how long this device remembers what it sent (see isStaleEcho)
const TASK_COLUMNS = "id, text, done, due_date, completed_at, created_at";

let syncUserId = null; // whose tasks are being synced, or null when not syncing
let flushTimer = null;
let retryTimer = null;
let retryDelay = RETRY_MIN_MS;
let flushing = null; // the save in progress, if any
let syncing = null; // the full sync in progress, if any
let lastSyncFailed = false; // the latest attempt to reach Supabase failed
let liveChannel = null; // live connection bringing changes from your other devices
let liveConnected = false;
let liveTimer = null;
const liveQueue = new Map(); // live changes waiting to be shown: id -> task, or null if deleted
const sentKeys = new Map(); // id -> [{ key, at }]: what this device sent lately

// ----- Tasks <-> database rows -----

// Postgres times can have 6 decimal places and a short "+00" offset, which
// not every browser can read (older Safari); this tidies them into plain ISO
function toIso(ts) {
  if (!ts) return null;
  const d = new Date(
    String(ts)
      .replace(" ", "T")
      .replace(/(\.\d{3})\d+/, "$1")
      .replace(/([+-]\d\d)$/, "$1:00")
  );
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

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
  completedAt: toIso(r.completed_at),
  createdAt: toIso(r.created_at) ?? new Date().toISOString(),
});

// ----- Syncing -----

// Starts keeping this account's tasks in step with the cloud
function startCloudSync(userId) {
  if (!cloud || syncUserId === userId) return;
  syncUserId = userId;
  retryDelay = RETRY_MIN_MS;
  lastSyncFailed = false;
  listenForChanges(userId);
  syncNow();
}

function stopCloudSync() {
  syncUserId = null;
  clearTimeout(flushTimer);
  clearTimeout(retryTimer);
  clearTimeout(liveTimer);
  liveQueue.clear();
  if (liveChannel) cloud.removeChannel(liveChannel);
  liveChannel = null;
  liveConnected = false;
  showSyncStatus(null);
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
      noteResult(ok);
      return ok;
    });
    refreshSyncStatus();
  }
  return syncing;
}

// After each attempt to reach Supabase: on failure, try again a bit later
function noteResult(ok) {
  lastSyncFailed = !ok;
  if (ok) retryDelay = RETRY_MIN_MS;
  else scheduleRetry();
  refreshSyncStatus();
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
  refreshSyncStatus(); // "Saving…"
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
        noteResult(ok);
        return ok;
      });
    refreshSyncStatus();
  }
  return flushing;
}

async function sendUnsynced() {
  const userId = syncUserId;
  while (unsynced.saved.size || unsynced.deleted.size) {
    // What's waiting right now; anything changed meanwhile goes next round
    const saving = [...unsynced.saved];
    const deleting = [...unsynced.deleted];

    const sending = saving.map(([id]) => taskById(id)).filter(Boolean);
    sending.forEach(rememberSent);
    if (sending.length) {
      const { error } = await cloud.from("todos").upsert(sending.map(toRow));
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

// ----- Live changes from your other devices -----

function listenForChanges(userId) {
  const channel = cloud
    .channel(`todos:${userId}`)
    // The database's security rules let only your own tasks through
    // (deletions arrive as just an id, which is all that's needed)
    .on("postgres_changes", { event: "*", schema: "public", table: "todos" }, onLiveChange)
    .subscribe((status) => {
      if (channel !== liveChannel) return; // an old connection closing
      const wasConnected = liveConnected;
      liveConnected = status === "SUBSCRIBED";
      // (Re)connected: catch up on anything missed while not listening
      if (liveConnected && !wasConnected) syncNow();
      refreshSyncStatus();
    });
  liveChannel = channel;
}

function onLiveChange(payload) {
  if (!syncUserId) return;
  if (payload.eventType === "DELETE") {
    if (payload.old?.id) liveQueue.set(payload.old.id, null);
  } else {
    const row = payload.new;
    if (!row?.id || row.user_id !== syncUserId) return;
    const task = fromRow(row);
    if (isStaleEcho(task)) return;
    liveQueue.set(task.id, task);
  }
  // Changes arriving together (say, several from another device) are shown together
  clearTimeout(liveTimer);
  liveTimer = setTimeout(() => {
    const changes = new Map(liveQueue);
    liveQueue.clear();
    applyCloudChanges(changes);
  }, LIVE_BATCH_MS);
}

// Every save from this device also comes back over the live connection.
// Usually that's harmless (it matches what's on screen), but if you change a
// task twice in a row, the first save can come back after the second one has
// gone up. Remembering what was sent lets that older echo be ignored, so the
// task doesn't flick back for a moment.
function rememberSent(task) {
  const now = Date.now();
  const recent = (sentKeys.get(task.id) || []).filter((s) => now - s.at < ECHO_WINDOW_MS);
  recent.push({ key: taskKey(task), at: now });
  sentKeys.set(task.id, recent);
}

function isStaleEcho(task) {
  const now = Date.now();
  const recent = (sentKeys.get(task.id) || []).filter((s) => now - s.at < ECHO_WINDOW_MS);
  if (recent.length < 2) return false;
  const key = taskKey(task);
  return key !== recent[recent.length - 1].key && recent.some((s) => s.key === key);
}

// ----- Sync status (the dot on your avatar) -----

function refreshSyncStatus() {
  if (!syncUserId) return showSyncStatus(null);
  const waiting = unsynced.saved.size > 0 || unsynced.deleted.size > 0;
  if (!navigator.onLine) {
    showSyncStatus("offline", waiting ? "Offline · changes will sync when you're back online" : "Offline");
  } else if (lastSyncFailed) {
    showSyncStatus("offline", "Can't reach the server · retrying");
  } else if (waiting || flushing) {
    showSyncStatus("saving", "Saving…");
  } else if (syncing) {
    showSyncStatus("saving", "Syncing…");
  } else if (!liveConnected) {
    showSyncStatus("saving", "Connecting…");
  } else {
    showSyncStatus("synced", "All changes synced");
  }
}

// Catch up when the connection comes back, or when you come back to this tab
window.addEventListener("online", () => {
  refreshSyncStatus();
  syncNow();
});
window.addEventListener("offline", refreshSyncStatus);
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
