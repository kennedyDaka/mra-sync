import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import {
  Plug,
  CheckCircle2,
  XCircle,
  ArrowRight,
  ArrowLeft,
  Trash2,
  RefreshCcw,
  Database,
  Globe,
  Webhook,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusPill } from "@/components/ops/primitives";
import { supabase } from "@/integrations/supabase/client";
import {
  listConnectors,
  getTenantConnectors,
  testConnector,
  saveConnector,
  deleteConnector,
  triggerSync,
} from "@/routes/api/ops/v1/connectors";

interface Props {
  tenantId: string;
}

type ConnectorType = "odoo" | "generic-rest" | "generic-webhook";

const CONNECTOR_CARDS: Record<
  ConnectorType,
  { label: string; description: string; icon: typeof Globe; authFields: AuthField[] }
> = {
  odoo: {
    label: "Odoo ERP",
    description: "Connect to Odoo via XML-RPC. Supports products, invoices, and stock sync.",
    icon: Database,
    authFields: [
      { key: "url", label: "Odoo URL", placeholder: "https://yourcompany.odoo.com", type: "url" },
      { key: "database", label: "Database", placeholder: "mycompany", type: "text" },
      { key: "username", label: "Username / Email", placeholder: "admin@mycompany.com", type: "text" },
      { key: "password", label: "Password / API Key", placeholder: "", type: "password" },
    ],
  },
  "generic-rest": {
    label: "Generic REST API",
    description: "Connect to any ERP/POS via REST API. Configure endpoints for products, invoices, and stock.",
    icon: Globe,
    authFields: [
      { key: "base_url", label: "Base URL", placeholder: "https://erp.mycompany.com", type: "url" },
      { key: "api_key", label: "API Key / Bearer Token", placeholder: "sk_live_...", type: "password" },
      { key: "products_endpoint", label: "Products endpoint", placeholder: "/api/products", type: "text" },
      { key: "invoices_endpoint", label: "Invoices endpoint", placeholder: "/api/invoices", type: "text" },
      { key: "stock_endpoint", label: "Stock endpoint", placeholder: "/api/stock", type: "text" },
    ],
  },
  "generic-webhook": {
    label: "Custom Webhook (Push)",
    description: "Your ERP pushes data to us via webhook. No pull capability — your ERP controls sync.",
    icon: Webhook,
    authFields: [
      { key: "webhook_secret", label: "Webhook Secret", placeholder: "shared HMAC secret", type: "password" },
    ],
  },
};

interface AuthField {
  key: string;
  label: string;
  placeholder: string;
  type: string;
}

