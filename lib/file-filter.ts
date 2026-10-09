/**
 * lib/file-filter.ts
 *
 * Classifies, filters, and caps repository files from the Git tree.
 * Explicitly skips vendored, generated, lockfile, binary, and huge (>500KB) files,
 * reporting detailed statistics on skipped files.
 */

import { type GitTreeItem, isSupportedFile } from "./github";

export const MAX_INDEX_FILES_DEFAULT = 2000;
export const MAX_FILE_SIZE_BYTES = 500 * 1024; // 500 KB

export type SkipReason =
  | "vendored"
  | "generated"
  | "lockfile"
  | "binary"
  | "huge"
  | "unsupported";

export interface SkipDetail {
  path: string;
  reason: SkipReason;
  size?: number;
}

export interface SkippedStats {
  vendored: number;
  generated: number;
  lockfiles: number;
  binary: number;
  huge: number;
  unsupported: number;
  totalSkipped: number;
  sampleSkipped: SkipDetail[];
}

export interface FilterResult {
  totalRepoFiles: number;
  totalEligibleFiles: number;
  indexedFiles: GitTreeItem[];
  indexedFilePaths: string[];
  capHit: boolean;
  maxFilesCap: number;
  skippedStats: SkippedStats;
}

const VENDORED_PATTERNS = [
  /(?:^|\/)node_modules\//i,
  /(?:^|\/)vendor\//i,
  /(?:^|\/)third_party\//i,
  /(?:^|\/)third-party\//i,
  /(?:^|\/)bower_components\//i,
  /(?:^|\/)jspm_packages\//i,
];

const GENERATED_PATTERNS = [
  /(?:^|\/)dist\//i,
  /(?:^|\/)build\//i,
  /(?:^|\/)\.next\//i,
  /(?:^|\/)out\//i,
  /(?:^|\/)coverage\//i,
  /(?:^|\/)\.docusaurus\//i,
  /(?:^|\/)\.turbo\//i,
  /(?:^|\/)target\//i,
  /(?:^|\/)__pycache__\//i,
  /\.min\.(js|css|mjs|cjs)$/i,
  /\.bundle\.(js|css)$/i,
  /\.map$/i,
];

const LOCKFILE_NAMES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "cargo.lock",
  "go.sum",
  "composer.lock",
  "gemfile.lock",
  "poetry.lock",
  "flake.lock",
  "mix.lock",
  "pubspec.lock",
]);

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".svg", ".webp", ".avif",
  ".pdf", ".zip", ".tar", ".gz", ".tgz", ".7z", ".rar",
  ".exe", ".dll", ".so", ".dylib", ".wasm", ".bin",
  ".pyc", ".pyo", ".class", ".jar", ".war", ".ear",
  ".iso", ".dmg", ".mp3", ".mp4", ".mov", ".avi",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".sqlite", ".db", ".idx",
]);

/**
 * Determine if a path belongs to vendored dependencies.
 */
export function isVendored(path: string): boolean {
  return VENDORED_PATTERNS.some((p) => p.test(path));
}

/**
 * Determine if a path belongs to generated or build artifacts.
 */
export function isGenerated(path: string): boolean {
  return GENERATED_PATTERNS.some((p) => p.test(path));
}

/**
 * Determine if a path is a package manager lockfile.
 */
export function isLockfile(path: string): boolean {
  const fileName = path.split("/").pop()?.toLowerCase() || "";
  return LOCKFILE_NAMES.has(fileName);
}

/**
 * Determine if a path has a known binary file extension.
 */
export function isBinary(path: string): boolean {
  const ext = "." + (path.split(".").pop()?.toLowerCase() || "");
  return BINARY_EXTENSIONS.has(ext);
}

/**
 * Determine if a file exceeds the maximum size limit (>500KB).
 */
export function isHuge(size?: number): boolean {
  return typeof size === "number" && size > MAX_FILE_SIZE_BYTES;
}

/**
 * Filters the Git tree blobs, categorizing skipped files and capping source files.
 */
export function filterRepoFiles(
  tree: GitTreeItem[],
  options?: { maxFiles?: number }
): FilterResult {
  const maxCap = options?.maxFiles && options.maxFiles > 0
    ? options.maxFiles
    : MAX_INDEX_FILES_DEFAULT;

  const blobItems = tree.filter((item) => item.type === "blob");
  const totalRepoFiles = blobItems.length;

  const skippedStats: SkippedStats = {
    vendored: 0,
    generated: 0,
    lockfiles: 0,
    binary: 0,
    huge: 0,
    unsupported: 0,
    totalSkipped: 0,
    sampleSkipped: [],
  };

  const eligibleFiles: GitTreeItem[] = [];

  for (const item of blobItems) {
    const path = item.path;

    if (isVendored(path)) {
      skippedStats.vendored++;
      skippedStats.totalSkipped++;
      if (skippedStats.sampleSkipped.length < 50) {
        skippedStats.sampleSkipped.push({ path, reason: "vendored", size: item.size });
      }
      continue;
    }

    if (isGenerated(path)) {
      skippedStats.generated++;
      skippedStats.totalSkipped++;
      if (skippedStats.sampleSkipped.length < 50) {
        skippedStats.sampleSkipped.push({ path, reason: "generated", size: item.size });
      }
      continue;
    }

    if (isLockfile(path)) {
      skippedStats.lockfiles++;
      skippedStats.totalSkipped++;
      if (skippedStats.sampleSkipped.length < 50) {
        skippedStats.sampleSkipped.push({ path, reason: "lockfile", size: item.size });
      }
      continue;
    }

    if (isBinary(path)) {
      skippedStats.binary++;
      skippedStats.totalSkipped++;
      if (skippedStats.sampleSkipped.length < 50) {
        skippedStats.sampleSkipped.push({ path, reason: "binary", size: item.size });
      }
      continue;
    }

    if (isHuge(item.size)) {
      skippedStats.huge++;
      skippedStats.totalSkipped++;
      if (skippedStats.sampleSkipped.length < 50) {
        skippedStats.sampleSkipped.push({ path, reason: "huge", size: item.size });
      }
      continue;
    }

    if (!isSupportedFile(path)) {
      skippedStats.unsupported++;
      skippedStats.totalSkipped++;
      if (skippedStats.sampleSkipped.length < 50) {
        skippedStats.sampleSkipped.push({ path, reason: "unsupported", size: item.size });
      }
      continue;
    }

    eligibleFiles.push(item);
  }

  const totalEligibleFiles = eligibleFiles.length;
  const capHit = totalEligibleFiles > maxCap;
  const indexedFiles = capHit ? eligibleFiles.slice(0, maxCap) : eligibleFiles;
  const indexedFilePaths = indexedFiles.map((f) => f.path);

  return {
    totalRepoFiles,
    totalEligibleFiles,
    indexedFiles,
    indexedFilePaths,
    capHit,
    maxFilesCap: maxCap,
    skippedStats,
  };
}
