import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import type { SignedApnsDeliveryJob } from "./apnsDeliveryJobs.ts";
import * as RelayConfiguration from "../Config.ts";
import * as ApnsDeliveryQueue from "./ApnsDeliveryQueue.ts";

const config: RelayConfiguration.RelayConfiguration["Service"] = {
  relayIssuer: "https://relay.example.com",
  apns: {
    teamId: "team-1",
    keyId: "key-1",
    privateKey: Redacted.make("apns-private-key"),
    bundleId: "com.t3tools.test",
    environment: "sandbox",
  },
  clerkSecretKey: Redacted.make("clerk-secret"),
  clerkPublishableKey: "pk_test_test",
  clerkJwtAudience: "t3-code-relay",
  apnsDeliveryJobSigningSecret: Redacted.make("apns-job-secret"),
  cloudMintPrivateKey: Redacted.make("cloud-private-key"),
  cloudMintPublicKey: "cloud-public-key",
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
};

describe("ApnsDeliveryQueue", () => {
  it.effect("does not require the deployment RuntimeContext when building the Worker layer", () => {
    const sent: unknown[] = [];
    const sender: Cloudflare.Queues.WriteQueueClient = {
      raw: Effect.die("raw queue binding is not used"),
      send: (body) =>
        Effect.sync(() => {
          sent.push(body);
        }),
      sendBatch: () => Effect.die("batch queue binding is not used"),
    };
    const runtimeContext = {} as Alchemy.BaseRuntimeContext;
    const layer = ApnsDeliveryQueue.layerCloudflareQueues(sender, runtimeContext).pipe(
      Layer.provide(NodeCryptoLayer.layer),
      Layer.provide(RelayConfiguration.layer(config)),
    );

    return Effect.gen(function* () {
      const queue = yield* ApnsDeliveryQueue.ApnsDeliveryQueue;
      yield* queue.enqueuePushNotification({
        userId: "user-1",
        deviceId: "device-1",
        token: "push-token",
        notification: {
          title: "Thread",
          body: "Input: Project",
          environmentId: "env-1",
          threadId: "thread-1",
          deepLink: "/threads/env-1/thread-1",
        },
      });

      expect(sent).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("preserves job identity and the queue sender cause", () => {
    const cause = new Error("queue unavailable");
    const senderCause = new Cloudflare.Queues.SendError({
      message: cause.message,
      cause,
    });
    const layer = ApnsDeliveryQueue.layer.pipe(
      Layer.provide(NodeCryptoLayer.layer),
      Layer.provide(RelayConfiguration.layer(config)),
      Layer.provide(
        Layer.succeed(ApnsDeliveryQueue.ApnsDeliveryQueueSender, {
          send: () => Effect.fail(senderCause),
        }),
      ),
    );

    return Effect.gen(function* () {
      const queue = yield* ApnsDeliveryQueue.ApnsDeliveryQueue;
      const error = yield* Effect.flip(
        queue.enqueuePushNotification({
          userId: "user-1",
          deviceId: "device-1",
          token: "push-token",
          notification: {
            title: "Thread",
            body: "Input: Project",
            environmentId: "env-1",
            threadId: "thread-1",
            deepLink: "/threads/env-1/thread-1",
          },
        }),
      );

      expect(error).toMatchObject({
        _tag: "ApnsDeliveryQueueSendError",
        operation: "send",
        jobId: expect.any(String),
        kind: "push_notification",
        userId: "user-1",
        deviceId: "device-1",
        cause: senderCause,
      });
      expect(senderCause.cause).toBe(cause);
      expect(error.message).toBe(
        "Failed to enqueue APNs push notification delivery during send for device device-1.",
      );
    }).pipe(Effect.provide(layer));
  });
});

it.effect(
  "deduplicates APNs jobs by device and logical turn rather than mutable timestamps",
  () => {
    const sent: SignedApnsDeliveryJob[] = [];
    const layer = ApnsDeliveryQueue.layer.pipe(
      Layer.provide(
        Layer.succeed(ApnsDeliveryQueue.ApnsDeliveryQueueSender, {
          send: (job) =>
            Effect.sync(() => {
              sent.push(job);
            }),
        }),
      ),
      Layer.provide(NodeCryptoLayer.layer),
      Layer.provide(RelayConfiguration.layer(config)),
    );
    return Effect.gen(function* () {
      const queue = yield* ApnsDeliveryQueue.ApnsDeliveryQueue;
      const input = {
        userId: "user",
        deviceId: "phone",
        token: "token",
        notification: {
          title: "Thread",
          body: "Reply ready",
          environmentId: "env",
          threadId: "thread",
          deepLink: "/threads/env/thread",
          notification: {
            kind: "reply" as const,
            identity: "turn",
            origin: "human" as const,
            occurredAt: "1970-01-01T00:00:00Z",
          },
        },
      };
      yield* queue.enqueuePushNotification(input);
      yield* queue.enqueuePushNotification({
        ...input,
        notification: { ...input.notification, updatedAt: "later" },
      });
      yield* queue.enqueuePushNotification({
        ...input,
        notification: {
          ...input.notification,
          notification: { ...input.notification.notification, identity: "next-turn" },
        },
      });
      yield* queue.enqueuePushNotification({ ...input, deviceId: "other-phone" });
      expect(sent[0]!.payload.jobId).toBe(sent[1]!.payload.jobId);
      expect(sent[2]!.payload.jobId).not.toBe(sent[0]!.payload.jobId);
      expect(sent[3]!.payload.jobId).not.toBe(sent[0]!.payload.jobId);
      expect(sent[0]!.payload.notification?.notification).toEqual(input.notification.notification);
    }).pipe(Effect.provide(layer));
  },
);
