import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";

import * as CodexError from "./errors.ts";
import { JsonRpcId, JsonRpcResponseEnvelope } from "./_internal/shared.ts";
const isJsonRpcId = Schema.is(JsonRpcId);
const isJsonRpcResponseEnvelope = Schema.is(JsonRpcResponseEnvelope);
const isCodexAppServerError = Schema.is(CodexError.CodexAppServerError);
const MAX_BUFFERED_RAW_MESSAGES = 32;
const MAX_NOTIFICATION_TURNS = 128;
const MAX_NOTIFICATIONS_PER_TURN = 256;

function notificationKey(notification: CodexAppServerIncomingNotification): string {
  const params = notification.params;
  if (!isObject(params)) return "connection";
  const turnId =
    typeof params.turnId === "string"
      ? params.turnId
      : isObject(params.turn) && typeof params.turn.id === "string"
        ? params.turn.id
        : undefined;
  const threadId = typeof params.threadId === "string" ? params.threadId : "connection";
  return JSON.stringify([threadId, turnId ?? null]);
}

export interface CodexAppServerProtocolLogEvent {
  readonly direction: "incoming" | "outgoing";
  readonly stage: "raw" | "decoded" | "decode_failed";
  readonly payload: unknown;
}

export interface CodexAppServerIncomingNotification {
  readonly method: string;
  readonly params?: unknown;
}

export interface CodexAppServerIncomingRequest {
  readonly id: string | number;
  readonly method: string;
  readonly params?: unknown;
}

export interface CodexAppServerPatchedProtocolOptions {
  readonly stdio: Stdio.Stdio;
  readonly requestTimeoutMs?: number;
  readonly terminationError?: Effect.Effect<CodexError.CodexAppServerError>;
  readonly logIncoming?: boolean;
  readonly logOutgoing?: boolean;
  readonly logger?: (event: CodexAppServerProtocolLogEvent) => Effect.Effect<void, never>;
  readonly onNotification?: (
    notification: CodexAppServerIncomingNotification,
  ) => Effect.Effect<void, never>;
  readonly onRequest?: (
    request: CodexAppServerIncomingRequest,
  ) => Effect.Effect<unknown, CodexError.CodexAppServerError>;
  readonly onTermination?: (error: CodexError.CodexAppServerError) => Effect.Effect<void, never>;
}

export interface CodexAppServerPatchedProtocol {
  readonly incomingNotifications: Stream.Stream<CodexAppServerIncomingNotification>;
  readonly incomingRequests: Stream.Stream<CodexAppServerIncomingRequest>;
  readonly request: (
    method: string,
    payload?: unknown,
  ) => Effect.Effect<unknown, CodexError.CodexAppServerError>;
  readonly notify: (
    method: string,
    payload?: unknown,
  ) => Effect.Effect<void, CodexError.CodexAppServerError>;
  readonly respond: (
    requestId: string | number,
    result: unknown,
  ) => Effect.Effect<void, CodexError.CodexAppServerError>;
  readonly respondError: (
    requestId: string | number,
    error: CodexError.CodexAppServerRequestError,
  ) => Effect.Effect<void, CodexError.CodexAppServerError>;
}

