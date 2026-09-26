# Task Management Application

A full-stack task manager: user accounts with JWT authentication, a
per-user task board with CRUD operations, drag-and-drop status changes,
and real-time sync across open tabs/devices via WebSockets (Socket.IO).
Responsive from desktop down to phone width.

```
task-manager-project/
├── public/                frontend (served as static files)
│   ├── index.html          auth screens + task board
│   ├── style.css
│   └── script.js            fetch calls, drag-and-drop, socket client
├── middleware/
│   └── auth.js              JWT verification middleware
├── server.js                Express app + REST API + Socket.IO
├── db.js                    SQLite connection + schema
├── package.json
└── .env.example
```

## 1. Run it locally

Requires Node.js 18+.

```bash
npm install
cp .env.example .env      # then edit JWT_SECRET to your own secret
npm start
```

Visit **http://localhost:3000**, create an account, and start adding tasks.
Open the same URL in a second tab while logged in to see live sync —
changes in one tab appear in the other without a refresh.

For auto-restart on file changes during development:

```bash
npm run dev
```

## 2. How the pieces fit together

- **Frontend** (`public/`) is plain HTML/CSS/JS — no build step. It stores
  the JWT in `localStorage`, calls the REST API with `fetch()`, and opens
  a Socket.IO connection (authenticated with that same token) to receive
  live task events.
- **Backend** (`server.js`) is an Express app serving the static frontend
  plus a JSON REST API under `/api/*`, and a Socket.IO server for
  real-time updates.
- **Auth**: passwords are hashed with `bcryptjs`; `POST /api/auth/login`
  and `/register` return a JWT, which the frontend sends as
  `Authorization: Bearer <token>` on every task request and as the
  Socket.IO handshake `auth.token`.
- **Database** (`db.js`) is SQLite via `better-sqlite3`, stored in a local
  `tasks.db` file with `users` and `tasks` tables (tasks are scoped to
  `user_id`, so each account only ever sees its own tasks).
- **Real-time**: each authenticated socket joins a room named after its
  user ID. Any create/update/delete broadcasts only to that user's own
  connections — not to other users.

## 3. API reference

| Method | Route                    | Auth  | Description                        |
|--------|--------------------------|-------|-------------------------------------|
| POST   | `/api/auth/register`     | —     | Create an account, returns a token  |
| POST   | `/api/auth/login`        | —     | Log in, returns a token             |
| GET    | `/api/auth/me`           | token | Get the current user                |
| GET    | `/api/tasks`             | token | List the current user's tasks       |
| GET    | `/api/tasks?status=done` | token | Filter tasks by status              |
| GET    | `/api/tasks/:id`         | token | Get one task                        |
| POST   | `/api/tasks`             | token | Create a task                       |
| PUT    | `/api/tasks/:id`         | token | Update a task                       |
| PATCH  | `/api/tasks/:id/status`  | token | Change just the status (drag/drop)  |
| DELETE | `/api/tasks/:id`         | token | Delete a task                       |
| GET    | `/api/health`            | —     | Health check (used by hosts)        |

`status` is one of `todo`, `in_progress`, `done`. `priority` is one of
`low`, `medium`, `high`.

Example — register and create a task from the command line:

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"name":"Alex","email":"alex@example.com","password":"a-strong-password"}' \
  | node -pe "JSON.parse(require('fs').readFileSync(0)).token")

curl -X POST http://localhost:3000/api/tasks \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"title":"Write README","priority":"high","due_date":"2026-10-01"}'
```

## 4. Deploying

This app needs a **persistent Node process** (not a static host), because
it holds open WebSocket connections and reads/writes a SQLite file.

### Option A — Render (recommended, simplest)
1. Push this project to a GitHub repo.
2. On [render.com](https://render.com), create a **New Web Service** from
   that repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Add an environment variable `JWT_SECRET` with your own secret.
5. Deploy. Render gives you a live URL — Socket.IO works over Render's
   standard HTTPS/WSS without extra config.

### Option B — Railway
Same idea: connect the repo, set `JWT_SECRET`, it detects `npm start`
automatically.

### Netlify / Vercel note
These are built for static sites and short-lived serverless functions,
not a long-running server with open WebSocket connections and a local
SQLite file. To deploy there you'd need to drop real-time sync (or move
it to a managed service like Pusher/Ably) and swap SQLite for a hosted
database (Postgres via Neon/Supabase, or MongoDB Atlas).

## 5. Notes on the auth model

The JWT secret (`JWT_SECRET`) signs every token — treat it like a
password and never commit it. Tokens expire after 7 days (see
`signToken` in `server.js`); adjust `expiresIn` there if you want shorter
or longer sessions, or add a refresh-token flow for production use.
