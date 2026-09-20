# AGENTS.md — LearnLive API

Read this file completely before writing any code in this repository.

## What this project is

LearnLive runs live coaching classes for batches of students.

- A **batch** is a cohort — a community of students at the same level. Every student belongs to exactly one.
- A student **registers** with minimal details plus a batch code. The account starts `pending`.
- An **admin verifies** the account. Only then can the student sign in and reach their batch.
- An admin **starts a live class** for a batch. Verified students of that batch join a video room.
- A student who is present for **at least 60% of the class's actual duration** is marked present.
- Admins see per-class and per-batch attendance analytics.

## Your job in this repo

The skeleton, the risky core, and every contract are already written. Your job is
to fill in the handlers marked `TODO(agent)` — nothing else.

**Work through `docs/TASKS.md` in order.** Each task names the file, the
function, and the exact response shape. Do not invent endpoints, do not rename
fields, and do not restructure folders.

## Hard rules

1. **Never change `src/modules/attendance/attendance.engine.ts`.**
   It decides whether students get credit for classes they attended. It is
   covered by `attendance.engine.test.ts`; if a change to it makes those tests
   fail, the change is wrong. If you believe the engine has a bug, write it up
   in your output instead of editing it.

2. **Never derive attendance from anything the browser sends.**
   The heartbeat endpoint exists, and it writes only `lastHeartbeatAt` for a
   live display. Presence comes from LiveKit's server-side webhooks. A student
   must not be able to earn attendance with `curl`.

3. **Every batch-scoped read must call `assertBatchAccess(req, batchId)`**
   from `@/middleware/auth`. Without it, a student can read another batch's
   roster, timetable or analytics by guessing an id.

4. **Respond only through `sendResponse`** from `@/utils/sendResponse`. The
   client unwraps `data` for every request; a bare `res.json()` breaks it.

5. **Throw, never `res.status(400).json(...)`.** Use the helpers in
   `@/utils/AppError` (`badRequest`, `notFound`, `forbidden`, `conflict`, …).
   The error middleware formats them consistently.

6. **Validate in the route, not the controller.** Add a zod schema to the
   module's `*.validation.ts` and wire it through `validate({ body, query, params })`.
   By the time a controller runs, `req.body` and `req.query` are already parsed
   and coerced.

7. **Read a route param with `param(req, 'id')`** from `@/utils/params`.
   Express 5 types params as `string | string[]`.

8. **`npx tsc --noEmit` and `npx vitest run` must both pass** before you call a
   task done. `strict` and `noUncheckedIndexedAccess` are on.

## Conventions

- Path alias `@/*` maps to `src/*`. Always import that way, never `../../..`.
- One module per domain concept under `src/modules/<name>/`, containing
  `*.routes.ts`, `*.controller.ts`, `*.validation.ts`, and `*.service.ts` when
  there is logic worth separating from HTTP.
- Models live in `src/models/`, one file per collection, named `*.model.ts`.
- Mongoose documents are read with `.lean()` unless the code needs to `.save()`.
- Comments explain *why*, not *what*. Do not narrate the code.
- User-facing messages are full sentences that tell the person what to do next.

## Where things are

| Path | What it holds |
|---|---|
| `src/config/index.ts` | All env vars, validated at boot. Add new ones here. |
| `src/lib/livekit.ts` | Token minting, room control, webhook verification. |
| `src/lib/tokens.ts` | JWT signing, cookie handling. |
| `src/middleware/auth.ts` | `authenticate`, `requireAdmin`, `assertBatchAccess`. |
| `src/models/` | The six collections. See `docs/DATA_MODEL.md`. |
| `src/modules/attendance/attendance.engine.ts` | **Do not edit.** The 60% rule. |
| `src/modules/webhooks/livekit.webhook.ts` | Presence events in. |
| `src/jobs/reconcilePresence.ts` | The sweep that repairs dropped webhooks. |
| `docs/API_SPEC.md` | Every endpoint and its exact response shape. |
| `docs/TASKS.md` | **Your work queue.** |

## Running it

```bash
cp .env.example .env    # then fill in MONGODB_URI, the two JWT secrets, LIVEKIT_*
npm install
npm run seed            # creates the first admin + a DEMO-B1 batch
npm run dev             # http://localhost:5000
npm run typecheck
npm test
```

The API will start without `LIVEKIT_*` set — it logs a warning and live classes
are disabled. Everything except joining a room can be built and tested that way.
