# S7 — Integration verification

Date: 2026-09-20. Environment: production-mode API on `:5006`, remote Atlas
MongoDB, and a real LiveKit cloud project (`learnlive-ekbrkorm.livekit.cloud`).

Every step below was run against the live API. All passed. LiveKit webhooks were
delivered for the presence portion — segment records show `openedBy: webhook` /
`closedBy: webhook`, not the reconciliation sweep.

## Flow and observations

1. **Seed** — `npm run seed` is idempotent; the admin
   (`admin@learnlive.com`) already existed and no duplicate was created.

2. **Admin sign-in** — `POST /auth/login` returned 200 with `role: admin`.

3. **Create batch `TEST-1`** — `POST /batches` returned 201.

4. **Register two students** — both `POST /auth/register` calls returned 201.
   Both accounts were `pending` and could not sign in.

5. **Pending gate** — signing in as either student returned 403
   `ACCOUNT_PENDING`.

6. **Verify / reject** — `verify` on student A returned 200; `reject` on
   student B (reason "Not eligible for this batch.") returned 200.

7. **Rejection surfaces at sign-in** — student B's login returned 403
   `ACCOUNT_REJECTED` with
   `"Your registration was declined: Not eligible for this batch."`.
   Student A's login then returned 200 with `status: verified`.

8. **Schedule + start** — `POST /classes` returned 201; `POST /classes/:id/start`
   moved it to `live` and stamped `actualStartAt`.

9. **Join token** — `POST /classes/:id/join` as student A returned a LiveKit
   token, `wsUrl`, `roomName` and `isHost: false`.

10. **Live presence (browser)** — student A connected to the room from a real
    Chrome instance. `GET /classes/:id/live-attendance` showed
    `inRoom: true` for A.

11. **Segments** — three leave/rejoin cycles produced **three** presence
    segments with sane boundaries (each `joinedAt < leftAt`, positive
    durations). All were `openedBy: webhook`, `closedBy: webhook`:

    | Segment | joinedAt (UTC) | leftAt (UTC) | duration |
    |---|---|---|---|
    | 1 | 14:29:36 | 14:30:36 | 60s |
    | 2 | 14:30:36 | 14:30:53 | 17s |
    | 3 | 14:30:53 | 14:31:18 | 25s |

12. **End + presence percentage** — `POST /classes/:id/end` finalized the
    class. `totalPresentMs` = 102000 (60s + 17s + 25s), class `durationMs` =
    132610, `presencePct` = 76.92 (102000 / 132610), `status: present`.
    This matches the wall-clock time A was connected.

13. **Admin exclusion** — the attendance sheet contained exactly one row
    (student A). The admin did not appear. A second class ended with no
    presence backfilled a single `absent` row for A, also with no admin row.

## Notes and discrepancies

- **Webhook delivery works** in this environment. Segments were written by the
  real webhook path, which is the intended source of truth for attendance.
- The client's classroom route (`src/app/classes/[id]/room/page.tsx`) is still
  a pending client task (empty stub), so the browser join used a minimal
  LiveKit page served locally and driven with `agent-browser`, rather than the
  app UI. The server-side path exercised is identical.
- Node has no WebRTC stack, so a headless `livekit-client` connect fails with
  "LiveKit doesn't seem to be supported on this browser". The presence steps
  therefore used a real browser.
- Step 6 in `docs/TASKS.md` says "Leave, rejoin, leave … three entries". Taken
  literally that is two segments (join→leave, rejoin→leave); three entries
  require three join/leave cycles, which is what was run here.

## Test data left behind

The run created `TEST-1` batch, students `s7.a.*@example.com` and
`s7.b.*@example.com`, and two `S7 …` class sessions in the Atlas dev database.
They were left in place; delete them if a clean slate is wanted.
