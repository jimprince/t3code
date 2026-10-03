import type { GiteaInstanceConfig, OrchestrationProjectShell } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ThreadId } from "@t3tools/contracts";
import { ServerSettingsService } from "../serverSettings.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { describe, expect, it, vi } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";

import {
  buildThreadIssueLink,
  fetchThreadIssueMetadata,
  isPullRequestIssue,
  resolveThreadIssueReference,
  make,
} from "./ThreadIssueService.ts";

const instance: GiteaInstanceConfig = {
  id: "home",
  host: "git.bradleyprince.com",
  sshAliases: [],
  sshPorts: [22],
  webOrigin: "https://git.bradleyprince.com",
  apiOrigin: "https://git.bradleyprince.com",
  token: "test",
};

const project: Pick<OrchestrationProjectShell, "repositoryIdentity"> = {
  repositoryIdentity: {
    canonicalKey: "git.bradleyprince.com/brad/t3code-fork",
    provider: "gitea",
    displayName: "brad/t3code-fork",
    owner: "brad",
    name: "t3code-fork",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "ssh://git@git.bradleyprince.com/brad/t3code-fork.git",
    },
  },
};

const macInstance: GiteaInstanceConfig = {
  id: "home",
  host: "git.home",
  sshAliases: [],
  sshPorts: [2222],
  webOrigin: "http://git.home:3000",
  apiOrigin: "http://git.home:3000",
  token: "test",
};
const macProject: Pick<OrchestrationProjectShell, "repositoryIdentity"> = {
  repositoryIdentity: {
    canonicalKey: "git.bradleyprince.com/brad/gpu-transcriber",
    provider: "gitea",
    displayName: "brad/gpu-transcriber",
    owner: "brad",
    name: "gpu-transcriber",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "ssh://git@git.home:2222/brad/gpu-transcriber.git",
    },
  },
};

describe("Gitea issue reference resolution", () => {
  it.each(["brad/t3code-fork#73", "https://git.bradleyprince.com/brad/t3code-fork/issues/73"])(
    "accepts configured Gitea reference %s",
    (reference) => {
      expect(resolveThreadIssueReference(reference, project, [instance])).toMatchObject({
        host: "git.bradleyprince.com",
        repository: "brad/t3code-fork",
        number: 73,
      });
    },
  );

  it.each([
    "https://github.com/brad/t3code-fork/issues/73",
    "https://git.bradleyprince.com/brad/t3code-fork/pulls/73",
    "https://git.bradleyprince.com/brad/t3code-fork/issues/73?tab=activity",
  ])("rejects non-Gitea or noncanonical reference %s", (reference) => {
    expect(() => resolveThreadIssueReference(reference, project, [instance])).toThrow();
  });

  it("rejects a short reference for a non-Gitea project", () => {
    expect(() =>
      resolveThreadIssueReference("brad/t3code-fork#73", { repositoryIdentity: null }, [instance]),
    ).toThrow(/requires the thread project to use configured Gitea/);
  });

  it.each([
    "https://git.bradleyprince.com/brad/gpu-transcriber/issues/6",
    "http://git.home/brad/gpu-transcriber/issues/6",
  ])(
    "accepts public and internal issue URLs through the project's configured Gitea route",
    (url) => {
      expect(resolveThreadIssueReference(url, macProject, [macInstance])).toMatchObject({
        instance: macInstance,
        repository: "brad/gpu-transcriber",
        number: 6,
        url,
      });
    },
  );

  it("creates a usable cached badge without a live Gitea response", () => {
    const target = resolveThreadIssueReference(
      "https://git.bradleyprince.com/brad/gpu-transcriber/issues/6",
      macProject,
      [macInstance],
    );
    expect(buildThreadIssueLink(target, null, "2026-10-04T12:00:00.000Z")).toMatchObject({
      repository: "brad/gpu-transcriber",
      number: 6,
      url: "https://git.bradleyprince.com/brad/gpu-transcriber/issues/6",
      snapshot: { title: "brad/gpu-transcriber #6", state: "open" },
    });
  });

  effectIt.effect("fetches a public issue URL through the configured internal API origin", () =>
    Effect.gen(function* () {
      const target = resolveThreadIssueReference(
        "https://git.bradleyprince.com/brad/gpu-transcriber/issues/6",
        macProject,
        [macInstance],
      );
      const response = {
        number: 6,
        title: "Fix transcription",
        state: "open" as const,
        html_url: "http://git.home:3000/brad/gpu-transcriber/issues/6",
        pull_request: null,
      };
      const request = vi.fn(() => Effect.succeed(response)) as never;

      expect(yield* fetchThreadIssueMetadata({ request }, target)).toEqual(response);
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({ apiOrigin: "http://git.home:3000" }),
        "/repos/brad/gpu-transcriber/issues/6",
        expect.anything(),
      );
    }),
  );

  it("uses the API pull_request value without mistaking null for a pull request", () => {
    const issue = {
      number: 6,
      title: "Real issue",
      state: "open" as const,
      html_url: "http://git.home:3000/brad/gpu-transcriber/issues/6",
    };
    expect(isPullRequestIssue({ ...issue, pull_request: null })).toBe(false);
    expect(isPullRequestIssue({ ...issue, pull_request: { url: "pulls/6" } })).toBe(true);
  });

  it("keeps the linked public URL when metadata came from an internal API alias", () => {
    const target = resolveThreadIssueReference(
      "https://git.bradleyprince.com/brad/gpu-transcriber/issues/6",
      macProject,
      [macInstance],
    );
    expect(
      buildThreadIssueLink(
        target,
        {
          title: "Fix transcription",
          state: "open",
          html_url: "http://git.home:3000/brad/gpu-transcriber/issues/6",
        },
        "2026-10-04T12:00:00.000Z",
      ),
    ).toMatchObject({
      url: "https://git.bradleyprince.com/brad/gpu-transcriber/issues/6",
      snapshot: { title: "Fix transcription", state: "open" },
    });
  });
});

