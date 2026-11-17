// Keys used to save data in the browser's localStorage
// The most tasks one account can keep in the cloud. The database enforces the
// same number (the enforce_todo_limit rule in Supabase).
const TASK_LIMIT = 250;

const STORAGE_KEY = "todo-tasks"; // guest tasks
const CLOUD_CACHE_KEY = "todo-cloud-tasks"; // this device's copy of your account's tasks
const ACTIVE_LIST_KEY = "todo-active-list";
const THEME_KEY = "todo-theme";

// ----- Dates -----
// Dates are stored as "YYYY-MM-DD" text in local time. Text in that shape
// sorts and compares in date order, so "<" and ">" work directly.

function dateKey(d) {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function parseKey(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

// The date ranges the lists are built from. Recomputed on every render,
// so the lists roll over by themselves when the day changes.
function getRanges() {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart = addDays(today, -today.getDay()); // weeks start on Sunday
  return {
    today: dateKey(today),
    tomorrow: dateKey(addDays(today, 1)),
    weekStart: dateKey(weekStart),
    weekEnd: dateKey(addDays(weekStart, 6)),
    nextWeekStart: dateKey(addDays(weekStart, 7)),
    nextWeekEnd: dateKey(addDays(weekStart, 13)),
    monthStart: dateKey(new Date(today.getFullYear(), today.getMonth(), 1)),
    monthEnd: dateKey(new Date(today.getFullYear(), today.getMonth() + 1, 0)),
  };
}

let R = getRanges();

const isOverdue = (t) => !t.done && t.date < R.today;

// The latest date any task can be given
const maxDate = () => (R.monthEnd > R.nextWeekEnd ? R.monthEnd : R.nextWeekEnd);

// "Today", "Tomorrow" or e.g. "Thu 13 Nov"
function formatDate(key) {
  if (key === R.today) return "Today";
  if (key === R.tomorrow) return "Tomorrow";
  return parseKey(key).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

// The lists, in the order their tabs appear. Each one is a view onto tasks by
// date, so a task can show in several lists (Today's tasks are also in This
// Week and This Month). "pick" lists let you choose a date when adding.
const LISTS = [
  {
    id: "today",
    name: "Today",
    includes: (t) => t.date === R.today || isOverdue(t),
    range: () => ({ min: R.today, max: R.today }),
  },
  {
    id: "tomorrow",
    name: "Tomorrow",
    includes: (t) => t.date === R.tomorrow,
    range: () => ({ min: R.tomorrow, max: R.tomorrow }),
  },
  {
    id: "this-week",
    name: "This Week",
    pick: true,
    includes: (t) =>
      (t.date >= R.weekStart && t.date <= R.weekEnd) || t.date === R.tomorrow || isOverdue(t),
    range: () => ({ min: R.today, max: R.weekEnd }),
  },
  {
    id: "next-week",
    name: "Next Week",
    pick: true,
    includes: (t) => t.date >= R.nextWeekStart && t.date <= R.nextWeekEnd,
    range: () => ({ min: R.nextWeekStart, max: R.nextWeekEnd }),
  },
  {
    id: "this-month",
    name: "This Month",
    pick: true,
    // Everything: this month, anything later, and unfinished overdue tasks
    includes: (t) => t.date >= R.monthStart || isOverdue(t),
    range: () => ({ min: R.today, max: R.monthEnd }),
  },
];

const listById = (id) => LISTS.find((l) => l.id === id);

const form = document.getElementById("task-form");
const input = document.getElementById("task-input");
const addBtn = form.querySelector('button[type="submit"]');
const tabs = document.getElementById("list-tabs");
const viewport = document.getElementById("list-viewport");
const track = document.getElementById("list-track");

// Matches the phone layout in style.css
const PHONE = window.matchMedia("(max-width: 640px)");

// Each task looks like:
// { id: string, text: string, done: boolean, date: "YYYY-MM-DD",
//   completedAt: ISO string | null, createdAt: ISO string }
// The id is a random UUID, so tasks made on different devices never clash.
let tasks = [];

// Whose tasks are on screen: the signed-in account's id, or null for this
// device's guest tasks. Starts from the sign-in saved on this device;
// sync.js confirms it once it has loaded.
let accountId = null;

// Signed in: changes the cloud hasn't confirmed yet (sync.js sends them up).
// Each changed task's id maps to the changeCount when it last changed, so a
// change made while an earlier one is still sending isn't taken as sent.
const unsynced = { saved: new Map(), deleted: new Set() };
let changeCount = 0;

useAccount(document.documentElement.dataset.account === "user" ? (savedUser()?.id ?? null) : null);
let activeList = loadActiveList();

// ----- Saving and loading -----

// Older tasks belonged to a named list instead of a date; give them a date from it
function dateForOldList(list) {
  switch (list) {
    case "tomorrow":
      return R.tomorrow;
    case "this-week":
      return R.weekEnd;
    case "next-week":
      return R.nextWeekStart;
    case "this-month":
    case "next-month":
      return R.monthEnd;
    default:
      return R.today;
  }
}

// A random id like "3f2b8c1e-9a4d-4c2b-8e1f-...". Older browsers without
// crypto.randomUUID get one built by hand from random numbers.
function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
    (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)
  );
}

// Brings tasks saved in older shapes up to date. Returns them, and whether
// any had to change.
function normalizeTasks(saved) {
  let converted = false;

  const normalized = saved.map(({ list, ...t }) => {
    // Older tasks used the moment they were added (a number) as their id.
    // They get a random id instead, and that moment becomes createdAt, so
    // the list keeps the same order.
    if (typeof t.id === "number") {
      const made = new Date(t.id);
      t.createdAt = Number.isNaN(made.getTime()) ? new Date().toISOString() : made.toISOString();
      t.id = newId();
      converted = true;
    }
    if (!t.date || !t.createdAt) converted = true;

    return {
      ...t,
      date: t.date || dateForOldList(list),
      completedAt: t.completedAt ?? null,
      createdAt: t.createdAt ?? new Date().toISOString(),
    };
  });

  return { tasks: normalized, converted };
}

// This device's guest tasks. Older ones are converted once and saved back,
// so they keep the same ids from then on.
function readGuestTasks() {
  let saved = [];
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch {}
  const { tasks: guestTasks, converted } = normalizeTasks(Array.isArray(saved) ? saved : []);
  if (converted) writeGuestTasks(guestTasks);
  return guestTasks;
}

function writeGuestTasks(list) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // Storage unavailable (e.g. private mode); tasks just won't persist
  }
}

// Called once they've joined your account (see sync.js)
function clearGuestTasks() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
}

// This device's copy of an account's tasks, if it has one for that account
function readCloudCache(userId) {
  try {
    const cache = JSON.parse(localStorage.getItem(CLOUD_CACHE_KEY));
    return cache && cache.userId === userId ? cache : null;
  } catch {
    return null;
  }
}

function clearCloudCache() {
  try {
    localStorage.removeItem(CLOUD_CACHE_KEY);
  } catch {}
}

// Switches whose tasks are on screen: an account's (by id) or, with null,
// this device's guest tasks. Call render() afterwards.
function useAccount(id) {
  accountId = id;
  unsynced.saved.clear();
  unsynced.deleted.clear();

  const cache = id ? readCloudCache(id) : null;
  if (cache) {
    tasks = normalizeTasks(Array.isArray(cache.tasks) ? cache.tasks : []).tasks;
    for (const taskId of cache.unsaved || []) unsynced.saved.set(taskId, ++changeCount);
    for (const taskId of cache.deleted || []) unsynced.deleted.add(taskId);
  } else {
    // Guest mode, or signed in with no copy here yet: show the guest tasks
    // (when signed in, they're about to join the account)
    tasks = readGuestTasks();
  }
}

