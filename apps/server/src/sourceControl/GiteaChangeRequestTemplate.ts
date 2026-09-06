import * as GitHubChangeRequestTemplate from "@t3tools/source-control-github/server/gitHubChangeRequestTemplate";

/** Gitea conventions share the committed-blob reader and its bounded/symlink-safe behavior. */
export const detectPrTemplate = (
  ...[cwd, treeish, executeGit]: Parameters<typeof GitHubChangeRequestTemplate.detect>
) =>
  GitHubChangeRequestTemplate.detect(cwd, treeish, executeGit, {
    paths: [
      ".gitea/pull_request_template.md",
      ".gitea/PULL_REQUEST_TEMPLATE.md",
      ".github/pull_request_template.md",
      ".github/PULL_REQUEST_TEMPLATE.md",
      "pull_request_template.md",
      "PULL_REQUEST_TEMPLATE.md",
      "docs/pull_request_template.md",
      "docs/PULL_REQUEST_TEMPLATE.md",
    ],
    directories: [
      ".gitea/PULL_REQUEST_TEMPLATE",
      ".github/PULL_REQUEST_TEMPLATE",
      "PULL_REQUEST_TEMPLATE",
      "docs/PULL_REQUEST_TEMPLATE",
    ],
  });
