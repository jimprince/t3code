import { GITEA_TOKEN_REDACTED, type GiteaInstanceConfig } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { ServerSecretStore } from "../auth/ServerSecretStore.ts";

export const giteaTokenSecretName = (id: string) =>
  `gitea-token-${Buffer.from(id, "utf8").toString("base64url")}`;

export const redactGiteaInstances = (instances: ReadonlyArray<GiteaInstanceConfig>) =>
  instances.map((instance) => ({
    ...instance,
    token: instance.token ? GITEA_TOKEN_REDACTED : "",
  }));

export const materializeGiteaTokens = Effect.fn("materializeGiteaTokens")(function* (
  instances: ReadonlyArray<GiteaInstanceConfig>,
  store: ServerSecretStore["Service"],
) {
  return yield* Effect.forEach(
    instances,
    Effect.fn(function* (instance) {
      if (instance.token !== GITEA_TOKEN_REDACTED) return instance;
      const token = yield* store.get(giteaTokenSecretName(instance.id));
      return {
        ...instance,
        token: Option.isSome(token) ? new TextDecoder().decode(token.value) : "",
      };
    }),
  );
});

export const persistGiteaTokens = Effect.fn("persistGiteaTokens")(function* (
  current: ReadonlyArray<GiteaInstanceConfig>,
  next: ReadonlyArray<GiteaInstanceConfig>,
  store: ServerSecretStore["Service"],
) {
  for (const instance of next) {
    if (instance.token === GITEA_TOKEN_REDACTED) continue;
    if (instance.token)
      yield* store.set(giteaTokenSecretName(instance.id), new TextEncoder().encode(instance.token));
    else yield* store.remove(giteaTokenSecretName(instance.id));
  }
  for (const instance of current) {
    if (!next.some((candidate) => candidate.id === instance.id))
      yield* store.remove(giteaTokenSecretName(instance.id));
  }
  return redactGiteaInstances(next);
});
