// Keys used to save data in the browser's localStorage
const STORAGE_KEY = "todo-tasks";
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

// Each task looks like:
// { id: number, text: string, done: boolean, date: "YYYY-MM-DD", completedAt: ISO string | null }
let tasks = loadTasks();
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

function loadTasks() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    const parsed = saved ? JSON.parse(saved) : [];
    return parsed.map(({ list, ...t }) => ({
      ...t,
      date: t.date || dateForOldList(list),
      completedAt: t.completedAt ?? null,
    }));
  } catch {
    return [];
  }
}

function saveTasks() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
  } catch {
    // Storage unavailable (e.g. private mode); tasks just won't persist
  }
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
    .sort((a, b) => Number(a.done) - Number(b.done) || a.date.localeCompare(b.date) || a.id - b.id);
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
  cal.hidden = false;
  positionCalendar();

  // Next frame: fade and slide in
  requestAnimationFrame(() => cal.classList.add("open"));
  (selectedBtn || grid.querySelector(".cal-day:not(:disabled)"))?.focus({ preventScroll: true });
}

// Below the chip, lined up with its right edge; above it if there's no room below
function positionCalendar() {
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
  clearTimeout(calHideTimer);
  if (instant || reduceMotion.matches) cal.hidden = true;
  else calHideTimer = setTimeout(() => (cal.hidden = true), 200);
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
window.addEventListener("resize", () => closeCalendar(true));

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

// Tabs change width when their badge grows or shrinks; keep the glow fitted
const tabResizeWatcher = new ResizeObserver(() => positionTabGlow());

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
  checkbox.addEventListener("change", () => toggleTask(task.id, li));

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
  deleteBtn.addEventListener("click", () => deleteTask(task.id));

  li.append(checkbox, text, picker.wrap, deleteBtn);
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

// Smoothly blends red -> yellow -> green as the percentage rises
const COLOR_STOPS = [
  [0, 0], // [percent, hue]
  [30, 0], // red
  [50, 45], // yellow
  [65, 50],
  [90, 125], // green
  [100, 130],
];

function progressColor(pct) {
  for (let i = 1; i < COLOR_STOPS.length; i++) {
    const [p1, h1] = COLOR_STOPS[i - 1];
    const [p2, h2] = COLOR_STOPS[i];
    if (pct <= p2) {
      const hue = h1 + ((pct - p1) / (p2 - p1)) * (h2 - h1);
      return `hsl(${hue}, 75%, 50%)`;
    }
  }
  return `hsl(130, 75%, 50%)`;
}

function renderStats() {
  // Gauge: the list that's open
  const g = progressFor(activeList);
  const gColor = progressColor(g.pct);
  gaugeFill.style.strokeDashoffset = 100 - g.pct;
  gaugeFill.style.stroke = gColor;
  // The arc glows in its own color, and breathes once the list is all done
  gaugeEl.style.setProperty("--gauge-color", g.pct > 0 ? gColor : "transparent");
  gaugeEl.classList.toggle("complete", g.total > 0 && g.pct === 100);
  gaugeFill.style.opacity = g.pct > 0 ? 1 : 0; // avoid a stray dot at 0%
  spinTo(gaugePct, g.pct);
  rollTo(gaugeDone, g.done);
  rollTo(gaugeTotal, g.total);
  gaugeLabel.textContent = listName(activeList);

  // Bars: today / this week / this month
  PERIODS.forEach((listId, i) => {
    const p = progressFor(listId);
    const part = barParts[i];
    part.fill.style.width = p.pct + "%";
    part.fill.style.background = progressColor(p.pct);
    part.fill.style.setProperty("--bar-color", p.pct > 0 ? progressColor(p.pct) : "transparent");
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
const insideFrame = (el) => appFrame.contains(el) || cal.contains(el);

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
  // Focus stays on the tab you clicked; the add-task box only lights up
  // when you click or tab into it yourself
}

function addTask(text) {
  const l = listById(activeList);
  const date = l.pick ? formDate : l.range().min;
  tasks.push({ id: Date.now(), text, done: false, date, completedAt: null });
  saveTasks();
  render();
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
  saveTasks();

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

// Re-renders, then animates each visible task from its old position to its new one
function renderWithMove() {
  const oldTops = new Map();
  for (const li of track.querySelectorAll(".list-panel:not([inert]) .task-item")) {
    oldTops.set(li.dataset.id, li.getBoundingClientRect().top);
  }

  render();
  if (reduceMotion.matches) return;

  for (const li of track.querySelectorAll(".list-panel:not([inert]) .task-item")) {
    const oldTop = oldTops.get(li.dataset.id);
    if (oldTop === undefined) continue;
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
    saveTasks();
    renderWithMove(); // tasks glide to their new spots if the order changed
  }
}

function deleteTask(id) {
  tasks = tasks.filter((t) => t.id !== id);
  saveTasks();
  render();
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (text) {
    addTask(text);
    input.value = "";
    focusInputQuietly();
  }
});

// Keep the viewport height right if the window is resized (text may rewrap)
window.addEventListener("resize", positionTrack);

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

const themeToggle = document.getElementById("theme-toggle");

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  // Show the icon for the theme you'd switch TO
  themeToggle.textContent = theme === "dark" ? "☀️" : "🌙";
  themeToggle.title = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
}

themeToggle.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(next);
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    // Storage unavailable; theme just won't be remembered
  }
});

applyTheme(document.documentElement.dataset.theme || "light");

// First draw without animation, then turn animations on
viewport.classList.add("no-animate");
tabs.classList.add("no-animate");
stats.classList.add("no-animate");
buildTabs();
buildPanels();
buildBars();
render();

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

// Web fonts can change text height once they finish loading
if (document.fonts) document.fonts.ready.then(positionTrack);
