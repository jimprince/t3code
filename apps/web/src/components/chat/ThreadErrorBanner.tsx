import { memo } from "react";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { CircleAlertIcon, XIcon } from "lucide-react";

export const ThreadErrorBanner = memo(function ThreadErrorBanner({
  error,
  onResume,
  onDismiss,
}: {
  error: string | null;
  onResume?: () => void;
  onDismiss?: () => void;
}) {
  if (!error) return null;
  return (
    <div className="mx-auto max-w-3xl pt-3">
      <Alert variant="error">
        <CircleAlertIcon />
        <AlertDescription className="line-clamp-3" title={error}>
          {error}
        </AlertDescription>
        {(onDismiss || onResume) && (
          <AlertAction className="flex items-center gap-3">
            {onResume && (
              <button
                type="button"
                className="text-sm font-medium text-destructive/80 hover:text-destructive hover:underline"
                onClick={onResume}
              >
                Resume
              </button>
            )}
            {onDismiss && (
              <button
                type="button"
                aria-label="Dismiss error"
                className="inline-flex size-6 items-center justify-center rounded-md text-destructive/60 transition-colors hover:text-destructive"
                onClick={onDismiss}
              >
                <XIcon className="size-3.5" />
              </button>
            )}
          </AlertAction>
        )}
      </Alert>
    </div>
  );
});
