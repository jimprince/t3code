import Constants from "expo-constants";
import * as Linking from "expo-linking";
import { useEffect } from "react";

import type { EnvironmentId } from "@t3tools/contracts";

import { recordMobileDiagnostic } from "../../lib/mobileDiagnostics";
import {
  disconnectAllEnvironments,
  disconnectEnvironment,
  pairRemoteEnvironment,
} from "../../state/use-remote-environment-registry";
import { writeMobileDebugSnapshot } from "./getMobileDebugSnapshot";
import { parseMobileDebugCommand, type MobileDebugCommand } from "./mobileDebugCommands";

const MOBILE_DEBUG_COMMAND_FILE = "t3-mobile-debug-command.json";

function isMobileDebugControlEnabled(): boolean {
  const extra = Constants.expoConfig?.extra as
    | { readonly enableMobileDebugControl?: boolean; readonly appVariant?: string }
    | undefined;
  return Boolean((typeof __DEV__ !== "undefined" && __DEV__) || extra?.enableMobileDebugControl);
}

async function executeMobileDebugCommand(command: MobileDebugCommand): Promise<void> {
  switch (command.type) {
    case "pair": {
      const connection = await pairRemoteEnvironment({
        pairingUrl: command.pairingUrl,
        replaceExisting: command.replaceExisting,
      });
      recordMobileDiagnostic({
        level: "info",
        tag: "mobile.debug.command.pair.success",
        data: {
          environmentId: connection.environmentId,
          httpBaseUrl: connection.httpBaseUrl,
          replaceExisting: command.replaceExisting,
        },
      });
      return;
    }
    case "clear-connections":
      await disconnectAllEnvironments({ removeSaved: true });
      recordMobileDiagnostic({
        level: "info",
        tag: "mobile.debug.command.clearConnections.success",
      });
      return;
    case "dump": {
      const { uri, snapshot } = await writeMobileDebugSnapshot();
      recordMobileDiagnostic({
        level: "info",
        tag: "mobile.debug.command.dump.success",
        data: {
          uri,
          savedConnectionCount: snapshot.savedConnections.length,
          runtimeCount: snapshot.runtime.length,
        },
      });
      return;
    }
    case "disconnect":
      if (command.all) {
        await disconnectAllEnvironments();
      } else if (command.environmentId) {
        await disconnectEnvironment(command.environmentId as EnvironmentId);
      } else {
        throw new Error("Debug disconnect command needs all=1 or environmentId.");
      }
      recordMobileDiagnostic({
        level: "info",
        tag: "mobile.debug.command.disconnect.success",
        data: { all: command.all, environmentId: command.environmentId },
      });
      return;
  }
}

async function handleMobileDebugUrl(rawUrl: string): Promise<void> {
  let command: MobileDebugCommand | null;
  try {
    command = parseMobileDebugCommand(rawUrl);
  } catch (error) {
    recordMobileDiagnostic({
      level: "error",
      tag: "mobile.debug.command.parse.error",
      message: error instanceof Error ? error.message : "Failed to parse debug command.",
      data: { url: rawUrl },
    });
    return;
  }

  if (!command) {
    return;
  }

  if (!isMobileDebugControlEnabled()) {
    recordMobileDiagnostic({
      level: "warn",
      tag: "mobile.debug.command.rejected",
      message: "Mobile debug command rejected because debug control is disabled.",
      data: { command: command.type },
    });
    return;
  }

  recordMobileDiagnostic({
    level: "info",
    tag: "mobile.debug.command.start",
    data: {
      command: command.type,
      ...(command.type === "pair"
        ? { pairingUrl: command.pairingUrl, replaceExisting: command.replaceExisting }
        : {}),
    },
  });

  try {
    await executeMobileDebugCommand(command);
  } catch (error) {
    recordMobileDiagnostic({
      level: "error",
      tag: "mobile.debug.command.error",
      message: error instanceof Error ? error.message : "Debug command failed.",
      data: { command: command.type },
    });
  }
}

export function useMobileDebugCommands(): void {
  useEffect(() => {
    let active = true;
    let lastCommandId: string | null = null;

    recordMobileDiagnostic({
      level: "info",
      tag: "mobile.debug.commands.installed",
      data: { enabled: isMobileDebugControlEnabled() },
    });

    void Linking.getInitialURL().then((url) => {
      if (active && url) {
        void handleMobileDebugUrl(url);
      }
    });

    const subscription = Linking.addEventListener("url", (event) => {
      void handleMobileDebugUrl(event.url);
    });

    const pollCommandFile = async () => {
      try {
        const { File, Paths } = await import("expo-file-system");
        const file = new File(Paths.document, MOBILE_DEBUG_COMMAND_FILE);
        if (!file.exists) {
          return;
        }
        const parsed = JSON.parse(await file.text()) as {
          readonly id?: string;
          readonly url?: string;
        };
        const id = parsed.id?.trim() ?? "";
        const url = parsed.url?.trim() ?? "";
        if (!id || !url || id === lastCommandId) {
          return;
        }
        lastCommandId = id;
        recordMobileDiagnostic({
          level: "info",
          tag: "mobile.debug.command.file.received",
          data: { id, url },
        });
        await handleMobileDebugUrl(url);
      } catch (error) {
        recordMobileDiagnostic({
          level: "warn",
          tag: "mobile.debug.command.file.error",
          message: error instanceof Error ? error.message : "Failed to read debug command file.",
        });
      }
    };

    const interval = setInterval(() => {
      if (active && isMobileDebugControlEnabled()) {
        void pollCommandFile();
      }
    }, 1000);

    return () => {
      active = false;
      clearInterval(interval);
      subscription.remove();
    };
  }, []);
}
