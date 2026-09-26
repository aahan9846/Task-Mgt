// server.js
// Express backend for the task manager: user auth (JWT), task CRUD scoped
// per-user, and real-time sync across a user's open tabs/devices via
// Socket.IO.
//
// Run locally:  npm install && npm start
// Then visit:   http://localhost:3000

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server: SocketIOServer } = require('socket.io');

const db = require('./db');
const { requireAuth, JWT_SECRET } = require('./middleware/auth');

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Real-time: each authenticated socket joins a room named after the
// user's id, so task changes only broadcast to that user's own devices. ---
io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('No token provided'));
    const payload = jwt.verify(token, JWT_SECRET);
    socket.userId = payload.sub;
    next();
  } catch (err) {
    next(new Error('Invalid token'));
  }
});

io.on('connection', (socket) => {
  socket.join(`user:${socket.userId}`);
});

function broadcastTaskEvent(userId, event, payload) {
  io.to(`user:${userId}`).emit(event, payload);
}

// ===================== Auth =====================

app.post('/api/auth/register', (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'name, email, and password are required.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (existing) {
    return res.status(409).json({ error: 'An account with that email already exists.' });
  }

  const password_hash = bcrypt.hashSync(password, 10);
  const info = db
    .prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)')
    .run(name, email.toLowerCase(), password_hash);

  const user = { id: info.lastInsertRowid, name, email: email.toLowerCase() };
  const token = signToken(user);
  res.status(201).json({ token, user });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required.' });
  }

  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
  if (!row || !bcrypt.compareSync(password, row.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  const user = { id: row.id, name: row.name, email: row.email };
  const token = signToken(user);
  res.json({ token, user });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

function signToken(user) {
  return jwt.sign({ sub: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
}

// ===================== Tasks (all routes require auth) =====================

app.get('/api/tasks', requireAuth, (req, res) => {
  const { status } = req.query;
  let rows;
  if (status) {
    rows = db
      .prepare('SELECT * FROM tasks WHERE user_id = ? AND status = ? ORDER BY id DESC')
      .all(req.user.id, status);
  } else {
    rows = db.prepare('SELECT * FROM tasks WHERE user_id = ? ORDER BY id DESC').all(req.user.id);
  }
  res.json(rows);
});

app.get('/api/tasks/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Task not found.' });
  res.json(row);
});

app.post('/api/tasks', requireAuth, (req, res) => {
  const { title, description, status, priority, due_date } = req.body;
  if (!title) return res.status(400).json({ error: 'title is required.' });

  const info = db
    .prepare(`
      INSERT INTO tasks (user_id, title, description, status, priority, due_date)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .run(req.user.id, title, description || '', status || 'todo', priority || 'medium', due_date || null);

  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(info.lastInsertRowid);
  broadcastTaskEvent(req.user.id, 'task:created', task);
  res.status(201).json(task);
});

app.put('/api/tasks/:id', requireAuth, (req, res) => {
  const existing = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!existing) return res.status(404).json({ error: 'Task not found.' });

  const merged = { ...existing, ...req.body, id: existing.id, user_id: existing.user_id };

  db.prepare(`
    UPDATE tasks SET title=@title, description=@description, status=@status,
      priority=@priority, due_date=@due_date, updated_at=datetime('now')
    WHERE id=@id AND user_id=@user_id
  `).run(merged);

  const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(existing.id);
  broadcastTaskEvent(req.user.id, 'task:updated', updated);
  res.json(updated);
});

// Lightweight endpoint just for dragging a task between status columns.
app.patch('/api/tasks/:id/status', requireAuth, (req, res) => {
  const { status } = req.body;
  const valid = ['todo', 'in_progress', 'done'];
  if (!valid.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${valid.join(', ')}` });
  }

  const existing = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!existing) return res.status(404).json({ error: 'Task not found.' });

  db.prepare("UPDATE tasks SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, existing.id);
  const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(existing.id);
  broadcastTaskEvent(req.user.id, 'task:updated', updated);
  res.json(updated);
});

app.delete('/api/tasks/:id', requireAuth, (req, res) => {
  const info = db.prepare('DELETE FROM tasks WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Task not found.' });
  broadcastTaskEvent(req.user.id, 'task:deleted', { id: Number(req.params.id) });
  res.status(204).end();
});

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
  console.log(`Task manager running at http://localhost:${PORT}`);
});
