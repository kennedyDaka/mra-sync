import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Copy, LogOut, RefreshCcw, RotateCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Metric, StatusPill } from "@/components/ops/primitives";
import { StoresPanel } from "@/components/ops/stores-panel";
import { ConnectorsPanel } from "@/components/ops/connectors-panel";
import { supabase } from "@/integrations/supabase/client";
import {
  createTenant,
  drainQueueNow,
  issueToken,
  retryInvoice,
} from "@/lib/mra/admin.functions";

export const Route = createFileRoute("/_authenticated/ops")({
  head: () => ({
    meta: [
      { title: "Ops console — MRA EIS Middleware" },
      {
        name: "description",
        content:
          "Monitor fiscal invoice submissions, queue depth, terminal activation and MRA gateway logs.",
      },
      { property: "og:title", content: "Ops console — MRA EIS Middleware" },
      {
        property: "og:description",
        content: "Live view of MRA EIS invoice sync, queue depth and terminal health.",
      },
    ],
  }),
  component: OpsConsole,
});

const REFRESH_MS = 15_000;

function copy(value: string) {
  void navigator.clipboard.writeText(value);
  toast.success("Copied to clipboard");
}

function OpsConsole() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [freshToken, setFreshToken] = useState<string | null>(null);

  const tenants = useQuery({
    queryKey: ["tenants"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenants")
        .select("id, name, slug, taxpayer_tin, rate_limit_per_min")
        .order("created_at");
      if (error) throw error;
      return data ?? [];
    },
  });

  const activeTenant = useMemo(() => {
    const list = tenants.data ?? [];
    return list.find((t) => t.id === tenantId) ?? list[0] ?? null;
  }, [tenants.data, tenantId]);
  const activeId = activeTenant?.id ?? null;

  const invoices = useQuery({
    queryKey: ["invoices", activeId],
    enabled: !!activeId,
    refetchInterval: REFRESH_MS,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("invoices")
        .select(
          "id, erp_invoice_number, status, mra_invoice_id, grand_total, total_vat, is_offline, attempts, last_error, created_at",
        )
        .eq("tenant_id", activeId!)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return data ?? [];
    },
  });

  const terminals = useQuery({
    queryKey: ["terminals", activeId],
    enabled: !!activeId,
    refetchInterval: REFRESH_MS,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("terminals")
        .select(
          "id, store_id, terminal_id, status, last_error, activated_at, last_config_sync_at, invoice_sequence",
        )
        .eq("tenant_id", activeId!)
        .order("created_at");
      if (error) throw error;
      return data ?? [];
    },
  });

  const queue = useQuery({
    queryKey: ["queue", activeId],
    enabled: !!activeId,
    refetchInterval: REFRESH_MS,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sync_queue")
        .select("id, invoice_id, status, attempts, run_after, last_error")
        .eq("tenant_id", activeId!)
        .order("id")
        .limit(100);
      if (error) throw error;
      return data ?? [];
    },
  });

  const logs = useQuery({
    queryKey: ["logs", activeId],
    enabled: !!activeId,
    refetchInterval: REFRESH_MS,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("mra_logs")
        .select("id, endpoint, status_code, ok, duration_ms, created_at, response_body")
        .eq("tenant_id", activeId!)
        .order("id", { ascending: false })
        .limit(40);
      if (error) throw error;
      return data ?? [];
    },
  });

  const products = useQuery({
    queryKey: ["products", activeId],
    enabled: !!activeId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("product_maps")
        .select("id, local_sku, mra_product_id, tax_category, product_type, auto_registered")
        .eq("tenant_id", activeId!)
        .order("local_sku")
        .limit(100);
      if (error) throw error;
      return data ?? [];
    },
  });

  const createTenantFn = useServerFn(createTenant);
  const issueTokenFn = useServerFn(issueToken);
  const retryFn = useServerFn(retryInvoice);
  const drainFn = useServerFn(drainQueueNow);

  const createMerchant = useMutation({
    mutationFn: (input: { name: string; slug: string; taxpayer_tin?: string }) =>
      createTenantFn({ data: input }),
    onSuccess: (res) => {
      setFreshToken(res.token);
      setTenantId(res.tenant.id);
      void qc.invalidateQueries({ queryKey: ["tenants"] });
      toast.success("Merchant created — copy the API token now");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const newToken = useMutation({
    mutationFn: () => issueTokenFn({ data: { tenant_id: activeId!, label: "rotated" } }),
    onSuccess: (res) => {
      setFreshToken(res.token);
      toast.success("New API token issued");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const retry = useMutation({
    mutationFn: (id: string) => retryFn({ data: { invoice_id: id } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["invoices", activeId] });
      void qc.invalidateQueries({ queryKey: ["queue", activeId] });
      toast.success("Invoice re-queued");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const drain = useMutation({
    mutationFn: () => drainFn(),
    onSuccess: (res) => {
      void qc.invalidateQueries();
      toast.success(`Worker run: ${res["submitted"] ?? 0} submitted, ${res["requeued"] ?? 0} requeued`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rows = invoices.data ?? [];
  const submitted = rows.filter((r) => r.status === "SUBMITTED").length;
  const pending = rows.filter((r) => r.status === "QUEUED" || r.status === "PENDING_SYNC").length;
  const rejected = rows.filter((r) => r.status === "REJECTED" || r.status === "FAILED").length;

  const signOut = async () => {
    await supabase.auth.signOut();
    qc.clear();
    navigate({ to: "/auth", search: { redirect: undefined } });
  };

  return (
    <div className="min-h-screen">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-6 py-4">
          <div>
            <h1 className="text-lg font-semibold">Ops console</h1>
            <p className="mono-tag text-muted-foreground">MRA EIS middleware</p>
          </div>
          <div className="flex items-center gap-2">
            {(tenants.data ?? []).length > 0 && (
              <Select value={activeId ?? ""} onValueChange={setTenantId}>
                <SelectTrigger className="w-56">
                  <SelectValue placeholder="Select merchant" />
                </SelectTrigger>
                <SelectContent>
                  {(tenants.data ?? []).map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Button variant="outline" size="sm" onClick={() => void qc.invalidateQueries()}>
              <RefreshCcw className="size-4" />
            </Button>
            <Button variant="ghost" size="sm" onClick={signOut}>
              <LogOut className="size-4" />
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-6 px-6 py-8">
        {freshToken && (
          <div className="panel flex flex-wrap items-center gap-3 border-primary/40 p-4">
            <span className="text-sm font-medium">API token (shown once):</span>
            <code className="mono-tag flex-1 truncate rounded bg-secondary px-2 py-1">
              {freshToken}
            </code>
            <Button size="sm" variant="outline" onClick={() => copy(freshToken)}>
              <Copy className="size-4" /> Copy
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setFreshToken(null)}>
              Dismiss
            </Button>
          </div>
        )}

        {(tenants.data ?? []).length === 0 && !tenants.isLoading ? (
          <NewMerchant onCreate={(v) => createMerchant.mutate(v)} busy={createMerchant.isPending} />
        ) : null}

        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="Submitted" value={submitted} hint="last 50 invoices" />
          <Metric label="Awaiting sync" value={pending} hint="queued or pending" />
          <Metric label="Rejected" value={rejected} hint="needs operator action" />
          <Metric label="Queue depth" value={(queue.data ?? []).length} hint="rows in sync_queue" />
        </section>

        <Tabs defaultValue="invoices">
          <TabsList>
            <TabsTrigger value="invoices">Invoices</TabsTrigger>
            <TabsTrigger value="queue">Queue</TabsTrigger>
            <TabsTrigger value="stores">Stores</TabsTrigger>
            <TabsTrigger value="terminals">Terminals</TabsTrigger>
            <TabsTrigger value="catalogue">Catalogue</TabsTrigger>
            <TabsTrigger value="connectors">Connectors</TabsTrigger>
            <TabsTrigger value="logs">MRA logs</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>

          <TabsContent value="invoices" className="mt-4">
            <div className="panel overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="mono-tag text-muted-foreground">
                  <tr className="border-b border-border text-left">
                    <th className="px-4 py-3">ERP #</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">MRA ID</th>
                    <th className="px-4 py-3">Total</th>
                    <th className="px-4 py-3">VAT</th>
                    <th className="px-4 py-3">Tries</th>
                    <th className="px-4 py-3">Created</th>
                    <th className="px-4 py-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id} className="border-b border-border/60 last:border-0">
                      <td className="px-4 py-3 font-medium">{row.erp_invoice_number}</td>
                      <td className="px-4 py-3">
                        <StatusPill value={row.status} />
                      </td>
                      <td className="mono-tag px-4 py-3 text-muted-foreground">
                        {row.mra_invoice_id ?? "—"}
                      </td>
                      <td className="px-4 py-3">{Number(row.grand_total ?? 0).toFixed(2)}</td>
                      <td className="px-4 py-3">{Number(row.total_vat ?? 0).toFixed(2)}</td>
                      <td className="px-4 py-3">{row.attempts}</td>
                      <td className="mono-tag px-4 py-3 text-muted-foreground">
                        {new Date(row.created_at as string).toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {row.status !== "SUBMITTED" && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => retry.mutate(row.id)}
                            disabled={retry.isPending}
                          >
                            <RotateCw className="size-3.5" /> Retry
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={8} className="px-4 py-10 text-center text-muted-foreground">
                        No invoices submitted yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </TabsContent>

          <TabsContent value="queue" className="mt-4 space-y-3">
            <div className="flex justify-end">
              <Button size="sm" onClick={() => drain.mutate()} disabled={drain.isPending}>
                Run sync worker now
              </Button>
            </div>
            <div className="panel overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="mono-tag text-muted-foreground">
                  <tr className="border-b border-border text-left">
                    <th className="px-4 py-3">Job</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Attempts</th>
                    <th className="px-4 py-3">Runs after</th>
                    <th className="px-4 py-3">Last error</th>
                  </tr>
                </thead>
                <tbody>
                  {(queue.data ?? []).map((job) => (
                    <tr key={job.id} className="border-b border-border/60 last:border-0">
                      <td className="mono-tag px-4 py-3">#{job.id}</td>
                      <td className="px-4 py-3">
                        <StatusPill value={job.status} />
                      </td>
                      <td className="px-4 py-3">{job.attempts}</td>
                      <td className="mono-tag px-4 py-3 text-muted-foreground">
                        {new Date(job.run_after as string).toLocaleTimeString()}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{job.last_error ?? "—"}</td>
                    </tr>
                  ))}
                  {(queue.data ?? []).length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-4 py-10 text-center text-muted-foreground">
                        Queue is empty — everything is in sync.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </TabsContent>

          <TabsContent value="stores" className="mt-4">
            {activeId ? (
              <StoresPanel tenantId={activeId} />
            ) : (
              <div className="panel p-10 text-center text-muted-foreground">
                Create a merchant in Settings to register stores.
              </div>
            )}
          </TabsContent>

          <TabsContent value="terminals" className="mt-4 grid gap-4 lg:grid-cols-[1fr_20rem]">
            <div className="panel overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="mono-tag text-muted-foreground">
                  <tr className="border-b border-border text-left">
                    <th className="px-4 py-3">Store</th>
                    <th className="px-4 py-3">Terminal</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Seq</th>
                    <th className="px-4 py-3">Config synced</th>
                  </tr>
                </thead>
                <tbody>
                  {(terminals.data ?? []).map((t) => (
                    <tr key={t.id} className="border-b border-border/60 last:border-0">
                      <td className="px-4 py-3">{t.store_id}</td>
                      <td className="mono-tag px-4 py-3">{t.terminal_id}</td>
                      <td className="px-4 py-3">
                        <StatusPill value={t.status} />
                      </td>
                      <td className="px-4 py-3">{t.invoice_sequence}</td>
                      <td className="mono-tag px-4 py-3 text-muted-foreground">
                        {t.last_config_sync_at
                          ? new Date(t.last_config_sync_at as string).toLocaleString()
                          : "never"}
                      </td>
                    </tr>
                  ))}
                  {(terminals.data ?? []).length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-4 py-10 text-center text-muted-foreground">
                        No terminals activated yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <ActivationHint />
          </TabsContent>

          <TabsContent value="catalogue" className="mt-4">
            <div className="panel overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="mono-tag text-muted-foreground">
                  <tr className="border-b border-border text-left">
                    <th className="px-4 py-3">Local SKU</th>
                    <th className="px-4 py-3">MRA product ID</th>
                    <th className="px-4 py-3">Type</th>
                    <th className="px-4 py-3">Tax</th>
                    <th className="px-4 py-3">Source</th>
                  </tr>
                </thead>
                <tbody>
                  {(products.data ?? []).map((p) => (
                    <tr key={p.id} className="border-b border-border/60 last:border-0">
                      <td className="mono-tag px-4 py-3">{p.local_sku}</td>
                      <td className="mono-tag px-4 py-3 text-muted-foreground">
                        {p.mra_product_id ?? "unmapped"}
                      </td>
                      <td className="px-4 py-3">{p.product_type}</td>
                      <td className="px-4 py-3">{p.tax_category}</td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {p.auto_registered ? "auto (UAT)" : "ERP sync"}
                      </td>
                    </tr>
                  ))}
                  {(products.data ?? []).length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-4 py-10 text-center text-muted-foreground">
                        Push mappings via POST /api/public/v1/inventory/sync.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </TabsContent>

          <TabsContent value="connectors" className="mt-4">
            {activeId ? (
              <ConnectorsPanel tenantId={activeId} />
            ) : (
              <div className="panel p-10 text-center text-muted-foreground">
                Create a merchant in Settings first.
              </div>
            )}
          </TabsContent>

          <TabsContent value="logs" className="mt-4">
            <div className="panel divide-y divide-border">
              {(logs.data ?? []).map((log) => (
                <div key={log.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <StatusPill value={log.ok ? "SUBMITTED" : "FAILED"} />
                    <code className="mono-tag">{log.endpoint}</code>
                    <span className="mono-tag text-muted-foreground">
                      {log.status_code} · {log.duration_ms}ms ·{" "}
                      {new Date(log.created_at as string).toLocaleTimeString()}
                    </span>
                  </div>
                  {log.response_body ? (
                    <pre className="mono-tag mt-2 max-h-28 overflow-auto rounded bg-secondary/60 p-2 text-muted-foreground">
                      {String(log.response_body).slice(0, 800)}
                    </pre>
                  ) : null}
                </div>
              ))}
              {(logs.data ?? []).length === 0 && (
                <p className="px-4 py-10 text-center text-muted-foreground">No gateway calls yet.</p>
              )}
            </div>
          </TabsContent>

          <TabsContent value="settings" className="mt-4 grid gap-4 lg:grid-cols-2">
            <div className="panel p-5">
              <h2 className="text-base font-semibold">Merchant</h2>
              <dl className="mt-4 space-y-2 text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Name</dt>
                  <dd>{activeTenant?.name ?? "—"}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Slug</dt>
                  <dd className="mono-tag">{activeTenant?.slug ?? "—"}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Taxpayer TIN</dt>
                  <dd className="mono-tag">{activeTenant?.taxpayer_tin ?? "not set"}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Rate limit</dt>
                  <dd>{activeTenant?.rate_limit_per_min ?? 0} req/min</dd>
                </div>
              </dl>
              <Button
                className="mt-5"
                variant="outline"
                disabled={!activeId || newToken.isPending}
                onClick={() => newToken.mutate()}
              >
                <KeyIcon /> Issue new API token
              </Button>
            </div>
            <NewMerchant onCreate={(v) => createMerchant.mutate(v)} busy={createMerchant.isPending} />
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}

function KeyIcon() {
  return <RotateCw className="size-4" />;
}

function ActivationHint() {
  return (
    <div className="panel p-5">
      <h2 className="text-base font-semibold">Activate a terminal</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Terminals are activated by the POS itself using its Terminal Activation Code.
      </p>
      <pre className="mono-tag mt-3 overflow-auto rounded bg-secondary/60 p-3">{`POST /api/public/v1/tenant/activate
Authorization: Bearer <api-token>

{
  "store_id": "STORE-01",
  "terminal_id": "TILL-01",
  "tac": "<activation code>"
}`}</pre>
    </div>
  );
}

function NewMerchant({
  onCreate,
  busy,
}: {
  onCreate: (v: { name: string; slug: string; taxpayer_tin?: string }) => void;
  busy: boolean;
}) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [tin, setTin] = useState("");

  return (
    <form
      className="panel space-y-4 p-5"
      onSubmit={(e) => {
        e.preventDefault();
        onCreate({ name, slug, ...(tin ? { taxpayer_tin: tin } : {}) });
        setName("");
        setSlug("");
        setTin("");
      }}
    >
      <div>
        <h2 className="text-base font-semibold">Onboard a merchant</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Creates the tenant and issues its first API token.
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="m-name">Trading name</Label>
        <Input id="m-name" required value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="m-slug">Slug</Label>
        <Input
          id="m-slug"
          required
          pattern="[a-z0-9-]+"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="m-tin">Taxpayer TIN (optional)</Label>
        <Input id="m-tin" value={tin} onChange={(e) => setTin(e.target.value)} />
      </div>
      <Button type="submit" disabled={busy}>
        Create merchant
      </Button>
    </form>
  );
}
