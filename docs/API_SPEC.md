# API specification

Base URL: `/api/v1`. Auth is an httpOnly cookie (`ll_token`), with
`Authorization: Bearer <token>` accepted as a fallback for tooling.

## Response envelope

Every endpoint answers in one of exactly two shapes.

**Success**

```json
{ "success": true, "message": "optional", "meta": { "page": 1, "limit": 20, "total": 57, "totalPages": 3 }, "data": {} }
```

`meta` appears only on paginated lists. The client's RTK Query unwraps `data`.

**Failure**

```json
{ "success": false, "message": "Some fields need attention.", "code": "VALIDATION_ERROR", "details": [{ "field": "email", "message": "Enter a valid email address" }] }
```

`code` is the stable identifier — branch on it, never on `message`.

### Error codes the client must handle

| Code | Status | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 400 | `details[]` maps field → message. Paint them on the form. |
| `UNAUTHORIZED` | 401 | Not signed in, or the token expired. Try `POST /auth/refresh`, then redirect to login. |
| `ACCOUNT_PENDING` | 403 | Registered, awaiting admin verification. Show the waiting screen. |
| `ACCOUNT_REJECTED` | 403 | Registration declined; `message` carries the reason. |
| `FORBIDDEN` | 403 | Wrong role, or another batch's resource. |
| `NOT_FOUND` | 404 | |
| `UNKNOWN_BATCH_CODE` | 400 | The batch code typed at registration does not exist. |
| `DUPLICATE_USER` | 409 | `details.field` is `email` or `phone`. |
| `CLASS_NOT_LIVE` | 409 | Tried to join a class that has not started or has ended. |
| `INVALID_TRANSITION` | 409 | e.g. starting a class that already ended. |
| `ALREADY_LIVE` | 409 | |
| `LIVEKIT_NOT_CONFIGURED` | 503 | Server has no LiveKit keys. |
| `RATE_LIMITED` | 429 | |

---

## Auth — `/auth`

| Method | Path | Access | Body |
|---|---|---|---|
| POST | `/auth/register` | public | `{ name, email, phone, password, batchCode }` |
| POST | `/auth/login` | public | `{ identifier, password }` — `identifier` is email **or** phone |
| POST | `/auth/refresh` | cookie | — |
| POST | `/auth/logout` | cookie | — |
| GET | `/auth/me` | any signed-in | — |
| PATCH | `/auth/password` | any signed-in | `{ currentPassword, newPassword }` |

`register` returns 201 and **does not sign the user in** — the account is
`pending` until an admin verifies it.

`login`, `refresh` and `me` all return the same user shape:

```ts
{ id, name, email, phone, role: 'student'|'admin', status: 'pending'|'verified'|'rejected'|'suspended',
  batch: { id, code, title } | null, createdAt }
```

`password` change clears the cookies and revokes every other session.

---

## Batches — `/batches`

| Method | Path | Access | Notes |
|---|---|---|---|
| GET | `/batches` | admin | `?page&limit&status&search`. Rows carry `studentCount`. |
| POST | `/batches` | admin | `{ code, title, description?, startDate?, endDate? }` |
| GET | `/batches/:id` | member or admin | Adds `studentCount`, `upcomingClassCount`. |
| PATCH | `/batches/:id` | admin | `code` is immutable. |
| GET | `/batches/:id/students` | member or admin | Students see `{ id, name }` only; admins see contact details and status. |
| GET | `/batches/:id/analytics` | admin | `?from&to`. See below. |

`GET /batches/:id/analytics` returns:

```ts
{
  perStudent: [{ studentId, name, email, classesHeld, attended, attendanceRate, avgPresencePct }],
  perClass:   [{ classId, title, date, durationMin, enrolled, present, attendanceRate, attendanceThresholdPct }],
  summary:    { totalClasses, totalStudents, overallAttendanceRate }
}
```

---

## Classes — `/classes`

