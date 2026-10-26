/** Keep bundler externals and staged runtime dependency roots aligned. */
// Filesystem-loaded externals need dependencies outside the bundle.
export const CLI_RUNTIME_EXTERNAL_PREFIXES = [
  // Cursor ships computed Webpack imports and platform helper packages.
  "@cursor/sdk",
  // Playwright reads package.json and browsers.json beside its runtime modules.
  "playwright-core",
  "node-pty",
  "ffi-rs",
  "@yuuang/",
  "@ff-labs/",
  "@napi-rs/keyring",
  "@clerk/electron-passkeys",
  "node-gyp-build",
  "node-addon-api",
  "bufferutil",
  "utf-8-validate",
  // The embedding runtime and its runtime closure (jinja, tokenizers), loaded
  // through createRequire at the point of use. External so the bundler never
  // walks into transformers: it statically imports sharp and
  // onnxruntime-common, and those imports in the emitted graph are
  // unresolvable inside the single executable, which can only `import`
  // built-ins.
  "@huggingface/",
  // Semantic search's embedding runtime. onnxruntime-node loads its prebuilt
  // addon with `require("../bin/napi-v6/<platform>/<arch>/onnxruntime_binding.node")`,
  // a path relative to its own lib directory. Inlined into a bundle chunk that
  // path resolves against apps/server/dist instead and misses, so the model
  // never loads and semantic search silently degrades to lexical-only.
  // onnxruntime-common follows it because the runtime requires it by name.
  "onnxruntime-node",
  "onnxruntime-common",
  // @huggingface/transformers statically imports sharp, a libvips addon that
  // loads its @img/sharp-<platform> binding by package name. Inlined, the whole
  // embedding chunk fails to load. semver, detect-libc and @img/colour are its
  // runtime closure.
  "sharp",
  "@img/",
  "semver",
  "detect-libc",
] as const;

/**
 * Declared dependencies of an external package that Node never loads.
 *
 * The closure rule above exists because an external package's runtime
 * `require` resolves from the real filesystem. A dependency reached only by an
 * install script is not part of that closure: onnxruntime-node names adm-zip
 * and global-agent for its postinstall downloader, which pnpm-workspace.yaml
 * disables (`allowBuilds: onnxruntime-node: false`) since the package already
 * ships the CPU binaries we use. Bundling them away is therefore harmless, and
 * exempting them keeps semver, type-fest, escape-string-regexp and the rest of
 * global-agent's tree inside the bundle where they belong.
 */
export const CLI_EXTERNAL_INSTALL_ONLY_DEPENDENCIES = [
  "adm-zip",
  "global-agent",
  // transformers declares the web runtime but its Node build inlines the parts
  // it needs, so nothing ever requires the package (or its protobufjs tree) by
  // name on this platform. On Node it loads onnxruntime-node instead.
  "onnxruntime-web",
] as const;

/** True when `name` is only reached by an external package's install script. */
export function isInstallOnlyExternalDependency(name: string): boolean {
  return CLI_EXTERNAL_INSTALL_ONLY_DEPENDENCIES.some((entry) => entry === name);
}

// Match Cursor dependency boundaries so zod does not externalize zod-to-json-schema.
const CURSOR_RUNTIME_DEPENDENCIES = [
  "@bufbuild/protobuf",
  "@connectrpc/connect",
  "@connectrpc/connect-node",
  "@connectrpc/connect-web",
  "@statsig/js-client",
  "@statsig/client-core",
  "zod",
  "undici",
  "@fastify/busboy",
] as const;

export function isRuntimeExternalCliDependency(id: string): boolean {
  return (
    CLI_RUNTIME_EXTERNAL_PREFIXES.some((prefix) => id.startsWith(prefix)) ||
    CURSOR_RUNTIME_DEPENDENCIES.some((name) => id === name || id.startsWith(`${name}/`))
  );
}

/** Use neverBundle: false from alwaysBundle means no opinion and leaves transitive packages bundled. */
export function isExternalCliDependency(id: string): boolean {
  return isRuntimeExternalCliDependency(id);
}

export function shouldBundleCliDependency(id: string): boolean {
  if (id.startsWith("node:")) return false;
  return !isExternalCliDependency(id);
}

export function selectCliRuntimeExternalDependencies(
  dependencies: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(dependencies).filter(([name]) => isRuntimeExternalCliDependency(name)),
  );
}

/** regionCount distinguishes a clean bundle from a changed marker format the scan cannot see. */
export function findInlinedExternalPackages(source: string): {
  readonly regionCount: number;
  readonly inlined: ReadonlyArray<string>;
  readonly inlinedPackages: ReadonlyArray<string>;
} {
  // Rolldown marks each inlined module with a `//#region <path>` line; newer
  // releases (vite-plus 1.4) emit a bare `// <path>` line instead.
  const regionPattern = /^\/\/(?:#region)?[ \t]+(\S+)[ \t]*$/gm;
  const packagePattern = /node_modules\/((?:@[^/\s]+\/)?[^/\s]+)\//g;

  let regionCount = 0;
  const inlined = new Set<string>();
  const inlinedPackages = new Set<string>();
  for (const region of source.matchAll(regionPattern)) {
    regionCount += 1;
    const regionPath = region[1] ?? "";
    for (const candidate of regionPath.matchAll(packagePattern)) {
      const name = candidate[1];
      if (name === undefined || name === ".pnpm") continue;
      inlinedPackages.add(name);
      if (isExternalCliDependency(name)) inlined.add(name);
    }
  }

  return {
    regionCount,
    inlined: [...inlined].sort(),
    inlinedPackages: [...inlinedPackages].sort(),
  };
}
