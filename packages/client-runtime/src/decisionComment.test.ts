import { describe, expect, it } from "vite-plus/test";

import {
  answerSentences,
  isNotAnswer,
  parseDecisionComment,
  readyComment,
} from "./decisionComment.ts";

describe("parseDecisionComment", () => {
  it("reads the options, the recommendation and the rest of a ready comment", () => {
    const parsed = parseDecisionComment(
      "Ready for your call.\nOption A: Rework the jaw now\nOption B: Wait for the scale test\nRecommended: A",
    );
    expect(parsed.options.map((option) => option.label)).toEqual(["Option A", "Option B"]);
    expect(parsed.recommendation).toBe("A");
    expect(parsed.detail).toBe("Ready for your call.");
  });

  it("is a plain approval when fewer than two options are listed", () => {
    expect(parseDecisionComment("Plan is ready.\nOption A: only one").options).toEqual([]);
  });

  it("reads the latest comment of an issue", () => {
    expect(
      readyComment({
        latestComment: { author: "a", body: "Option A: x\nOption B: y", createdAt: "z" },
      }).options,
    ).toHaveLength(2);
    expect(readyComment({}).options).toEqual([]);
  });
});

describe("answer helpers", () => {
  it("cuts an answer to whole sentences", () => {
    expect(answerSentences("**Yes.** It works! And more. Even more.", 2)).toBe("Yes. It works!");
  });

  it("never treats a progress note, curator note or Brad's follow-up as an answer", () => {
    expect(isNotAnswer("Progress: started")).toBe(true);
    expect(isNotAnswer("<!-- x -->curator: moved")).toBe(true);
    expect(isNotAnswer("The set is 27 mm.")).toBe(false);
  });
});

it.each([
  "Built in fork.9). Ready to test.",
  '\"No change.\" turns now stay quiet. Ready to test.',
  "Released v0.0.31. Ready to test.",
  "See https://github.com/jimprince/t3code/pull/85 for proof. Ready to test.",
])("keeps punctuation inside a sentence: %s", (body) => {
  expect(answerSentences(body, 2)).toBe(body);
});

it.each([
  "Brad chose: A",
  "Brad answered: works",
  "Brad sent this back: fix it",
  "Not yet: wait",
  "Approved by Brad",
  "Approved and closed by Brad",
  "Passed: works",
  "Failed: broken",
  "Got it: acknowledged",
  "Release-bot: shipped",
  "Release: shipped",
  "PR bot: merged",
  "Brad approved and merged PR 4: https://example.test/pull/4",
  "Filed by mistake. Withdrawn by Brad.",
])("skips server-written summaries: %s", (body) => expect(isNotAnswer(body)).toBe(true));

it("preserves the real #354 body", () => {
  const body =
    '## Brad\'s words\n\n> Brad approved \'hook yes\' 09:54 Calgary Oct 15 (via Operations). After 3 unauthorized copies of the live statev2.sqlite (Oct 10 x2, Oct 15): Claude PreToolUse Bash hook in every Claude home on dev-vm and the Mac, plus a matching Codex exec rule, refusing the DB as a copy source (cp, rsync, install, dd, tar, sqlite3 .backup/VACUUM INTO, shutil); allowlist Deployment\'s verified backup runner; tests before enabling; one audit after.\n\nRequested in **T3 Orchestrator**. Kind: task. Settled only by the requester, from the project page.\n\n<!-- t3-request {"threadId":"0db3169b-9f2e-4bf8-8f5e-c2b26be1c75e","rootThreadId":"0db3169b-9f2e-4bf8-8f5e-c2b26be1c75e","messageId":"t3-statev2-copy-guard-20261015","item":0} -->\n';
  const parsed = parseDecisionComment(body);
  expect(parsed.summary).not.toMatch(/\[[ xX]\]/);
});

it("preserves the real #338 body", () => {
  const body =
    'Part of #335\n\n<!-- t3-request {"threadId":"c28769b9-87c4-4636-9f19-0783fdaab267","rootThreadId":"c7da3448-db80-4c1a-8454-3a6859305370","messageId":"handoff:5c077e94-a0c8-44a6-9678-2fd2a979c6f4:message","item":3} -->\n\n## Product migration steps\n\n- [x] Align fork iOS app, widget and share-extension identities\n- [x] Implement phone project nesting and navigation\n- [x] Build the mobile fork patch stack\n- [x] Review and validate the mobile candidate\n- [x] Hand the candidate to the release head and attempt the iOS dispatch\n- [ ] Resolve share-extension signing credentials with Brad\n- [ ] Rerun the iOS build and validate Apple signing and widgets\n- [ ] Upload to TestFlight and verify installation on Brad\u2019s iPhone\n\nRelated existing scope (preserved): #10, #320.\n\nOriginal source link: https://github.com/jimprince/t3code/pull/85\n\nSource: Product briefing row `phone-nesting`; recorded aggregate progress, not new release or user acceptance.\n';
  const parsed = parseDecisionComment(body);
  expect(parsed.summary).not.toMatch(/\[[ xX]\]/);
  expect(parsed.summary).toContain("https://github.com/jimprince/t3code/pull/85");
});

it("preserves the real #345 body", () => {
  const body =
    'Part of #336\n\n<!-- t3-request {"threadId":"c28769b9-87c4-4636-9f19-0783fdaab267","rootThreadId":"c7da3448-db80-4c1a-8454-3a6859305370","messageId":"handoff:5c077e94-a0c8-44a6-9678-2fd2a979c6f4:message","item":12} -->\n\n## Product migration steps\n\n- [x] Trace completion and request-publication surfaces\n- [x] Implement a shared exact no-change reply predicate\n- [x] Suppress redundant request answers and completion notifications\n- [x] Suppress delegated result previews and worker summaries\n- [x] Verify positive controls and mutation regressions\n- [x] Integrate and obtain fork.17 dev-vm installation acceptance\n\nOriginal source link: https://github.com/jimprince/t3code/pull/91\n\nSource: Product briefing row `no-change-suppress`; recorded aggregate progress, not new release or user acceptance.\n';
  const parsed = parseDecisionComment(body);
  expect(parsed.summary).not.toMatch(/\[[ xX]\]/);
});

it("preserves the real #345 ready reply", () => {
  const body =
    "Turns that end 'No change.' no longer create a visible result or a desk request.\n\nWhat you are judging and where: Nothing to click: tell me if you still see 'No change.' items and where.\n\nOption A: Passed\nOption B: Failed (type what is wrong)\nRecommended: Passed";
  expect(parseDecisionComment(body).summary).toContain(
    "Turns that end 'No change.' no longer create a visible result or a desk request.",
  );
});
it("preserves the real #354 ready reply", () => {
  const body =
    "Done: agents on dev-vm and the Mac can no longer copy the live T3 database through their command tool. Claude and Codex both refuse any copy of statev2.sqlite and point to reading it in place, read-only. Tested: copies refused, read-only reads allowed. Limits: a text check, so MCP tools and sessions started before today are not covered. To judge: nothing visible in your app; approve to close, or reply with what to change.";
  expect(parseDecisionComment(body).summary).toContain(
    "Done: agents on dev-vm and the Mac can no longer copy the live T3 database through their command tool. Claude and Codex both refuse any copy of statev2.sqlite and point to reading it in place, read-only.",
  );
});