// Saves the tasks on this device: as the account's copy when signed in
// (with the changes still waiting to go up), otherwise as guest tasks
function saveTasks() {
  if (!accountId) {
    writeGuestTasks(tasks);
    return;
  }
  try {
    localStorage.setItem(
      CLOUD_CACHE_KEY,
      JSON.stringify({
        userId: accountId,
        tasks,
        unsaved: [...unsynced.saved.keys()],
        deleted: [...unsynced.deleted],
      })
    );
  } catch {}
}

const taskById = (id) => tasks.find((t) => t.id === id);

// Call after adding or changing a task: saves it here and, when signed in,
// marks it to go up to the cloud
function taskChanged(id) {
  changeCount++;
  if (accountId) unsynced.saved.set(id, changeCount);
  saveTasks();
  if (accountId && typeof scheduleFlush === "function") scheduleFlush();
}

// Call after deleting a task (same idea)
function taskDeleted(id) {
  changeCount++;
  if (accountId) {
    unsynced.saved.delete(id);
    unsynced.deleted.add(id);
  }
  saveTasks();
  if (accountId && typeof scheduleFlush === "function") scheduleFlush();
}

function loadActiveList() {
  try {
    const saved = localStorage.getItem(ACTIVE_LIST_KEY);
    if (LISTS.some((l) => l.id === saved)) return saved;
  } catch {}
  return LISTS[0].id;
}

function saveActiveList() {
  try {
    localStorage.setItem(ACTIVE_LIST_KEY, activeList);
  } catch {}
}

// ----- Drawing the page -----

function listName(id) {
  return listById(id).name;
}

// Tasks shown in a list: unfinished first, then by date, then in the order added
function tasksIn(listId) {
  const l = listById(listId);
  return tasks
    .filter(l.includes)
    .sort(
      (a, b) =>
        Number(a.done) - Number(b.done) ||
        a.date.localeCompare(b.date) ||
        a.createdAt.localeCompare(b.createdAt)
    );
}

// A date chip: shows a date as text and opens the calendar below when clicked
function createDatePicker(onPick) {
  const wrap = document.createElement("span");
  wrap.className = "date-picker";

  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "date-chip";

  const state = { value: null, min: null, max: null };
  chip.addEventListener("click", () => toggleCalendar(chip, state, onPick));

  wrap.append(chip);
  return {
    wrap,
    chip,
    set(value, min, max, label) {
      Object.assign(state, { value, min, max });
      chip.textContent = label;
    },
  };
}

// ----- Custom calendar -----
// One shared pop-up. It only shows the weeks that contain choosable days:
// a single row for This Week or Next Week, a few rows for This Month.
// Days outside the allowed range are shown faded and can't be picked.

const MONTHS = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];

const cal = document.createElement("div");
cal.className = "cal";
cal.setAttribute("role", "dialog");
cal.setAttribute("aria-label", "Choose a date");
cal.hidden = true;
document.body.appendChild(cal);

// Dims the page behind the calendar when it opens as a bottom sheet (phones)
const calBackdrop = document.createElement("div");
calBackdrop.className = "cal-backdrop";
calBackdrop.hidden = true;
document.body.appendChild(calBackdrop);

let calAnchor = null; // the chip the calendar is open for
let calHideTimer = null;

// "November 2026", "November – December 2026" or "December 2026 – January 2027"
function calTitle(min, max) {
  const a = parseKey(min);
  const b = parseKey(max);
  if (a.getFullYear() !== b.getFullYear()) {
    return `${MONTHS[a.getMonth()]} ${a.getFullYear()} – ${MONTHS[b.getMonth()]} ${b.getFullYear()}`;
  }
  if (a.getMonth() !== b.getMonth()) {
    return `${MONTHS[a.getMonth()]} – ${MONTHS[b.getMonth()]} ${a.getFullYear()}`;
  }
  return `${MONTHS[a.getMonth()]} ${a.getFullYear()}`;
}

function toggleCalendar(chip, { value, min, max }, onPick) {
  if (calAnchor === chip) {
    closeCalendar();
    return;
  }
  closeCalendar(true);
  clearTimeout(calHideTimer);
  calAnchor = chip;

  const title = document.createElement("div");
  title.className = "cal-title";
  title.textContent = calTitle(min, max);

  const grid = document.createElement("div");
  grid.className = "cal-grid";
  for (const wd of ["S", "M", "T", "W", "T", "F", "S"]) {
    const cell = document.createElement("span");
    cell.className = "cal-wd";
    cell.textContent = wd;
    grid.appendChild(cell);
  }

  // From the Sunday on or before min, to the Saturday on or after max
  const first = parseKey(min);
  const start = addDays(first, -first.getDay());
  const last = parseKey(max);
  const end = addDays(last, 6 - last.getDay());

  let selectedBtn = null;
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const key = dateKey(d);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cal-day";
    btn.disabled = key < min || key > max;
    btn.classList.toggle("today", key === R.today);
    btn.classList.toggle("selected", key === value);
    btn.setAttribute("aria-label", parseKey(key).toDateString());

    // Mark the 1st of a month with the month's short name, so weeks that
    // cross into the next month are clear
    if (d.getDate() === 1) {
      const mon = document.createElement("span");
      mon.className = "cal-mon";
      mon.textContent = MONTHS[d.getMonth()].slice(0, 3);
      btn.appendChild(mon);
    }
    btn.append(String(d.getDate()));

    btn.addEventListener("click", () => {
      closeCalendar();
      chip.focus();
      onPick(key);
    });
    grid.appendChild(btn);
    if (key === value) selectedBtn = btn;
  }

  cal.replaceChildren(title, grid);
  // On phones it opens as a bottom sheet over a dimmed page
  const asSheet = PHONE.matches;
  cal.classList.toggle("sheet", asSheet);
  cal.classList.remove("above");
  cal.hidden = false;
  calBackdrop.hidden = !asSheet;
  positionCalendar();

  // Next frame: fade and slide in
  requestAnimationFrame(() => {
    cal.classList.add("open");
    if (asSheet) calBackdrop.classList.add("open");
  });
  (selectedBtn || grid.querySelector(".cal-day:not(:disabled)"))?.focus({ preventScroll: true });
}

// Below the chip, lined up with its right edge; above it if there's no room below
function positionCalendar() {
  // A bottom sheet is pinned to the bottom of the screen by the CSS
  if (cal.classList.contains("sheet")) {
    cal.style.left = "";
    cal.style.top = "";
    return;
  }
  const r = calAnchor.getBoundingClientRect();
  const w = cal.offsetWidth;
  const h = cal.offsetHeight;
  const margin = 16;

  let left = r.right - w;
  left = Math.max(margin, Math.min(left, window.innerWidth - w - margin));
  let top = r.bottom + 8;
  const flip = top + h > window.innerHeight - margin && r.top - 8 - h > margin;
  if (flip) top = r.top - 8 - h;

  cal.classList.toggle("above", flip);
  cal.style.left = `${left + window.scrollX}px`;
  cal.style.top = `${top + window.scrollY}px`;
}

function closeCalendar(instant = false) {
  if (!calAnchor) return;
  calAnchor = null;
  cal.classList.remove("open");
  calBackdrop.classList.remove("open");
  clearTimeout(calHideTimer);
  const hide = () => {
    cal.hidden = true;
    calBackdrop.hidden = true;
  };
  if (instant || reduceMotion.matches) hide();
  else calHideTimer = setTimeout(hide, 320); // after the close animation
}