describe("issue link service", () => {
  effectIt.effect.each([null, { url: "http://git.home:3000/brad/gpu-transcriber/pulls/6" }])(
    "persists ordinary issues and rejects actual PRs (pull_request=%j)",
    (pull_request) =>
      Effect.gen(function* () {
        const requests: string[] = [];
        const dispatched: unknown[] = [];
        const threadId = ThreadId.make("issue-worker");
        const result = yield* make.pipe(
          Effect.flatMap((service) =>
            service.link({
              threadId,
              reference: "https://git.bradleyprince.com/brad/gpu-transcriber/issues/6",
            }),
          ),
          Effect.result,
          Effect.provideService(ProjectionSnapshotQuery, {
            getThreadShellById: () =>
              Effect.succeed(Option.some({ id: threadId, projectId: "project", issues: [] })),
            getProjectShellById: () => Effect.succeed(Option.some(macProject)),
          } as never),
          Effect.provideService(OrchestrationEngineService, {
            dispatch: (command: unknown) => {
              dispatched.push(command);
              return Effect.succeed({});
            },
          } as never),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) => {
              requests.push(request.url);
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(
                    JSON.stringify({
                      number: 6,
                      title: "Fix transcription",
                      state: "closed",
                      html_url: "http://git.home:3000/brad/gpu-transcriber/issues/6",
                      pull_request,
                    }),
                  ),
                ),
              );
            }),
          ),
          Effect.provide(
            Layer.mergeAll(
              ServerSettingsService.layerTest({ giteaInstances: [macInstance] }),
              NodeServices.layer,
            ),
          ),
        );
        expect(requests).toEqual([
          "http://git.home:3000/api/v1/repos/brad/gpu-transcriber/issues/6",
        ]);
        if (pull_request === null) {
          expect(result._tag).toBe("Success");
          if (result._tag === "Success")
            expect(result.success.link.snapshot).toMatchObject({
              title: "Fix transcription",
              state: "closed",
            });
          expect(dispatched).toMatchObject([
            {
              type: "thread.issue.link",
              link: { snapshot: { title: "Fix transcription", state: "closed" } },
            },
          ]);
        } else {
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure")
            expect(result.failure.message).toBe("That Gitea URL is a pull request, not an issue.");
          expect(dispatched).toEqual([]);
        }
      }),
  );
});

