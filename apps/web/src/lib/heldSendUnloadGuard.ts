// A reload would drop held commands, including their idempotency identities.
let held = false;
export const setHeldSendUnloadGuard = (pending: boolean) => {
  held = pending;
};
export const hasHeldSendUnloadGuard = () => held;
export function preventHeldSendUnload(event: BeforeUnloadEvent) {
  if (!held) return;
  event.preventDefault();
  event.returnValue = "";
}