// Close when clicking elsewhere, pressing Escape, or resizing the window
document.addEventListener("pointerdown", (e) => {
  if (calAnchor && !cal.contains(e.target) && !calAnchor.contains(e.target)) closeCalendar();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && calAnchor) {
    const chip = calAnchor;
    closeCalendar();
    chip.focus();
  }
});
// Only when the width changes: phones fire "resize" just from the address
// bar sliding in and out while scrolling, which shouldn't close the sheet
let lastWidth = window.innerWidth;
window.addEventListener("resize", () => {
  if (window.innerWidth === lastWidth) return;
  lastWidth = window.innerWidth;
  closeCalendar(true);
});

// Tabs are built once and then updated in place, so their changes can animate
const tabButtons = new Map(); // list id -> { tab, count }

// The glow that sits under the active tab and slides between tabs
const tabGlow = document.createElement("span");
tabGlow.className = "tab-glow";
tabGlow.setAttribute("aria-hidden", "true");

function positionTabGlow() {
  const { tab } = tabButtons.get(activeList);
  tabGlow.style.width = `${tab.offsetWidth}px`;
  tabGlow.style.height = `${tab.offsetHeight}px`;
  tabGlow.style.transform = `translate(${tab.offsetLeft}px, ${tab.offsetTop}px)`;
}

// Fade whichever edge of the tab row has more tabs hidden past it
function updateTabFades() {
  const maxScroll = tabs.scrollWidth - tabs.clientWidth;
  tabs.classList.toggle("fade-left", tabs.scrollLeft > 2);
  tabs.classList.toggle("fade-right", tabs.scrollLeft < maxScroll - 2);
}
tabs.addEventListener("scroll", updateTabFades, { passive: true });

// Scroll the tab row so the selected tab sits in the middle (only matters
// when the tabs don't all fit, e.g. on phones)
function revealActiveTab(smooth = true) {
  const { tab } = tabButtons.get(activeList);
  const left = tab.offsetLeft - (tabs.clientWidth - tab.offsetWidth) / 2;
  tabs.scrollTo({ left: Math.max(0, left), behavior: smooth && !reduceMotion.matches ? "smooth" : "auto" });
}

// Tabs change width when their badge grows or shrinks; keep the glow and fades fitted
const tabResizeWatcher = new ResizeObserver(() => {
  positionTabGlow();
  updateTabFades();
});

function buildTabs() {
  tabs.appendChild(tabGlow);
  for (const l of LISTS) {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "tab";
    tab.addEventListener("click", () => switchList(l.id));

    const label = document.createElement("span");
    label.textContent = l.name;

    const count = document.createElement("span");
    count.className = "tab-count roll";

    tab.append(label, count);
    tabs.appendChild(tab);
    tabButtons.set(l.id, { tab, count });
    tabResizeWatcher.observe(tab);
  }
  tabResizeWatcher.observe(tabs); // the row itself resizes with the window
}

function renderTabs() {
  for (const l of LISTS) {
    const { tab, count } = tabButtons.get(l.id);
    const remaining = tasks.filter((t) => l.includes(t) && !t.done).length;

    const wasVisible = count.classList.contains("visible");

    tab.classList.toggle("active", l.id === activeList);
    count.classList.toggle("visible", remaining > 0);
    // Going to 0: keep the last number showing while the badge shrinks away.
    // Just appearing: show the number straight away, no roll.
    if (remaining > 0) rollTo(count, remaining, wasVisible);
  }
  positionTabGlow();
}

// Changes the number inside a .roll element, rolling it up when it
// increases and down when it decreases
function rollTo(el, value, animate = true) {
  const prev = el.dataset.value === undefined ? null : Number(el.dataset.value);
  if (value === prev) return;
  el.dataset.value = value;

  const next = document.createElement("span");
  next.className = "num";
  next.textContent = value;

  if (!animate || prev === null || reduceMotion.matches) {
    el.replaceChildren(next);
    return;
  }

  const goingUp = value > prev;

  // Drop any number still on its way out from a previous quick change
  el.querySelectorAll(".num.leaving").forEach((n) => n.remove());
  const old = el.querySelector(".num");

  // New number starts below (going up) or above (going down)...
  next.classList.add(goingUp ? "below" : "above");
  el.appendChild(next);
  next.getBoundingClientRect(); // apply the start position before animating
  next.classList.remove("below", "above");

  // ...and the old number exits the opposite way
  if (old) {
    old.classList.add("leaving", goingUp ? "above" : "below");
    old.addEventListener("transitionend", () => old.remove(), { once: true });
    setTimeout(() => old.remove(), 500); // fallback in case transitionend doesn't fire
  }
}

function createTaskItem(task) {
  const li = document.createElement("li");
  li.className = "task-item" + (task.done ? " done" : "");
  li.dataset.id = task.id;

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = task.done;
  checkbox.setAttribute("aria-label", `Done: ${task.text}`);
  checkbox.addEventListener("change", () => toggleTask(task.id, li));
  // A label around it gives the checkbox a larger area to tap
  const checkHit = document.createElement("label");
  checkHit.className = "check-hit";
  checkHit.appendChild(checkbox);

  // Outer span takes the free space; inner span carries the animated strike line
  const text = document.createElement("span");
  text.className = "task-text";
  const label = document.createElement("span");
  label.className = "task-label";
  label.textContent = task.text;
  text.appendChild(label);

  // Date chip: click to reschedule; the task then moves to the matching lists
  const picker = createDatePicker((date) => changeDate(task.id, date));
  const overdue = isOverdue(task);
  picker.set(
    task.date,
    R.today,
    maxDate(),
    overdue ? `Overdue · ${formatDate(task.date)}` : formatDate(task.date)
  );
  picker.chip.classList.toggle("overdue", overdue);
  picker.chip.title = "Change date";

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "delete-btn";
  deleteBtn.textContent = "×";
  deleteBtn.title = "Delete task";
  deleteBtn.setAttribute("aria-label", `Delete: ${task.text}`);
  deleteBtn.addEventListener("click", () => deleteTask(task.id));

  li.append(checkHit, text, picker.wrap, deleteBtn);
  return li;
}

// Panels are built once (one per list, side by side in the track).
// After that only their contents are updated, so the counts can roll.
const panels = new Map(); // list id -> { panel, ul, empty, footer, remaining, total, plural }

function buildPanels() {
  for (const l of LISTS) {
    const panel = document.createElement("section");
    panel.className = "list-panel";

    const ul = document.createElement("ul");
    ul.className = "task-list";

    const empty = document.createElement("p");
    empty.className = "empty-message";
    empty.textContent = `No tasks for ${l.name} yet. Add one above!`;

    // "<remaining> of <total> task(s) remaining", with the two numbers rolling
    const footer = document.createElement("p");
    footer.className = "task-count";
    const remaining = document.createElement("span");
    remaining.className = "roll";
    const total = document.createElement("span");
    total.className = "roll";
    const plural = document.createElement("span");
    footer.append(remaining, " of ", total, " task", plural, " remaining");

    panel.append(ul, empty, footer);
    track.appendChild(panel);
    panels.set(l.id, { panel, ul, empty, footer, remaining, total, plural });
  }
}

function renderPanels() {
  for (const l of LISTS) {
    const { panel, ul, empty, footer, remaining, total, plural } = panels.get(l.id);

    const panelTasks = tasksIn(l.id);

    // Hidden panels can't be tabbed into or clicked
    panel.inert = l.id !== activeList;

    ul.replaceChildren(...panelTasks.map(createTaskItem));

    // Only roll when the footer was already showing on the visible list
    const animate = !footer.hidden && !panel.inert;
    empty.hidden = panelTasks.length > 0;
    footer.hidden = panelTasks.length === 0;
    if (panelTasks.length > 0) {
      rollTo(remaining, panelTasks.filter((t) => !t.done).length, animate);
      rollTo(total, panelTasks.length, animate);
      plural.textContent = panelTasks.length === 1 ? "" : "s";
    }
  }
}

