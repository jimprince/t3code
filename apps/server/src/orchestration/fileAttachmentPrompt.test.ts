import { describe, expect, it } from "vite-plus/test";
import type { ChatFileHandoffAttachment } from "@t3tools/contracts";

import {
  appendFileAttachmentPromptLines,
  formatFileAttachmentSize,
} from "./fileAttachmentPrompt.ts";

function fileAttachment(
  overrides: Partial<ChatFileHandoffAttachment> = {},
): ChatFileHandoffAttachment {
  return {
    type: "file",
    id: "thread-1-abc",
    name: "report.pdf",
    mimeType: "application/pdf",
    sizeBytes: 1258291,
    path: "/tmp/t3-file-attachments/thread-1-abc/report.pdf",
    ...overrides,
  };
}

describe("formatFileAttachmentSize", () => {
  it("formats bytes, kilobytes, and megabytes", () => {
    expect(formatFileAttachmentSize(512)).toBe("512 B");
    expect(formatFileAttachmentSize(2048)).toBe("2.0 KB");
    expect(formatFileAttachmentSize(1258291)).toBe("1.2 MB");
  });
});

describe("appendFileAttachmentPromptLines", () => {
  it("returns the text unchanged without file attachments", () => {
    expect(appendFileAttachmentPromptLines("hello", undefined)).toBe("hello");
    expect(appendFileAttachmentPromptLines("hello", [])).toBe("hello");
  });

  it("appends one labelled path line per attachment", () => {
    const result = appendFileAttachmentPromptLines("Review this file.", [
      fileAttachment(),
      fileAttachment({
        id: "thread-1-def",
        name: "data.csv",
        mimeType: "text/csv",
        sizeBytes: 2048,
        path: "/tmp/t3-file-attachments/thread-1-def/data.csv",
      }),
    ]);

    // REGRESSION: the provider input must contain the absolute path the
    // thread can read; without these lines the agent never learns the file
    // exists.
    expect(result).toBe(
      "Review this file.\n\n" +
        "[Attached file: /tmp/t3-file-attachments/thread-1-abc/report.pdf (application/pdf, 1.2 MB)]\n" +
        "[Attached file: /tmp/t3-file-attachments/thread-1-def/data.csv (text/csv, 2.0 KB)]",
    );
  });

  it("emits only the attachment block for empty text", () => {
    const result = appendFileAttachmentPromptLines("", [fileAttachment()]);
    expect(result).toBe(
      "[Attached file: /tmp/t3-file-attachments/thread-1-abc/report.pdf (application/pdf, 1.2 MB)]",
    );
  });

  it("composes after transferred-thread context without disturbing it", () => {
    const transferredInput = "## Transferred history\n- earlier message\n\nCurrent request: go";
    const result = appendFileAttachmentPromptLines(transferredInput, [fileAttachment()]);
    expect(result.startsWith(transferredInput)).toBe(true);
    expect(result).toContain("[Attached file: ");
  });
});