export function ConnectorsPanel({ tenantId }: Props) {
  const qc = useQueryClient();
  const [step, setStep] = useState<"select" | "configure" | "test" | "activate">("select");
  const [selectedType, setSelectedType] = useState<ConnectorType | null>(null);
  const [config, setConfig] = useState<Record<string, string>>({});
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);

  const listFn = useServerFn(listConnectors);
  const getTenantFn = useServerFn(getTenantConnectors);
  const testFn = useServerFn(testConnector);
  const saveFn = useServerFn(saveConnector);
  const deleteFn = useServerFn(deleteConnector);
  const syncFn = useServerFn(triggerSync);

  const connectors = useQuery({
    queryKey: ["connectors-available"],
    queryFn: async () => {
      const result = await listFn({});
      return result.data?.connectors ?? [];
    },
  });

  const tenantConnectors = useQuery({
    queryKey: ["tenant-connectors", tenantId],
    queryFn: async () => {
      const result = await getTenantFn({ data: { tenant_id: tenantId } });
      return result.data?.connectors ?? [];
    },
  });

  const testMutation = useMutation({
    mutationFn: async () => {
      if (!selectedType) return { valid: false, error: "No connector selected" };
      const result = await testFn({
        data: { connector_type: selectedType, config: config as Record<string, string | number | boolean> },
      });
      return result.data ?? { valid: false };
    },
    onSuccess: (result) => {
      setTestResult(result as { ok: boolean; error?: string });
      if ((result as any).valid) {
        toast.success("Connection successful!");
        setStep("activate");
      } else {
        toast.error("Connection failed. Check your credentials.");
      }
    },
    onError: (e: Error) => {
      setTestResult({ ok: false, error: e.message });
      toast.error(e.message);
    },
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!selectedType) return;
      await saveFn({
        data: {
          tenant_id: tenantId,
          connector_type: selectedType,
          config: config as Record<string, string | number | boolean>,
          sync_mode: "auto",
        },
      });
    },
    onSuccess: () => {
      toast.success("Connector saved and activated!");
      void qc.invalidateQueries({ queryKey: ["tenant-connectors", tenantId] });
      resetWizard();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteMutation = useMutation({
    mutationFn: async (connectorType: string) => {
      await deleteFn({ data: { tenant_id: tenantId, connector_type: connectorType } });
    },
    onSuccess: () => {
      toast.success("Connector removed");
      void qc.invalidateQueries({ queryKey: ["tenant-connectors", tenantId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const syncMutation = useMutation({
    mutationFn: async (args: { connector_type: string; job_type: "product_sync" | "invoice_push" | "inventory_sync" }) => {
      await syncFn({
        data: {
          tenant_id: tenantId,
          connector_type: args.connector_type,
          job_type: args.job_type,
        },
      });
    },
    onSuccess: () => toast.success("Sync job queued"),
    onError: (e: Error) => toast.error(e.message),
  });

  function resetWizard() {
    setStep("select");
    setSelectedType(null);
    setConfig({});
    setTestResult(null);
  }

  const configuredTypes = new Set((tenantConnectors.data ?? []).map((c: any) => c.connector_type));
  const activeConnectors = (tenantConnectors.data ?? []).filter((c: any) => c.is_active);

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_24rem]">
      {/* Left: Main content area */}
      <div className="space-y-4">
        {/* Configured connectors */}
        {activeConnectors.length > 0 && (
          <div className="panel divide-y divide-border">
            <div className="flex items-center gap-2 px-4 py-3">
              <Plug className="size-4 text-primary" />
              <h3 className="text-sm font-semibold">Active connectors</h3>
            </div>
            {activeConnectors.map((c: any) => {
              const card = CONNECTOR_CARDS[c.connector_type as ConnectorType];
              if (!card) return null;
              const Icon = card.icon;
              return (
                <div key={c.id} className="flex items-center justify-between px-4 py-3">
                  <div className="flex items-center gap-3">
                    <Icon className="size-4 text-muted-foreground" />
                    <div>
                      <p className="text-sm font-medium">{card.label}</p>
                      <p className="mono-tag text-xs text-muted-foreground">
                        Sync mode: {c.sync_mode} · Last sync:{" "}
                        {c.last_sync_at
                          ? new Date(c.last_sync_at).toLocaleString()
                          : "never"}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={syncMutation.isPending}
                      onClick={() =>
                        syncMutation.mutate({
                          connector_type: c.connector_type,
                          job_type: "product_sync",
                        })
                      }
                    >
                      <RefreshCcw className="size-3" /> Sync
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={deleteMutation.isPending}
                      onClick={() => deleteMutation.mutate(c.connector_type)}
                    >
                      <Trash2 className="size-3" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Wizard */}
        {step === "select" && (
          <div className="panel p-5">
            <h3 className="text-sm font-semibold">Connect an ERP / POS system</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Link your existing business system to automatically sync products, push invoices, and
              track stock. This is a multi-tenant middleware — each merchant configures their own connector.
            </p>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              {(Object.entries(CONNECTOR_CARDS) as [ConnectorType, (typeof CONNECTOR_CARDS)[ConnectorType]][]).map(
                ([type, card]) => {
                  const Icon = card.icon;
                  const isConfigured = configuredTypes.has(type);
                  return (
                    <button
                      key={type}
                      onClick={() => {
                        setSelectedType(type);
                        setConfig({});
                        setTestResult(null);
                        setStep("configure");
                      }}
                      className={`panel flex flex-col items-start gap-2 p-4 text-left transition-colors hover:border-primary ${
                        isConfigured ? "border-success/50" : ""
                      }`}
                    >
                      <Icon className="size-5 text-primary" />
                      <p className="text-sm font-medium">{card.label}</p>
                      <p className="text-xs text-muted-foreground">{card.description}</p>
                      {isConfigured && (
                        <span className="mono-tag text-xs text-success">Configured</span>
                      )}
                    </button>
                  );
                }
              )}
            </div>
          </div>
        )}

        {step === "configure" && selectedType && (
          <div className="panel p-5">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold">
                  Configure {CONNECTOR_CARDS[selectedType].label}
                </h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  Enter your {CONNECTOR_CARDS[selectedType].label} credentials.
                </p>
              </div>
              <Button variant="ghost" size="sm" onClick={resetWizard}>
                <ArrowLeft className="size-4" /> Back
              </Button>
            </div>
            <div className="mt-4 space-y-3">
              {CONNECTOR_CARDS[selectedType].authFields.map((field) => (
                <div key={field.key} className="space-y-1">
                  <Label htmlFor={`cfg-${field.key}`}>{field.label}</Label>
                  <Input
                    id={`cfg-${field.key}`}
                    type={field.type}
                    placeholder={field.placeholder}
                    value={config[field.key] ?? ""}
                    onChange={(e) => setConfig({ ...config, [field.key]: e.target.value })}
                  />
                </div>
              ))}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" onClick={resetWizard}>
                Cancel
              </Button>
              <Button
                onClick={() => setStep("test")}
                disabled={
                  CONNECTOR_CARDS[selectedType].authFields.some(
                    (f) => !config[f.key]?.trim()
                  )
                }
              >
                Next: Test <ArrowRight className="size-4" />
              </Button>
            </div>
          </div>
        )}

        {step === "test" && selectedType && (
          <div className="panel p-5">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Test connection</h3>
              <Button variant="ghost" size="sm" onClick={() => setStep("configure")}>
                <ArrowLeft className="size-4" /> Back
              </Button>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              We'll attempt to connect to your {CONNECTOR_CARDS[selectedType].label} instance to verify
              credentials.
            </p>
            <div className="mt-4">
              {testMutation.isPending && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <RefreshCcw className="size-4 animate-spin" />
                  Testing connection...
                </div>
              )}
              {!testMutation.isPending && testResult && (
                <div
                  className={`flex items-center gap-2 rounded-lg border p-3 text-sm ${
                    testResult.ok
                      ? "border-success/30 bg-success/10 text-success"
                      : "border-destructive/30 bg-destructive/10 text-destructive"
                  }`}
                >
                  {testResult.ok ? (
                    <CheckCircle2 className="size-4" />
                  ) : (
                    <XCircle className="size-4" />
                  )}
                  {testResult.ok
                    ? "Connection successful! Credentials are valid."
                    : `Connection failed: ${testResult.error ?? "Unknown error"}`}
                </div>
              )}
              {!testMutation.isPending && !testResult && (
                <Button onClick={() => testMutation.mutate()} className="w-full">
                  Test connection
                </Button>
              )}
            </div>
            {testResult?.ok && (
              <div className="mt-4 flex justify-end">
                <Button onClick={() => setStep("activate")}>
                  Next: Activate <ArrowRight className="size-4" />
                </Button>
              </div>
            )}
          </div>
        )}

        {step === "activate" && selectedType && (
          <div className="panel p-5">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Activate sync</h3>
              <Button variant="ghost" size="sm" onClick={() => setStep("test")}>
                <ArrowLeft className="size-4" /> Back
              </Button>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Enable automatic sync for your {CONNECTOR_CARDS[selectedType].label} connector.
            </p>
            <div className="mt-4 space-y-3">
              <div className="rounded-lg border p-3">
                <p className="text-sm font-medium">Auto-sync mode</p>
                <p className="text-xs text-muted-foreground">
                  Products sync automatically from your ERP. Invoices pushed to MRA are also forwarded
                  to your ERP. Stock levels are refreshed periodically.
                </p>
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" onClick={resetWizard}>
                Cancel
              </Button>
              <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
                {saveMutation.isPending ? "Saving..." : "Activate connector"}
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Right: Info sidebar */}
      <div className="space-y-4">
        <div className="panel p-5">
          <h3 className="text-sm font-semibold">How it works</h3>
          <div className="mt-3 space-y-3 text-xs text-muted-foreground">
            <div className="flex gap-2">
              <span className="mono-tag mt-0.5 shrink-0">1</span>
              <p>Pick your ERP system and enter credentials.</p>
            </div>
            <div className="flex gap-2">
              <span className="mono-tag mt-0.5 shrink-0">2</span>
              <p>We test the connection against your live ERP.</p>
            </div>
            <div className="flex gap-2">
              <span className="mono-tag mt-0.5 shrink-0">3</span>
              <p>Activate sync — products, invoices, and stock flow automatically.</p>
            </div>
            <div className="flex gap-2">
              <span className="mono-tag mt-0.5 shrink-0">4</span>
              <p>Each merchant's connector runs independently. Your data stays isolated.</p>
            </div>
          </div>
        </div>
        <div className="panel p-5">
          <h3 className="text-sm font-semibold">Supported flows</h3>
          <dl className="mt-2 space-y-2 text-xs">
            <div>
              <dt className="font-medium">ERP → MRA</dt>
              <dd className="text-muted-foreground">Invoices created in your ERP are submitted to MRA automatically.</dd>
            </div>
            <div>
              <dt className="font-medium">MRA → ERP</dt>
              <dd className="text-muted-foreground">Products and stock from MRA are synced to your ERP catalog.</dd>
            </div>
            <div>
              <dt className="font-medium">Webhook (Push)</dt>
              <dd className="text-muted-foreground">Your ERP pushes data to us — no polling needed.</dd>
            </div>
          </dl>
        </div>
      </div>
    </div>
  );
}
