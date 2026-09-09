import { canDispatchShipment } from "../src/shipment.js";

if (!canDispatchShipment("open")) throw new Error("open shipments must dispatch");
if (canDispatchShipment("frozen")) throw new Error("frozen shipments must not dispatch");
