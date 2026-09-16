# What Do You Think? API

Express and MongoDB Atlas API for the What Do You Think? polling platform.

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

Set `MONGODB_URI` to an Atlas connection string and list allowed frontend origins in `CLIENT_ORIGINS`.

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
