const PNPM_STORE_NODE_MODULES_PATTERN = /((?:\.\.\/)+node_modules)\/\.pnpm\/[^/]+\/node_modules\//g;

module.exports = {
  fileHookTransform(source, chunk, isEndOfFile) {
    if (!isEndOfFile || source.type !== "contents" || typeof chunk !== "string") {
      return chunk;
    }

    if (!source.id.includes("AutolinkingConfig")) {
      return chunk;
    }

    return chunk.replace(PNPM_STORE_NODE_MODULES_PATTERN, "$1/");
  },
};
