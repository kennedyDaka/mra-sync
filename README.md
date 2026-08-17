# MRA EIS Middleware

Multi-tenant middleware that signs, queues and syncs POS/ERP invoices to the Malawi Revenue Authority (MRA) Electronic Invoicing System without ever blocking a checkout.

## Tech Stack

- **Framework:** TanStack Start (React 19, file-based routing)
- **Database:** Supabase (PostgreSQL + RLS)
- **Deployment:** Vercel (Nitro preset)
- **Language:** TypeScript 5.8

## Quick Start

```sh
npm install
cp .env.example .env   # fill in your values
npm run dev
```

Open http://localhost:5173/ops to access the Ops Console.

## Login

- **URL:** `https://mra-sync-nexus-main.vercel.app/ops`
- **Email:** `admin@mraconnect.app`
- **Password:** `Admin123!`

## Environment Variables

| Variable | Dev Default | Production Required |
|---|---|---|
| `SUPABASE_URL` | — | Yes |
| `SUPABASE_ANON_KEY` | — | Yes |
| `SUPABASE_SERVICE_ROLE_KEY` | — | Yes |
| `SUPABASE_JWT_SECRET` | — | Yes |
| `APP_MODE` | `development` | `production` |
| `MRA_BASE_URL` | `https://dev-eis-api.mra.mw` | `https://eis-api.mra.mw` |
| `MRA_VALIDATION_BASE_URL` | `https://dev-eis-portal.mra.mw/...` | `https://eis-portal.mra.mw/...` |
| `MRA_TIMEOUT_MS` | `30000` | `30000` |
| `MRA_MASTER_KEY` | — | Yes (min 32 chars) |
| `MRA_VENDOR_ACCESS_KEY` | — | Production activation only |
| `MRA_POS_PRODUCT_ID` | `MRA-middleware/mraconnect` | Certified product ID |
| `MRA_POS_PRODUCT_VERSION` | `1.0.0` | Certified product version |

## API Endpoints

### Health & Config
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/public/v1/health` | Liveness + MRA gateway probe |
| `GET` | `/api/public/v1/config` | Terminal config (tax rates, offline limits) |
| `POST` | `/api/public/v1/ping` | MRA gateway connectivity check |

### Terminal Management
| Method | Path | Description |
|---|---|---|
| `POST` | `/api/public/v1/tenant/activate` | Activate terminal with TAC |
| `POST` | `/api/public/v1/tenant/confirm-activation` | Confirm activation with HMAC signature |
| `POST` | `/api/public/v1/tenant/refresh-token` | Request new JWT token |

### Sales
| Method | Path | Description |
|---|---|---|
| `POST` | `/api/public/v1/sales` | Submit sales invoice |
| `POST` | `/api/public/v1/sales/credit-debit-note` | Process credit/debit note |
| `POST` | `/api/public/v1/sales/invoice-by-number` | Lookup invoice by ERP number |
| `POST` | `/api/public/v1/sales/cancel-receipt` | Cancel a receipt |
| `POST` | `/api/public/v1/sales/void-receipts` | Get void receipts |
| `POST` | `/api/public/v1/sales/last-submitted-online` | Last submitted online transaction |
| `POST` | `/api/public/v1/sales/last-submitted-offline` | Last submitted offline transaction |

### Inventory
| Method | Path | Description |
|---|---|---|
| `POST` | `/api/public/v1/inventory/products` | Pull products from MRA |
| `POST` | `/api/public/v1/inventory/sync` | Push SKU mappings |
| `POST` | `/api/public/v1/inventory/initial-upload` | Initial inventory upload |
| `POST` | `/api/public/v1/inventory/adjustment` | Stock adjustment |
| `POST` | `/api/public/v1/inventory/adjustment-reasons` | Get adjustment reasons |
| `POST` | `/api/public/v1/inventory/transfer` | Transfer inventory |
| `POST` | `/api/public/v1/inventory/convert` | Raw material conversion |
| `POST` | `/api/public/v1/inventory/warehouse` | Warehouse inventory |
| `POST` | `/api/public/v1/inventory/product-status` | Check product status |
| `POST` | `/api/public/v1/inventory/raw-material` | Get raw material info |

### Stock
| Method | Path | Description |
|---|---|---|
| `POST` | `/api/public/v1/stock/add-product` | Add product to MRA |
| `POST` | `/api/public/v1/stock/hs-codes` | Get HS codes |
| `POST` | `/api/public/v1/stock/suppliers` | Get suppliers |
| `POST` | `/api/public/v1/stock/units-of-measure` | Get units of measure |
| `POST` | `/api/public/v1/stock/informal-purchase` | Submit informal purchase |

### Recipes (BOM)
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/public/v1/recipes` | List all recipes |
| `POST` | `/api/public/v1/recipes` | Create recipe |
| `PUT` | `/api/public/v1/recipes` | Update recipe |
| `DELETE` | `/api/public/v1/recipes` | Delete recipe |
| `POST` | `/api/public/v1/recipes/convert` | Convert recipe → MRA submission |

