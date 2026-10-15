import { parseDecisionComment } from "@t3tools/client-runtime/decision-comment";

/** The four parts agents supply for a review, test or decision. */
export function decisionReadyParts(title: string, body: string | null | undefined) {
  const text = (body ?? "").replace(/<!--[\s\S]*?-->/g, "").replace(/^\s*Part of #\d+\s*$/gm, "");
  const judging = /^[ \t]*What you are judging and where:[ \t]*(.*)$/im.exec(text);
  const parsed = parseDecisionComment(
    text.replace(/^[ \t]*What you are judging and where:.*$/gim, ""),
  );
  const normalize = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  const explanation = normalize(parsed.detail).replace(normalize(title), "").trim();
  const asksNothingYet = !explanation || explanation.split(/\s+/).length < 2;
  return {
    ...parsed,
    summary: asksNothingYet ? "" : parsed.summary,
    judgingWhere: judging?.[1]?.trim() || null,
    recommended: parsed.recommendation,
    asksNothingYet,
  };
}

/** Ready writes fail only for missing substance; other contract gaps stay actionable warnings. */
export function validateDecisionReady(title: string, body: string) {
  const parts = decisionReadyParts(title, body);
  const warnings = [
    ...(!parts.judgingWhere
      ? [
          'Add "What you are judging and where:" with what Brad should judge and a screenshot, link, or Dev app Update location.',
        ]
      : []),
    ...(!parts.recommended ? ['Add "Recommended: Option A" naming the answer you recommend.'] : []),
    ...(parts.options.length < 2
      ? [
          'Add 2 to 5 "Option A:" / "Option B:" choices, or --option labels; the dashboard will use defaults meanwhile.',
        ]
      : []),
  ];
  return {
    error: parts.asksNothingYet
      ? "Ready needs a plain sentence explaining what changed or what you propose, beyond repeating the title. Add that sentence, then a 'What you are judging and where:' line, Option A:/Option B: choices and a Recommended: line."
      : null,
    warnings,
  };
}
