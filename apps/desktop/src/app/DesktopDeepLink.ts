import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";

import * as Electron from "electron";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";

export interface DesktopThreadDeepLink {
  readonly environmentId: string;
  readonly threadId: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseDesktopThreadDeepLink(rawUrl: string): DesktopThreadDeepLink | null {
  try {
    const url = new URL(rawUrl);
    if (
      (url.protocol !== `${ElectronProtocol.DESKTOP_PRODUCTION_SCHEME}:` &&
        url.protocol !== `${ElectronProtocol.DESKTOP_DEVELOPMENT_SCHEME}:`) ||
      url.hostname !== "threads" ||
      url.port !== "" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return null;
    }
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length !== 2 || !segments.every((segment) => UUID_PATTERN.test(segment))) {
      return null;
    }
    return { environmentId: segments[0]!, threadId: segments[1]! };
  } catch {
    return null;
  }
}

export function findDesktopThreadDeepLink(argv: readonly string[]): DesktopThreadDeepLink | null {
  for (const argument of argv) {
    const link = parseDesktopThreadDeepLink(argument);
    if (link !== null) return link;
  }
  return null;
}

export class DesktopDeepLink extends Context.Service<
  DesktopDeepLink,
  {
    readonly configure: Effect.Effect<void, never, Scope.Scope>;
    readonly flush: Effect.Effect<void>;
  }
>()("@t3tools/desktop/app/DesktopDeepLink") {}

export const make = Effect.gen(function* () {
  const electronApp = yield* ElectronApp.ElectronApp;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const ready = yield* Ref.make(false);
  const pending = yield* Ref.make<readonly DesktopThreadDeepLink[]>([]);

  const open = (link: DesktopThreadDeepLink) =>
    desktopWindow.openThread(link).pipe(Effect.catch(() => Effect.void));
  const accept = (link: DesktopThreadDeepLink) =>
    Ref.get(ready).pipe(
      Effect.flatMap((isReady) =>
        isReady
          ? open(link).pipe(Effect.as(true))
          : Ref.update(pending, (links) => [...links, link]).pipe(Effect.as(true)),
      ),
    );
  const receive = (rawUrl: string) => {
    const link = parseDesktopThreadDeepLink(rawUrl);
    return link === null ? Effect.succeed(false) : accept(link);
  };

  return DesktopDeepLink.of({
    configure: Effect.gen(function* () {
      // Register both public schemes independently of Clerk. Clerk still owns
      // OAuth callbacks; its matcher accepts only the renderer root, while
      // thread links use the distinct `threads` host.
      yield* electronApp.setAsDefaultProtocolClient(ElectronProtocol.DESKTOP_PRODUCTION_SCHEME);
      yield* electronApp.setAsDefaultProtocolClient(ElectronProtocol.DESKTOP_DEVELOPMENT_SCHEME);

      const initialLink = findDesktopThreadDeepLink(process.argv);
      if (initialLink !== null) {
        yield* Ref.update(pending, (links) => [...links, initialLink]);
      }

      yield* electronApp.on<readonly [Electron.Event, string]>("open-url", (event, rawUrl) => {
        void Effect.runPromise(
          receive(rawUrl).pipe(
            Effect.tap((handled) =>
              handled ? Effect.sync(() => event.preventDefault()) : Effect.void,
            ),
          ),
        );
      });
      yield* electronApp.on<readonly [Electron.Event, string[], string]>(
        "second-instance",
        (_event, argv) => {
          const link = findDesktopThreadDeepLink(argv);
          if (link !== null) void Effect.runPromise(accept(link));
        },
      );
    }),
    flush: Effect.gen(function* () {
      yield* Ref.set(ready, true);
      const links = yield* Ref.getAndSet(pending, []);
      yield* Effect.forEach(links, open, { discard: true });
    }),
  });
});

export const layer = Layer.effect(DesktopDeepLink, make);
