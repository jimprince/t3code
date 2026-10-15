import {
  NamedAgentError,
  isProviderAvailable,
  type SubheadRegistryInput,
  type Subhead,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { makeSubheadRegistry } from "./SubheadRegistry.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Providers from "../provider/ProviderRegistry.ts";

const isNamedAgentError = Schema.is(NamedAgentError);

/** Enabling validates actual execution resources; files are never read as live templates. */
export const makeSubheadRegistryRpc = Effect.gen(function* () {
  const registry = yield* makeSubheadRegistry;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const threads = yield* Threads.ThreadManagementService;
  const providers = yield* Providers.ProviderRegistry;
  const validate = (entry: Subhead) =>
    Effect.gen(function* () {
      const project = yield* projects.getShell(entry.projectId);
      if (Option.isNone(project))
        return yield* new NamedAgentError({ message: "Execution project is unavailable." });
      const owner = yield* threads.getThreadShell(entry.ownerThreadId);
      if (!owner || owner.deletedAt !== null || owner.archivedAt !== null)
        return yield* new NamedAgentError({ message: "Owning head is unavailable." });
      const provider = (yield* providers.getProviders).find(
        (item) => item.instanceId === entry.modelSelection.instanceId,
      );
      if (
        !provider?.enabled ||
        !provider.installed ||
        !isProviderAvailable(provider) ||
        provider.status === "error" ||
        provider.auth.status === "unauthenticated"
      )
        return yield* new NamedAgentError({
          message: "Pinned provider is not ready and authenticated.",
        });
      if (
        provider.models.length > 0 &&
        !provider.models.some((model) => model.slug === entry.modelSelection.model)
      )
        return yield* new NamedAgentError({
          message: "Pinned model is absent from the current provider catalog.",
        });
      if (
        provider.supportedRuntimeModes &&
        !provider.supportedRuntimeModes.includes(entry.runtimeMode)
      )
        return yield* new NamedAgentError({
          message: "Pinned provider does not support this runtime permission mode.",
        });
      // Codex enforces the approval/sandbox modes. Other adapters need explicit parity evidence.
      if (entry.runtimeMode !== "full-access" && provider.driver !== "codex")
        return yield* new NamedAgentError({
          message: "This provider has no verified enforcement for restricted subhead permissions.",
        });
      if (/astra|fable/i.test(entry.modelSelection.model))
        return yield* new NamedAgentError({
          message:
            "This model needs recorded administrator authorization; use an ordinary approved model for slice 1.",
        });
    }).pipe(
      Effect.mapError((cause) =>
        isNamedAgentError(cause) ? cause : new NamedAgentError({ message: String(cause) }),
      ),
    );
  const handle = (input: SubheadRegistryInput, actor = "system") =>
    Effect.gen(function* () {
      switch (input.operation) {
        case "list":
          return { agents: yield* registry.list(input.all) };
        case "show":
          return yield* registry.get(input.name);
        case "create":
          return yield* registry.create(input.template, actor);
        case "edit":
          return yield* registry.edit(input.name, input.template, input.expectedVersion, actor);
        case "state": {
          if (input.state === "enable") yield* validate(yield* registry.get(input.name));
          return yield* registry.setState(input.name, input.state, actor);
        }
      }
    }).pipe(
      Effect.mapError((cause) =>
        isNamedAgentError(cause) ? cause : new NamedAgentError({ message: String(cause) }),
      ),
    );
  return { handle, validate, registry };
});
