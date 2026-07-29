export function assertSupportedNode(version = process.versions.node): void {
  const [major = 0, minor = 0] = version
    .split('.')
    .map((part) => Number(part));
  if (major < 22 || (major === 22 && minor < 19)) {
    throw new Error(
      `Node.js >=22.19.0 is required by Pi 0.82.1; current runtime is v${version}.`,
    );
  }
}
