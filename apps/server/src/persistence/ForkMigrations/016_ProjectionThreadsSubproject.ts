import { initializeMetadata } from "../../forkThreads/MetadataStore.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";
/** Keep the published ledger identity while moving modes into V2 fork metadata. */
export default Effect.gen(function* () {
  yield* initializeMetadata(yield* SqlClient.SqlClient);
});