describe("issue link service with a public alias not in the configuration", () => {
  const internalProject: Pick<OrchestrationProjectShell, "repositoryIdentity"> = {
    repositoryIdentity: {
      canonicalKey: "git.home/brad/switchboard",
      provider: "gitea",
      displayName: "brad/switchboard",
      owner: "brad",
      name: "switchboard",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "ssh://git@git.home:2222/brad/switchboard.git",
      },
    },
  };
  const aliasUrl = "https://git.bradleyprince.com/brad/t3code-fork/issues/146";
  const threadId = ThreadId.make("alias-worker");

  const run = <A, E>(
    operation: (service: Effect.Success<typeof make>) => Effect.Effect<A, E>,
    options: { issues?: unknown[]; response?: (url: string) => Response } = {},
  ) => {
    const requests: string[] = [];
    const dispatched: unknown[] = [];
    const respond =
      options.response ??
      ((url: string) =>
        url.endsWith("/repos/brad/t3code-fork/issues/146")
          ? new Response(
              JSON.stringify({
                number: 146,
                title: "Alias",
                state: "open",
                html_url: "http://git.home:3000/brad/t3code-fork/issues/146",
              }),
            )
          : new Response("{}", { status: 404 }));
    return make.pipe(
      Effect.flatMap(operation),
      Effect.result,
      Effect.provideService(ProjectionSnapshotQuery, {
        getThreadShellById: () =>
          Effect.succeed(
            Option.some({ id: threadId, projectId: "project", issues: options.issues ?? [] }),
          ),
        getProjectShellById: () => Effect.succeed(Option.some(internalProject)),
      } as never),
      Effect.provideService(OrchestrationEngineService, {
        dispatch: (command: unknown) => {
          dispatched.push(command);
          return Effect.succeed({});
        },
      } as never),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          requests.push(request.url);
          return Effect.succeed(HttpClientResponse.fromWeb(request, respond(request.url)));
        }),
      ),
      Effect.provide(
        Layer.mergeAll(
          ServerSettingsService.layerTest({ giteaInstances: [macInstance] }),
          NodeServices.layer,
        ),
      ),
      Effect.map((result) => ({ result, requests, dispatched })),
    );
  };

  effectIt.effect(
    "links the public HTTPS alias once the configured instance confirms the issue",
    () =>
      Effect.gen(function* () {
        const { result, dispatched } = yield* run((service) =>
          service.link({ threadId, reference: aliasUrl }),
        );
        expect(result._tag).toBe("Success");
        expect(dispatched).toMatchObject([
          {
            type: "thread.issue.link",
            link: {
              host: "git.home:3000",
              repository: "brad/t3code-fork",
              number: 146,
              url: aliasUrl,
              snapshot: { title: "Alias", state: "open" },
            },
          },
        ]);
      }),
  );

  effectIt.effect("rejects an alias URL that no configured instance has", () =>
    Effect.gen(function* () {
      const { result, dispatched } = yield* run((service) =>
        service.link({
          threadId,
          reference: "https://github.com/brad/t3code-fork/issues/999",
        }),
      );
      expect(result._tag).toBe("Failure");
      expect(dispatched).toEqual([]);
    }),
  );

  effectIt.effect("rejects an alias URL whose number is a pull request on the instance", () =>
    Effect.gen(function* () {
      const { result, dispatched } = yield* run(
        (service) => service.link({ threadId, reference: aliasUrl }),
        {
          response: () =>
            new Response(
              JSON.stringify({
                number: 146,
                title: "PR",
                state: "open",
                html_url: "http://git.home:3000/brad/t3code-fork/pulls/146",
                pull_request: { merged: false },
              }),
            ),
        },
      );
      expect(result._tag).toBe("Failure");
      expect(dispatched).toEqual([]);
    }),
  );

  effectIt.effect("unlinks a linked alias URL without reaching the API", () =>
    Effect.gen(function* () {
      const { result, requests, dispatched } = yield* run(
        (service) => service.unlink({ threadId, reference: aliasUrl }),
        {
          issues: [
            {
              host: "git.home:3000",
              repository: "brad/t3code-fork",
              number: 146,
              url: aliasUrl,
            },
          ],
        },
      );
      expect(result._tag).toBe("Success");
      expect(requests).toEqual([]);
      expect(dispatched).toMatchObject([
        {
          type: "thread.issue.unlink",
          host: "git.home:3000",
          repository: "brad/t3code-fork",
          number: 146,
        },
      ]);
    }),
  );
});
