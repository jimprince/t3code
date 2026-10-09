import { runRepairDelegatedWorkers } from "../src/cli/repairDelegatedWorkers.ts";

await runRepairDelegatedWorkers(process.argv.slice(2));
