# What Do You Think? API

Express and MongoDB Atlas API for the What Do You Think? polling platform.

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

Set `MONGODB_URI` to an Atlas connection string and list allowed frontend origins in `CLIENT_ORIGINS`.

## Vercel

Vercel discovers `src/app.js` and uses its default Express app export. The separate `src/local.js` starts a listener only for local development.

Set `MONGODB_URI` (secret, including the database name) and `CLIENT_ORIGINS=https://pooling-client.vercel.app` in the Vercel project's **Production** environment. Do not set `PORT` for the Vercel function. Redeploy after changing variables. The database connection is opened on demand and reused by warm function instances.

## API

- `GET /api/health` — readiness check
- `GET /api/polls` — polls and platform statistics
- `GET /api/polls/:slug` — one poll
- `POST /api/polls` — create a poll
- `POST /api/polls/:slug/votes` — atomically record a vote

## Checks

```bash
npm run lint
npm test
```
