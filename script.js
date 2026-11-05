// Keys used to save data in the browser's localStorage
const STORAGE_KEY = "todo-tasks";
const ACTIVE_LIST_KEY = "todo-active-list";
const THEME_KEY = "todo-theme";

// The separate lists, in the order their tabs appear
const LISTS = [
  { id: "today", name: "Today" },
  { id: "tomorrow", name: "Tomorrow" },
  { id: "this-week", name: "This Week" },
  { id: "next-week", name: "Next Week" },
  { id: "this-month", name: "This Month" },
  { id: "next-month", name: "Next Month" },
];

const form = document.getElementById("task-form");
const input = document.getElementById("task-input");
const tabs = document.getElementById("list-tabs");
const viewport = document.getElementById("list-viewport");
const track = document.getElementById("list-track");

// Each task looks like: { id: number, text: string, done: boolean, list: string }
let tasks = loadTasks();
let activeList = loadActiveList();

// ----- Saving and loading -----

function loadTasks() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    const parsed = saved ? JSON.parse(saved) : [];
    // Tasks from before lists existed go into "Today"
    return parsed.map((t) => ({ ...t, list: t.list || "today" }));
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
  return LISTS.find((l) => l.id === id).name;
}

// Tabs are built once and then updated in place, so their changes can animate
const tabButtons = new Map(); // list id -> { tab, count }

function buildTabs() {
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
  }
}

function renderTabs() {
  for (const l of LISTS) {
    const { tab, count } = tabButtons.get(l.id);
    const remaining = tasks.filter((t) => t.list === l.id && !t.done).length;

    const wasVisible = count.classList.contains("visible");

    tab.classList.toggle("active", l.id === activeList);
    count.classList.toggle("visible", remaining > 0);
    // Going to 0: keep the last number showing while the badge shrinks away.
    // Just appearing: show the number straight away, no roll.
    if (remaining > 0) rollTo(count, remaining, wasVisible);
  }
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

  // Dropdown to move the task to a different list
  const move = document.createElement("select");
  move.className = "move-select";
  move.title = "Move to another list";
  for (const l of LISTS) {
    const option = document.createElement("option");
    option.value = l.id;
    option.textContent = l.name;
    option.selected = l.id === task.list;
    move.appendChild(option);
  }
  move.addEventListener("change", () => moveTask(task.id, move.value));

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "delete-btn";
  deleteBtn.textContent = "×";
  deleteBtn.title = "Delete task";
  deleteBtn.addEventListener("click", () => deleteTask(task.id));

  li.append(checkbox, text, move, deleteBtn);
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

    // Unfinished tasks first, completed ones at the bottom (otherwise keep added order)
    const panelTasks = tasks
      .filter((t) => t.list === l.id)
      .sort((a, b) => Number(a.done) - Number(b.done));

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

// Which lists each bar counts
const PERIODS = [
  { name: "Today", lists: ["today"] },
  { name: "This Week", lists: ["today", "tomorrow", "this-week"] },
  { name: "This Month", lists: ["today", "tomorrow", "this-week", "next-week", "this-month"] },
];

const stats = document.getElementById("stats");
const gaugeFill = document.getElementById("gauge-fill");
const gaugePct = document.getElementById("gauge-pct");
const gaugeDone = document.getElementById("gauge-done");
const gaugeTotal = document.getElementById("gauge-total");
const gaugeLabel = document.getElementById("gauge-label");
const statBars = document.getElementById("stat-bars");
const barParts = []; // one { pct, done, total, fill } per period

function buildBars() {
  for (const period of PERIODS) {
    const row = document.createElement("div");
    row.className = "bar-row";

    const head = document.createElement("div");
    head.className = "bar-head";
    const label = document.createElement("span");
    label.textContent = period.name;
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

function progressFor(listIds) {
  const relevant = tasks.filter((t) => listIds.includes(t.list));
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
  const g = progressFor([activeList]);
  gaugeFill.style.strokeDashoffset = 100 - g.pct;
  gaugeFill.style.stroke = progressColor(g.pct);
  gaugeFill.style.opacity = g.pct > 0 ? 1 : 0; // avoid a stray dot at 0%
  spinTo(gaugePct, g.pct);
  rollTo(gaugeDone, g.done);
  rollTo(gaugeTotal, g.total);
  gaugeLabel.textContent = listName(activeList);

  // Bars: today / this week / this month
  PERIODS.forEach((period, i) => {
    const p = progressFor(period.lists);
    const part = barParts[i];
    part.fill.style.width = p.pct + "%";
    part.fill.style.background = progressColor(p.pct);
    spinTo(part.pct, p.pct);
    rollTo(part.done, p.done);
    rollTo(part.total, p.total);
  });
}

function render() {
  clearTimeout(reorderTimer);
  renderTabs();
  renderStats();
  renderPanels();
  positionTrack();
  input.placeholder = `Add a task for ${listName(activeList)}...`;
}

// ----- Actions -----

function switchList(id) {
  if (id === activeList) return;
  activeList = id;
  saveActiveList();
  render();
  input.focus();
}

function addTask(text) {
  tasks.push({ id: Date.now(), text, done: false, list: activeList });
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
  saveTasks();

  // 1. Draw (or erase) the strike line on the existing row
  li.classList.toggle("done", task.done);
  renderTabs();
  renderStats();

  // 2. Once the line has finished, slide tasks into their new order
  clearTimeout(reorderTimer);
  reorderTimer = setTimeout(renderWithMove, reduceMotion.matches ? 0 : STRIKE_DURATION);
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

function moveTask(id, newList) {
  const task = tasks.find((t) => t.id === id);
  if (task) {
    task.list = newList;
    saveTasks();
    render();
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
    input.focus();
  }
});

// Keep the viewport height right if the window is resized (text may rewrap)
window.addEventListener("resize", positionTrack);

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
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    viewport.classList.remove("no-animate");
    tabs.classList.remove("no-animate");
    stats.classList.remove("no-animate");
  });
});

// Web fonts can change text height once they finish loading
if (document.fonts) document.fonts.ready.then(positionTrack);
