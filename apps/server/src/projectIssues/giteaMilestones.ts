import type { GiteaInstanceConfig } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as GiteaApi from "../sourceControl/GiteaApi.ts";

const GiteaMilestone = Schema.Struct({
  id: Schema.Number,
  title: Schema.String,
  state: Schema.optional(Schema.String),
  due_on: Schema.optional(Schema.NullOr(Schema.String)),
});
export type GiteaMilestone = typeof GiteaMilestone.Type;
const GiteaMilestones = Schema.Array(GiteaMilestone);

type Api = Effect.Success<typeof GiteaApi.make>;

/** A tracker repository's milestones (versions); `open` lists only unreleased ones. */
export const listMilestones = (
  api: Api,
  instance: GiteaInstanceConfig,
  repository: string,
  state: "open" | "all",
) =>
  api.request(
    instance,
    `${GiteaApi.repositoryPath(repository)}/milestones?state=${state}&limit=50`,
    GiteaMilestones,
  );

/** The milestone with this title (case-insensitive), created when missing. */
export const ensureMilestone = (
  api: Api,
  instance: GiteaInstanceConfig,
  repository: string,
  title: string,
) =>
  Effect.gen(function* () {
    const wanted = title.trim();
    const existing = (yield* listMilestones(api, instance, repository, "all")).find(
      (milestone) => milestone.title.trim().toLowerCase() === wanted.toLowerCase(),
    );
    if (existing) return existing;
    return yield* api.request(
      instance,
      `${GiteaApi.repositoryPath(repository)}/milestones`,
      GiteaMilestone,
      { title: wanted },
    );
  });

/** Puts an issue in a milestone, or takes it out with `null` (Gitea clears on 0). */
export const setIssueMilestone = (
  api: Api,
  instance: GiteaInstanceConfig,
  repository: string,
  number: number,
  milestoneId: number | null,
) =>
  api.send(instance, "PATCH", `${GiteaApi.repositoryPath(repository)}/issues/${number}`, {
    milestone: milestoneId ?? 0,
  });
