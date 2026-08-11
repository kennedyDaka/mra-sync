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

// Eagerly import and register all built-in connectors
import "./builtin-connectors";
