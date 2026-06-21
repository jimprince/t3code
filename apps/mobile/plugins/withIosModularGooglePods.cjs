const fs = require("node:fs");
const path = require("node:path");
const { withDangerousMod } = require("expo/config-plugins");

const APP_TARGET_PATTERN = /target 'T3CodeDev' do\n/;
const MODULAR_GOOGLE_PODS = [
  "  pod 'GoogleUtilities', :modular_headers => true",
  "  pod 'RecaptchaInterop', :modular_headers => true",
].join("\n");

module.exports = function withIosModularGooglePods(config) {
  return withDangerousMod(config, [
    "ios",
    (nextConfig) => {
      const podfilePath = path.join(nextConfig.modRequest.platformProjectRoot, "Podfile");
      const podfile = fs.readFileSync(podfilePath, "utf8");

      if (podfile.includes(MODULAR_GOOGLE_PODS)) {
        return nextConfig;
      }

      if (!APP_TARGET_PATTERN.test(podfile)) {
        throw new Error("Could not find the T3CodeDev target in the generated Podfile.");
      }

      fs.writeFileSync(
        podfilePath,
        podfile.replace(APP_TARGET_PATTERN, (match) => `${match}${MODULAR_GOOGLE_PODS}\n\n`),
        "utf8",
      );

      return nextConfig;
    },
  ]);
};
