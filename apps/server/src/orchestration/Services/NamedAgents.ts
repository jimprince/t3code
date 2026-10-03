/**
 * NamedAgents - singleton agents that own one resource each.
 *
 * A named agent is a project (its folder holds AGENT.md and BRIEFING.md) with at
 * most one live top-level thread, enforced by the decider. This service lists
 * agents, resolves a name to its live incarnation (starting one when dormant),
 * and hands an agent over to a fresh incarnation seeded from its folder.
 *
 * @module NamedAgents
 */
import type {
  HandOverNamedAgentInput,
  ListNamedAgentsResult,
  NamedAgentError,
  NamedAgentThreadResult,
  ResolveNamedAgentInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface NamedAgentsShape {
  readonly list: () => Effect.Effect<ListNamedAgentsResult, NamedAgentError>;
  /** The live incarnation; a dormant agent starts with `message` as its first request. */
  readonly resolve: (
    input: ResolveNamedAgentInput,
  ) => Effect.Effect<NamedAgentThreadResult, NamedAgentError>;
  /** Replace an idle live incarnation with a fresh one seeded from AGENT.md and BRIEFING.md. */
  readonly handOver: (
    input: HandOverNamedAgentInput,
  ) => Effect.Effect<NamedAgentThreadResult, NamedAgentError>;
}

export class NamedAgents extends Context.Service<NamedAgents, NamedAgentsShape>()(
  "t3/orchestration/Services/NamedAgents",
) {}