interface CodexAppServerPendingRequest {
  readonly deferred: Deferred.Deferred<unknown, CodexError.CodexAppServerError>;
  readonly method: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isIncomingRequest(value: unknown): value is CodexAppServerIncomingRequest {
  if (!isObject(value) || typeof value.method !== "string") {
    return false;
  }
  return isJsonRpcId(value.id);
}

function isIncomingNotification(value: unknown): value is CodexAppServerIncomingNotification {
  return isObject(value) && typeof value.method === "string" && !("id" in value);
}

function isIncomingResponse(value: unknown): value is typeof JsonRpcResponseEnvelope.Type {
  return isJsonRpcResponseEnvelope(value);
}

const encodeJsonString = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeJsonString = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const encodeWireMessage = (
  message: Record<string, unknown>,
): Effect.Effect<string, CodexError.CodexAppServerProtocolParseError> =>
  encodeJsonString(message).pipe(
    Effect.map((encoded) => `${encoded}\n`),
    Effect.mapError((cause) => {
      const method = typeof message.method === "string" ? message.method : undefined;
      const requestId =
        typeof message.id === "string" || typeof message.id === "number"
          ? String(message.id)
          : undefined;
      return CodexError.CodexAppServerProtocolParseError.fromSchemaError(
        "encode-wire-message",
        cause,
        {
          ...(method === undefined ? {} : { method }),
          ...(requestId === undefined ? {} : { requestId }),
        },
      );
    }),
  );

const decodeWireMessage = (
  line: string,
): Effect.Effect<unknown, CodexError.CodexAppServerProtocolParseError> =>
  decodeJsonString(line).pipe(
    Effect.mapError((cause) =>
      CodexError.CodexAppServerProtocolParseError.fromSchemaError("decode-wire-message", cause),
    ),
  );

const normalizeIncomingError = (
  error: unknown,
  operation: CodexError.CodexAppServerTransportOperation,
): CodexError.CodexAppServerError =>
  isCodexAppServerError(error)
    ? error
    : new CodexError.CodexAppServerTransportError({
        operation,
        cause: error,
      });

const toProtocolMessage = (
  requestId: string | number,
  fields: {
    readonly result?: unknown;
    readonly error?: CodexError.CodexAppServerProtocolErrorShape;
  },
): { readonly [key: string]: unknown } => ({
  id: requestId,
  ...(fields.result !== undefined ? { result: fields.result } : {}),
  ...(fields.error !== undefined ? { error: fields.error } : {}),
});

export const makeCodexAppServerPatchedProtocol = Effect.fn("makeCodexAppServerPatchedProtocol")(
  function* (
    options: CodexAppServerPatchedProtocolOptions,
  ): Effect.fn.Return<CodexAppServerPatchedProtocol, never, Scope.Scope> {
    const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    const protocolScope = yield* Scope.Scope;
    const requestHandlerScope = yield* Scope.fork(protocolScope, "parallel");
    const outgoing = yield* Queue.unbounded<
      {
        readonly encoded: string;
        readonly written: Deferred.Deferred<void>;
      },
      Cause.Done<void>
    >();
    const incomingNotifications =
      yield* Queue.sliding<CodexAppServerIncomingNotification>(MAX_BUFFERED_RAW_MESSAGES);
    const incomingRequests =
      yield* Queue.sliding<CodexAppServerIncomingRequest>(MAX_BUFFERED_RAW_MESSAGES);
    const pending = yield* Ref.make(new Map<string, CodexAppServerPendingRequest>());
    const nextRequestId = yield* Ref.make(1);
    const remainder: Array<string> = [];
    const terminationHandled = yield* Ref.make(false);
    const terminationFailure = yield* Ref.make(Option.none<CodexError.CodexAppServerError>());
    const terminationSignal = yield* Deferred.make<void>();
    const activeRequestHandlers = yield* Ref.make(0);
    const notificationQueues = new Map<string, Array<CodexAppServerIncomingNotification>>();

    const logProtocol = (event: CodexAppServerProtocolLogEvent) => {
      if (event.direction === "incoming" && !options.logIncoming) {
        return Effect.void;
      }
      if (event.direction === "outgoing" && !options.logOutgoing) {
        return Effect.void;
      }
      return (
        options.logger?.(event) ??
        Effect.logDebug("Codex App Server protocol event").pipe(Effect.annotateLogs({ event }))
      );
    };

    const failAllPending = (error: CodexError.CodexAppServerError) =>
      Ref.get(pending).pipe(
        Effect.flatMap((current) =>
          Effect.forEach([...current.values()], ({ deferred }) => Deferred.fail(deferred, error), {
            discard: true,
          }),
        ),
        Effect.andThen(Ref.set(pending, new Map())),
      );

    const handleTermination = (classify: () => Effect.Effect<CodexError.CodexAppServerError>) =>
      Ref.modify(terminationHandled, (handled) => {
        if (handled) {
          return [Effect.void, true] as const;
        }
        return [
          Effect.gen(function* () {
            const error = yield* classify();
            yield* Ref.set(terminationFailure, Option.some(error));
            yield* failAllPending(error);
            yield* Queue.end(outgoing);
            yield* Deferred.succeed(terminationSignal, undefined);
            yield* Scope.close(requestHandlerScope, Exit.void).pipe(
              Effect.forkIn(protocolScope, { startImmediately: true }),
              Effect.asVoid,
            );
            if (options.onTermination) {
              yield* options.onTermination(error);
            }
          }),
          true,
        ] as const;
      }).pipe(Effect.flatten);

    const offerOutgoing = (message: Record<string, unknown>) =>
      Effect.gen(function* () {
        const failure = yield* Ref.get(terminationFailure);
        if (Option.isSome(failure)) return yield* failure.value;

        yield* logProtocol({
          direction: "outgoing",
          stage: "decoded",
          payload: message,
        });
        const encoded = yield* encodeWireMessage(message);
        yield* logProtocol({
          direction: "outgoing",
          stage: "raw",
          payload: encoded,
        });
        const written = yield* Deferred.make<void>();
        const accepted = yield* Queue.offer(outgoing, { encoded, written });
        if (!accepted) {
          const closed = yield* Ref.get(terminationFailure);
          return yield* Option.getOrElse(
            closed,
            () => new CodexError.CodexAppServerInputStreamEndedError({}),
          );
        }
        yield* Deferred.await(written);
      });

    const removePending = (requestId: string) =>
      Ref.update(pending, (current) => {
        if (!current.has(requestId)) {
          return current;
        }
        const next = new Map(current);
        next.delete(requestId);
        return next;
      });

    const resolvePending = (
      requestId: string,
      handler: (pendingRequest: CodexAppServerPendingRequest) => Effect.Effect<void>,
    ) =>
      Ref.modify(pending, (current) => {
        const pendingRequest = current.get(requestId);
        if (!pendingRequest) {
          return [Effect.void, current] as const;
        }
        const next = new Map(current);
        next.delete(requestId);
        return [handler(pendingRequest), next] as const;
      }).pipe(Effect.flatten);

    const respond = (requestId: string | number, result: unknown) =>
      offerOutgoing(toProtocolMessage(requestId, { result }));

    const respondError = (
      requestId: string | number,
      error: CodexError.CodexAppServerRequestError,
    ) => offerOutgoing(toProtocolMessage(requestId, { error: error.toProtocolError() }));

    const handleResponse = (response: typeof JsonRpcResponseEnvelope.Type) => {
      const requestId = String(response.id);
      const protocolError = response.error;
      if (protocolError !== undefined) {
        return resolvePending(requestId, ({ deferred, method }) =>
          Deferred.fail(
            deferred,
            CodexError.CodexAppServerRequestError.fromProtocolError(
              protocolError,
              method,
              requestId,
            ),
          ),
        );
      }
      return resolvePending(requestId, ({ deferred }) =>
        Deferred.succeed(deferred, response.result),
      );
    };

    const handleRequest = (request: CodexAppServerIncomingRequest) =>
      Queue.offer(incomingRequests, request).pipe(
        Effect.flatMap(() => {
          const handler = options.onRequest;
          if (!handler) return Effect.void;

          return Ref.modify(activeRequestHandlers, (count) =>
            count >= MAX_BUFFERED_RAW_MESSAGES ? [false, count] : [true, count + 1],
          ).pipe(
            Effect.flatMap((accepted) => {
              if (!accepted) {
                return respondError(
                  request.id,
                  CodexError.CodexAppServerRequestError.overloaded(
                    "Too many Codex requests are already active.",
                  ),
                );
              }

              return handler(request).pipe(
                Effect.matchEffect({
                  onFailure: (error) =>
                    respondError(
                      request.id,
                      CodexError.CodexAppServerRequestError.fromAppServerError(
                        error,
                        request.method,
                      ),
                    ),
                  onSuccess: (result) => respond(request.id, result),
                }),
                Effect.ensuring(
                  Ref.update(activeRequestHandlers, (count) => Math.max(0, count - 1)),
                ),
                Effect.catch((error) =>
                  handleTermination(() => Effect.succeed(error)).pipe(
                    Effect.forkIn(protocolScope),
                    Effect.asVoid,
                  ),
                ),
                Effect.forkIn(requestHandlerScope, { startImmediately: true }),
                Effect.asVoid,
              );
            }),
          );
        }),
        Effect.asVoid,
      );

    // A turn handler may wait for the turn/start response that this reader must decode.
    // Keep each turn ordered, but never join its worker on the input stream.
    const handleNotification = Effect.fnUntraced(function* (
      notification: CodexAppServerIncomingNotification,
    ) {
      yield* Queue.offer(incomingNotifications, notification);
      const handler = options.onNotification;
      if (!handler) return;
      const key = notificationKey(notification);
      const existing = notificationQueues.get(key);
      if (
        (existing?.length ?? 0) >= MAX_NOTIFICATIONS_PER_TURN ||
        (existing === undefined && notificationQueues.size >= MAX_NOTIFICATION_TURNS)
      ) {
        // Fail explicitly rather than lose live turn events or grow without a bound.
        return yield* handleTermination(() =>
          Effect.succeed(
            CodexError.CodexAppServerRequestError.overloaded(
              "Codex notification backlog exceeded its bound.",
            ),
          ),
        );
      }
      if (existing !== undefined) {
        existing.push(notification);
        return;
      }
      const notifications = [notification];
      notificationQueues.set(key, notifications);
      yield* Effect.gen(function* () {
        while (notifications.length > 0) {
          const next = notifications[0]!;
          yield* handler(next);
          notifications.shift();
          if (notifications.length === 0) {
            notificationQueues.delete(key);
            return;
          }
        }
      }).pipe(
        Effect.catchDefect((cause) =>
          handleTermination(() =>
            Effect.succeed(normalizeIncomingError(cause, "read-input-stream")),
          ),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (notificationQueues.get(key) === notifications) notificationQueues.delete(key);
          }),
        ),
        Effect.forkIn(requestHandlerScope, { startImmediately: true }),
      );
    });

