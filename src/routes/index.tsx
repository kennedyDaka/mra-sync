import { createFileRoute, Link } from "@tanstack/react-router";
import { Activity, KeyRound, RefreshCcw, ShieldCheck, Terminal, Zap } from "lucide-react";

import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "MRA EIS Middleware — Zero-downtime fiscal invoicing" },
      {
        name: "description",
        content:
          "Multi-tenant middleware that signs, queues and syncs POS/ERP invoices to the Malawi Revenue Authority EIS without ever blocking a checkout.",
      },
      { property: "og:title", content: "MRA EIS Middleware" },
      {
        property: "og:description",
        content:
          "HMAC-SHA512 signing, offline-first queueing and per-tenant credential isolation for MRA electronic invoicing.",
      },
    ],
  }),
  component: Landing,
});

const capabilities = [
  {
    icon: Zap,
    title: "Checkout never blocks",
    body: "Every sale gets a signed local receipt first. If the MRA gateway is slow or down, the invoice lands in the FIFO queue and the till keeps moving.",
  },
  {
    icon: ShieldCheck,
    title: "HMAC-SHA512 signing",
    body: "Canonical zero-whitespace JSON is signed per terminal. Secrets are sealed with AES-256-GCM and never leave the server boundary.",
  },
  {
    icon: RefreshCcw,
    title: "Catch-up sync engine",
    body: "A queue worker claims jobs atomically, replays them as offline batches with exponential backoff, and dead-letters compliance rejections.",
  },
  {
    icon: Terminal,
    title: "Terminal activation",
    body: "Exchange a TAC for terminal credentials, cache MRA configuration, and track per-terminal invoice sequences.",
  },
  {
    icon: KeyRound,
    title: "Multi-tenant by default",
    body: "Bearer tokens are hashed at rest, scoped per merchant, and rate limited with a Postgres token bucket.",
  },
  {
    icon: Activity,
    title: "Ops visibility",
    body: "Queue depth, rejection reasons, raw MRA request/response logs and one-click retries in a single console.",
  },
];

const endpoints = [
  ["POST", "/api/public/v1/sales", "Submit an ERP invoice"],
  ["POST", "/api/public/v1/tenant/activate", "Activate a terminal with a TAC"],
  ["POST", "/api/public/v1/inventory/sync", "Push SKU → MRA product mappings"],
  ["GET", "/api/public/v1/health", "Liveness + gateway probe"],
];

function Landing() {
  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <div className="flex items-center gap-2">
          <div className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Zap className="size-4" />
          </div>
          <span className="font-display text-sm font-semibold tracking-tight">MRA EIS Middleware</span>
        </div>
        <Button asChild size="sm">
          <Link to="/ops">Open ops console</Link>
        </Button>
      </header>

      <main className="mx-auto max-w-6xl px-6 pb-24">
        <section className="py-16">
          <span className="mono-tag rounded-full border border-border bg-surface px-3 py-1 text-muted-foreground">
            Malawi Revenue Authority · Electronic Invoicing System
          </span>
          <h1 className="mt-6 max-w-3xl text-4xl leading-tight font-semibold sm:text-5xl">
            Fiscal compliance that stays out of the way of the till.
          </h1>
          <p className="mt-5 max-w-2xl text-base text-muted-foreground">
            A resilient integration layer between POS/ERP systems and the MRA EIS. It translates,
            signs and submits invoices in real time — and quietly replays them when the network
            fails.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button asChild>
              <Link to="/ops">Open ops console</Link>
            </Button>
            <Button asChild variant="outline">
              <a href="/api/public/v1/health">Check gateway health</a>
            </Button>
          </div>
        </section>

        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {capabilities.map((item) => (
            <article key={item.title} className="panel p-5">
              <item.icon className="size-5 text-primary" />
              <h2 className="mt-4 text-base font-semibold">{item.title}</h2>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{item.body}</p>
            </article>
          ))}
        </section>

        <section className="panel mt-10 overflow-hidden">
          <h2 className="border-b border-border px-5 py-4 text-sm font-semibold">
            Integration surface
          </h2>
          <ul className="divide-y divide-border">
            {endpoints.map(([method, path, label]) => (
              <li key={path} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <span className="mono-tag rounded bg-secondary px-2 py-0.5 text-secondary-foreground">
                  {method}
                </span>
                <code className="mono-tag text-foreground">{path}</code>
                <span className="text-sm text-muted-foreground">{label}</span>
              </li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  );
}