// Slides the track to the active list and fits the viewport to its height
function positionTrack() {
  const index = LISTS.findIndex((l) => l.id === activeList);
  track.style.transform = `translateX(-${index * 100}%)`;
  const activePanel = track.children[index];
  viewport.style.height = activePanel.offsetHeight + "px";
}

// ----- Progress panel -----

// The lists that get a bar (each list already includes the shorter ones)
const PERIODS = ["today", "this-week", "this-month"];

const stats = document.getElementById("stats");
const gaugeEl = document.querySelector(".gauge");
const gaugeFill = document.getElementById("gauge-fill");
const gaugePct = document.getElementById("gauge-pct");
const gaugeDone = document.getElementById("gauge-done");
const gaugeTotal = document.getElementById("gauge-total");
const gaugeLabel = document.getElementById("gauge-label");
const statBars = document.getElementById("stat-bars");
const barParts = []; // one { pct, done, total, fill } per period

// Phones: a compact one-line summary (mini ring, %, count) that opens the full panel
const statsSummary = document.getElementById("stats-summary");
const miniFill = document.getElementById("mini-fill");
const miniLabel = document.getElementById("mini-label");
const miniPct = document.getElementById("mini-pct");
const miniDone = document.getElementById("mini-done");
const miniTotal = document.getElementById("mini-total");
const STATS_OPEN_KEY = "todo-stats-open";

function setStatsExpanded(open) {
  stats.classList.toggle("expanded", open);
  statsSummary.setAttribute("aria-expanded", String(open));
}

statsSummary.addEventListener("click", () => {
  const open = !stats.classList.contains("expanded");
  setStatsExpanded(open);
  try {
    localStorage.setItem(STATS_OPEN_KEY, open ? "1" : "0");
  } catch {}
});

try {
  setStatsExpanded(localStorage.getItem(STATS_OPEN_KEY) === "1");
} catch {
  setStatsExpanded(false);
}

// On phones the progress panel moves inside the list card, just under the
// title, so your tasks stay near the top. On wider screens it goes back to
// being its own card beside (or above) the list.
const layout = document.querySelector(".layout");
const appHeader = document.querySelector(".app-header");

function placeStats() {
  if (PHONE.matches) appHeader.after(stats);
  else layout.appendChild(stats);
}
placeStats();
PHONE.addEventListener("change", () => {
  placeStats();
  positionTrack();
  positionTabGlow();
  updateTabFades();
});

function buildBars() {
  for (const listId of PERIODS) {
    const row = document.createElement("div");
    row.className = "bar-row";

    const head = document.createElement("div");
    head.className = "bar-head";
    const label = document.createElement("span");
    label.textContent = listName(listId);
    const value = document.createElement("span");
    value.className = "bar-value";
    const pct = document.createElement("span");
    const done = document.createElement("span");
    done.className = "roll";
    const total = document.createElement("span");
    total.className = "roll";
    value.append(pct, "% · ", done, "/", total);
    head.append(label, value);

    const barTrack = document.createElement("div");
    barTrack.className = "bar-track";
    const fill = document.createElement("div");
    fill.className = "bar-fill";
    barTrack.appendChild(fill);

    row.append(head, barTrack);
    statBars.appendChild(row);
    barParts.push({ pct, done, total, fill });
  }
}

// ----- Odometer for percentages -----
// Each digit is a vertical strip 0-9 (plus a second 0 for wrapping) that
// scrolls through the digits in between at a steady speed.

const ODO_DIGITS = 3; // enough for 100
const ODO_STEP_MS = 150; // time to scroll one digit; same for every column (9 steps ≈ 0.6s)

function makeOdometer(el) {
  el.classList.add("odo");
  const cols = [];
  for (let k = ODO_DIGITS - 1; k >= 0; k--) {
    const col = document.createElement("span");
    col.className = "odo-col";
    // Invisible "0" gives the column its width and text baseline
    const placeholder = document.createElement("span");
    placeholder.className = "odo-ph";
    placeholder.textContent = "0";
    const strip = document.createElement("span");
    strip.className = "odo-strip";
    const cells = [];
    for (let d = 0; d <= 10; d++) {
      const cell = document.createElement("span");
      cell.textContent = d % 10;
      strip.appendChild(cell);
      cells.push(cell);
    }
    col.append(placeholder, strip);
    el.appendChild(col);
    // cols[0] = ones, cols[1] = tens... p = strip position, blank = cell 0 shown empty
    cols[k] = { col, strip, firstCell: cells[0], p: 0, blank: false };
  }
  return { el, cols, target: undefined, frame: 0 };
}

// Is digit column k a leading zero (shown blank, taking no space) for this value?
function isLeading(value, k) {
  return k > 0 && value < 10 ** k;
}

// Draws one column at strip position p (0-10; cell 10 is the wrap-around 0)
function drawColumn(c) {
  c.firstCell.textContent = c.blank ? " " : "0";
  // A blank column grows in (or shrinks away) as it rolls between blank and 1
  c.col.style.maxWidth = c.blank ? `${Math.min(1, c.p)}em` : "";
  c.strip.style.transform = `translateY(${(-c.p * 100) / 11}%)`;
}

function setOdometerInstantly(odo, value) {
  odo.cols.forEach((c, k) => {
    c.blank = isLeading(value, k);
    c.p = c.blank ? 0 : Math.floor(value / 10 ** k) % 10;
    drawColumn(c);
  });
}

function spinTo(el, target, animate = true) {
  if (!el._odo) el._odo = makeOdometer(el);
  const odo = el._odo;
  // Already showing (or scrolling towards) this number: let it finish
  if (target === odo.target) return;
  cancelAnimationFrame(odo.frame);

  if (odo.target === undefined || !animate || reduceMotion.matches) {
    odo.target = target;
    setOdometerInstantly(odo, target);
    return;
  }

  // Every digit turns the same way (up when the number grows, down when it
  // shrinks) and at the same speed, straight to its new digit. Digits with
  // less distance to cover simply finish sooner.
  const dir = target > odo.target ? 1 : -1;
  odo.target = target;

  const moves = odo.cols.map((c, k) => {
    const endBlank = isLeading(target, k);
    const endDigit = endBlank ? 0 : Math.floor(target / 10 ** k) % 10;

    // A "0" sitting at cell 0 is the same as cell 10; use 10 when rolling down
    if (dir < 0 && !c.blank && c.p < 0.001) c.p = 10;

    let steps = dir > 0 ? (((endDigit - c.p) % 10) + 10) % 10 : (((c.p - endDigit) % 10) + 10) % 10;
    // Same digit but going between blank and "0" (e.g. 5% -> 100%): full turn
    if (steps < 0.001 && c.blank !== endBlank) steps = 10;

    const move = { c, start: c.p, steps, endBlank };
    c.blank = c.blank || endBlank; // keep cell 0 blank while it may be on screen
    return move;
  });

  const startTime = performance.now();

  const frame = (now) => {
    // Cells moved so far. The browser's frame time can be slightly earlier than
    // startTime, so clamp at 0 or the first frame would nudge digits backwards
    // (a digit at 0 would wrap round and flash a 9 or 0).
    const travelled = Math.max(0, (now - startTime) / ODO_STEP_MS);
    let running = false;

    for (const m of moves) {
      const d = Math.min(m.steps, travelled);
      if (d < m.steps) running = true;
      let p = m.start + dir * d;
      if (p > 10) p -= 10; // wrapped past 9 -> 0 going up
      if (p < 0) p += 10; // wrapped past 0 -> 9 going down
      m.c.p = p;

      if (d >= m.steps) {
        // Finished: settle on the plain digit
        m.c.blank = m.endBlank;
        if (m.c.p >= 10) m.c.p = 0;
      }
      drawColumn(m.c);
    }

    if (running) odo.frame = requestAnimationFrame(frame);
  };
  odo.frame = requestAnimationFrame(frame);
}

