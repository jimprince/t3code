import {
  ProjectRoadmapError,
  type ProjectRoadmap,
  type ProjectRoadmapGetInput,
  type ProjectRoadmapMoveInput,
  type ProjectRoadmapSaveVersionInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as GiteaApi from "../sourceControl/GiteaApi.ts";
import { listMilestones, setIssueMilestone } from "../projectIssues/giteaMilestones.ts";
import type { ProjectIssuesService } from "../projectIssues/ProjectIssuesService.ts";
import type { RequestLedger } from "../projectIssues/RequestLedger.ts";
import { parseRequestReference } from "../projectIssues/requestLedger.logic.ts";
import { findVersion, orderVersions, roadmapItems } from "./projectRoadmap.logic.ts";

const fail = (message: string) => new ProjectRoadmapError({ message });

/**
 * The project roadmap: versions are the tracker repository's open Gitea
 * milestones, and an item is in a version when its issue has that milestone.
 * Items without one are Later. No other store.
 */
export const make = (deps: {
  readonly ledger: RequestLedger;
  readonly projectIssues: ProjectIssuesService;
}) =>
  Effect.gen(function* () {
    const api = yield* GiteaApi.make;

    const tracker = (threadId: ProjectRoadmapGetInput["threadId"]) =>
      deps.ledger.resolveThread(threadId).pipe(
        Effect.mapError((error) => fail(error.message)),
        Effect.flatMap((resolved) =>
          resolved
            ? Effect.succeed(resolved.target)
            : Effect.fail(
                fail(
                  "This project has no Gitea tracker repository. Set one with t3-thread project tracker set.",
                ),
              ),
        ),
      );

    const get = (input: ProjectRoadmapGetInput) =>
      Effect.gen(function* () {
        const resolved = yield* deps.ledger
          .resolveThread(input.threadId)
          .pipe(Effect.mapError((error) => fail(error.message)));
        if (!resolved) return { tracker: null, versions: [], items: [] } satisfies ProjectRoadmap;
        const { target, root } = resolved;
        const listing = yield* deps.projectIssues
          .list({ rootThreadId: root.id })
          .pipe(Effect.mapError((error) => fail(error.message)));
        const milestones = yield* listMilestones(
          api,
          target.instance,
          target.repository,
          "open",
        ).pipe(Effect.mapError((error) => fail(error.detail)));
        return {
          tracker: { host: target.host, repository: target.repository },
          versions: orderVersions(milestones).map((milestone) => ({
            id: milestone.id,
            title: milestone.title.trim(),
            dueOn: milestone.due_on ?? null,
            openIssues: Math.max(0, milestone.open_issues ?? 0),
            closedIssues: Math.max(0, milestone.closed_issues ?? 0),
            description: milestone.description?.trim() || null,
          })),
          items: roadmapItems(listing.issues, target, milestones),
        } satisfies ProjectRoadmap;
      });

    const move = (input: ProjectRoadmapMoveInput) =>
      Effect.gen(function* () {
        const target = yield* tracker(input.threadId);
        const reference = parseRequestReference(input.reference, target);
        if (!reference) return yield* fail("Expected an issue number, owner/repo#N, or issue URL.");
        if (reference.repository !== target.repository) {
          return yield* fail(`Versions belong to ${target.repository}; that issue is elsewhere.`);
        }
        let milestoneId: number | null = null;
        if (input.version !== null && !input.later) {
          const milestones = yield* listMilestones(
            api,
            target.instance,
            target.repository,
            "open",
          ).pipe(Effect.mapError((error) => fail(error.detail)));
          const version = findVersion(milestones, input.version);
          if (!version) return yield* fail(`No open version named "${input.version}".`);
          milestoneId = version.id;
        }
        yield* setIssueMilestone(
          api,
          target.instance,
          target.repository,
          reference.number,
          milestoneId,
        ).pipe(Effect.mapError((error) => fail(error.detail)));
        // Later parks the item; anywhere else (a version or the automatic next one)
        // takes it off the shelf.
        yield* (input.later ? deps.ledger.park : deps.ledger.unpark)(target, reference.number).pipe(
          Effect.ignore,
        );
        deps.projectIssues.invalidate(target);
        return yield* get(input);
      });

    const saveVersion = (input: ProjectRoadmapSaveVersionInput) =>
      Effect.gen(function* () {
        const target = yield* tracker(input.threadId);
        const path = `${GiteaApi.repositoryPath(target.repository)}/milestones`;
        const milestones = yield* listMilestones(
          api,
          target.instance,
          target.repository,
          "open",
        ).pipe(Effect.mapError((error) => fail(error.detail)));
        const clash = findVersion(milestones, input.title);
        if (clash && clash.id !== input.id) return yield* fail(`"${input.title}" already exists.`);
        yield* (
          input.id === undefined
            ? api.send(target.instance, "POST", path, { title: input.title })
            : api.send(target.instance, "PATCH", `${path}/${input.id}`, { title: input.title })
        ).pipe(Effect.mapError((error) => fail(error.detail)));
        deps.projectIssues.invalidate(target);
        return yield* get(input);
      });

    return { get, move, saveVersion };
  });
