import { requestHeadlessUpdateCheck } from "./headlessUpdateCheck.ts";

/** Transport registration; group middleware applies the operate scope. */
export const headlessDeliveryHandlers = () => ({
  "server.requestHeadlessUpdateCheck": requestHeadlessUpdateCheck,
});
