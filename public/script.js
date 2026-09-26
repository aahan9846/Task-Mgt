// script.js — auth, task board rendering, drag-and-drop, and real-time sync.

const API = '';
let token = localStorage.getItem('token');
let currentUser = null;
let tasks = [];
let socket = null;
let draggedTaskId = null;

const el = (id) => document.getElementById(id);

// ===================== Boot =====================

(async function init() {
  if (token) {
    const ok = await fetchMe();
    if (ok) {
      showApp();
      connectSocket();
      await loadTasks();
      return;
    }
  }
  showAuth();
})();

// ===================== Auth screen wiring =====================

el('auth-toggle').addEventListener('click', () => {
  const showingLogin = !el('login-form').classList.contains('hidden');
  el('login-form').classList.toggle('hidden', showingLogin);
  el('register-form').classList.toggle('hidden', !showingLogin);
  el('auth-title').textContent = showingLogin ? 'Create your account' : 'Welcome back';
  el('auth-toggle').textContent = showingLogin ? 'Already have an account? Log in' : 'Need an account? Sign up';
});

el('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  el('login-error').textContent = '';
  try {
    const res = await api('/api/auth/login', 'POST', {
      email: el('login-email').value.trim(),
      password: el('login-password').value
    });
    onAuthed(res);
  } catch (err) {
    el('login-error').textContent = err.message;
  }
});

el('register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  el('register-error').textContent = '';
  try {
    const res = await api('/api/auth/register', 'POST', {
      name: el('register-name').value.trim(),
      email: el('register-email').value.trim(),
      password: el('register-password').value
    });
    onAuthed(res);
  } catch (err) {
    el('register-error').textContent = err.message;
  }
});

el('logout-btn').addEventListener('click', () => {
  localStorage.removeItem('token');
  token = null;
  currentUser = null;
  if (socket) socket.disconnect();
  showAuth();
});

function onAuthed({ token: t, user }) {
  token = t;
  currentUser = user;
  localStorage.setItem('token', t);
  showApp();
  connectSocket();
  loadTasks();
}

async function fetchMe() {
  try {
    const res = await api('/api/auth/me', 'GET');
    currentUser = res.user;
    return true;
  } catch {
    localStorage.removeItem('token');
    token = null;
    return false;
  }
}

function showAuth() {
  el('auth-screen').classList.remove('hidden');
  el('app-screen').classList.add('hidden');
}

function showApp() {
  el('auth-screen').classList.add('hidden');
  el('app-screen').classList.remove('hidden');
  el('user-name').textContent = currentUser ? currentUser.name : '';
}

// ===================== API helper =====================

async function api(path, method = 'GET', body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ===================== Real-time =====================

function connectSocket() {
  socket = io({ auth: { token } });
  socket.on('connect', () => el('sync-dot').classList.add('live'));
  socket.on('disconnect', () => el('sync-dot').classList.remove('live'));
  socket.on('task:created', () => loadTasks());
  socket.on('task:updated', () => loadTasks());
  socket.on('task:deleted', () => loadTasks());
}

// ===================== Tasks: load & render =====================

async function loadTasks() {
  try {
    tasks = await api('/api/tasks');
    renderBoard();
  } catch (err) {
    console.error(err);
  }
}

function renderBoard() {
  const columns = { todo: [], in_progress: [], done: [] };
  for (const t of tasks) (columns[t.status] || columns.todo).push(t);

  for (const status of ['todo', 'in_progress', 'done']) {
    el(`count-${status}`).textContent = columns[status].length;
    const body = el(`col-${status}`);
    body.innerHTML =
      columns[status].length === 0
        ? '<p class="empty-hint">Nothing here yet.</p>'
        : columns[status].map(renderTaskCard).join('');
  }

  attachCardHandlers();
  attachColumnDnD();
}

function renderTaskCard(t) {
  const overdue = t.due_date && t.status !== 'done' && new Date(t.due_date) < new Date(new Date().toDateString());
  return `
    <div class="task-card" draggable="true" data-id="${t.id}">
      <div class="task-title-row">
        <h3>${escapeHtml(t.title)}</h3>
        <span class="priority-tag priority-${t.priority}">${t.priority}</span>
      </div>
      ${t.description ? `<p class="task-desc">${escapeHtml(t.description)}</p>` : ''}
      ${t.due_date ? `<p class="task-meta ${overdue ? 'overdue' : ''}">${overdue ? 'Overdue — ' : 'Due '}${formatDate(t.due_date)}</p>` : ''}
    </div>
  `;
}

function attachCardHandlers() {
  document.querySelectorAll('.task-card').forEach((card) => {
    card.addEventListener('click', () => openModal(Number(card.dataset.id)));
    card.addEventListener('dragstart', () => {
      draggedTaskId = Number(card.dataset.id);
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
  });
}

function attachColumnDnD() {
  document.querySelectorAll('.column-body').forEach((body) => {
    body.addEventListener('dragover', (e) => {
      e.preventDefault();
      body.classList.add('drag-over');
    });
    body.addEventListener('dragleave', () => body.classList.remove('drag-over'));
    body.addEventListener('drop', async (e) => {
      e.preventDefault();
      body.classList.remove('drag-over');
      const status = body.closest('.column').dataset.status;
      if (draggedTaskId == null) return;
      try {
        await api(`/api/tasks/${draggedTaskId}/status`, 'PATCH', { status });
        await loadTasks();
      } catch (err) {
        console.error(err);
      }
      draggedTaskId = null;
    });
  });
}

// ===================== Task modal (create/edit) =====================

el('new-task-btn').addEventListener('click', () => openModal(null));
el('cancel-task-btn').addEventListener('click', closeModal);

el('task-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = el('task-id').value;
  const payload = {
    title: el('task-title').value.trim(),
    description: el('task-description').value.trim(),
    priority: el('task-priority').value,
    due_date: el('task-due').value || null,
    status: el('task-status').value
  };
  try {
    if (id) {
      await api(`/api/tasks/${id}`, 'PUT', payload);
    } else {
      await api('/api/tasks', 'POST', payload);
    }
    closeModal();
    await loadTasks();
  } catch (err) {
    alert(err.message);
  }
});

el('delete-task-btn').addEventListener('click', async () => {
  const id = el('task-id').value;
  if (!id || !confirm('Delete this task?')) return;
  try {
    await api(`/api/tasks/${id}`, 'DELETE');
    closeModal();
    await loadTasks();
  } catch (err) {
    alert(err.message);
  }
});

function openModal(id) {
  const task = id ? tasks.find((t) => t.id === id) : null;
  el('modal-title').textContent = task ? 'Edit task' : 'New task';
  el('task-id').value = task ? task.id : '';
  el('task-title').value = task ? task.title : '';
  el('task-description').value = task ? task.description : '';
  el('task-priority').value = task ? task.priority : 'medium';
  el('task-due').value = task && task.due_date ? task.due_date.slice(0, 10) : '';
  el('task-status').value = task ? task.status : 'todo';
  el('delete-task-btn').classList.toggle('hidden', !task);
  el('task-modal').classList.remove('hidden');
  el('task-title').focus();
}

function closeModal() {
  el('task-modal').classList.add('hidden');
  el('task-form').reset();
}

el('task-modal').addEventListener('click', (e) => {
  if (e.target === el('task-modal')) closeModal();
});

// ===================== Helpers =====================

function escapeHtml(str = '') {
  return str.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
