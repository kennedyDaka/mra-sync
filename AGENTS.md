# AGENTS.md

This project uses TanStack Start + Supabase + Vercel.

## Development

```sh
npm install
npm run dev
```

## Build

```sh
npm run build
```

## Deploy

Push to GitHub. Vercel auto-deploys on every push.

## Environment Variables

Set these in `.env` (local) or Vercel dashboard (production):

- `SUPABASE_URL` — Supabase project URL
- `SUPABASE_ANON_KEY` — Supabase anon/public key
- `SUPABASE_SERVICE_ROLE_KEY` — Supabase service role key (server-side only)
- `SUPABASE_JWT_SECRET` — Supabase JWT secret (for auth middleware)
- `APP_MODE` — `development` or `production`
- `MRA_BASE_URL` — MRA EIS API base URL
- `MRA_VALIDATION_BASE_URL` — Receipt validation portal URL
- `MRA_TIMEOUT_MS` — MRA API timeout in milliseconds
- `MRA_MASTER_KEY` — Master key for AES-256-GCM credential encryption
- `MRA_VENDOR_ACCESS_KEY` — MRA vendor access key (production activation only)
- `MRA_POS_PRODUCT_ID` — Certified POS product ID
- `MRA_POS_PRODUCT_VERSION` — Certified POS product version