function progressFor(listId) {
  const relevant = tasks.filter(listById(listId).includes);
  const done = relevant.filter((t) => t.done).length;
  const total = relevant.length;
  return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
}

// Smoothly blends low -> middle -> high as the percentage rises.
// Each stop is [percent, hue, saturation %, lightness %].
const COLOR_STOPS = {
  // Dark mode ("muted traffic light"): dusty rose-red -> warm amber -> emerald.
  // (Hue -5 is the same as 355, a rose-red; negative keeps the blend going
  // the short way round to amber.)
  dark: [
    [0, -5, 62, 62],
    [30, -5, 62, 62], // dusty rose-red
    [50, 32, 78, 60], // warm amber
    [65, 40, 80, 58],
    [90, 150, 50, 50], // emerald
    [100, 155, 55, 48],
  ],
  // Light mode ("pastel sunrise"): soft coral -> apricot/honey -> sage green
  light: [
    [0, 4, 80, 68],
    [30, 4, 80, 68], // coral
    [50, 30, 88, 64], // apricot
    [65, 40, 85, 58], // honey
    [90, 145, 45, 55], // sage green
    [100, 150, 48, 52],
  ],
};

const isDarkTheme = () => document.documentElement.dataset.theme === "dark";

// alpha < 1 gives a see-through version (used for the softer light-mode glow)
function progressColor(pct, alpha = 1) {
  const stops = COLOR_STOPS[isDarkTheme() ? "dark" : "light"];
  let [, h, s, l] = stops[stops.length - 1];
  for (let i = 1; i < stops.length; i++) {
    const [p1, h1, s1, l1] = stops[i - 1];
    const [p2, h2, s2, l2] = stops[i];
    if (pct <= p2) {
      const t = (pct - p1) / (p2 - p1);
      h = h1 + t * (h2 - h1);
      s = s1 + t * (s2 - s1);
      l = l1 + t * (l2 - l1);
      break;
    }
  }
  return `hsla(${h}, ${s}%, ${l}%, ${alpha})`;
}

// Glow strength (how see-through the glow color is): a soft glow in dark
// mode, an even fainter haze in light mode
const GLOW_ALPHA = { dark: 0.4, light: 0.45 };
const glowColor = (pct) =>
  pct > 0 ? progressColor(pct, GLOW_ALPHA[isDarkTheme() ? "dark" : "light"]) : "transparent";

function renderStats() {
  // Gauge: the list that's open
  const g = progressFor(activeList);
  const gColor = progressColor(g.pct);
  gaugeFill.style.strokeDashoffset = 100 - g.pct;
  gaugeFill.style.stroke = gColor;
  // The arc glows in its own color, and breathes once the list is all done
  gaugeEl.style.setProperty("--gauge-color", glowColor(g.pct));
  gaugeEl.classList.toggle("complete", g.total > 0 && g.pct === 100);
  gaugeFill.style.opacity = g.pct > 0 ? 1 : 0; // avoid a stray dot at 0%
  spinTo(gaugePct, g.pct);
  rollTo(gaugeDone, g.done);
  rollTo(gaugeTotal, g.total);
  gaugeLabel.textContent = listName(activeList);

  // Phone summary strip: same numbers, small ring
  miniFill.style.strokeDashoffset = 100 - g.pct;
  miniFill.style.stroke = gColor;
  miniFill.style.opacity = g.pct > 0 ? 1 : 0;
  statsSummary.style.setProperty("--mini-glow", glowColor(g.pct));
  miniLabel.textContent = listName(activeList);
  spinTo(miniPct, g.pct);
  rollTo(miniDone, g.done);
  rollTo(miniTotal, g.total);
  statsSummary.setAttribute(
    "aria-label",
    `${listName(activeList)}: ${g.pct}% done, ${g.done} of ${g.total} tasks. Show progress details`
  );

  // Bars: today / this week / this month
  PERIODS.forEach((listId, i) => {
    const p = progressFor(listId);
    const part = barParts[i];
    part.fill.style.width = p.pct + "%";
    part.fill.style.background = progressColor(p.pct);
    part.fill.style.setProperty("--bar-color", glowColor(p.pct));
    spinTo(part.pct, p.pct);
    rollTo(part.done, p.done);
    rollTo(part.total, p.total);
  });
}

// ----- Light ray around the add-task box -----
// When you click or tab into the box, a ray of light runs once around its
// edge and fades out as it completes the lap.

const ray = document.getElementById("input-ray");
let quietFocus = false;

function playRay() {
  const w = input.offsetWidth;
  const h = input.offsetHeight;
  ray.setAttribute("viewBox", `0 0 ${w} ${h}`);
  for (const rect of ray.querySelectorAll("rect")) {
    // Sit exactly on the input's 1px border, with its 8px rounded corners
    rect.setAttribute("x", 0.5);
    rect.setAttribute("y", 0.5);
    rect.setAttribute("width", w - 1);
    rect.setAttribute("height", h - 1);
    rect.setAttribute("rx", 8);
  }
  // Restart the animation even if it's still running
  ray.classList.remove("play");
  ray.getBoundingClientRect();
  ray.classList.add("play");
}

// After the ray: the box glows with aurora colors while it's focused, and the
// background lights go from relaxed to full. They stay full while you work
// anywhere in the to-do list card, and relax again once you click or tab
// outside it.
const inputWrap = input.parentElement;
const appFrame = document.querySelector(".app");

function lightUp(on) {
  inputWrap.classList.toggle("lit", on);
  if (on) document.documentElement.classList.add("ambient-on");
}

function relaxLights() {
  document.documentElement.classList.remove("ambient-on");
}

// The calendar pop-up lives outside the card in the page, but belongs to it
const insideFrame = (el) => appFrame.contains(el) || cal.contains(el) || el === calBackdrop;

document.addEventListener("pointerdown", (e) => {
  if (!insideFrame(e.target)) relaxLights();
});
document.addEventListener("focusin", (e) => {
  if (!insideFrame(e.target)) relaxLights();
});

ray.addEventListener("animationend", (e) => {
  // Two rects each run two animations; react once, when the lap's fade ends
  if (e.animationName === "ray-fade" && e.target.classList.contains("ray-core")) {
    ray.classList.remove("play");
    if (document.activeElement === input) lightUp(true);
  }
});

input.addEventListener("focus", () => {
  if (quietFocus) lightUp(true);
  else if (reduceMotion.matches) lightUp(true); // ray is switched off; just glow
  else playRay();
});

input.addEventListener("blur", () => lightUp(false));

// Used when the app moves focus back to the box itself (after adding a task
// or switching lists), so the ray only plays when you focus it yourself
function focusInputQuietly() {
  quietFocus = true;
  input.focus();
  quietFocus = false;
}

// ----- Add-task form date chip -----
// Today and Tomorrow have a fixed date. This Week, Next Week and This Month
// show a date chip so you can pick a day within that range.

let formDate = null; // the date chosen in the form's chip
const formPicker = createDatePicker((date) => {
  formDate = date;
  renderForm();
});
formPicker.wrap.classList.add("form-picker");
formPicker.chip.title = "Choose a date";
form.insertBefore(formPicker.wrap, addBtn);

function renderForm() {
  const l = listById(activeList);
  const { min, max } = l.range();
  // Keep the chosen date if it still fits this list; otherwise start at the earliest day
  if (!formDate || formDate < min || formDate > max) formDate = min;

  formPicker.set(formDate, min, max, `📅 ${formatDate(formDate)}`);
  formPicker.wrap.classList.toggle("collapsed", !l.pick);
  formPicker.wrap.inert = !l.pick;
  input.placeholder = `Add a task for ${l.name}...`;
}

