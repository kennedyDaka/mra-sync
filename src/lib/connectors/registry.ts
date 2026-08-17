/**
 * Connector registry — maps connector types to their adapter classes.
 * New connectors are registered here and become available in the Ops console.
 */
import type { ErpConnector } from "./base";

const registry = new Map<string, () => ErpConnector>();

/** Register a connector type. */
export function registerConnector(type: string, factory: () => ErpConnector): void {
  registry.set(type, factory);
}

/** Get a connector instance by type. */
export function getConnector(type: string): ErpConnector | null {
  const factory = registry.get(type);
  if (!factory) return null;
  return factory();
}

/** List all registered connector types. */
export function listConnectors(): Array<{ type: string; label: string; auth_type: string }> {
  const result: Array<{ type: string; label: string; auth_type: string }> = [];
  for (const [type, factory] of registry) {
    const instance = factory();
    result.push({
      type,
      label: instance.label,
      auth_type: instance.auth_type,
    });
  }
  return result;
}

/** Check if a connector type is registered. */
export function hasConnector(type: string): boolean {
  return registry.has(type);
}

// Register built-in connectors eagerly
import { OdooConnector } from "./odoo.connector";
import { GenericRestConnector } from "./generic-rest.connector";
import { GenericWebhookConnector } from "./generic-webhook.connector";
import { AroniumConnector } from "./aronium.connector";
import { CliqPosConnector } from "./cliqpos.connector";
import { ErpNextConnector } from "./erpnext.connector";
import { KiboErpConnector } from "./kiboerp.connector";
import { SageConnector } from "./sage.connector";
import { SapB1Connector } from "./sapb1.connector";
import { TallyConnector } from "./tally.connector";

registerConnector("odoo", () => new OdooConnector());
registerConnector("generic-rest", () => new GenericRestConnector());
registerConnector("generic-webhook", () => new GenericWebhookConnector());
registerConnector("aronium", () => new AroniumConnector());
registerConnector("cliqpos", () => new CliqPosConnector());
registerConnector("erpnext", () => new ErpNextConnector());
registerConnector("kiboerp", () => new KiboErpConnector());
registerConnector("sage", () => new SageConnector());
registerConnector("sap-b1", () => new SapB1Connector());
registerConnector("tally", () => new TallyConnector());
