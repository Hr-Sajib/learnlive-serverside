# The attendance system

This is the feature the product exists for, and the one place where a
plausible-looking shortcut produces wrong answers that nobody notices for
weeks. Read this before touching anything under `src/modules/attendance/`.

## The rule

> A student is **present** for a class when their time inside the meeting room
> covers at least **60%** of the class's **actual** duration.

Two words in that sentence do a lot of work.

**"Actual"** means `actualEndAt − actualStartAt` — when the admin pressed Start
to when they pressed End. Not the scheduled 90 minutes. A class booked for 90
minutes that really ran for 50 is scored against 50, because the students who
sat through the whole thing attended the whole thing.

**"Time inside"** means the union of the intervals during which LiveKit says
they were connected. A student who drops out three times and comes back gets
the sum of their four stretches, counted once each.

The threshold is per class (`ClassSession.attendanceThresholdPct`), snapshotted
at creation from `ATTENDANCE_THRESHOLD_PCT`. Changing the env var later does not
retroactively rescore classes that already ran — which is the point.

## Why presence comes from the server, never the browser

The obvious implementation is a timer in the student's tab that posts "still
here" every thirty seconds. It is also trivially defeated: open devtools, fire
the same request on a loop, close the laptop, get full marks.

So the only input to attendance is LiveKit's **server-side** participant feed.
LiveKit knows who holds an open media connection to the room because it is the
one terminating those connections. A student cannot forge it without actually
being connected — and being actually connected is what we are trying to measure.

The client heartbeat (`POST /classes/:id/heartbeat`) still exists, and it writes
exactly one field: `lastHeartbeatAt`, used to put a green dot next to a name on
the admin's live panel. It is never read by the engine. **Do not "improve" this
by feeding it into the calculation.**

## Segments

Presence is stored as intervals on `AttendanceRecord.segments`:

```ts
{ joinedAt: Date, leftAt: Date | null, openedBy: 'webhook' | 'reconcile' | 'session_end', closedBy: ... }
```

`leftAt: null` means "still in the room right now". The invariant that makes
everything else safe:

> **At most one open segment per record, ever.**

It is enforced in the Mongo query filters, not in application logic:

- opening requires `segments: { $not: { $elemMatch: { leftAt: null } } }`
- closing targets `segments.$` matched by `'segments.leftAt': null`

So a duplicated webhook matches nothing and changes nothing, and two concurrent
writers cannot both succeed. `openedBy` / `closedBy` record which mechanism
wrote each boundary, which is what you read when a student disputes a result.

## The two writers

### 1. Webhooks — the normal path

`POST /api/v1/webhooks/livekit` receives `participant_joined` and
`participant_left`. Participant identity is minted as the student's Mongo user
id (see `mintJoinToken`), which is what maps an event back to a record.

Three properties of this endpoint matter:

- It is mounted with `express.raw()` **before** the JSON body parser. The
  signature covers the exact bytes LiveKit sent; reparsing them breaks it.
- It answers `200` before doing the work. LiveKit retries non-2xx responses,
  and a retry storm from one bad event would delay presence for every class.
- Every write is idempotent, because LiveKit guarantees at-least-once delivery.

### 2. The reconciliation sweep — the safety net

`src/jobs/reconcilePresence.ts` runs every 60 seconds. For each live class it
asks LiveKit who is *actually* in the room and repairs the difference:

| LiveKit says | Our record says | Action |
|---|---|---|
| present | no open segment | open one (a missed `participant_joined`) |
| absent | open segment | close it (a missed `participant_left`) |

This exists because webhook delivery is best-effort, and the failure that
matters is a dropped `participant_left`: the segment stays open, finalization
closes it at the end of the class, and a student who left after ten minutes
collects full attendance. The sweep bounds that error to one interval.

It also auto-ends a class that has been `live` with an empty room for 30
minutes past its scheduled end, so an admin who forgets to press End does not
leave attendance permanently unfinalized.

## Finalization

`finalizeClassSession(classId)` runs once when a class ends, and it is what
turns segments into verdicts.

1. **Claim.** A guarded `findOneAndUpdate` on `attendanceFinalizedAt: null`.
   The admin's "End class" and LiveKit's `room_finished` webhook both try; the
   first one through does the work, the second gets `alreadyFinalized: true`.
2. **Close** every still-open segment at `actualEndAt`.
3. **Backfill** an empty record for every verified student in the batch, so a
   no-show appears in analytics as `absent` rather than not appearing at all.
4. **Score** each record with `computePresence`:
   - clamp every segment to `[actualStartAt, actualEndAt]`
   - drop what falls outside, merge what overlaps
   - `presencePct = totalPresentMs / durationMs × 100`, capped at 100
   - `present` at or above the threshold, `partial` if they showed up at all,
     `absent` if they never did
5. **Denormalise** `{ enrolledCount, joinedCount, presentCount, avgPresencePct }`
   onto `ClassSession.stats`, which is what the batch analytics page reads.

### Edge cases already handled

| Situation | Behaviour |
|---|---|
| Student idles in the room before the class starts | Clamped away. No credit. |
| Student stays connected after the class ends | Clamped to `actualEndAt`. |
| Class never started (`actualStartAt` null) | Everyone `absent`. |
| Class ran under 60 seconds | Treated as not held. Everyone `absent`. |
| Student joins from two devices | LiveKit rejects the duplicate identity; overlapping segments would merge anyway. |
| Class ended twice | Second call returns `alreadyFinalized`. |
| Admin forgot to press End | Sweep auto-ends it 30 min past schedule. |
| Admin fixes the times afterwards | `POST /classes/:id/recompute` rescores it. |
| Student's internet genuinely died | `PATCH /attendance/:id/override` — computed numbers are kept beside the override. |

## `partial` is not attendance

`partial` means "turned up, did not meet the bar". It does not count as present
anywhere. It exists so that an admin looking at a list can tell a student who
sat through 55% from one who never opened the link — those are different
conversations to have with a student.

## Testing it

`src/modules/attendance/attendance.engine.test.ts` covers the pure functions:
clamping, merging, the threshold boundary, rejoins, and the scheduled-vs-actual
distinction. Run `npx vitest run`.

If you change the engine and these fail, the change is wrong.