### Utilities
| Method | Path | Description |
|---|---|---|
| `POST` | `/api/public/v1/utilities/validate-vat5` | Validate VAT5 certificate |
| `POST` | `/api/public/v1/utilities/blocking-message` | Get terminal blocking message |
| `POST` | `/api/public/v1/utilities/unblock-status` | Check terminal unblock status |

### ERP/POS Ingestion (Webhooks)
| Method | Path | Description |
|---|---|---|
| `POST` | `/api/public/v1/ingest/sales` | Normalized sale payload (middleware sales schema) |
| `POST` | `/api/public/v1/ingest/inventory` | Normalized inventory payload (middleware inventory schema) |
| `POST` | `/api/public/v1/ingest/{source}/sales` | Native sale payload (source: aronium, cliqpos, erpnext, kiboerp, odoo, sap-b1, tally) |
| `POST` | `/api/public/v1/ingest/{source}/inventory` | Native inventory payload (CSV text for sage, JSON otherwise) |
| `GET` | `/api/public/v1/recipe` | Get a recipe by `recipe_id` query param |

Ingest endpoints authenticate with `Authorization: Bearer <api_token>` **or** webhook auth via
`X-Tenant-ID` + `X-Webhook-Secret` (or `X-Webhook-Signature`, an HMAC-SHA256 hex digest of the raw
body using the connector's webhook secret). Terminal resolution: `X-Terminal-ID` header →
connector `default_terminal_id` → tenant's first active terminal.

### Connecting a POS or ERP

1. **Activate a terminal** — the POS posts its Terminal Activation Code (TAC) to
   `POST /api/public/v1/tenant/activate`. Sales can only be submitted once a terminal is active.
2. **Copy the API token** — issue one in the ops console (**Connection** tab); tokens are stored
   SHA-256 hashed with an optional master-key sealed copy so operators can re-copy them. Rotation
   revokes all previous tokens.
3. **Send inventory, then sales** — products are auto-registered with MRA on the first inventory
   push; unmapped SKUs are rejected with a 400 listing them.

```bash
curl -X POST https://<host>/api/public/v1/ingest/inventory \
  -H "Authorization: Bearer <api-token>" \
  -H "Content-Type: application/json" \
  -d '{"products":[{"sku":"SKU-001","name":"Widget","price":2500,"stock":10}]}'

curl -X POST https://<host>/api/public/v1/ingest/sales \
  -H "Authorization: Bearer <api-token>" \
  -H "Content-Type: application/json" \
  -d '{"receipt_number":"R-0001","payment_method":"Cash",
       "items":[{"erp_sku":"SKU-001","description":"Widget","quantity":1,"unit_price":2500}]}'
# -> {"status":"SUBMITTED","mra_receipt_number":"Cve-XXX-XXX-X", ...}
```

Connector capability summary (native endpoints at `/api/public/v1/ingest/{source}/...`):

| Connector | Sales | Inventory | ERP push | Notes |
|---|---|---|---|---|
| Odoo ERP | ✅ | ✅ | ✅ | JSON-RPC; also `listProducts`/`submitInvoice`/`getStockLevels` |
| Generic REST | ✅ | ✅ | ✅ | Any REST ERP via `base_url` + endpoints |
| Custom Webhook | — | — | ✅ | Receives invoices via `callback_url` with HMAC signature |
| Aronium POS | ✅ | ✅ | — | Native payloads |
| CliqPOS | ✅ | ✅ | — | Native payloads |
| ERPNext | ✅ | ✅ | — | Native payloads |
| Kibo ERP | ✅ | ✅ | — | Native payloads |
| SAP Business One | ✅ | ✅ | — | Native payloads |
| Tally ERP 9 | ✅ | ✅ | — | Native payloads |
| Sage (Pastel/Evolution) | — | ✅ | — | Inventory CSV only; sales rejected (`source_not_ingestible`) |

### Billing
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/public/v1/billing` | List store billing (tenant) |
| `GET` | `/api/ops/v1/billing` | List store billing (admin) |

All API endpoints (except `/health`) require:
- `Authorization: Bearer <api_token>` header
- `X-Terminal-ID: <terminal_id>` header (for terminal-specific endpoints)

## Database Schema (18 tables)

| Table | Purpose |
|---|---|
| `tenants` | Merchant/company registration |
| `stores` | Multiple stores per tenant |
| `terminals` | POS terminal registration & MRA config |
| `terminal_secrets` | Encrypted JWT + secret keys |
| `api_tokens` | Hashed bearer tokens (+ optional sealed copy for admin re-copy) |
| `product_maps` | SKU → MRA product mappings |
| `invoices` | Invoice records with MRA status |
| `sync_queue` | FIFO queue for offline catch-up |
| `rate_limit_buckets` | Postgres token-bucket rate limiting |
| `mra_logs` | Raw MRA request/response audit trail |
| `audit_logs` | Admin action audit trail |
| `connectors` | ERP/POS connector registry |
| `tenant_connectors` | Tenant-specific connector configs |
| `sync_jobs` | Connector sync job tracking |
| `recipes` | BOM/recipe definitions |
| `recipe_items` | Raw material items per recipe |
| `store_billing` | Per-store billing (MWK 30,000/store) |
| `fraud_alerts` | AI fraud detection alerts |

## Built-in Connectors

| Type | System | Ingest (push) | Pull |
|---|---|---|---|
| `odoo` | Odoo ERP | Sales + inventory | Products |
| `generic-rest` | Any REST ERP | — | Products / invoices / stock |
| `generic-webhook` | Custom webhook (push) | Sales + inventory (HMAC-signed) | — |
| `aronium` | Aronium POS | Sales + inventory | — |
| `cliqpos` | CliqPOS | Sales + inventory | — |
| `erpnext` | ERPNext | Sales + inventory | — |
| `kiboerp` | Kibo ERP (Mozu) | Sales + inventory | — |
| `sage` | Sage (Pastel / Evolution) | Inventory (CSV) | — |
| `sap-b1` | SAP Business One | Sales + inventory | — |
| `tally` | Tally ERP 9 | Sales + inventory | — |

## Dev vs Production Mode

| Behavior | Development | Production |
|---|---|---|
| MRA API URL | `dev-eis-api.mra.mw` | `eis-api.mra.mw` |
| Receipt validation URL | `dev-eis-portal.mra.mw` | `eis-portal.mra.mw` |
| Credential storage | AES-256-GCM (`gcm:iv.cipher`) | AES-256-GCM (`gcm:iv.cipher`) |
| CORS origins | `localhost:5173`, `localhost:3000` | `mraconnect.app` domains |
| HSTS header | Not set | Set (2-year max-age) |
| Activation access key | Not sent | `x-access-key` header sent |
| Startup validation | All env vars optional | Crashes if required vars missing |

## Architecture

```
POS/ERP System
    ↓ (REST API)
MRA EIS Middleware (Vercel)
    ↓ (HTTP)
MRA EIS Gateway (eis-api.mra.mw)
    ↓ (SQL)
Supabase PostgreSQL
```

### Key Flows

1. **Sale:** POS → `/sales` → sign + queue → submit to MRA → return validation URL
2. **Offline:** MRA down → queue invoice → sync worker retries with exponential backoff
3. **Activation:** TAC → `/tenant/activate` → exchange for JWT + secret → encrypt + store
4. **Recipe Convert:** `/recipes/convert` → read BOM → calculate quantities → call MRA conversion

## Deployment

```sh
npm run build          # builds with Nitro Vercel preset
vercel --prod          # deploy to production
```

Push to GitHub for automatic Vercel deployments.

## License

Proprietary - MRA Connect
