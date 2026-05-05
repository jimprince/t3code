# T3 Code Mobile (fork overlay) — CLI helper targets.
#
# Mirrors the ergonomics of /Users/brad/Programming/t3code-ios/Makefile so the
# fork-mobile flow feels familiar. Fork identity (Apple team, bundle id base,
# scheme base) lives in apps/mobile/fork.config.json and is consumed by
# app.config.ts at build time.
#
# Run targets from apps/mobile/. From the repo root, prefix with `cd apps/mobile`.

SHELL := /bin/bash

FORK_CONFIG := fork.config.json
APPLE_TEAM_ID := $(shell jq -r '.appleTeamId // empty' $(FORK_CONFIG) 2>/dev/null)
IOS_BUNDLE_ID_BASE := $(shell jq -r '.iosBundleIdBase // empty' $(FORK_CONFIG) 2>/dev/null)
SCHEME_BASE := $(shell jq -r '.schemeBase // empty' $(FORK_CONFIG) 2>/dev/null)
EAS_PROJECT_ID := $(shell jq -r '.easProjectId // empty' $(FORK_CONFIG) 2>/dev/null)
EAS_OWNER := $(shell jq -r '.easOwner // empty' $(FORK_CONFIG) 2>/dev/null)

# Optional: pin a specific connected iPhone UDID for `expo run:ios --device`.
# Pass via env or override on the command line:
#   make ios-device-dev DEVICE_UDID=00008140-001C71D93C2A801C
DEVICE_UDID ?=
EXPO_DEVICE_FLAG := $(if $(DEVICE_UDID),--device $(DEVICE_UDID),)

.DEFAULT_GOAL := help

.PHONY: help fork-config-show
help:
	@echo "T3 Code Mobile (fork overlay) — make targets:"
	@echo
	@echo "  Local builds (expo prebuild + run:ios):"
	@echo "    make ios-sim-dev           Build dev variant for iOS simulator"
	@echo "    make ios-sim-preview       Build preview variant for iOS simulator"
	@echo "    make ios-sim-prod          Build production variant for iOS simulator"
	@echo "    make ios-device-dev        Build dev variant for connected iPhone"
	@echo "    make ios-device-preview    Build preview variant for connected iPhone"
	@echo "    make ios-device-prod       Build production variant for connected iPhone"
	@echo "    Pass DEVICE_UDID=<udid> to target a specific device."
	@echo
	@echo "  Cloud builds (EAS):"
	@echo "    make eas-ios-dev           eas build --profile development -p ios"
	@echo "    make eas-ios-preview       eas build --profile preview -p ios"
	@echo "    make eas-ios-prod          eas build --profile production -p ios"
	@echo "    make eas-ios-dev-no-wait   Start development iOS build and return immediately"
	@echo "    make eas-ios-update-dev    Publish iOS OTA update to development channel"
	@echo "    make eas-ios-build-list    List recent iOS builds"
	@echo "    make eas-ios-update-list   List recent development updates"
	@echo
	@echo "  Inspect:"
	@echo "    make config-dev            APP_VARIANT=development expo config"
	@echo "    make config-preview        APP_VARIANT=preview expo config"
	@echo "    make config-prod           APP_VARIANT=production expo config"
	@echo "    make doctor                expo-doctor"
	@echo "    make fork-config-show      Print the resolved fork.config.json values"
	@echo
	@echo "  iOS device debug control:"
	@echo "    make ios-debug-vm-pair            Pair connected iPhone to the dev VM and preserve saved backends"
	@echo "    make ios-debug-vm-pair-replace    Pair to the dev VM after clearing saved backends"
	@echo "    make ios-debug-dump               Request and copy app debug snapshot"
	@echo "    make ios-debug-clear              Clear saved mobile backends"
	@echo "    make ios-debug-logs               Stream filtered iOS app logs"
	@echo
	@echo "Fork identity (from $(FORK_CONFIG)):"
	@echo "  Apple Team ID    : $(APPLE_TEAM_ID)"
	@echo "  iOS bundle base  : $(IOS_BUNDLE_ID_BASE)"
	@echo "  Scheme base      : $(SCHEME_BASE)"
	@echo "  EAS project id   : $(EAS_PROJECT_ID)"
	@echo "  EAS owner        : $(EAS_OWNER)"

