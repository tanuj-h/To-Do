// Settings for connecting to the Supabase project (database and sign-in).
//
// Both values are safe to have in public code: the publishable key only lets
// the browser talk to the project, and the database's security rules decide
// what each signed-in person can see (only their own tasks).
// Never put the secret key (sb_secret_... or service_role) in this file.
const SUPABASE_URL = "https://ksprkdomqzoqvzipwhor.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_QOveVnysEf-VAguk6PXNPA_-kuLfdtr";

// Where the browser keeps your sign-in (in localStorage). index.html checks
// it before the page paints, to decide between the sign-in page and the list.
const AUTH_STORAGE_KEY = "todo-auth";
