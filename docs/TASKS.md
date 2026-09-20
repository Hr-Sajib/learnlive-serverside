# Work queue — server

Do these in order. Each one is self-contained: the file exists, the route is
wired, the validation schema is written, and the controller holds a
`TODO(agent)` block with the exact contract.

After **every** task: `npx tsc --noEmit && npx vitest run`. Both must pass.

Do not create new files unless a task says to. Do not edit
`src/modules/attendance/attendance.engine.ts`.

---

### S1 — Batch CRUD
**File:** `src/modules/batches/batch.controller.ts`
**Functions:** `createBatch`, `listBatches`, `getBatch`, `updateBatch`, `listBatchStudents`

The contracts are in the docblocks. Two things to get right:

- `listBatches` must compute `studentCount` with **one** `User.aggregate`
  grouped by batch, then merge onto the rows. A `countDocuments` per row is a
  query per batch and will not be accepted.
- `getBatch` and `listBatchStudents` already call `assertBatchAccess`. Keep it.
  `listBatchStudents` returns `{ id, name }` to students and full contact
  details to admins — branch on `req.user.role`.

**Done when:** an admin can create `B12-FRONTEND`, a student registering with
that code lands in it, and `GET /batches/:id/students` refuses a student from
another batch with 403.

---

### S2 — Class list and detail
**File:** `src/modules/classes/class.controller.ts`
**Functions:** `listClasses`, `getClass`, `updateClass`

- `listClasses`: for `role === 'student'`, **overwrite** the batch filter with
  `req.user.batchId` — never trust a `batchId` they passed.
- `updateClass`: only a `scheduled` class is editable. Anything else →
  `conflict('A live or finished class cannot be edited.', 'INVALID_TRANSITION')`.

**Done when:** a student listing classes sees only their own batch's, sorted
newest first, and editing a live class returns 409.

---

### S3 — Admin overview
**File:** `src/modules/admin/adminUser.controller.ts`
**Functions:** `overview`, `createAdmin`

`overview` is six counts in one `Promise.all` — the exact queries are written in
the docblock. `createAdmin` uses `hashPassword` from
`@/modules/auth/auth.service` and writes an `admin.create` audit entry.

---

### S4 — The class attendance sheet
**File:** `src/modules/attendance/attendance.controller.ts`
**Function:** `classAttendance`

Read `AttendanceRecord`, do not recompute anything — the engine already wrote
`totalPresentMs`, `presencePct` and `status` at finalize. Shape and summary are
in the docblock.

**Done when:** ending a class and calling this shows each student's percentage
and a summary whose `present` count matches `ClassSession.stats.presentCount`.

---

### S5 — Student attendance history
**File:** `src/modules/attendance/attendance.controller.ts`
**Function:** `myAttendance`

Paginated list plus an `overall` block computed across **all** the student's
finalized records, not just the page. Use a separate `countDocuments` pair (or
one aggregate) for `overall`.

---

### S6 — Batch analytics
**File:** `src/modules/attendance/attendance.controller.ts`
**Function:** `batchAnalytics`

The hardest task here, and the aggregation pipeline is written out verbatim in
the docblock — use it as given. Three blocks: `perStudent` (aggregate),
`perClass` (read `ClassSession.stats`, do **not** re-aggregate), `summary`.

Honour the optional `from`/`to` window by first collecting the matching class
ids and adding `classSession: { $in: ids }` to the `$match`.

**Done when:** a batch with three finished classes reports a per-student
attendance rate that matches counting by hand.

---

### S7 — Integration check (no new endpoints)

Run the whole flow once against a real LiveKit project and confirm each step:

1. Seed, sign in as admin, create batch `TEST-1`.
2. Register two students with that code. Both are `pending` and cannot log in.
3. Verify student A, reject student B with a reason. B's login shows the reason.
4. Schedule a class, start it.
5. Join as student A in a browser. Check `GET /classes/:id/live-attendance`
   shows `inRoom: true`.
6. Leave, rejoin, leave. Check `segments` has three entries with sane boundaries.
7. End the class. Check `presencePct` matches the wall-clock time A was in.
8. Confirm the admin does **not** appear in the attendance rows.

Write what you observed into `docs/VERIFICATION.md`. If any step disagrees with
`docs/ATTENDANCE.md`, stop and report it rather than editing the engine.

---

## Not in scope

Do not build, and do not ask about: email/SMS notification, password reset,
file uploads, class recordings, chat, payments, or multi-admin-per-batch
permissions. They are deliberately out of v1.