fork-config-show:
	@cat $(FORK_CONFIG)

# --- Local Expo prebuild + run on iOS simulator ---
.PHONY: ios-sim-dev ios-sim-preview ios-sim-prod
ios-sim-dev:
	APP_VARIANT=development EXPO_NO_GIT_STATUS=1 bunx expo prebuild --clean --platform ios && bunx expo run:ios

ios-sim-preview:
	APP_VARIANT=preview EXPO_NO_GIT_STATUS=1 bunx expo prebuild --clean --platform ios && bunx expo run:ios

ios-sim-prod:
	APP_VARIANT=production EXPO_NO_GIT_STATUS=1 bunx expo prebuild --clean --platform ios && bunx expo run:ios

# --- Local Expo prebuild + run on connected iPhone ---
.PHONY: ios-device-dev ios-device-preview ios-device-prod
ios-device-dev:
	APP_VARIANT=development EXPO_NO_GIT_STATUS=1 bunx expo prebuild --clean --platform ios && bunx expo run:ios $(EXPO_DEVICE_FLAG)

ios-device-preview:
	APP_VARIANT=preview EXPO_NO_GIT_STATUS=1 bunx expo prebuild --clean --platform ios && bunx expo run:ios $(EXPO_DEVICE_FLAG)

ios-device-prod:
	APP_VARIANT=production EXPO_NO_GIT_STATUS=1 bunx expo prebuild --clean --platform ios && bunx expo run:ios $(EXPO_DEVICE_FLAG)

# --- EAS cloud builds and updates ---
.PHONY: eas-ios-dev eas-ios-preview eas-ios-prod eas-ios-dev-no-wait eas-ios-update-dev eas-ios-build-list eas-ios-update-list
eas-ios-dev:
	bunx eas-cli build --profile development -p ios

eas-ios-preview:
	bunx eas-cli build --profile preview -p ios

eas-ios-prod:
	bunx eas-cli build --profile production -p ios

eas-ios-dev-no-wait:
	APP_VARIANT=development EXPO_NO_GIT_STATUS=1 npx eas-cli build --profile development -p ios --no-wait

eas-ios-update-dev:
	APP_VARIANT=development CI=1 EXPO_NO_GIT_STATUS=1 npx eas-cli update --channel development --environment development --platform ios --message "$${MESSAGE:-mobile update}"

eas-ios-build-list:
	APP_VARIANT=development CI=1 EXPO_NO_GIT_STATUS=1 npx eas-cli build:list --platform ios --limit 5 --json

eas-ios-update-list:
	APP_VARIANT=development CI=1 EXPO_NO_GIT_STATUS=1 npx eas-cli update:list --branch development --limit 5 --json

# --- Inspect ---
.PHONY: config-dev config-preview config-prod doctor
config-dev:
	APP_VARIANT=development bunx expo config

config-preview:
	APP_VARIANT=preview bunx expo config

config-prod:
	APP_VARIANT=production bunx expo config

doctor:
	bunx expo-doctor

# --- iOS device debug control ---
.PHONY: ios-debug-vm-pair ios-debug-vm-pair-replace ios-debug-dump ios-debug-clear ios-debug-logs
ios-debug-vm-pair:
	node scripts/ios-debug-control.mjs pair-vm

ios-debug-vm-pair-replace:
	T3_MOBILE_DEBUG_REPLACE_EXISTING=1 node scripts/ios-debug-control.mjs pair-vm

ios-debug-dump:
	node scripts/ios-debug-control.mjs dump

ios-debug-clear:
	node scripts/ios-debug-control.mjs clear

ios-debug-logs:
	node scripts/ios-debug-control.mjs logs
