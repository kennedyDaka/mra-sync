import { createFileRoute, Link } from "@tanstack/react-router";
import { BookOpen } from "lucide-react";

import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/docs")({
  head: () => ({
    meta: [
      { title: "Developer docs — MRA EIS Middleware" },
      {
        name: "description",
        content:
          "Connect a POS or ERP to the MRA EIS middleware: activation, product catalogue, sales submission, status webhooks and the error reference.",
      },
    ],
  }),
  component: Docs,
});

const salesFields = [
  ["erp_invoice_number", "string", "required", "Your receipt number — used for idempotency (48h window)"],
  ["line_items[].erp_sku", "string", "required", "Local SKU registered in the catalogue"],
  ["line_items[].quantity", "number", "required", "Units (1–1,000,000)"],
  ["line_items[].unit_price", "number", "required", "Unit price in MWK"],
  ["line_items[].description", "string", "optional", "Shown on the MRA receipt"],
  ["line_items[].discount", "number", "optional", "Line discount in MWK"],
  ["line_items[].tax_rate_id", "string", "optional", "Official MRA rate id from terminal config (e.g. A, T, E)"],
  ["payment_method", "string", "default Cash", "e.g. Cash, Card, Mobile Money"],
  ["customer_tin", "string", "optional", "Buyer TIN"],
  ["buyer_name", "string", "optional", "Buyer name (required for receipts over MWK 500,000)"],
  ["cashier_id", "string", "optional", "Cashier reference"],
  ["invoice_timestamp", "string", "optional", "ISO timestamp of the sale; defaults to server time"],
  ["is_offline", "boolean", "optional", "Mark the receipt as offline; it is queued and synced later"],
  ["is_export / is_relief_supply", "boolean", "optional", "Special supply flags"],
  ["amount_tendered", "number", "optional", "Tendered amount"],
  ["vat5_certificate", "object", "optional", "VAT5 certificate details"],
];

const errorCodes = [
  ["401", "unauthorized", "Missing/invalid Bearer token, or token revoked", "Issue a new token in the ops console"],
  ["401", "token_expired", "API token past its expiry", "Rotate the token"],
  ["400", "invalid_json", "Body is not valid JSON", "Send valid JSON"],
  ["400", "invalid_payload", "Body failed schema validation (issues included)", "Check the schema above"],
  ["400", "missing_terminal", "No terminal resolved", "Send X-Terminal-ID, set default_terminal_id, or activate a terminal"],
  ["400", "unknown_terminal", "X-Terminal-ID is not registered", "Register/activate that terminal"],
  ["400", "unknown_source", "Unknown native connector source", "Use a supported source or the normalized endpoint"],
  ["400", "source_not_ingestible", "That source does not support sales (e.g. sage)", "Use the normalized /ingest/sales endpoint"],
  ["400", "normalization_failed", "Native payload could not be normalized", "Check the payload against the connector's format"],
  ["409", "terminal_inactive", "Terminal exists but is not active", "Complete activation"],
  ["409", "duplicate", "Same erp_invoice_number resubmitted", "Reuse the original MRA receipt number"],
  ["422", "mra_rejected", "MRA rejected the invoice (compliance issue)", "Inspect mra_response / last_error"],
  ["422", "unmapped_compliance_sku", "SKUs not in the MRA catalogue", "Push inventory or map the SKUs first"],
  ["423", "terminal_blocked", "MRA blocked the terminal", "Check /utilities/blocking-message"],
  ["429", "rate_limited", "Over the tenant rate limit", "Retry with backoff"],
  ["500", "persist_failed", "Database write failed", "Contact support"],
  ["502", "mra_rejection", "MRA gateway error", "Retry; check /health for gateway status"],
  ["202", "—", "Sale queued for offline sync (MRA unreachable)", "Await webhook or poll invoices"],
];

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="panel scroll-mt-24 p-5">
      <h2 className="text-base font-semibold">{title}</h2>
      <div className="mt-3 space-y-3 text-sm leading-relaxed text-muted-foreground">{children}</div>
    </section>
  );
}

function Code({ children }: { children: string }) {
  return (
    <pre className="mono-tag mt-1 overflow-auto rounded bg-secondary/60 p-3 text-xs text-foreground">
      {children}
    </pre>
  );
}