| Method | Path | Access | Notes |
|---|---|---|---|
| GET | `/classes` | member or admin | `?page&limit&batchId&status`. Students are forced to their own batch. |
| POST | `/classes` | admin | `{ batchId, title, description?, scheduledStartAt, scheduledDurationMin, attendanceThresholdPct? }` |
| GET | `/classes/:id` | member or admin | |
| PATCH | `/classes/:id` | admin | Only while `scheduled`. |
| POST | `/classes/:id/start` | admin | `scheduled → live`. Stamps `actualStartAt`. |
| POST | `/classes/:id/end` | admin | `live → ended`. Closes the room and finalizes attendance. |
| POST | `/classes/:id/cancel` | admin | `scheduled → cancelled`. |
| POST | `/classes/:id/join` | member or admin | **Mints the LiveKit token.** |
| POST | `/classes/:id/heartbeat` | member | Display only. Every 30s while in the room. |
| GET | `/classes/:id/attendance` | admin | The attendance sheet. |
| GET | `/classes/:id/live-attendance` | admin | Live panel. Poll every 10s. |
| POST | `/classes/:id/recompute` | admin | Rescore a finished class. |

### `POST /classes/:id/join`

The only place a room credential is created. Students get one only while the
class is `live` and only for their own batch.

```ts
{
  token, wsUrl, roomName, isHost,
  classSession: { id, title, startedAt, scheduledDurationMin, attendanceThresholdPct }
}
```

Hand `token` and `wsUrl` straight to `<LiveKitRoom>`. Do not cache it — get a
fresh one each time the student enters.

### `POST /classes/:id/end`

```ts
{ classSessionId, durationMs, enrolledCount, joinedCount, presentCount, avgPresencePct, alreadyFinalized }
```

### `GET /classes/:id/live-attendance`

```ts
{
  elapsedMs,
  rows: [{ studentId, name, email, inRoom, totalPresentMs, presencePct, projectedStatus, lastHeartbeatAt }]
}
```

`projectedStatus` is what the student would be marked if the class ended now.

### `GET /classes/:id/attendance`

```ts
{
  classSession: { id, title, actualStartAt, actualEndAt, durationMs, attendanceThresholdPct, status },
  rows: [{ id, student: { id, name, email, phone }, totalPresentMs, presencePct,
           status, firstJoinedAt, lastLeftAt, segmentCount, overridden }],
  summary: { enrolled, joined, present, partial, absent, avgPresencePct }
}
```

---

## Attendance — `/attendance`

| Method | Path | Access | Notes |
|---|---|---|---|
| GET | `/attendance/me` | student | Own history + `overall` block. |
| PATCH | `/attendance/:id/override` | admin | `{ status, reason }`. Reason is required. |

`GET /attendance/me`:

```ts
{
  data: [{ id, classSession: { id, title, scheduledStartAt, actualStartAt, actualEndAt, status, attendanceThresholdPct },
           totalPresentMs, presencePct, status }],
  meta: { page, limit, total, totalPages },
  overall: { totalClasses, attended, attendanceRate }
}
```

`overall` spans every finalized record, not just the current page.

---

## Admin — `/admin`

| Method | Path | Notes |
|---|---|---|
| GET | `/admin/overview` | Dashboard counters. |
| GET | `/admin/users` | `?page&limit&status&batchId&search`. Defaults to `status=pending`. |
| POST | `/admin/users` | Create another admin. |
| PATCH | `/admin/users/:id/verify` | `{ batchId? }` — optional, to place them in a different batch than they typed. |
| PATCH | `/admin/users/:id/reject` | `{ reason }` — shown to the student at next sign-in. |
| PATCH | `/admin/users/:id/suspend` | `{ reason? }`. Revokes every live session. |

`GET /admin/overview`:

```ts
{ pendingVerifications, verifiedStudents, activeBatches, liveClasses, upcomingClasses,
  recentClasses: [{ id, title, batch: { code }, actualStartAt, actualEndAt, stats }] }
```

---

## Webhooks — `/webhooks`

| Method | Path | Notes |
|---|---|---|
| POST | `/webhooks/livekit` | LiveKit only. Signature-verified, raw body, always answers 200. Not for client use. |
