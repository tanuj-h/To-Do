// ----- Cloud sync (Supabase) -----
// Everything that talks to Supabase lives here: signing in and out, and
// (coming next) loading and saving tasks and live updates from your other
// devices. script.js only deals with what's on screen; this file tells it
// what changed by calling onAccountChange() and onCloudUnavailable().

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
  cloud?.auth.stopAutoRefresh();
  try {
    localStorage.removeItem(AUTH_STORAGE_KEY);
    localStorage.removeItem(`${AUTH_STORAGE_KEY}-code-verifier`);
  } catch {}
  onAccountChange(null);
}

// Signs out on this device only; your other devices stay signed in
async function signOutOfCloud() {
  if (!cloud) return forgetSignInLocally();
  const { error } = await cloud.auth.signOut({ scope: "local" });
  // Couldn't reach Supabase (for example when offline): sign out here anyway
  if (error) forgetSignInLocally();
}

// Tell the page who's signed in: once now, then whenever it changes
if (cloud) {
  cloud.auth.onAuthStateChange((event, session) => {
    // Supabase recommends doing the work outside this callback
    setTimeout(() => onAccountChange(session?.user ?? null), 0);
  });
} else {
  onCloudUnavailable();
}