function render() {
  clearTimeout(reorderTimer);
  closeCalendar(); // its chip is about to be rebuilt
  R = getRanges();
  renderTabs();
  renderStats();
  renderPanels();
  positionTrack();
  renderForm();
}

// ----- Actions -----

function switchList(id) {
  if (id === activeList) return;
  activeList = id;
  formDate = null; // each list starts with its own default date
  saveActiveList();
  render();
  revealActiveTab();
  // Focus stays on the tab you clicked; the add-task box only lights up
  // when you click or tab into it yourself
}

// Returns false if the task couldn't be added (the account is full)
function addTask(text) {
  if (accountId && tasks.length >= TASK_LIMIT) {
    showToast(
      `Your account is full (${TASK_LIMIT.toLocaleString()} tasks). Delete some to add more.`,
      "warning"
    );
    return false;
  }
  const l = listById(activeList);
  const date = l.pick ? formDate : l.range().min;
  const task = {
    id: newId(),
    text,
    done: false,
    date,
    completedAt: null,
    createdAt: new Date().toISOString(),
  };
  tasks.push(task);
  taskChanged(task.id);
  render();
  return true;
}

// ----- Completing tasks (with animation) -----

const STRIKE_DURATION = 350; // ms; matches the strike transition in style.css
const MOVE_DURATION = 400; // ms; how long tasks take to slide to their new spot
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
let reorderTimer = null;

function toggleTask(id, li) {
  const task = tasks.find((t) => t.id === id);
  if (!task) return;

  task.done = !task.done;
  // Remember when it was finished (for progress history later)
  task.completedAt = task.done ? new Date().toISOString() : null;
  taskChanged(id);

  // 1. Draw (or erase) the strike line on the existing row
  li.classList.toggle("done", task.done);
  if (task.done) sparkle(li.querySelector('input[type="checkbox"]'));
  renderTabs();
  renderStats();

  // 2. Once the line has finished, slide tasks into their new order
  clearTimeout(reorderTimer);
  reorderTimer = setTimeout(renderWithMove, reduceMotion.matches ? 0 : STRIKE_DURATION);
}

// A small burst of glowing dots from the checkbox when a task is completed
const SPARKLE_COLORS = ["#22c55e", "#3b82f6", "#a78bfa", "#facc15", "#2dd4bf"];

function sparkle(el) {
  if (reduceMotion.matches) return;
  const r = el.getBoundingClientRect();
  const burst = document.createElement("span");
  burst.className = "sparkle-burst";
  burst.style.left = `${r.left + r.width / 2}px`;
  burst.style.top = `${r.top + r.height / 2}px`;

  const count = 12;
  for (let i = 0; i < count; i++) {
    const dot = document.createElement("span");
    dot.style.setProperty("--a", `${(360 / count) * i + Math.random() * 20}deg`);
    dot.style.setProperty("--d", `${18 + Math.random() * 14}px`);
    dot.style.setProperty("--s", `${3 + Math.random() * 3}px`);
    dot.style.setProperty("--c", SPARKLE_COLORS[i % SPARKLE_COLORS.length]);
    burst.appendChild(dot);
  }
  document.body.appendChild(burst);
  setTimeout(() => burst.remove(), 800);
}

// Re-renders, then animates each visible task from its old position to its
// new one. With fadeInNew, tasks that weren't there before fade in.
function renderWithMove(fadeInNew = false) {
  const oldTops = new Map();
  for (const li of track.querySelectorAll(".list-panel:not([inert]) .task-item")) {
    oldTops.set(li.dataset.id, li.getBoundingClientRect().top);
  }

  render();
  if (reduceMotion.matches) return;

  for (const li of track.querySelectorAll(".list-panel:not([inert]) .task-item")) {
    const oldTop = oldTops.get(li.dataset.id);
    if (oldTop === undefined) {
      if (fadeInNew) li.classList.add("appear");
      continue;
    }
    const shift = oldTop - li.getBoundingClientRect().top;
    if (shift === 0) continue;

    // Start the row where it used to be, then let it glide into place
    li.style.transition = "none";
    li.style.transform = `translateY(${shift}px)`;
    li.getBoundingClientRect(); // force the browser to apply the start position
    li.style.transition = `transform ${MOVE_DURATION}ms cubic-bezier(0.65, 0, 0.35, 1)`;
    li.style.transform = "";
  }
}

function changeDate(id, date) {
  const task = tasks.find((t) => t.id === id);
  if (task && task.date !== date) {
    task.date = date;
    taskChanged(id);
    renderWithMove(); // tasks glide to their new spots if the order changed
  }
}

function deleteTask(id) {
  tasks = tasks.filter((t) => t.id !== id);
  taskDeleted(id);
  render();
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = input.value.trim();
  // If it couldn't be added, the text stays in the box
  if (text && addTask(text)) {
    input.value = "";
    focusInputQuietly();
  }
});

// Keep the viewport height right if the window is resized (text may rewrap)
window.addEventListener("resize", positionTrack);

// ----- Swipe between lists (touch screens) -----
// Drag the list sideways: it follows your finger, then slides on to the
// next or previous list if you swiped far or fast enough, or springs back.
// Up/down movement is left to the browser for normal scrolling.

let swipe = null;
let justSwiped = false;

const activeIndex = () => LISTS.findIndex((l) => l.id === activeList);

viewport.addEventListener("pointerdown", (e) => {
  if (e.pointerType !== "touch" || !e.isPrimary) return;
  swipe = { id: e.pointerId, x: e.clientX, y: e.clientY, dx: 0, start: performance.now(), active: false };
});

viewport.addEventListener("pointermove", (e) => {
  if (!swipe || e.pointerId !== swipe.id) return;
  const dx = e.clientX - swipe.x;
  const dy = e.clientY - swipe.y;

  if (!swipe.active) {
    // Mostly vertical: it's a scroll, not a swipe
    if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {
      swipe = null;
      return;
    }
    // Wait until it's clearly sideways before taking over
    if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
    swipe.active = true;
    viewport.setPointerCapture(e.pointerId);
    track.style.transition = "none"; // follow the finger exactly
    closeCalendar(true);
  }

  // Past the first or last list, the drag resists (moves at a third of the speed)
  const index = activeIndex();
  const atEnd = (index === 0 && dx > 0) || (index === LISTS.length - 1 && dx < 0);
  swipe.dx = atEnd ? dx / 3 : dx;
  track.style.transform = `translateX(calc(-${index * 100}% + ${swipe.dx}px))`;
});

function endSwipe(e) {
  if (!swipe || e.pointerId !== swipe.id) return;
  const s = swipe;
  swipe = null;
  if (!s.active) return;

  track.style.transition = ""; // let it animate from where the finger left it
  const index = activeIndex();
  const elapsed = Math.max(1, performance.now() - s.start);
  const far = Math.abs(s.dx) > viewport.offsetWidth * 0.25;
  const fast = Math.abs(s.dx) > 40 && Math.abs(s.dx) / elapsed > 0.5; // a quick flick
  let target = index;
  if (far || fast) target = s.dx < 0 ? index + 1 : index - 1;
  target = Math.max(0, Math.min(LISTS.length - 1, target));

  // Don't let the end of a swipe count as a tap on a task underneath
  justSwiped = true;
  setTimeout(() => (justSwiped = false), 50);

  if (target !== index) switchList(LISTS[target].id);
  else positionTrack(); // spring back
}

viewport.addEventListener("pointerup", endSwipe);
viewport.addEventListener("pointercancel", endSwipe);
viewport.addEventListener(
  "click",
  (e) => {
    if (justSwiped) {
      e.preventDefault();
      e.stopPropagation();
    }
  },
  true
);

