import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { Store, KeyRound } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusPill } from "@/components/ops/primitives";
import { supabase } from "@/integrations/supabase/client";
import { activateTerminalSelfService, createStore } from "@/lib/mra/admin.functions";

interface Props {
  tenantId: string;
}

export function StoresPanel({ tenantId }: Props) {
  const qc = useQueryClient();
  const createStoreFn = useServerFn(createStore);
  const activateFn = useServerFn(activateTerminalSelfService);

  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");

  const [storeId, setStoreId] = useState("");
  const [terminalId, setTerminalId] = useState("");
  const [tac, setTac] = useState("");
  const [macAddress, setMacAddress] = useState("");

  const stores = useQuery({
    queryKey: ["stores", tenantId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("stores")
        .select("id, code, name, address, is_active, created_at")
        .eq("tenant_id", tenantId)
        .order("created_at");
      if (error) throw error;
      return data ?? [];
    },
  });

  const terminalCounts = useQuery({
    queryKey: ["store-terminals", tenantId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("terminals")
        .select("id, store_uid, status")
        .eq("tenant_id", tenantId);
      if (error) throw error;
      return data ?? [];
    },
  });

  const addStore = useMutation({
    mutationFn: () =>
      createStoreFn({
        data: {
          tenant_id: tenantId,
          code: code.trim(),
          name: name.trim(),
          ...(address.trim() ? { address: address.trim() } : {}),
        },
      }),
    onSuccess: () => {
      setCode("");
      setName("");
      setAddress("");
      void qc.invalidateQueries({ queryKey: ["stores", tenantId] });
      toast.success("Store registered");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const activate = useMutation({
    mutationFn: () =>
      activateFn({
        data: {
          tenant_id: tenantId,
          store_id: storeId,
          terminal_id: terminalId.trim(),
          tac: tac.trim(),
          ...(macAddress.trim() ? { mac_address: macAddress.trim() } : {}),
        },
      }),
    onSuccess: (res) => {
      setTac("");
      setTerminalId("");
      setMacAddress("");
      void qc.invalidateQueries();
      toast.success(`Terminal activated (position ${res.terminal_position})`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const list = stores.data ?? [];
  const terminals = terminalCounts.data ?? [];

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
      <div className="panel overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="mono-tag text-muted-foreground">
            <tr className="border-b border-border text-left">
              <th className="px-4 py-3">Code</th>
              <th className="px-4 py-3">Store</th>
              <th className="px-4 py-3">Address</th>
              <th className="px-4 py-3">Terminals</th>
              <th className="px-4 py-3">Status</th>
            </tr>
          </thead>
          <tbody>
            {list.map((s) => {
              const linked = terminals.filter((t) => t.store_uid === s.id);
              const active = linked.filter((t) => t.status === "active").length;
              return (
                <tr key={s.id} className="border-b border-border/60 last:border-0">
                  <td className="mono-tag px-4 py-3">{s.code}</td>
                  <td className="px-4 py-3">{s.name}</td>
                  <td className="px-4 py-3 text-muted-foreground">{s.address ?? "—"}</td>
                  <td className="px-4 py-3">
                    {active}/{linked.length} active
                  </td>
                  <td className="px-4 py-3">
                    <StatusPill value={s.is_active ? "active" : "disabled"} />
                  </td>
                </tr>
              );
            })}
            {list.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-muted-foreground">
                  No stores yet. Register your first store to activate a terminal.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="space-y-4">
        <div className="panel space-y-3 p-5">
          <div className="flex items-center gap-2">
            <Store className="size-4 text-primary" />
            <h3 className="text-sm font-semibold">Register a store</h3>
          </div>
          <p className="text-xs text-muted-foreground">
            Each physical store is billed separately and can hold many terminals.
          </p>
          <div className="space-y-2">
            <Label htmlFor="store-code">Store code</Label>
            <Input
              id="store-code"
              placeholder="BT-MAIN"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="store-name">Store name</Label>
            <Input
              id="store-name"
              placeholder="Blantyre Main Branch"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="store-address">Address (optional)</Label>
            <Input
              id="store-address"
              placeholder="Victoria Avenue, Blantyre"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
          </div>
          <Button
            className="w-full"
            disabled={addStore.isPending || code.trim().length < 2 || name.trim().length < 2}
            onClick={() => addStore.mutate()}
          >
            Add store
          </Button>
        </div>

        <div className="panel space-y-3 p-5">
          <div className="flex items-center gap-2">
            <KeyRound className="size-4 text-primary" />
            <h3 className="text-sm font-semibold">Activate a terminal</h3>
          </div>
          <p className="text-xs text-muted-foreground">
            Paste the Terminal Activation Code issued by MRA. We run both onboarding steps and
            store the returned credentials encrypted — your POS never handles them.
          </p>
          <div className="space-y-2">
            <Label>Store</Label>
            <Select value={storeId} onValueChange={setStoreId}>
              <SelectTrigger>
                <SelectValue placeholder="Select store" />
              </SelectTrigger>
              <SelectContent>
                {list.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.code} — {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="terminal-id">Terminal ID</Label>
            <Input
              id="terminal-id"
              placeholder="TERM-01"
              value={terminalId}
              onChange={(e) => setTerminalId(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="tac">Activation code (TAC)</Label>
            <Input
              id="tac"
              placeholder="XXXX-XXXX-XXXX-XXXX"
              autoComplete="off"
              spellCheck={false}
              value={tac}
              onChange={(e) => setTac(e.target.value.toUpperCase())}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="mac-address">
              MAC address <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="mac-address"
              placeholder="B4-95-80-46-57-55"
              autoComplete="off"
              spellCheck={false}
              value={macAddress}
              onChange={(e) => setMacAddress(e.target.value)}
            />
            <p className="text-[11px] text-muted-foreground">
              The physical MAC address of the POS machine. Required in production.
              Leave blank to auto-generate for testing.
            </p>
          </div>
          <Button
            className="w-full"
            disabled={
              activate.isPending || !storeId || terminalId.trim().length < 1 || tac.trim().length < 8
            }
            onClick={() => activate.mutate()}
          >
            {activate.isPending ? "Activating with MRA…" : "Activate terminal"}
          </Button>
          <p className="text-xs text-muted-foreground">
            A TAC can only be used once. If activation fails, request a new code from MRA.
          </p>
        </div>
      </div>
    </div>
  );
}
