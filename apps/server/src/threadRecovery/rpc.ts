import { RecoveryAuthority, requireAdmin } from "./RecoveryAuthority.ts";
import * as SessionReset from "./SessionResetService.ts";
import * as Handover from "./HandoverService.ts";
import * as HostRoutes from "./HostRouteTransfer.ts";
import * as Human from "./PendingHumanRequests.ts";
import * as Effect from "effect/Effect";

/** Authenticated transport context supplies administrative authority; payloads contain only targets. */
const handlers = () => ({
  "thread.session.reset": (
    input: Parameters<SessionReset.SessionResetService["Service"]["reset"]>[0],
  ) => Effect.flatMap(SessionReset.SessionResetService, (s) => s.reset(input)),
  "thread.handover.prepare": (
    input: Parameters<Handover.HandoverService["Service"]["prepare"]>[0],
  ) => Effect.flatMap(Handover.HandoverService, (s) => s.prepare(input)),
  "thread.handover.commit": (input: Parameters<Handover.HandoverService["Service"]["commit"]>[0]) =>
    Effect.flatMap(Handover.HandoverService, (s) => s.commit(input)),
  "thread.handover.status": (input: { readonly transferId: string }) =>
    Effect.flatMap(Handover.HandoverService, (s) => s.status(input)),
  "thread.handover.routes": (
    input: Parameters<HostRoutes.HostRouteTransfer["Service"]["transfer"]>[0],
  ) => Effect.flatMap(HostRoutes.HostRouteTransfer, (s) => s.transfer(input)),
  "thread.human.pending": (input: Parameters<Human.PendingHumanRequests["Service"]["read"]>[0]) =>
    requireAdmin.pipe(
      Effect.andThen(Effect.flatMap(Human.PendingHumanRequests, (s) => s.read(input))),
    ),
  "thread.human.resolve": (
    input: Parameters<Human.PendingHumanRequests["Service"]["resolve"]>[0],
  ) => Effect.flatMap(Human.PendingHumanRequests, (s) => s.resolve(input)),
});

/** Shared by the real WS boundary and scoped-credential transport tests. */
export const authenticatedHandlers = (authority: RecoveryAuthority["Service"]) => {
  const h = handlers();
  return {
    "thread.session.reset": (input: Parameters<(typeof h)["thread.session.reset"]>[0]) =>
      h["thread.session.reset"](input).pipe(Effect.provideService(RecoveryAuthority, authority)),
    "thread.handover.prepare": (input: Parameters<(typeof h)["thread.handover.prepare"]>[0]) =>
      h["thread.handover.prepare"](input).pipe(Effect.provideService(RecoveryAuthority, authority)),
    "thread.handover.commit": (input: Parameters<(typeof h)["thread.handover.commit"]>[0]) =>
      h["thread.handover.commit"](input).pipe(Effect.provideService(RecoveryAuthority, authority)),
    "thread.handover.status": (input: Parameters<(typeof h)["thread.handover.status"]>[0]) =>
      h["thread.handover.status"](input).pipe(Effect.provideService(RecoveryAuthority, authority)),
    "thread.handover.routes": (input: Parameters<(typeof h)["thread.handover.routes"]>[0]) =>
      h["thread.handover.routes"](input).pipe(Effect.provideService(RecoveryAuthority, authority)),
    "thread.human.pending": (input: Parameters<(typeof h)["thread.human.pending"]>[0]) =>
      h["thread.human.pending"](input).pipe(Effect.provideService(RecoveryAuthority, authority)),
    "thread.human.resolve": (input: Parameters<(typeof h)["thread.human.resolve"]>[0]) =>
      h["thread.human.resolve"](input).pipe(Effect.provideService(RecoveryAuthority, authority)),
  };
};
