// Keys used to save data in the browser's localStorage
const STORAGE_KEY = "todo-tasks";
const ACTIVE_LIST_KEY = "todo-active-list";
const THEME_KEY = "todo-theme";

// The separate lists, in the order their tabs appear
const LISTS = [
  { id: "today", name: "Today" },
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

function render() {
  clearTimeout(reorderTimer);
  renderTabs();
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
buildTabs();
buildPanels();
render();
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    viewport.classList.remove("no-animate");
    tabs.classList.remove("no-animate");
  });
});

// Web fonts can change text height once they finish loading
if (document.fonts) document.fonts.ready.then(positionTrack);