    const routeMessage = Effect.fnUntraced(function* (message: unknown) {
      if (Option.isSome(yield* Ref.get(terminationFailure))) return;
      if (isIncomingRequest(message)) return yield* handleRequest(message);
      if (isIncomingNotification(message)) return yield* handleNotification(message);
      if (isIncomingResponse(message)) return yield* handleResponse(message);
      return yield* CodexError.CodexAppServerProtocolParseError.fromUnroutableMessage(message);
    });

    const handleLine = (line: string): Effect.Effect<void, CodexError.CodexAppServerError> => {
      if (line.trim().length === 0) {
        return Effect.void;
      }
      return logProtocol({
        direction: "incoming",
        stage: "raw",
        payload: line,
      }).pipe(
        Effect.flatMap(() => decodeWireMessage(line)),
        Effect.flatMap((decoded) => {
          const logged = logProtocol({
            direction: "incoming",
            stage: "decoded",
            payload: decoded,
          });
          // ACK completion measures wire decoding, not the logger or application callback.
          return isIncomingResponse(decoded)
            ? routeMessage(decoded).pipe(Effect.andThen(logged))
            : logged.pipe(Effect.andThen(routeMessage(decoded)));
        }),
        Effect.tapErrorTag("CodexAppServerProtocolParseError", (error) =>
          logProtocol({
            direction: "incoming",
            stage: "decode_failed",
            payload: {
              operation: error.operation,
              ...(error.method === undefined ? {} : { method: error.method }),
              ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
              ...(error.issueCount === undefined ? {} : { issueCount: error.issueCount }),
              ...(error.issueKinds === undefined ? {} : { issueKinds: error.issueKinds }),
              ...(error.maximumPathDepth === undefined
                ? {}
                : { maximumPathDepth: error.maximumPathDepth }),
            },
          }),
        ),
      );
    };

