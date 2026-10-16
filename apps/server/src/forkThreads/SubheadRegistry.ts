import {
  NamedAgentError,
  Subhead,
  SubheadTemplate,
  type Subhead as Entry,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { withOwnershipLock } from "./NamedAgentPolicy.ts";

const isNamedAgentError = Schema.is(NamedAgentError);
const decodeTemplate = Schema.decodeUnknownEffect(SubheadTemplate);

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Subhead));
const encode = Schema.encodeSync(Schema.fromJsonString(Subhead));
const fail = (message: string) => new NamedAgentError({ message });
const storageError = (cause: unknown) => (isNamedAgentError(cause) ? cause : fail(String(cause)));

/**
 * Who may edit or change the state of a subhead: its creating principal, or a session holding the
 * administrative scope (the desktop app). A row from before creators were recorded belongs to
 * "system". Clients use the same rule to disable buttons that would be refused.
 */
export const mayChangeSubhead = (
  entry: { readonly createdBy?: string | undefined },
  actor: string,
  administrator: boolean,
) => administrator || actor === (entry.createdBy ?? "system");

/** Registry/revision writes share standing-agent ownership serialization and one SQL transaction. */
export const makeSubheadRegistry = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const list = (all: boolean) =>
    sql<{
      payload: string;
    }>`SELECT payload FROM named_virtual_agents WHERE ${all ? 1 : 0}=1 OR json_extract(payload,'$.retiredAt') IS NULL ORDER BY name`.pipe(
      Effect.flatMap((rows) => Effect.forEach(rows, (row) => decode(row.payload))),
      Effect.mapError(storageError),
    );
  const get = (name: string) =>
    sql<{ payload: string }>`SELECT payload FROM named_virtual_agents WHERE name=${name}`.pipe(
      Effect.flatMap((rows) =>
        rows[0]
          ? decode(rows[0].payload).pipe(Effect.mapError(storageError))
          : Effect.fail(fail(`No subhead '${name}'.`)),
      ),
      Effect.mapError(storageError),
    );
  const write = (value: Entry) =>
    Effect.gen(function* () {
      const payload = encode(value);
      yield* sql`INSERT INTO named_virtual_agents (id,name,project_id,version,payload) VALUES (${value.id},${value.name},${value.projectId},${value.version},${payload}) ON CONFLICT(id) DO UPDATE SET version=excluded.version,payload=excluded.payload`;
      yield* sql`INSERT INTO named_virtual_agent_revisions (agent_id,version,payload) VALUES (${value.id},${value.version},${payload}) ON CONFLICT DO NOTHING`;
      return value;
    });
  const locked = <A, E>(effect: Effect.Effect<A, E>) =>
    withOwnershipLock(sql, sql.withTransaction(effect)).pipe(Effect.mapError(storageError));
  const create = (input: unknown, actor = "system") =>
    locked(
      Effect.gen(function* () {
        const template = yield* decodeTemplate(input, {
          onExcessProperty: "error",
        });
        const collision =
          yield* sql`SELECT id FROM named_virtual_agents WHERE name=${template.name} UNION ALL SELECT project_id AS id FROM projection_projects WHERE deleted_at IS NULL AND json_extract(permanent_agent_json,'$.name')=${template.name}`;
        if (collision.length) return yield* fail(`Named agent '${template.name}' already exists.`);
        const at = yield* now;
        return yield* write({
          ...template,
          id: yield* crypto.randomUUIDv4,
          kind: "virtual",
          version: 1,
          enabled: false,
          retiredAt: null,
          createdAt: at,
          updatedAt: at,
          createdBy: actor,
          updatedBy: actor,
        });
      }),
    );
  const edit = (
    name: string,
    input: unknown,
    expectedVersion: number,
    actor = "system",
    administrator = false,
  ) =>
    locked(
      Effect.gen(function* () {
        const previous = yield* get(name);
        if (!mayChangeSubhead(previous, actor, administrator))
          return yield* fail(
            "Only the creating principal or an administrator may edit this subhead.",
          );
        if (previous.version !== expectedVersion)
          return yield* fail(
            `Template version conflict: expected ${expectedVersion}, current ${previous.version}.`,
          );
        if (previous.retiredAt !== null) return yield* fail("Subhead is retired.");
        const template = yield* decodeTemplate(input, {
          onExcessProperty: "error",
        });
        if (template.name !== previous.name) return yield* fail("A subhead name is immutable.");
        if (
          template.projectId !== previous.projectId ||
          template.ownerThreadId !== previous.ownerThreadId
        )
          return yield* fail("A subhead projectId and ownerThreadId are immutable.");
        return yield* write({
          ...previous,
          ...template,
          version: previous.version + 1,
          updatedAt: yield* now,
          updatedBy: actor,
        });
      }),
    );
  const setState = (
    name: string,
    state: "enable" | "disable" | "retire",
    actor = "system",
    administrator = false,
  ) =>
    locked(
      Effect.gen(function* () {
        const previous = yield* get(name);
        if (!mayChangeSubhead(previous, actor, administrator))
          return yield* fail(
            "Only the creating principal or an administrator may change this subhead.",
          );
        if (previous.retiredAt !== null && state === "enable")
          return yield* fail("Subhead is retired; its name remains reserved.");
        const at = yield* now;
        const next = {
          ...previous,
          enabled: state === "enable",
          retiredAt: state === "retire" ? (previous.retiredAt ?? at) : previous.retiredAt,
          updatedAt: at,
          updatedBy: actor,
        };
        yield* sql`UPDATE named_virtual_agents SET payload=${encode(next)} WHERE id=${next.id}`;
        return next;
      }),
    );
  const revision = (id: string, version: number) =>
    sql<{
      payload: string;
    }>`SELECT payload FROM named_virtual_agent_revisions WHERE agent_id=${id} AND version=${version}`.pipe(
      Effect.flatMap((rows) =>
        rows[0]
          ? decode(rows[0].payload).pipe(Effect.mapError(storageError))
          : Effect.fail(fail("Template revision not found.")),
      ),
      Effect.mapError(storageError),
    );
  return { list, get, create, edit, setState, revision };
});
