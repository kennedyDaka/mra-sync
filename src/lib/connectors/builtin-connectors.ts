/**
 * Built-in connector registrations.
 * Import this file to auto-register all available connectors.
 */
import { registerConnector } from "./registry";
import { OdooConnector } from "./odoo.connector";
import { GenericRestConnector } from "./generic-rest.connector";
import { GenericWebhookConnector } from "./generic-webhook.connector";

registerConnector("odoo", () => new OdooConnector());
registerConnector("generic-rest", () => new GenericRestConnector());
registerConnector("generic-webhook", () => new GenericWebhookConnector());
