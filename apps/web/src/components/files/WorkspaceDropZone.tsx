import { uploadWorkspaceFiles } from "./fileUploads";
import { type EnvironmentId } from "@t3tools/contracts";
import { Upload } from "lucide";
import { MorphIcon } from "~/components/MorphIcon";
import {
  type DragEvent as ReactDragEvent,
  type ReactNode,
  type RefObject,
  useRef,
  useState,
} from "react";
import { readFileAsDataUrl } from "~/components/ChatView.logic";
import { toastManager } from "~/components/ui/toast";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
export function WorkspaceDropZone({
  environmentId,
  cwd,
  projectName,
  onUploaded,
  panelRef,
  children,
}: {
  environmentId: EnvironmentId;
  cwd: string;
  projectName: string;
  onUploaded: () => void;
  panelRef: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  const uploadFile = useAtomCommand(projectEnvironment.uploadFile);
  const [isDragOverPanel, setIsDragOverPanel] = useState(false);
  const uploadDragDepthRef = useRef(0);

  const handleDroppedFiles = async (files: File[], containsDirectory: boolean) => {
    const uploaded = await uploadWorkspaceFiles({
      files,
      containsDirectory,
      environmentId,
      cwd,
      readFile: readFileAsDataUrl,
      uploadFile,
      refresh: onUploaded,
      reportFailure: (description) =>
        toastManager.add({ type: "error", title: "Upload failed", description }),
    });
    if (uploaded.length > 0) {
      toastManager.add({
        type: "success",
        title: `Uploaded to ${projectName}`,
        description: uploaded.join(", "),
      });
    }
  };

  const isFileDrag = (event: ReactDragEvent<HTMLDivElement>) =>
    event.dataTransfer.types.includes("Files");

  const onUploadDragEnter = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    uploadDragDepthRef.current += 1;
    setIsDragOverPanel(true);
  };
  const onUploadDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsDragOverPanel(true);
  };
  const onUploadDragLeave = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    uploadDragDepthRef.current = Math.max(0, uploadDragDepthRef.current - 1);
    if (uploadDragDepthRef.current === 0) {
      setIsDragOverPanel(false);
    }
  };
  const onUploadDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    uploadDragDepthRef.current = 0;
    setIsDragOverPanel(false);
    const items = Array.from(event.dataTransfer.items);
    let containsDirectory = false;
    const files: File[] = [];
    if (items.length > 0) {
      for (const item of items) {
        if (item.kind !== "file") continue;
        if (item.webkitGetAsEntry()?.isDirectory) {
          containsDirectory = true;
          continue;
        }
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    } else {
      files.push(...Array.from(event.dataTransfer.files));
    }
    void handleDroppedFiles(files, containsDirectory);
  };
  return (
    <div
      ref={panelRef}
      className="relative flex min-h-0 flex-1 flex-col bg-background"
      data-file-browser-panel={`${environmentId}:${cwd}`}
      onDragEnter={onUploadDragEnter}
      onDragOver={onUploadDragOver}
      onDragLeave={onUploadDragLeave}
      onDrop={onUploadDrop}
    >
      {children}
      {isDragOverPanel ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center border-2 border-dashed border-primary/60 bg-background/80">
          <div className="flex items-center gap-2 text-xs font-medium text-foreground">
            <MorphIcon icon={Upload} size={16} />
            Drop files to upload to {projectName}
          </div>
        </div>
      ) : null}
    </div>
  );
}
