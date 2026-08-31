import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { type ComposerFileAttachment, useComposerDraftStore } from "./composerDraftStore";

const TEST_ENVIRONMENT_ID = EnvironmentId.make("environment-local");

function resetComposerDraftStore() {
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    stickyModelSelectionByProvider: {},
    stickyActiveProvider: null,
  });
}

function threadKeyFor(threadId: ThreadId, environmentId: EnvironmentId): string {
  return scopedThreadKey(scopeThreadRef(environmentId, threadId));
}

function draftFor(threadId: ThreadId, environmentId: EnvironmentId) {
  const store = useComposerDraftStore.getState().draftsByThreadKey;
  return store[threadKeyFor(threadId, environmentId)] ?? undefined;
}

describe("composerDraftStore file attachments", () => {
  const threadId = ThreadId.make("thread-files");
  const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId);

  beforeEach(() => {
    resetComposerDraftStore();
  });

  function makeFile(overrides: Partial<ComposerFileAttachment> = {}): ComposerFileAttachment {
    return {
      type: "file",
      id: "file-1",
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 2048,
      file: new File(["payload"], "report.pdf", { type: "application/pdf" }),
      ...overrides,
    };
  }

  it("adds, dedupes, and removes file attachments", () => {
    const store = useComposerDraftStore.getState();
    store.addFiles(threadRef, [makeFile(), makeFile({ id: "file-dup" })]);
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.files.map((file) => file.id)).toEqual([
      "file-1",
    ]);

    useComposerDraftStore
      .getState()
      .addFiles(threadRef, [makeFile({ id: "file-2", name: "data.csv", mimeType: "text/csv" })]);
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.files.map((file) => file.id)).toEqual([
      "file-1",
      "file-2",
    ]);

    useComposerDraftStore.getState().removeFile(threadRef, "file-1");
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.files.map((file) => file.id)).toEqual([
      "file-2",
    ]);
  });

  it("excludes file attachments from persisted drafts", () => {
    // Prompt text anchors the draft in persistence; a files-only draft
    // persists nothing at all (also correct).
    useComposerDraftStore.getState().setPrompt(threadRef, "keep this draft");
    useComposerDraftStore.getState().addFiles(threadRef, [makeFile()]);

    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        partialize: (state: ReturnType<typeof useComposerDraftStore.getState>) => unknown;
      };
    };
    const persistedState = persistApi.getOptions().partialize(useComposerDraftStore.getState()) as {
      draftsByThreadKey?: Record<string, Record<string, unknown>>;
    };

    // REGRESSION: file payloads must never reach localStorage — a 32 MiB
    // base64 body would blow the quota and evict image persistence.
    const persistedDraft =
      persistedState.draftsByThreadKey?.[threadKeyFor(threadId, TEST_ENVIRONMENT_ID)];
    expect(persistedDraft).toBeDefined();
    expect(persistedDraft?.files).toBeUndefined();
  });

  it("clears file attachments with clearComposerPromptAndImages", () => {
    useComposerDraftStore.getState().addFiles(threadRef, [makeFile()]);
    useComposerDraftStore.getState().clearComposerPromptAndImages(threadRef);
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.files ?? []).toEqual([]);
  });
});