// Roll the lists over when the day changes (checked every minute and when
// you come back to the tab), so tomorrow's tasks move into Today by themselves
function checkForNewDay() {
  if (getRanges().today !== R.today) render();
}
setInterval(checkForNewDay, 60 * 1000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) checkForNewDay();
});

// ----- Theme toggle -----

// One on the sign-in page, one in the to-do card's header
const themeToggles = document.querySelectorAll(".theme-toggle");

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  // Show the icon for the theme you'd switch TO
  for (const btn of themeToggles) {
    btn.textContent = theme === "dark" ? "☀️" : "🌙";
    btn.title = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
  }
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(next);
  renderStats(); // progress colors differ between themes
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    // Storage unavailable; theme just won't be remembered
  }
}

themeToggles.forEach((btn) => btn.addEventListener("click", toggleTheme));

applyTheme(document.documentElement.dataset.theme || "light");

// ----- Sign-in page and account -----
// The page shows either the sign-in card or the to-do list. index.html picks
// which one before the page paints, so the wrong one never flashes up; after
// that, showScreen() switches between them with an animation. sync.js does
// the actual signing in, and calls onAccountChange() when it knows who's
// signed in.

const root = document.documentElement;
const MODE_KEY = "todo-mode"; // "guest" once you've chosen guest mode
const SCREEN_LEAVE_MS = 300; // matches screen-out in style.css
const SCREEN_ENTER_MS = 700; // screen-in (0.6s) plus the progress panel's small delay

const signinCard = document.getElementById("signin");
const googleBtn = document.getElementById("google-btn");
const guestBtn = document.getElementById("guest-btn");
const signinError = document.getElementById("signin-error");
const signInPill = document.getElementById("sign-in-btn");
const avatarBtn = document.getElementById("avatar-btn");
const avatarImg = document.getElementById("avatar-img");
const avatarInitials = document.getElementById("avatar-initials");
const accountMenu = document.getElementById("account-menu");
const menuName = document.getElementById("menu-name");
const menuEmail = document.getElementById("menu-email");
const signOutBtn = document.getElementById("sign-out-btn");

// sync.js loads after this file (see the end of index.html). This settles
// once it has run, in case a button is pressed before then.
const syncLoaded = new Promise((resolve) => {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", resolve, { once: true });
  } else {
    resolve();
  }
});

let screenTimer = null;
let screenTarget = null; // where a switch in progress is heading
let enterTimer = null;

// The list measures as zero while it's hidden, so lay it out again once shown
function refreshLayout() {
  viewport.classList.add("no-animate");
  tabs.classList.add("no-animate");
  positionTrack();
  positionTabGlow();
  revealActiveTab(false);
  updateTabFades();
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      viewport.classList.remove("no-animate");
      tabs.classList.remove("no-animate");
    });
  });
}

// Switches to "signin" or "app": the current card shrinks away, then the
// other rises in. afterSwap runs once the old card is out of sight.
function showScreen(name, afterSwap) {
  if (screenTimer && screenTarget === name) return; // already on its way there
  const current = root.dataset.screen;
  const leaving = current === "app" ? layout : signinCard;

  if (current === name) {
    // Already there; just cancel a switch away from it if one was starting
    if (screenTimer) {
      clearTimeout(screenTimer);
      screenTimer = null;
      leaving.classList.remove("leaving");
    }
    afterSwap?.();
    return;
  }

  clearTimeout(screenTimer);
  clearTimeout(enterTimer);
  layout.classList.remove("entering");
  closeCalendar(true);
  closeAccountMenu();

  const swap = () => {
    screenTimer = null;
    screenTarget = null;
    leaving.classList.remove("leaving");
    root.dataset.screen = name;
    if (leaving === signinCard) setSigningIn(false); // reset it while it's hidden
    afterSwap?.();
    if (name === "app") {
      refreshLayout();
      if (!reduceMotion.matches) {
        layout.classList.add("entering");
        enterTimer = setTimeout(() => layout.classList.remove("entering"), SCREEN_ENTER_MS);
      }
    }
  };

  if (reduceMotion.matches) {
    swap();
  } else {
    leaving.classList.add("leaving");
    screenTarget = name;
    screenTimer = setTimeout(swap, SCREEN_LEAVE_MS);
  }
}

// "Signing you in…" on the Google button, with the guest button paused
function setSigningIn(on) {
  if (on) root.dataset.signingIn = "";
  else delete root.dataset.signingIn;
  googleBtn.setAttribute("aria-busy", String(on));
  guestBtn.disabled = on;
}

const isSigningIn = () => root.dataset.signingIn !== undefined;

function showSigninError(message) {
  signinError.textContent = message;
  signinError.hidden = false;
}

function hideSigninError() {
  signinError.hidden = true;
}

// Remembers guest mode, so guests go straight to their list next time
function setGuestMode(on) {
  try {
    if (on) localStorage.setItem(MODE_KEY, "guest");
    else localStorage.removeItem(MODE_KEY);
  } catch {}
}

guestBtn.addEventListener("click", () => {
  hideSigninError();
  setGuestMode(true);
  showScreen("app");
});

googleBtn.addEventListener("click", async () => {
  if (isSigningIn()) return;
  hideSigninError();
  setSigningIn(true);
  await syncLoaded;
  // If it works, the browser is already on its way to Google
  const result = typeof signInWithGoogle === "function" ? await signInWithGoogle() : { error: true };
  if (result.error) {
    setSigningIn(false);
    showSigninError("Couldn't reach Google sign-in. Check your connection and try again.");
  }
});

// Guest mode's "Sign in" button: back to the sign-in page
signInPill.addEventListener("click", () => {
  setGuestMode(false);
  hideSigninError();
  showScreen("signin");
});

// ----- Account menu (avatar) -----

function closeAccountMenu() {
  accountMenu.classList.remove("open");
  avatarBtn.setAttribute("aria-expanded", "false");
}

avatarBtn.addEventListener("click", () => {
  const open = !accountMenu.classList.contains("open");
  accountMenu.classList.toggle("open", open);
  avatarBtn.setAttribute("aria-expanded", String(open));
});

document.addEventListener("pointerdown", (e) => {
  if (
    accountMenu.classList.contains("open") &&
    !accountMenu.contains(e.target) &&
    !avatarBtn.contains(e.target)
  ) {
    closeAccountMenu();
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && accountMenu.classList.contains("open")) {
    closeAccountMenu();
    avatarBtn.focus();
  }
});

signOutBtn.addEventListener("click", async () => {
  closeAccountMenu();
  await syncLoaded;
  if (typeof signOutOfCloud === "function") await signOutOfCloud();
  // sync.js then reports that nobody's signed in, which brings back the sign-in page
});

// "Jane Doe" -> "JD", "jane@gmail.com" -> "J"
function initialsOf(text) {
  const words = text.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  return words.map((w) => Array.from(w)[0]).join("").toUpperCase() || "?";
}

// Fills in the header's avatar and menu (user = null means guest)
function showAccount(user) {
  root.dataset.account = user ? "user" : "guest";
  if (!user) return;

  const meta = user.user_metadata || {};
  const name = meta.full_name || meta.name || "";
  const email = user.email || "";
  menuName.textContent = name || email;
  menuEmail.textContent = name ? email : "";
  avatarInitials.textContent = initialsOf(name || email);
  avatarBtn.setAttribute("aria-label", `Account: ${name || email}`);

  // Google photo: fades in over the initials once loaded (initials stay if it fails)
  const photo = meta.avatar_url || meta.picture || "";
  if (photo !== (avatarImg.getAttribute("src") || "")) {
    avatarImg.classList.remove("loaded");
    if (photo) avatarImg.src = photo;
    else avatarImg.removeAttribute("src");
  }
}

