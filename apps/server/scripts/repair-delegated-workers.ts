/* oxlint-disable t3code/no-global-process-runtime -- Standalone offline operator entry. */
import { runRepairDelegatedWorkers } from "../src/cli/repairDelegatedWorkers.ts";

await runRepairDelegatedWorkers(process.argv.slice(2));
