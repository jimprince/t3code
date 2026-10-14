import { ProjectIssuesError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as GiteaApi from "../sourceControl/GiteaApi.ts";
import type { GiteaRepositoryTarget } from "./projectIssues.logic.ts";
import { editBeforeOrderTrailers } from "./requestOrder.logic.ts";

// Shared across service instances and transports in this server process.
const locks = new Map<string, Semaphore.Semaphore>();
const Body = Schema.Struct({ body: Schema.optional(Schema.NullOr(Schema.String)) });
export const make = Effect.gen(function* () {
  const api = yield* GiteaApi.make;
  const withIssueBodyEditor = <A, E, R>(
    target: GiteaRepositoryTarget,
    use: (
      edit: (
        number: number,
        patch: (body: string) => string,
      ) => Effect.Effect<string, ProjectIssuesError>,
    ) => Effect.Effect<A, E, R>,
  ) => {
    const key = `${target.host}/${target.repository}`;
    let lock = locks.get(key);
    if (!lock) {
      lock = Semaphore.makeUnsafe(1);
      locks.set(key, lock);
    }
    const edit = (number: number, patch: (body: string) => string) =>
      Effect.gen(function* () {
        const path = `${GiteaApi.repositoryPath(target.repository)}/issues/${number}`;
        const read = api
          .request(target.instance, path, Body)
          .pipe(Effect.mapError((e) => new ProjectIssuesError({ message: e.detail })));
        let before = yield* read;
        for (let attempt = 0; attempt < 2; attempt++) {
          const body = editBeforeOrderTrailers(patch(before.body ?? ""), (text) => text);
          if (body === (before.body ?? "")) return body;
          yield* api
            .send(target.instance, "PATCH", path, { body })
            .pipe(Effect.mapError((e) => new ProjectIssuesError({ message: e.detail })));
          const after = yield* read;
          if ((after.body ?? "") === body) return body;
          before = after;
        }
        return yield* new ProjectIssuesError({
          message: "The issue body changed while saving; retry the edit.",
        });
      });
    return lock.withPermit(Effect.suspend(() => use(edit)));
  };
  const editIssueBody = (
    target: GiteaRepositoryTarget,
    number: number,
    patch: (body: string) => string,
  ) => withIssueBodyEditor(target, (edit) => edit(number, patch));
  return { withIssueBodyEditor, editIssueBody };
});
/** All body writers re-read and verify under the same repository lock. */
export const editIssueBody = (
  target: GiteaRepositoryTarget,
  number: number,
  patch: (body: string) => string,
) => make.pipe(Effect.flatMap((editor) => editor.editIssueBody(target, number, patch)));
