import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Copy, LogOut, RefreshCcw, RotateCw, ShieldAlert, Info, CheckCircle2, KeyRound, Ban, TerminalSquare } from "lucide-react";

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
  refreshTerminalToken,
  confirmActivationRetry,
  getTerminalBlockingMessage,
  mapProduct,
  listTenantTokens,
  revealTenantToken,
  revokeTenantToken,
  rotateTenantToken,
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
  const refreshTokenFn = useServerFn(refreshTerminalToken);
  const confirmFn = useServerFn(confirmActivationRetry);
  const blockingFn = useServerFn(getTerminalBlockingMessage);
  const mapProductFn = useServerFn(mapProduct);
  const listTokensFn = useServerFn(listTenantTokens);
  const revealTokenFn = useServerFn(revealTenantToken);
  const revokeTokenFn = useServerFn(revokeTenantToken);
  const rotateTokenFn = useServerFn(rotateTenantToken);

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
      void qc.invalidateQueries({ queryKey: ["tokens", activeId] });
      toast.success("New API token issued");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const tokens = useQuery({
    queryKey: ["tokens", activeId],
    enabled: !!activeId,
    queryFn: () => listTokensFn({ data: { tenant_id: activeId! } }),
  });

  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const reveal = useMutation({
    mutationFn: (tokenId: string) => revealTokenFn({ data: { tenant_id: activeId!, token_id: tokenId } }),
    onSuccess: (res, tokenId) => {
      setRevealed((prev) => ({ ...prev, [tokenId]: res.token }));
      void copy(res.token);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const revoke = useMutation({
    mutationFn: (tokenId: string) => revokeTokenFn({ data: { tenant_id: activeId!, token_id: tokenId } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["tokens", activeId] });
      toast.success("API token revoked");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rotate = useMutation({
    mutationFn: () => rotateTokenFn({ data: { tenant_id: activeId! } }),
    onSuccess: (res) => {
      setFreshToken(res.token);
      void qc.invalidateQueries({ queryKey: ["tokens", activeId] });
      toast.success("Token rotated — previous tokens revoked");
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

  const mapMutation = useMutation({
    mutationFn: (v: { local_sku: string; mra_product_id: string; description?: string }) =>
      mapProductFn({ data: { tenant_id: activeId!, ...v } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["products", activeId] });
      toast.success("SKU mapped to MRA product");
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

  const refreshTerminal = useMutation({
    mutationFn: (terminalId: string) =>
      refreshTokenFn({ data: { tenant_id: activeId!, terminal_id: terminalId } }),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ["terminals", activeId] });
      toast.success(res.refreshed ? "Terminal token refreshed and re-sealed" : "Refresh returned no new credentials");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const confirmActivation = useMutation({
    mutationFn: (terminalId: string) =>
      confirmFn({ data: { tenant_id: activeId!, terminal_id: terminalId } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["terminals", activeId] });
      toast.success("Activation confirmed — terminal is active");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const blockingMessage = useMutation({
    mutationFn: (terminalId: string) =>
      blockingFn({ data: { tenant_id: activeId!, terminal_id: terminalId } }),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ["terminals", activeId] });
      const msg = JSON.stringify(res.data).slice(0, 300);
      toast.success(msg === "{}" ? "No blocking message from MRA" : `Blocking message: ${msg}`);
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
            <TabsTrigger value="connection">Connection</TabsTrigger>
            <TabsTrigger value="invoices">Invoices</TabsTrigger>
            <TabsTrigger value="queue">Queue</TabsTrigger>
            <TabsTrigger value="stores">Stores</TabsTrigger>
            <TabsTrigger value="terminals">Terminals</TabsTrigger>
            <TabsTrigger value="catalogue">Catalogue</TabsTrigger>
            <TabsTrigger value="connectors">Connectors</TabsTrigger>
            <TabsTrigger value="logs">MRA logs</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>

          <TabsContent value="connection" className="mt-4 space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold">API keys</h2>
                <p className="text-sm text-muted-foreground">
                  Bearer tokens your POS or ERP uses to call the middleware. Only one token is
                  typically needed — rotate to replace it.
                </p>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" disabled={!activeId || newToken.isPending} onClick={() => newToken.mutate()}>
                  <KeyRound className="size-4" /> Issue new
                </Button>
                <Button size="sm" disabled={!activeId || rotate.isPending} onClick={() => rotate.mutate()}>
                  <RotateCw className="size-4" /> Rotate (revokes old)
                </Button>
              </div>
            </div>

            <div className="panel overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="mono-tag text-muted-foreground">
                  <tr className="border-b border-border text-left">
                    <th className="px-4 py-3">Label</th>
                    <th className="px-4 py-3">Token</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Created</th>
                    <th className="px-4 py-3">Expires</th>
                    <th className="px-4 py-3">Last used</th>
                    <th className="px-4 py-3 text-right"></th>
                  </tr>
                </thead>
                <tbody>
                  {(tokens.data ?? []).map((t) => {
                    const full = revealed[t.id];
                    const expired = t.expires_at && new Date(t.expires_at) < new Date();
                    return (
                      <tr key={t.id} className="border-b border-border/60 last:border-0">
                        <td className="px-4 py-3 font-medium">{t.label || "default"}</td>
                        <td className="px-4 py-3">
                          {full ? (
                            <code className="mono-tag block max-w-72 truncate rounded bg-secondary px-2 py-1 text-xs">
                              {full}
                            </code>
                          ) : (
                            <code className="mono-tag rounded bg-secondary/60 px-2 py-1 text-xs text-muted-foreground">
                              {t.prefix}…{t.revealable ? "" : " (raw not stored)"}
                            </code>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <StatusPill value={t.revoked ? "REVOKED" : expired ? "EXPIRED" : "ACTIVE"} />
                        </td>
                        <td className="mono-tag px-4 py-3 text-muted-foreground">
                          {new Date(t.created_at as string).toLocaleDateString()}
                        </td>
                        <td className="mono-tag px-4 py-3 text-muted-foreground">
                          {t.expires_at ? new Date(t.expires_at as string).toLocaleDateString() : "never"}
                        </td>
                        <td className="mono-tag px-4 py-3 text-muted-foreground">
                          {t.last_used_at ? new Date(t.last_used_at as string).toLocaleString() : "never"}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex justify-end gap-2">
                            {t.revealable && (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={t.revoked || reveal.isPending}
                                onClick={() => reveal.mutate(t.id)}
                              >
                                <Copy className="size-3.5" /> Copy
                              </Button>
                            )}
                            {!t.revoked && !expired && (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={revoke.isPending}
                                onClick={() => revoke.mutate(t.id)}
                              >
                                <Ban className="size-3.5" /> Revoke
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {(tokens.data ?? []).length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-4 py-10 text-center text-muted-foreground">
                        No API tokens for this merchant yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <ConnectionGuide />
          </TabsContent>

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
                    <th className="px-4 py-3"></th>
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
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1">
                          {t.status !== "active" && (
                            <Button
                              size="sm"
                              variant="outline"
                              title="Retry MRA activation confirmation"
                              disabled={confirmActivation.isPending}
                              onClick={() => confirmActivation.mutate(t.terminal_id)}
                            >
                              <CheckCircle2 className="size-3.5" /> Confirm
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="outline"
                            title="Request a fresh JWT + secret from MRA"
                            disabled={refreshTerminal.isPending}
                            onClick={() => refreshTerminal.mutate(t.terminal_id)}
                          >
                            <RotateCw className="size-3.5" /> Refresh token
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            title="Fetch the MRA blocking message for this terminal"
                            disabled={blockingMessage.isPending}
                            onClick={() => blockingMessage.mutate(t.terminal_id)}
                          >
                            <ShieldAlert className="size-3.5" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {(terminals.data ?? []).length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">
                        No terminals activated yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <ActivationHint />
          </TabsContent>

          <TabsContent value="catalogue" className="mt-4 space-y-3">
            <MapSkuForm
              tenantId={activeId}
              busy={mapMutation.isPending}
              onMap={(v) => mapMutation.mutate(v)}
            />
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

function MapSkuForm({
  tenantId,
  busy,
  onMap,
}: {
  tenantId: string | null;
  busy: boolean;
  onMap: (v: { local_sku: string; mra_product_id: string; description?: string }) => void;
}) {
  const [sku, setSku] = useState("");
  const [mraId, setMraId] = useState("");
  const [description, setDescription] = useState("");

  if (!tenantId) return null;

  return (
    <form
      className="panel flex flex-wrap items-end gap-3 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!sku.trim() || !mraId.trim()) return;
        onMap({
          local_sku: sku.trim(),
          mra_product_id: mraId.trim(),
          ...(description.trim() ? { description: description.trim() } : {}),
        });
        setSku("");
        setMraId("");
        setDescription("");
      }}
    >
      <div className="space-y-1">
        <Label htmlFor="map-sku">Local SKU</Label>
        <Input id="map-sku" required value={sku} onChange={(e) => setSku(e.target.value)} placeholder="SKU-001" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="map-mra">MRA product ID</Label>
        <Input id="map-mra" required value={mraId} onChange={(e) => setMraId(e.target.value)} placeholder="87025" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="map-desc">Description (optional)</Label>
        <Input id="map-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Product name" />
      </div>
      <Button type="submit" size="sm" disabled={busy || !sku.trim() || !mraId.trim()}>
        <Info className="size-4" /> Map SKU
      </Button>
    </form>
  );
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

const CONNECTOR_CAPABILITIES: Array<{
  type: string;
  name: string;
  sales: boolean;
  inventory: boolean;
  push: boolean;
  note: string;
}> = [
  { type: "odoo", name: "Odoo ERP", sales: true, inventory: true, push: true, note: "Full connector — JSON-RPC" },
  { type: "generic-rest", name: "Generic REST API", sales: true, inventory: true, push: true, note: "Any REST ERP" },
  { type: "generic-webhook", name: "Custom Webhook (Push)", sales: false, inventory: false, push: true, note: "ERP receives invoices via webhook" },
  { type: "aronium", name: "Aronium POS", sales: true, inventory: true, push: false, note: "Native payloads" },
  { type: "cliqpos", name: "CliqPOS", sales: true, inventory: true, push: false, note: "Native payloads" },
  { type: "erpnext", name: "ERPNext", sales: true, inventory: true, push: false, note: "Native payloads" },
  { type: "kiboerp", name: "Kibo ERP", sales: true, inventory: true, push: false, note: "Native payloads" },
  { type: "sap-b1", name: "SAP Business One", sales: true, inventory: true, push: false, note: "Native payloads" },
  { type: "tally", name: "Tally ERP 9", sales: true, inventory: true, push: false, note: "Native payloads" },
  { type: "sage", name: "Sage (Pastel / Evolution)", sales: false, inventory: true, push: false, note: "Inventory CSV only — sales not supported" },
];

function CapabilityMark({ ok }: { ok: boolean }) {
  return ok ? (
    <CheckCircle2 className="size-4 text-success" />
  ) : (
    <span className="text-muted-foreground">—</span>
  );
}

function ConnectionGuide() {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="panel p-5">
        <h2 className="text-base font-semibold">Connect your POS or ERP in 3 steps</h2>
        <ol className="mt-3 space-y-3 text-sm text-muted-foreground">
          <li className="flex gap-3">
            <span className="mono-tag flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 font-semibold text-primary">1</span>
            <span>
              <strong className="text-foreground">Activate a terminal</strong> — the POS calls{" "}
              <code className="mono-tag rounded bg-secondary/60 px-1">POST /api/public/v1/tenant/activate</code> with its
              Terminal Activation Code (TAC). Until a terminal is active, sales cannot be submitted.
            </span>
          </li>
          <li className="flex gap-3">
            <span className="mono-tag flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 font-semibold text-primary">2</span>
            <span>
              <strong className="text-foreground">Copy your API token</strong> from the table above and put it in your POS
              as <code className="mono-tag rounded bg-secondary/60 px-1">Authorization: Bearer &lt;token&gt;</code>. The token
              identifies your merchant — it never touches MRA itself.
            </span>
          </li>
          <li className="flex gap-3">
            <span className="mono-tag flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 font-semibold text-primary">3</span>
            <span>
              <strong className="text-foreground">Send inventory, then sales</strong> — push products first (auto-registers
              them with MRA), then submit receipts. Each sale returns <code className="mono-tag rounded bg-secondary/60 px-1">SUBMITTED</code>{" "}
              with an MRA receipt number.
            </span>
          </li>
        </ol>
        <pre className="mono-tag mt-4 overflow-auto rounded bg-secondary/60 p-3 text-xs">{`# 1) Register your products (SKUs appear in the Catalogue)
curl -X POST https://<host>/api/public/v1/ingest/inventory \\
  -H "Authorization: Bearer <api-token>" \\
  -H "Content-Type: application/json" \\
  -d '{"products":[{"sku":"SKU-001","name":"Widget","price":2500,"stock":10}]}'

# 2) Submit a sale — every receipt goes to MRA EIS
curl -X POST https://<host>/api/public/v1/ingest/sales \\
  -H "Authorization: Bearer <api-token>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "receipt_number": "R-0001",
    "payment_method": "Cash",
    "items": [{"erp_sku":"SKU-001","description":"Widget","quantity":1,"unit_price":2500}]
  }'

# -> {"status":"SUBMITTED","mra_receipt_number":"Cve-XXX-XXX-X", ...}`}</pre>
        <div className="mt-4 space-y-1 text-xs text-muted-foreground">
          <p className="font-medium text-foreground">Common failures</p>
          <p>• <strong>Unknown SKU</strong> — product not in the catalogue yet: push inventory first.</p>
          <p>• <strong>Terminal inactive</strong> — no active terminal: activate it (step 1).</p>
          <p>• <strong>401 unauthorized</strong> — token revoked or expired: issue a new one above.</p>
        </div>
      </div>

      <div className="panel p-5">
        <h2 className="text-base font-semibold">Built-in connectors</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Use the native endpoint{" "}
          <code className="mono-tag rounded bg-secondary/60 px-1">/api/public/v1/ingest/&lt;source&gt;/sales</code> to send
          each system&apos;s own payload format. Sage receives inventory CSV only.
        </p>
        <table className="mt-3 w-full text-sm">
          <thead className="mono-tag text-muted-foreground">
            <tr className="border-b border-border text-left">
              <th className="py-2 pr-2">Connector</th>
              <th className="px-2 py-2">Sales</th>
              <th className="px-2 py-2">Inventory</th>
              <th className="px-2 py-2">ERP push</th>
              <th className="py-2 pl-2 text-right"></th>
            </tr>
          </thead>
          <tbody>
            {CONNECTOR_CAPABILITIES.map((c) => (
              <tr key={c.type} className="border-b border-border/60 last:border-0">
                <td className="py-2 pr-2 font-medium">{c.name}</td>
                <td className="px-2 py-2"><CapabilityMark ok={c.sales} /></td>
                <td className="px-2 py-2"><CapabilityMark ok={c.inventory} /></td>
                <td className="px-2 py-2"><CapabilityMark ok={c.push} /></td>
                <td className="py-2 pl-2 text-right text-xs text-muted-foreground">{c.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
