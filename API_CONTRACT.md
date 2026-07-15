# Nexia Auth Server — API Contract

> This document defines the API the Nexia IDE client expects from an auth server.
> The server itself is not part of this repository — build one that implements
> these endpoints (Node.js/Express + SQLite is a straightforward fit).

## Base URL

The client ships with a default server URL compiled in, and it's overridable at
runtime from **the account menu → Server Settings** (persisted to
`~/.nexia-ide-server.json`). Point it at your own instance — e.g.
`http://localhost:3500` while developing, or `https://auth.example.com` behind
nginx in production.

## Headers

All endpoints accept `Content-Type: application/json`.
Authenticated endpoints require `Authorization: Bearer <jwt_token>`.

---

## Health Check

### `GET /api/health`
Returns server status. No auth required.

**Response:**
```json
{ "status": "ok", "version": "1.0.0" }
```

---

## Authentication

### `POST /api/auth/register`
Create a new account. **First registered user is auto-promoted to admin.**

**Body:**
```json
{
  "username": "nexia_dev",
  "email": "user@example.com",
  "password": "securepassword"
}
```

**Success (201):**
```json
{
  "token": "jwt_token_here",
  "user": {
    "id": "uuid",
    "username": "nexia_dev",
    "email": "user@example.com",
    "role": "admin",
    "createdAt": "2025-03-01T00:00:00Z",
    "lastLogin": "2025-03-01T00:00:00Z"
  }
}
```

**Error (400/409):**
```json
{ "error": "Email already registered" }
```

---

### `POST /api/auth/login`
Sign in with email and password.

**Body:**
```json
{
  "email": "user@example.com",
  "password": "securepassword"
}
```

**Success (200):** Same shape as register response.

**Error (401):**
```json
{ "error": "Invalid email or password" }
```

---

### `GET /api/auth/me`
Validate the current token and return the user profile. **Requires auth.**

**Success (200):**
```json
{
  "user": { "id": "uuid", "username": "...", "email": "...", "role": "user|admin", "createdAt": "...", "lastLogin": "..." }
}
```

**Error (401):**
```json
{ "error": "Token expired or invalid" }
```

---

### `POST /api/auth/refresh`
Get a fresh token. **Requires auth.**

**Success (200):**
```json
{ "token": "new_jwt_token", "user": { ... } }
```

---

## Admin: User Management

All admin endpoints require `Authorization: Bearer <admin_token>`.
Non-admin tokens get **403 Forbidden**.

### `GET /api/admin/users`
List all registered users.

**Success (200):**
```json
{
  "users": [
    { "id": "uuid", "username": "...", "email": "...", "role": "admin", "createdAt": "...", "lastLogin": "..." },
    { "id": "uuid", "username": "...", "email": "...", "role": "user", "createdAt": "...", "lastLogin": "..." }
  ]
}
```

---

### `POST /api/admin/promote`
Change a user's role to admin.

**Body:**
```json
{ "userId": "uuid", "role": "admin" }
```

**Success (200):**
```json
{ "user": { "id": "uuid", "username": "...", "role": "admin", ... } }
```

---

### `POST /api/admin/demote`
Remove admin privileges (set role back to user).

**Body:**
```json
{ "userId": "uuid" }
```

**Success (200):**
```json
{ "user": { "id": "uuid", "username": "...", "role": "user", ... } }
```

---

### `DELETE /api/admin/users/:id`
Delete a user account permanently.

**Success (200):**
```json
{ "success": true }
```

---

## Cloud Lessons

### `GET /api/lessons`
List all published lessons. **No auth required** (public catalog).

**Success (200):**
```json
{
  "lessons": [
    {
      "id": "uuid",
      "title": "InitD3D — Xbox 360 Direct3D",
      "author": "nexia_dev",
      "version": "1.0.0",
      "difficulty": "beginner",
      "description": "Learn how to initialize Direct3D...",
      "language": "cpp",
      "tags": ["xbox360", "d3d"],
      "createdAt": "2025-03-01T00:00:00Z",
      "updatedAt": "2025-03-01T00:00:00Z"
    }
  ]
}
```

---

### `GET /api/lessons/:id`
Get full lesson data (including blocks, explanations, layout, etc.). **No auth required.**

**Success (200):**
```json
{
  "lesson": {
    "meta": { "id": "...", "title": "...", ... },
    "oldCode": ["line1", "line2"],
    "blocks": [
      {
        "id": "block_includes",
        "sec": "Includes",
        "lines": [{ "t": "#include <xtl.h>" }, { "t": "#include <xgraphics.h>" }]
      }
    ],
    "explanations": {
      "block_includes": { "label": "Xbox Headers", "tp": "concept", "desc": "..." }
    },
    "connections": {},
    "tokens": {},
    "visControls": {},
    "animatedVis": [],
    "layout": {
      "blocks": {
        "block_includes": {
          "spotlight": { "x": 50, "y": 10, "width": 400, "height": 52 },
          "panel": { "x": 520, "y": 10, "width": 340, "height": 260 }
        }
      },
      "tokens": {},
      "connections": {},
      "canvasWidth": 900,
      "canvasHeight": 600
    }
  }
}
```

---

### `POST /api/lessons`
Publish a new lesson. **Requires admin auth.**

**Body:** Full lesson data (same shape as GET response's `lesson` field).

**Success (201):**
```json
{
  "lesson": { "id": "uuid", "title": "...", ... }
}
```

---

### `PUT /api/lessons/:id`
Update an existing lesson. **Requires admin auth.**

**Body:** Full lesson data.

**Success (200):**
```json
{
  "lesson": { "id": "uuid", "title": "...", ... }
}
```

---

### `DELETE /api/lessons/:id`
Delete a lesson. **Requires admin auth.**

**Success (200):**
```json
{ "success": true }
```

---

## JWT Token Format

Tokens should contain at minimum:
```json
{
  "sub": "user_uuid",
  "role": "admin|user",
  "iat": 1709251200,
  "exp": 1709254800
}
```

Recommended expiry: **1 hour**, with refresh.

## Password Hashing

Use **bcrypt** with a cost factor of 10-12.

## Database

SQLite with two tables:

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'user',
  created_at TEXT DEFAULT (datetime('now')),
  last_login TEXT DEFAULT (datetime('now'))
);

CREATE TABLE lessons (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  version TEXT DEFAULT '1.0.0',
  difficulty TEXT DEFAULT 'beginner',
  description TEXT,
  language TEXT DEFAULT 'cpp',
  tags TEXT DEFAULT '[]',
  data TEXT NOT NULL,  -- JSON blob of full lesson data
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
```

## Recommended Dependencies

```
express, cors, bcrypt, jsonwebtoken, better-sqlite3, uuid
```

## CORS

Allow origin from Electron (typically `file://` or `http://localhost:*`).
Simplest: `cors({ origin: true })`.
