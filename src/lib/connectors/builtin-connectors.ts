/**
 * Built-in connector registrations.
 * Import this file to auto-register all available connectors.
 */
import { registerConnector } from "./registry";
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