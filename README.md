# LearnLive — server

Express 5 + TypeScript + MongoDB API for live coaching classes with
presence-based attendance.

## Quick start

```bash
cp .env.example .env     # fill MONGODB_URI, the two JWT secrets, LIVEKIT_*
npm install
npm run seed             # first admin + a DEMO-B1 batch
npm run dev              # http://localhost:5000
```

`npm run typecheck` · `npm test` · `npm run build && npm start`

## LiveKit setup

1. Create a free project at <https://cloud.livekit.io>.
2. **Settings → Keys** → copy the API key, secret, and the project URL into
   `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_HOST` (`https://…`) and
   `LIVEKIT_WS_URL` (`wss://…`).
3. **Settings → Webhooks** → add `https://<your-api>/api/v1/webhooks/livekit`.

Step 3 is not optional. Without the webhook no presence is recorded, and every
student is marked absent.

For local development LiveKit cannot reach `localhost`, so tunnel it:

```bash
npx ngrok http 5000      # then register the ngrok URL as the webhook
```

## Documentation

| Doc | Read it when |
|---|---|
| [`AGENTS.md`](./AGENTS.md) | Before writing any code here. |
| [`docs/ATTENDANCE.md`](./docs/ATTENDANCE.md) | Touching anything to do with the 60% rule. |
| [`docs/API_SPEC.md`](./docs/API_SPEC.md) | Building a client, or adding an endpoint. |
| [`docs/DATA_MODEL.md`](./docs/DATA_MODEL.md) | Changing a schema. |
| [`docs/TASKS.md`](./docs/TASKS.md) | The remaining work queue. |

## Deployment

Render or Railway — both have a free tier that suits this.

- Build `npm install && npm run build`, start `npm start`.
- Set every variable from the example env file. `CORS_ORIGINS` must list the
  deployed client origin, and `APP_URL` must match it.
- `NODE_ENV=production` switches auth cookies to `SameSite=None; Secure`, which
  is what lets a Vercel-hosted client talk to an API on another domain. Both
  sides must be served over HTTPS.
- Point the LiveKit webhook at the deployed URL.