function Docs() {
  return (
    <div className="min-h-screen">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2">
            <div className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <BookOpen className="size-4" />
            </div>
            <span className="font-display text-sm font-semibold tracking-tight">Developer docs</span>
          </div>
          <div className="flex gap-2">
            <Button asChild size="sm" variant="ghost">
              <Link to="/">Home</Link>
            </Button>
            <Button asChild size="sm">
              <Link to="/ops">Ops console</Link>
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-6 px-6 py-10">
        <div>
          <h1 className="text-3xl font-semibold">Connect a POS or ERP to the MRA EIS</h1>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
            The middleware sits between your system and the Malawi Revenue Authority Electronic
            Invoicing System (EIS). You send inventory and sales over REST; the middleware signs,
            submits and (when offline) queues every receipt. Four steps: get a token, activate a
            terminal, register products, submit sales.
          </p>
        </div>

        <Section id="quickstart" title="1 · Quickstart">
          <ol className="list-decimal space-y-2 pl-5">
            <li><strong className="text-foreground">Get an API token</strong> — ops console → Connection → Issue new. Send it as <code className="mono-tag rounded bg-secondary/60 px-1">Authorization: Bearer &lt;token&gt;</code>.</li>
            <li><strong className="text-foreground">Activate a terminal</strong> — the POS (or your back office) exchanges a Terminal Activation Code from the MRA EIS portal for terminal credentials.</li>
            <li><strong className="text-foreground">Register products</strong> — one inventory push; unmapped SKUs are reported back.</li>
            <li><strong className="text-foreground">Submit sales</strong> — each receipt returns <code className="mono-tag rounded bg-secondary/60 px-1">SUBMITTED</code> with an MRA receipt number, or <code className="mono-tag rounded bg-secondary/60 px-1">202</code> when queued offline.</li>
          </ol>
          <p className="text-xs">
            Sandbox gateway: <code className="mono-tag rounded bg-secondary/60 px-1">https://dev-eis-api.mra.mw</code>.
            Activation codes are issued by the MRA EIS portal and are single-use.
          </p>
        </Section>

        <Section id="terminals" title="2 · Terminal activation & discovery">
          <p>
            Sales are submitted by an <strong className="text-foreground">active terminal</strong>. Two-step onboarding,
            exactly per the MRA guide:
          </p>
          <Code>{`POST /api/public/v1/tenant/activate
Authorization: Bearer <api-token>

{
  "store_id": "STORE-01",
  "terminal_id": "TILL-01",
  "tac": "<activation code>",
  "taxpayer_tin": "71295599",          // optional
  "platform": {"os_name": "Windows", "os_version": "11", "mac_address": "AA:BB:CC:DD:EE:FF"},
  "pos": {"product_id": "your-pos-id", "product_version": "1.0.0"}
}`}</Code>
          <p>
            Terminal resolution for sales: <code className="mono-tag rounded bg-secondary/60 px-1">X-Terminal-ID</code> header →
            connector <code className="mono-tag rounded bg-secondary/60 px-1">default_terminal_id</code> → the tenant&apos;s first
            active terminal. A POS can discover its terminals without guessing:
          </p>
          <Code>{`GET /api/public/v1/terminals
Authorization: Bearer <api-token>

-> {"terminals":[{"terminal_id":"TILL-01","store_id":"STORE-01","status":"active",
    "terminal_position":25,"is_blocked":false,"mra_terminal_ref":"...", ...}]}`}</Code>
        </Section>

        <Section id="products" title="3 · Product catalogue">
          <p>
            SKUs are stored in <code className="mono-tag rounded bg-secondary/60 px-1">product_maps</code>. Push inventory to
            register them; sales referencing an unregistered SKU are rejected and list the missing
            SKUs.
          </p>
          <Code>{`POST /api/public/v1/ingest/inventory
Authorization: Bearer <api-token>

{"items":[
  {"local_sku":"SKU-001","description":"Widget","quantity_on_hand":10,"tax_rate_id":"A"},
  {"local_sku":"SKU-002","description":"Gadget","quantity_on_hand":4}
]}

-> {"synced":2,"unmapped":["SKU-002"]}   // SKU-002 exists locally but has no MRA code yet`}</Code>
          <p>
            To register a new product with MRA <em>and</em> map it in one call, use the stock
            endpoint — it returns the official MRA product code and upserts the mapping itself:
          </p>
          <Code>{`POST /api/public/v1/stock/add-product
Authorization: Bearer <api-token>
X-Terminal-ID: TILL-01

{"barcode":"6970012345678","local_sku":"SKU-001","hs_code":"8501.10","name":"Widget","description":"A widget","uom":"EA"}

-> {"status":"registered","local_sku":"SKU-001","mra_product_id":"87025","mapped":true}`}</Code>
          <p className="text-xs">
            Note: <code className="mono-tag rounded bg-secondary/60 px-1">hs_code</code> must exist in the taxpayer&apos;s MRA
            HS codes (<code className="mono-tag rounded bg-secondary/60 px-1">GET /api/public/v1/stock/hs-codes</code> lists them);
            products are registered per site, so the terminal that sells a product must have it in its site catalogue.
          </p>
        </Section>

        <Section id="sales" title="4 · Submit a sale">
          <Code>{`POST /api/public/v1/ingest/sales        // normalized — works for any POS/ERP
POST /api/public/v1/ingest/<source>/sales // native payloads (aronium, cliqpos, erpnext, kiboerp, odoo, sap-b1, tally)
Authorization: Bearer <api-token>

{
  "erp_invoice_number": "R-0001",
  "payment_method": "Cash",
  "customer_tin": "1234567890",           // optional
  "line_items": [
    {"erp_sku":"SKU-001","description":"Widget","quantity":1,"unit_price":2500,"tax_rate_id":"A"}
  ]
}

-> 200 {"status":"SUBMITTED","mra_receipt_number":"Cve-Z-XXXX-X","validation_url":"https://...","grand_total":2500}`}</Code>
          <table className="mt-2 w-full text-xs">
            <thead className="mono-tag text-muted-foreground">
              <tr className="border-b border-border text-left">
                <th className="py-1.5 pr-2">Field</th>
                <th className="px-2 py-1.5">Type</th>
                <th className="px-2 py-1.5">Req.</th>
                <th className="py-1.5 pl-2">Notes</th>
              </tr>
            </thead>
            <tbody>
              {salesFields.map(([f, t, r, n]) => (
                <tr key={f} className="border-b border-border/60 last:border-0">
                  <td className="mono-tag py-1.5 pr-2 text-foreground">{f}</td>
                  <td className="px-2 py-1.5">{t}</td>
                  <td className="px-2 py-1.5">{r}</td>
                  <td className="py-1.5 pl-2">{n}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs">
            Resubmitting the same <code className="mono-tag rounded bg-secondary/60 px-1">erp_invoice_number</code> within 48h
            returns the original receipt with <code className="mono-tag rounded bg-secondary/60 px-1">"duplicate":true</code>.
            Sales lifecycle endpoints (credit/debit notes, void, cancel, invoice lookup) live under{" "}
            <code className="mono-tag rounded bg-secondary/60 px-1">/api/public/v1/sales/*</code> and require X-Terminal-ID.
          </p>
        </Section>

        <Section id="webhooks" title="5 · Status webhooks">
          <p>
            When MRA is unreachable a sale returns <code className="mono-tag rounded bg-secondary/60 px-1">202 queued</code> —
            configure a callback to learn the outcome asynchronously. Configure the{" "}
            <strong className="text-foreground">generic-webhook</strong> connector in the ops console with{" "}
            <code className="mono-tag rounded bg-secondary/60 px-1">callback_url</code> and{" "}
            <code className="mono-tag rounded bg-secondary/60 px-1">webhook_secret</code>; every invoice status change is
            then POSTed to it.
          </p>
          <Code>{`POST <your callback_url>
X-Webhook-Event: invoice.status_changed
X-Webhook-Signature: <hex HMAC-SHA256 of the raw body using webhook_secret>

{"event":"invoice.status_changed","data":{
  "id":"...","erp_invoice_number":"R-0001","status":"SUBMITTED",
  "mra_invoice_id":"Cve-Z-XXXX-X","grand_total":2500,"terminal_id":"TILL-01","occurred_at":"..."}}

// status: SUBMITTED | REJECTED | FAILED | QUEUED`}</Code>
          <p className="text-xs">
            Delivery: best-effort, 3 attempts (immediate, +2s, +8s). Final failures are recorded in
            the ops console audit trail. Webhook ingest works the other way too: send{" "}
            <code className="mono-tag rounded bg-secondary/60 px-1">X-Tenant-ID</code> +{" "}
            <code className="mono-tag rounded bg-secondary/60 px-1">X-Webhook-Secret</code> (or an HMAC signature) instead of
            a Bearer token.
          </p>
        </Section>

        <Section id="errors" title="6 · Error reference">
          <table className="w-full text-xs">
            <thead className="mono-tag text-muted-foreground">
              <tr className="border-b border-border text-left">
                <th className="py-1.5 pr-2">HTTP</th>
                <th className="px-2 py-1.5">Code</th>
                <th className="px-2 py-1.5">Meaning</th>
                <th className="py-1.5 pl-2">Fix</th>
              </tr>
            </thead>
            <tbody>
              {errorCodes.map(([h, c, m, f]) => (
                <tr key={c} className="border-b border-border/60 last:border-0">
                  <td className="mono-tag py-1.5 pr-2 text-foreground">{h}</td>
                  <td className="mono-tag px-2 py-1.5">{c}</td>
                  <td className="px-2 py-1.5">{m}</td>
                  <td className="py-1.5 pl-2">{f}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>

        <Section id="limits" title="7 · Rate limits & environments">
          <p>
            Default tenant limit: <strong className="text-foreground">60 requests/minute</strong> (Postgres token bucket;
            raise it per tenant). Respect <code className="mono-tag rounded bg-secondary/60 px-1">429 rate_limited</code> with
            backoff. Check gateway health (no auth) at{" "}
            <code className="mono-tag rounded bg-secondary/60 px-1">GET /api/public/v1/health</code> — it reports the live MRA
            gateway state. Production uses the MRA production gateway (<code className="mono-tag rounded bg-secondary/60 px-1">eis-api.mra.mw</code>)
            with the vendor access key; the sandbox uses <code className="mono-tag rounded bg-secondary/60 px-1">dev-eis-api.mra.mw</code>.
          </p>
        </Section>
      </main>
    </div>
  );
}