    yield* options.stdio.stdin.pipe(
      Stream.interruptWhen(Deferred.await(terminationSignal)),
      Stream.decodeText(),
      Stream.runForEach((chunk) =>
        Effect.sync(() => {
          const lines: Array<string> = [];
          let start = 0;
          for (
            let newline = chunk.indexOf("\n");
            newline !== -1;
            newline = chunk.indexOf("\n", start)
          ) {
            remainder.push(chunk.slice(start, newline));
            lines.push(remainder.join("").replace(/\r$/, ""));
            remainder.length = 0;
            start = newline + 1;
          }
          // Keep unfinished lines in fragments so each chunk is scanned only once.
          if (start < chunk.length) {
            remainder.push(chunk.slice(start));
          }
          return lines;
        }).pipe(Effect.flatMap((lines) => Effect.forEach(lines, handleLine, { discard: true }))),
      ),
      Effect.matchEffect({
        onFailure: (error) =>
          handleTermination(() =>
            Effect.succeed(normalizeIncomingError(error, "read-input-stream")),
          ),
        onSuccess: () =>
          Effect.sync(() => {
            const line = remainder.join("");
            remainder.length = 0;
            return line;
          }).pipe(
            Effect.flatMap(handleLine),
            Effect.matchEffect({
              onFailure: (error) => handleTermination(() => Effect.succeed(error)),
              onSuccess: () =>
                handleTermination(
                  () =>
                    options.terminationError ??
                    Effect.succeed(new CodexError.CodexAppServerInputStreamEndedError({})),
                ),
            }),
          ),
      }),
      Effect.forkScoped,
    );