avatarImg.addEventListener("load", () => avatarImg.classList.add("loaded"));
avatarImg.addEventListener("error", () => avatarImg.classList.remove("loaded"));

// The sign-in saved on this device, so the avatar shows straight away
// (sync.js confirms it a moment later)
function savedUser() {
  try {
    const saved = JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY));
    return saved?.user ?? null;
  } catch {
    return null;
  }
}

// Removes sign-in leftovers (?code=… or ?error=…) from the address bar
function cleanAuthParamsFromUrl() {
  const url = new URL(location.href);
  const before = url.href;
  for (const p of ["code", "state", "error", "error_code", "error_description"]) {
    url.searchParams.delete(p);
  }
  if (/(^#|&)(access_token|error)=/.test(url.hash)) url.hash = "";
  if (url.href !== before) history.replaceState(history.state, "", url.href);
}

// sync.js calls this with the signed-in user, or null for nobody: once when
// the page loads, then whenever it changes (here, in another tab, or when a
// sign-in runs out)
function onAccountChange(user) {
  const wasSignedIn = root.dataset.account === "user";
  cleanAuthParamsFromUrl();

  if (user) {
    // Just signed in (or as someone else): show that account's tasks
    if (accountId !== user.id) {
      useAccount(user.id);
      render();
    }
    showAccount(user);
    setGuestMode(false);
    hideSigninError();
    showScreen("app");
  } else if (wasSignedIn) {
    // Signed out: the list keeps your avatar and tasks until it's out of
    // sight, then switches to this device's guest tasks
    showScreen("signin", () => {
      showAccount(null);
      useAccount(null);
      render();
    });
  } else if (isSigningIn()) {
    setSigningIn(false);
    showSigninError("Sign-in didn't finish. Please try again.");
  }
}

// sync.js calls this if Supabase couldn't load (for example when offline).
// Signed in, you can keep working: changes wait here until it can connect.
function onCloudUnavailable() {
  if (root.dataset.account === "user") {
    showSyncStatus("offline", "Offline · changes will sync when you're back online");
  }
  if (isSigningIn()) {
    setSigningIn(false);
    showSigninError("Couldn't reach the sign-in service. Check your connection and try again.");
  }
}

// ----- Tasks arriving from the cloud -----

// Two task lists hold the same tasks (in any order)
const taskKey = (t) => JSON.stringify([t.id, t.text, t.done, t.date, t.completedAt, t.createdAt]);
function sameTasks(a, b) {
  if (a.length !== b.length) return false;
  const keys = new Set(a.map(taskKey));
  return b.every((t) => keys.has(taskKey(t)));
}

// sync.js hands over the account's tasks as the cloud has them. Tasks with
// changes still on their way up (the keepLocal ids) stay as they are here.
function applyCloudTasks(cloudTasks, keepLocal) {
  const next = cloudTasks.filter((t) => !keepLocal.has(t.id));
  for (const id of keepLocal) {
    const t = taskById(id);
    if (t) next.push(t);
  }
  if (sameTasks(tasks, next)) return; // nothing new: leave the list (and any animation) alone
  tasks = next;
  changeCount++;
  saveTasks();
  renderWithMove(true); // tasks glide to their new places; new ones fade in
}

// Every row showing a task (it can be in several lists at once)
const rowsFor = (id) => track.querySelectorAll(`.task-item[data-id="${CSS.escape(id)}"]`);

// sync.js passes on live changes from your other devices: id -> the task as
// it is now, or null if it was deleted. They play out like your own changes:
// ticks get the strike-through, deleted tasks fade out, new ones fade in,
// then everything glides into place.
function applyCloudChanges(changes) {
  let changed = false;
  let pause = false; // something on screen needs a moment to animate first

  for (const [id, task] of changes) {
    // Changed here too and not sent yet: this device's version wins
    if (unsynced.saved.has(id) || unsynced.deleted.has(id)) continue;
    const current = taskById(id);

    if (!task) {
      if (!current) continue;
      tasks = tasks.filter((t) => t.id !== id);
      rowsFor(id).forEach((li) => li.classList.add("vanish"));
      pause = true;
    } else if (!current) {
      tasks.push(task);
    } else if (taskKey(current) !== taskKey(task)) {
      if (current.done !== task.done) {
        rowsFor(id).forEach((li) => li.classList.toggle("done", task.done));
        pause = true;
      }
      Object.assign(current, task);
    } else {
      continue; // already showing exactly this
    }
    changed = true;
  }
  if (!changed) return;

  changeCount++;
  saveTasks();
  renderTabs(); // counts roll straight away
  renderStats();
  clearTimeout(reorderTimer);
  if (pause && !reduceMotion.matches) {
    reorderTimer = setTimeout(() => renderWithMove(true), STRIKE_DURATION);
  } else {
    renderWithMove(true);
  }
}

// sync.js calls this if the cloud refused new tasks because the account is
// full (only possible if several devices added tasks at once near the
// limit). They come off this device too, with a message saying why.
function dropTasksOverLimit(ids) {
  const drop = new Set(ids);
  tasks = tasks.filter((t) => !drop.has(t.id));
  for (const id of drop) unsynced.saved.delete(id);
  changeCount++;
  saveTasks();
  renderWithMove();
  const n = drop.size;
  showToast(
    `Your account is full (${TASK_LIMIT.toLocaleString()} tasks), so ${n} new task${n === 1 ? "" : "s"} couldn't be saved.`,
    "warning"
  );
}

// ----- Sync status: the dot on your avatar, and the line in its menu -----

const syncLabel = document.getElementById("sync-label");

// sync.js reports "synced", "saving" or "offline" with a description, or
// null when not syncing (signed out)
function showSyncStatus(state, label = "") {
  if (state) root.dataset.sync = state;
  else delete root.dataset.sync;
  syncLabel.textContent = label;
  avatarBtn.title = label;
}

// ----- Toast: a short message that slides up from the bottom -----

const toast = document.getElementById("toast");
const TOAST_MS = 4000; // how long it stays up
let toastTimer = null;

// kind: "success" (green tick) or "warning" (amber "!")
function showToast(message, kind = "success") {
  toast.textContent = message;
  toast.classList.toggle("warning", kind === "warning");
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), TOAST_MS);
}

// Back from Google: still finishing, or it was cancelled / failed
if (isSigningIn()) setSigningIn(true);
if (/[?&#]error(_description)?=/.test(location.search + location.hash)) {
  showSigninError("Google sign-in was cancelled or didn't finish. Please try again.");
}

// Signed in on this device: show your avatar straight away
if (root.dataset.account === "user") {
  const user = savedUser();
  if (user) showAccount(user);
}

// Pressing Back on Google's page restores this page exactly as it was left,
// still saying "Signing you in…"
window.addEventListener("pageshow", (e) => {
  if (e.persisted) setSigningIn(false);
});

// First draw without animation, then turn animations on
viewport.classList.add("no-animate");
tabs.classList.add("no-animate");
stats.classList.add("no-animate");
buildTabs();
buildPanels();
buildBars();
render();
revealActiveTab(false); // e.g. reopening on "This Month" on a phone
updateTabFades();

// Start with nothing focused, even if the browser tries to restore focus to
// the box after a refresh or when coming back with the Back button
function startUnfocused() {
  if (document.activeElement === input) input.blur();
}
startUnfocused();
window.addEventListener("pageshow", startUnfocused);
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    viewport.classList.remove("no-animate");
    tabs.classList.remove("no-animate");
    stats.classList.remove("no-animate");
  });
});

// Web fonts can change text height (and tab widths) once they finish loading
if (document.fonts) {
  document.fonts.ready.then(() => {
    positionTrack();
    revealActiveTab(false);
    updateTabFades();
  });
}
