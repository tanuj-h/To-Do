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
const list = document.getElementById("task-list");
const emptyMessage = document.getElementById("empty-message");
const taskCount = document.getElementById("task-count");

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

function renderTabs() {
  tabs.innerHTML = "";

  for (const l of LISTS) {
    const remaining = tasks.filter((t) => t.list === l.id && !t.done).length;

    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "tab" + (l.id === activeList ? " active" : "");
    tab.addEventListener("click", () => switchList(l.id));

    const label = document.createElement("span");
    label.textContent = l.name;
    tab.appendChild(label);

    if (remaining > 0) {
      const count = document.createElement("span");
      count.className = "tab-count";
      count.textContent = remaining;
      tab.appendChild(count);
    }

    tabs.appendChild(tab);
  }
}

function renderTasks() {
  list.innerHTML = "";
  const visible = tasks.filter((t) => t.list === activeList);

  for (const task of visible) {
    const li = document.createElement("li");
    li.className = "task-item" + (task.done ? " done" : "");

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = task.done;
    checkbox.addEventListener("change", () => toggleTask(task.id));

    const text = document.createElement("span");
    text.className = "task-text";
    text.textContent = task.text;

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
    list.appendChild(li);
  }

  const remaining = visible.filter((t) => !t.done).length;
  emptyMessage.hidden = visible.length > 0;
  emptyMessage.textContent = `No tasks for ${listName(activeList)} yet. Add one above!`;
  taskCount.hidden = visible.length === 0;
  taskCount.textContent = `${remaining} of ${visible.length} task${visible.length === 1 ? "" : "s"} remaining`;
  input.placeholder = `Add a task for ${listName(activeList)}...`;
}

function render() {
  renderTabs();
  renderTasks();
}

// ----- Actions -----

function switchList(id) {
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

function toggleTask(id) {
  const task = tasks.find((t) => t.id === id);
  if (task) {
    task.done = !task.done;
    saveTasks();
    render();
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

render();
