const fs = require("node:fs");
const path = require("node:path");
const { withDangerousMod } = require("expo/config-plugins");

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
      const projectName = nextConfig.modRequest.projectName;
      const appTarget = projectName ? `target '${projectName}' do\n` : undefined;

      if (podfile.includes(MODULAR_GOOGLE_PODS)) {
        return nextConfig;
      }

      if (!appTarget || !podfile.includes(appTarget)) {
        throw new Error(
          `Could not find the generated app target${projectName ? ` '${projectName}'` : ""} in the Podfile.`,
        );
      }

      fs.writeFileSync(
        podfilePath,
        podfile.replace(appTarget, `${appTarget}${MODULAR_GOOGLE_PODS}\n\n`),
        "utf8",
      );

      return nextConfig;
    },
  ]);
};
