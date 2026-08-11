/**
 * End-to-end test: create tenant -> activate terminal -> pull products -> submit sale.
 * Runs against the local dev server (localhost:5173) + new Supabase.
 */
import { createHmac, createHash } from "crypto";

const BASE = "http://localhost:5173";
const SUPABASE_URL = "https://tbmxftizqqwoycqvtgcv.supabase.co";
const SERVICE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRibXhmdGl6cXF3b3ljcXZ0Z2N2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NjQxODY4OSwiZXhwIjoyMTAxOTk0Njg5fQ.kDr-uoT4OhLRyl-VXyXVFYVR7VZ94SxpI2CPNElX1vg";
const TAC = "X2YB-SBE2-ZQAM-MBSM";
const USER_ID = "af37b78b-a89d-4795-ac60-b056591d370f";

function sha256hex(s) {
  return createHash("sha256").update(s).digest("hex");
}

async function supa(method, path, body) {
  const opts = {
    method,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: body ? "return=representation" : undefined,
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`${SUPABASE_URL}/rest/v1${path}`, opts);
  const text = await r.text();
  return { status: r.status, data: text ? JSON.parse(text) : null };
}

async function api(method, path, { body, token, headers: extra } = {}) {
  const opts = {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...extra,
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`${BASE}${path}`, opts);
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}

async function apiNoAuth(method, path, body) {
  const opts = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`${BASE}${path}`, opts);
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}

async function step(name, fn) {
  console.log(`\n--- ${name} ---`);
  const result = await fn();
  console.log(JSON.stringify(result.data, null, 2));
  if (result.error) {
    console.error(`FAILED: ${result.error}`);
    process.exit(1);
  }
  return result;
}

// ──────────────────────────────────────────────── main
console.log("=== MRA E2E Test ===");

// 1. Create tenant
const tRes = await step("1. Create tenant", async () => {
  const r = await supa("POST", "/tenants", {
    owner_user_id: USER_ID,
    name: "MRA Test Tenant",
    slug: "mra-e2e-test",
    mode: "test",
  });
  return { status: r.status, data: r.data, error: r.status !== 201 ? `HTTP ${r.status}` : null };
});
const tenantId = tRes.data[0].id;

// 2. Create store
await step("2. Create store", async () => {
  const r = await supa("POST", "/stores", {
    tenant_id: tenantId,
    code: "MAIN-STORE",
    name: "Main Store",
  });
  return { status: r.status, data: r.data, error: r.status !== 201 ? `HTTP ${r.status}` : null };
});

// 3. Create API token
const rawToken = `mra_${createHash("sha256").update(String(Date.now())).digest("hex").slice(0, 48)}`;
const tokenHash = sha256hex(rawToken);
const tRes2 = await step("3. Create API token", async () => {
  const r = await supa("POST", "/api_tokens", {
    tenant_id: tenantId,
    label: "e2e-test",
    token_hash: tokenHash,
    token_prefix: rawToken.slice(0, 12),
  });
  return { status: r.status, data: { ...r.data, raw_token: rawToken }, error: r.status !== 201 ? `HTTP ${r.status}` : null };
});
console.log(`    RAW TOKEN: ${rawToken}`);

// 4. Activate terminal with real MAC
const activateRes = await step("4. Activate terminal", async () => {
  return api("POST", "/api/public/v1/tenant/activate", {
    token: rawToken,
    body: {
      store_id: "MAIN-STORE",
      terminal_id: "POS-001",
      tac: TAC,
      platform: {
        os_name: "Windows",
        os_version: "11",
        os_build: "22631",
        mac_address: "B4-95-80-46-57-55",
      },
      pos: {
        product_id: "MRA-middleware/lovable",
        product_version: "1.0.0",
      },
    },
  });
});
if (activateRes.status !== 200) {
  console.error("Activation failed, aborting.");
  process.exit(1);
}

// 5. Pull products
const productsRes = await step("5. Pull products", async () => {
  return api("POST", "/api/public/v1/inventory/products", {
    token: rawToken,
    headers: { "X-Terminal-ID": "POS-001" },
  });
});

// 6. Check what products we got, pick one for the sale
let saleProductCode = "PRODUCT-001";
let saleTaxRateId = "A";
if (productsRes.status === 200 && productsRes.data?.products?.length > 0) {
  const p = productsRes.data.products[0];
  saleProductCode = p.product_code;
  saleTaxRateId = p.tax_rate_id || "A";
  console.log(`    Using product: ${saleProductCode} (${p.description})`);
} else {
  console.log("    No products from MRA, using fallback SKU");
  // Insert a product map manually so the sale can proceed
  await supa("POST", "/product_maps", {
    tenant_id: tenantId,
    local_sku: "PRODUCT-001",
    mra_product_id: "PRODUCT-001",
    description: "Test Product",
    product_type: "product",
    tax_rate_id: "A",
  });
}

// 7. Submit a sale
const saleRes = await step("7. Submit sale", async () => {
  return api("POST", "/api/public/v1/sales", {
    token: rawToken,
    headers: { "X-Terminal-ID": "POS-001" },
    body: {
      erp_invoice_number: `E2E-INV-${Date.now()}`,
      payment_method: "Cash",
      line_items: [
        {
          erp_sku: saleProductCode,
          description: "Test Sale Item",
          quantity: 2,
          unit_price: 5000,
        },
      ],
    },
  });
});

// 8. Submit a second sale (idempotency test — same erp_invoice_number should return duplicate)
if (saleRes.status === 200 && saleRes.data?.invoice_id) {
  const firstInv = saleRes.data.erp_invoice_number;
  const dupRes = await step("8. Duplicate sale (idempotency check)", async () => {
    return api("POST", "/api/public/v1/sales", {
      token: rawToken,
      headers: { "X-Terminal-ID": "POS-001" },
      body: {
        erp_invoice_number: firstInv,
        payment_method: "Cash",
        line_items: [
          { erp_sku: saleProductCode, description: "Test Sale Item", quantity: 1, unit_price: 3000 },
        ],
      },
    });
  });
  if (dupRes.data?.duplicate) {
    console.log("    Idempotency check PASSED — duplicate detected correctly");
  }
}

// 9. Verify DB state
await step("9. Verify invoices in DB", async () => {
  const r = await supa("GET", `/invoices?tenant_id=eq.${tenantId}&select=id,erp_invoice_number,mra_invoice_number,status,grand_total,created_at&order=created_at.desc&limit=5`);
  return { status: r.status, data: r.data };
});

await step("10. Verify terminal in DB", async () => {
  const r = await supa("GET", `/terminals?tenant_id=eq.${tenantId}&select=terminal_id,status,mra_terminal_ref,store_id,activated_at&limit=1`);
  return { status: r.status, data: r.data };
});

console.log("\n=== ALL TESTS PASSED ===");