    yield* Stream.fromQueue(outgoing).pipe(
      Stream.flatMap(({ encoded, written }) =>
        Stream.make(encoded).pipe(
          Stream.concat(Stream.fromEffect(Deferred.succeed(written, undefined)).pipe(Stream.drain)),
        ),
      ),
      Stream.run(options.stdio.stdout()),
      Effect.forkScoped,
    );

    const request = (method: string, payload?: unknown) =>
      Effect.gen(function* () {
        const requestId = yield* Ref.modify(
          nextRequestId,
          (current) => [current, current + 1] as const,
        );
        const deferred = yield* Deferred.make<unknown, CodexError.CodexAppServerError>();
        yield* Ref.update(pending, (current) =>
          new Map(current).set(String(requestId), { deferred, method }),
        );
        // Bound dispatch separately; the ACK budget starts when the request is written.
        return yield* offerOutgoing({
          id: requestId,
          method,
          ...(payload !== undefined ? { params: payload } : {}),
        }).pipe(
          Effect.timeoutOrElse({
            duration: requestTimeoutMs,
            orElse: () =>
              Effect.fail(
                new CodexError.CodexAppServerRequestTimeoutError({
                  method,
                  requestId: String(requestId),
                  timeoutMs: requestTimeoutMs,
                }),
              ),
          }),
          Effect.andThen(
            Deferred.await(deferred).pipe(
              Effect.timeoutOrElse({
                duration: requestTimeoutMs,
                orElse: () =>
                  Effect.fail(
                    new CodexError.CodexAppServerRequestTimeoutError({
                      method,
                      requestId: String(requestId),
                      timeoutMs: requestTimeoutMs,
                    }),
                  ),
              }),
            ),
          ),
          // A decoded response itself proves the peer consumed the write. Some
          // stdio sinks (including replay peers) keep processing after replying.
          Effect.raceFirst(Deferred.await(deferred)),
          Effect.ensuring(removePending(String(requestId))),
        );
      });

    const notify = (method: string, payload?: unknown) =>
      offerOutgoing({
        method,
        ...(payload !== undefined ? { params: payload } : {}),
      });

    return {
      incomingNotifications: Stream.fromQueue(incomingNotifications),
      incomingRequests: Stream.fromQueue(incomingRequests),
      request,
      notify,
      respond,
      respondError,
    } satisfies CodexAppServerPatchedProtocol;
  },
);
