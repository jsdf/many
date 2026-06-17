// Compute a path relative to a root directory, handling both POSIX and Windows
// separators. Returns the root's own basename when given the root itself, and
// falls back to the absolute path if it isn't under the root.
export function relativeToRoot(absPath: string, rootPath: string): string {
  const sep = absPath.includes("\\") ? "\\" : "/";
  if (absPath === rootPath) {
    const i = absPath.lastIndexOf(sep);
    return i >= 0 ? absPath.slice(i + 1) : absPath;
  }
  const prefix = rootPath.endsWith(sep) ? rootPath : rootPath + sep;
  return absPath.startsWith(prefix) ? absPath.slice(prefix.length) : absPath;
}
