import { readGiteaTokenStdin } from "../../src/giteaTokenCore.ts";
// Synthetic pipe fixture: exercise the production stdin decoder without a live server.
try {
  await readGiteaTokenStdin(process.stdin, {}, 200);
  process.stdout.write(
    JSON.stringify({ instanceId: "fake", tokenSet: true, storedMatchesInput: true }) + "\n",
  );
} catch {
  process.stderr.write("Gitea token input rejected.\n");
  process.exitCode = 2;
}
