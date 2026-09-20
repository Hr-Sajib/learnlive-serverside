# Data model

Six collections. MongoDB via Mongoose. Files in `src/models/`.

```
Batch ──< User (students)
  │
  └──< ClassSession ──< AttendanceRecord >── User

User ──< Session (refresh grants)
User ──< AuditLog
```

## User — `user.model.ts`

One collection for both roles, separated by `role`.

| Field | Type | Notes |
|---|---|---|
| `name` | string | |
| `email` | string | unique, lowercased |
| `phone` | string | unique. BD format `01[3-9]XXXXXXXX` |
| `passwordHash` | string | argon2. `select: false` — ask for it explicitly |
| `role` | `'student' \| 'admin'` | |
| `status` | `'pending' \| 'verified' \| 'rejected' \| 'suspended'` | |
| `batch` | ObjectId → Batch | `null` for admins |
| `requestedBatchCode` | string | what they typed at registration, for the review screen |
| `verifiedAt` / `verifiedBy` | Date / ObjectId | |
| `rejectionReason` | string | shown to the student at next sign-in |
| `lastLoginAt` | Date | |

Indexes: `{ status, createdAt }` for the approval queue, `{ batch, status }` for
the roster.

**The status machine.** `pending` on registration. An admin moves it to
`verified` or `rejected`. `verified` can become `suspended`, and either can be
re-verified. `authenticate` re-reads the user on every request, so a status
change takes effect immediately rather than when the 15-minute token expires.

## Batch — `batch.model.ts`

| Field | Type | Notes |
|---|---|---|
| `code` | string | unique, uppercase. What students type at registration |
| `title` | string | |
| `status` | `'active' \| 'archived'` | archived batches reject new registrations |
| `startDate` / `endDate` | Date | optional |
| `createdBy` | ObjectId → User | |

`code` is immutable once created — students have already been given it.

## ClassSession — `classSession.model.ts`

| Field | Type | Notes |
|---|---|---|
| `batch` | ObjectId → Batch | |
| `title`, `description` | string | |
| `host` | ObjectId → User | the admin running it |
| `scheduledStartAt` | Date | |
| `scheduledDurationMin` | number | 5–600 |
| `status` | `'scheduled' \| 'live' \| 'ended' \| 'cancelled'` | |
| `actualStartAt` | Date | **start of the attendance window** |
| `actualEndAt` | Date | **end of the attendance window** |
| `roomName` | string | unique, `class_<id>` |
| `attendanceThresholdPct` | number | snapshotted at creation, default 60 |
| `attendanceFinalizedAt` | Date | the finalization claim flag |
| `stats` | object | `{ enrolledCount, joinedCount, presentCount, avgPresencePct }` |

**Lifecycle:** `scheduled → live → ended`, with `scheduled → cancelled`. Every
transition is a guarded `findOneAndUpdate` naming the state it expects to leave,
so a double-click cannot produce two `actualStartAt` values.

`stats` is denormalised deliberately: the batch analytics page reads it instead
of re-aggregating thousands of attendance rows on every load. It is written
once, at finalize.

## AttendanceRecord — `attendance.model.ts`

One per (class, student). **Unique index on `{ classSession, student }`** — this
is what makes the join webhook safely idempotent, since it upserts on that key.

| Field | Type | Notes |
|---|---|---|
| `classSession` | ObjectId | |
| `batch` | ObjectId | denormalised, so batch analytics never joins through ClassSession |
| `student` | ObjectId | |
| `segments` | `{ joinedAt, leftAt, openedBy, closedBy }[]` | `leftAt: null` = in the room now |
| `totalPresentMs` | number | written at finalize |
| `presencePct` | number | written at finalize, 2dp |
| `status` | `'present' \| 'partial' \| 'absent'` | |
| `firstJoinedAt` / `lastLeftAt` | Date | |
| `lastHeartbeatAt` | Date | **display only** — never an input to attendance |
| `override` | `{ status, reason, by, at }` | admin correction; computed values are kept alongside |
| `finalizedAt` | Date | |

The invariant: **at most one segment with `leftAt: null` per record**, enforced
in the Mongo filters. See `docs/ATTENDANCE.md`.

## Session — `session.model.ts`

A live refresh-token grant. Only the SHA-256 hash is stored, so a database leak
cannot replay tokens. A TTL index on `expiresAt` means Mongo cleans up on its
own. Rotation deletes the old grant, so a stolen refresh token works at most
once.

## AuditLog — `auditLog.model.ts`

Append-only. Attendance is the kind of data students argue about, so every
verification, rejection, suspension, class lifecycle change, attendance
override and recompute is recorded with actor, target and context.

Actions in use: `user.verify`, `user.reject`, `user.suspend`, `admin.create`,
`class.create`, `class.start`, `class.end`, `attendance.override`,
`attendance.recompute`.
