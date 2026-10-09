/**
 * lib/github.ts
 *
 * Utilities for interacting with the GitHub REST API and building
 * a basic dependency graph from a repository's file tree.
 */

import { buildGraph } from "./graph-builder";
import { detectRepoGuide, type RepoGuide } from "./repo-guide";
import { detectMonorepo, type MonorepoInfo } from "./monorepo";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

import { type CodeNode, type CodeEdge } from "./graph-builder";

export type GraphNode = CodeNode;
export type GraphEdge = CodeEdge;

export interface RepoGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

import { type FunctionIndexRecord } from "./ast-intel";
import { detectRepoLanguages, type RepoLanguageHint } from "./language-plugins";
import { type SkippedStats, filterRepoFiles } from "./file-filter";

export interface AnalyzeResult {
  overview: string;
  files: string[];
  totalRepoFiles?: number;
  totalEligibleFiles?: number;
  indexedFileCount?: number;
  maxFilesCap?: number;
  capHit?: boolean;
  skippedStats?: SkippedStats;
  graph: RepoGraph;
  noSupportedFiles: boolean;
  repoGuide: RepoGuide;
  monorepoInfo: MonorepoInfo;
  detectedLanguages?: RepoLanguageHint[];
  functionCounts?: {
    allFunctions: { name: string; count: number; files: string[] }[];
    hooks?: { name: string; count: number; files: string[] }[];
  };
  functionIndex?: FunctionIndexRecord;
  aiConfigured?: boolean;
  aiError?: { error: string; message: string };
}

/** Shape of a single item returned by the GitHub Git Trees API. */
export interface GitTreeItem {
  path: string;
  mode: string;
  type: "blob" | "tree";
  sha: string;
  size?: number;
  url: string;
}

/** Response shape from GET /repos/:owner/:repo/git/trees/:sha?recursive=1 */
interface GitTreeResponse {
  sha: string;
  url: string;
  tree: GitTreeItem[];
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

const INVALID_URL_ERROR =
  "Invalid GitHub repository URL. Expected format: https://github.com/owner/repo";

/**
 * Extract `owner` and `repo` from a GitHub URL.
 *
 * Examples of valid input and normalized output:
 *  - "https://github.com/owner/repo"             -> { owner: "owner", repo: "repo" }
 *  - "https://github.com/owner/repo/"            -> { owner: "owner", repo: "repo" }
 *  - "https://github.com/owner/repo/tree/main"   -> { owner: "owner", repo: "repo" }
 *  - "https://github.com/owner/repo/blob/m/a.ts"  -> { owner: "owner", repo: "repo" }
 *  - "https://github.com/owner/repo.git"         -> { owner: "owner", repo: "repo" }
 *  - "github.com/owner/repo"                     -> { owner: "owner", repo: "repo" }
 *
 * Throws an Error with INVALID_URL_ERROR if invalid.
 */
export function parseGitHubUrl(raw: string): { owner: string; repo: string } {
  if (!raw || typeof raw !== "string") {
    throw new Error(INVALID_URL_ERROR);
  }

  let input = raw.trim();
  if (!input) {
    throw new Error(INVALID_URL_ERROR);
  }

  // Prepend protocol if omitted (e.g. "github.com/owner/repo")
  if (!/^https?:\/\//i.test(input)) {
    input = `https://${input}`;
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(INVALID_URL_ERROR);
  }

  // Validate hostname
  const hostname = url.hostname.toLowerCase();
  if (hostname !== "github.com" && hostname !== "www.github.com") {
    throw new Error(INVALID_URL_ERROR);
  }

  // Split pathname into non-empty segments
  // E.g. "/owner/repo/tree/main" -> ["owner", "repo", "tree", "main"]
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length === 0) {
    throw new Error(INVALID_URL_ERROR);
  }

  const owner = segments[0];

  // 1-segment Organization / User URL (e.g. "https://github.com/python")
  if (segments.length === 1) {
    const knownOrgRepos: Record<string, string> = {
      python: "cpython",
      facebook: "react",
      vercel: "next.js",
      microsoft: "vscode",
      google: "guava",
      golang: "go",
      "rust-lang": "rust",
      angular: "angular",
      vuejs: "core",
      django: "django",
      twbs: "bootstrap",
      tailwindlabs: "tailwindcss",
      nodejs: "node",
      expressjs: "express",
      fastapi: "fastapi",
    };
    const repo = knownOrgRepos[owner.toLowerCase()] || owner;
    return { owner, repo };
  }

  // 2+ segment Repository URL (e.g. "https://github.com/owner/repo")
  const repo = segments[1].replace(/\.git$/i, "");

  if (!owner || !repo) {
    throw new Error(INVALID_URL_ERROR);
  }

  return { owner, repo };
}

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

/**
 * Build the common headers for GitHub API requests.
 * If GITHUB_TOKEN is set in the environment, it is included as a Bearer
 * token — this raises the rate limit from 60 to 5,000 requests per hour.
 */
function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "codebase-atlas",
  };

  const token = process.env.GITHUB_TOKEN;
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  return headers;
}

export class GitHubRateLimitError extends Error {
  readonly code = "RATE_LIMITED";
  readonly resetEpoch?: number;
  readonly resetTime: string;

  constructor(resetEpoch?: number) {
    let formattedTime: string;
    if (resetEpoch && !isNaN(resetEpoch)) {
      const resetDate = new Date(resetEpoch * 1000);
      formattedTime = resetDate.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } else {
      formattedTime = "a later time";
    }
    const message = `GitHub rate limit hit. Add a GITHUB_TOKEN or retry at ${formattedTime}`;
    super(message);
    this.name = "GitHubRateLimitError";
    this.resetEpoch = resetEpoch;
    this.resetTime = formattedTime;
  }
}

/**
 * Fetch the full file tree for a repo using the Git Trees API.
 * Uses the default branch (fetched via /repos/:owner/:repo first).
 *
 * This is a single-request alternative to recursively calling /contents,
 * which would be very slow for large repos.
 */
export async function fetchRepoTreeWithBranch(
  owner: string,
  repo: string
): Promise<{ tree: GitTreeItem[]; branch: string }> {
  // 1. Get the default branch name
  const repoRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}`,
    { headers: githubHeaders() }
  );

  if (!repoRes.ok) {
    if (repoRes.status === 403 || repoRes.status === 429) {
      const resetHeader = repoRes.headers.get("x-ratelimit-reset");
      const resetEpoch = resetHeader ? parseInt(resetHeader, 10) : undefined;
      throw new GitHubRateLimitError(resetEpoch);
    }
    const body = await repoRes.text();
    throw new Error(
      `GitHub API error (${repoRes.status}) fetching repo info: ${body}`
    );
  }

  const repoData = (await repoRes.json()) as { default_branch: string };
  const branch = repoData.default_branch;

  // 2. Fetch the full recursive tree in one call
  const treeRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
    { headers: githubHeaders() }
  );

  if (!treeRes.ok) {
    if (treeRes.status === 403 || treeRes.status === 429) {
      const resetHeader = treeRes.headers.get("x-ratelimit-reset");
      const resetEpoch = resetHeader ? parseInt(resetHeader, 10) : undefined;
      throw new GitHubRateLimitError(resetEpoch);
    }
    const body = await treeRes.text();
    throw new Error(
      `GitHub API error (${treeRes.status}) fetching tree: ${body}`
    );
  }

  const treeData = (await treeRes.json()) as GitTreeResponse;
  return { tree: treeData.tree, branch };
}

export async function fetchRepoTree(
  owner: string,
  repo: string
): Promise<GitTreeItem[]> {
  const result = await fetchRepoTreeWithBranch(owner, repo);
  return result.tree;
}

// ---------------------------------------------------------------------------
// Graph building
// ---------------------------------------------------------------------------

/** Supported source file extensions: TypeScript, JavaScript, Python, Go, and Rust variants. */
export const SUPPORTED_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
];

/**
 * Checks if a file path belongs to a supported source code file type (.ts, .tsx, .js, .jsx, .mjs, .cjs).
 */
export function isSupportedFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return SUPPORTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Given the raw tree from GitHub, build the AnalyzeResult:
 *  - Filters vendored, generated, lockfiles, binary, and huge (>500KB) files
 *  - Collects supported source files up to configurable maxFiles cap (default 2000)
 *  - Reports capHit, totalRepoFiles, totalEligibleFiles, and skippedStats
 *  - Creates graph nodes and edges
 */
export function buildAnalyzeResult(
  tree: GitTreeItem[],
  options?: { maxFiles?: number }
): AnalyzeResult {
  const filterResult = filterRepoFiles(tree, options);
  const sourceFiles = filterResult.indexedFilePaths;
  const noSupportedFiles = sourceFiles.length === 0;

  // Collect all file paths for language detection
  const allTreePaths = tree
    .filter((item) => item.type === "blob")
    .map((item) => item.path);
  const detectedLanguages = detectRepoLanguages(allTreePaths);

  // Build graph nodes and edges using buildGraph helper
  const graph = buildGraph(sourceFiles, "high-level");
  const repoGuide = detectRepoGuide(sourceFiles);
  const monorepoInfo = detectMonorepo(tree, sourceFiles);

  return {
    overview: "",
    files: sourceFiles,
    totalRepoFiles: filterResult.totalRepoFiles,
    totalEligibleFiles: filterResult.totalEligibleFiles,
    indexedFileCount: filterResult.indexedFiles.length,
    maxFilesCap: filterResult.maxFilesCap,
    capHit: filterResult.capHit,
    skippedStats: filterResult.skippedStats,
    graph,
    noSupportedFiles,
    repoGuide,
    monorepoInfo,
    detectedLanguages,
  };
}

// ---------------------------------------------------------------------------
// File Content & Context Selection Helpers for Q&A
// ---------------------------------------------------------------------------

/**
 * Fetch text content of a file from GitHub using raw.githubusercontent.com.
 * Returns up to maxChars (default 2000) to keep LLM context light.
 */
export async function fetchFileContent(
  owner: string,
  repo: string,
  path: string,
  maxChars = 2000
): Promise<string | null> {
  try {
    const res = await fetch(
      `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${path}`,
      { headers: githubHeaders() }
    );

    if (!res.ok) return null;

    const text = await res.text();
    if (text.length > maxChars) {
      return text.slice(0, maxChars) + "\n...[truncated]";
    }
    return text;
  } catch {
    return null;
  }
}

/**
 * Domain-aware category patterns.
 *
 * When the user's question mentions certain topics (e.g. "routing", "API"),
 * files whose paths contain related directory/file names get a score boost.
 * Each entry maps a set of question trigger words to a set of path patterns.
 */
const CATEGORY_PATTERNS: { triggers: string[]; pathHints: string[] }[] = [
  {
    // Routing / API / endpoints
    triggers: ["route", "routing", "router", "api", "endpoint", "rest", "handler"],
    pathHints: ["route", "routes", "api", "controller", "controllers", "handler", "handlers", "middleware"],
  },
  {
    // Components / UI / pages
    triggers: ["component", "components", "ui", "page", "pages", "view", "layout", "button", "form"],
    pathHints: ["component", "components", "ui", "page", "pages", "view", "views", "layout", "layouts", "widget", "widgets"],
  },
  {
    // Configuration / settings / environment
    triggers: ["config", "configuration", "settings", "env", "environment", "option", "options"],
    pathHints: ["config", "configs", "configuration", "settings", "env", "options"],
  },
  {
    // State management / store / hooks
    triggers: ["state", "store", "redux", "context", "hook", "hooks", "provider"],
    pathHints: ["store", "stores", "state", "context", "hooks", "providers", "redux", "zustand"],
  },
  {
    // Testing
    triggers: ["test", "tests", "testing", "spec", "specs", "jest", "vitest"],
    pathHints: ["test", "tests", "__tests__", "spec", "specs", "fixtures"],
  },
  {
    // Types / interfaces / schemas
    triggers: ["type", "types", "interface", "schema", "model", "models"],
    pathHints: ["type", "types", "typings", "interfaces", "schema", "schemas", "model", "models"],
  },
  {
    // Utilities / helpers / lib
    triggers: ["util", "utils", "utility", "helper", "helpers", "lib", "common", "shared"],
    pathHints: ["util", "utils", "helpers", "lib", "common", "shared"],
  },
];

/** Well-known entry point file names used as fallback when nothing matches. */
const CENTRAL_FILE_PATTERNS = [
  "index.ts", "index.tsx",
  "main.ts", "main.tsx",
  "app.ts", "app.tsx",
  "app/page.tsx", "app/layout.tsx",
  "server.ts", "server.tsx",
];

/**
 * Select the most relevant file paths for a user's question.
 *
 * Scoring strategy (per file):
 *   1. Keyword overlap  — question words matched in path segments   (0-N × 10)
 *   2. Category boost   — domain patterns matched in path segments  (0-N × 8)
 *   3. Entry-point boost — well-known central files get a bonus     (+5)
 *   4. Depth penalty    — deeper paths are slightly penalised       (−1 per segment beyond 2)
 *
 * Scores are normalized to 0–1. Files above a minimum threshold are kept,
 * capped at `limit`. If nothing scores well, falls back to central files.
 *
 * @param files    Full list of TS/TSX paths from analysis
 * @param question The user's natural-language question
 * @param limit    Max files to return (default 12)
 */
export function selectRelevantFiles(
  files: string[],
  question: string,
  limit = 12,
): string[] {
  if (files.length === 0) return [];

  // ---- 1. Extract meaningful keywords from the question ----
  const keywords = question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);

  // ---- 2. Determine which category boosts apply ----
  const activePathHints = new Set<string>();
  for (const cat of CATEGORY_PATTERNS) {
    const matches = cat.triggers.some((t) => keywords.includes(t));
    if (matches) {
      for (const hint of cat.pathHints) {
        activePathHints.add(hint);
      }
    }
  }

  // ---- 3. Score every file ----
  const scored = files.map((file) => {
    const lower = file.toLowerCase();
    // Split path into segments for granular matching
    // e.g. "src/api/routes/auth.ts" → ["src", "api", "routes", "auth.ts"]
    const segments = lower.split("/");
    // Also split segments on hyphens for compound names like "auth-controller"
    const tokens = segments.flatMap((s) => s.replace(/\.(tsx?|jsx?|mjs|cjs)$/, "").split("-"));

    let score = 0;

    // Keyword overlap: each question keyword found in path tokens
    for (const kw of keywords) {
      for (const token of tokens) {
        if (token.includes(kw) || kw.includes(token)) {
          score += 10;
          break; // count each keyword at most once per file
        }
      }
    }

    // Category boost: if question triggers a domain category, boost files
    // whose path contains related directory names
    for (const hint of activePathHints) {
      if (tokens.includes(hint)) {
        score += 8;
      }
    }

    // Entry-point boost: well-known central files are generally useful
    const isCentral = CENTRAL_FILE_PATTERNS.some(
      (p) => lower.endsWith(p)
    );
    if (isCentral) {
      score += 5;
    }

    // Depth penalty: prefer shallower files (more likely to be important)
    // Files at depth ≤ 2 get no penalty; each extra level costs 1 point
    const depth = segments.length;
    if (depth > 2) {
      score -= (depth - 2);
    }

    // Floor at 0
    if (score < 0) score = 0;

    return { file, score };
  });

  // ---- 4. Normalize scores to 0–1 ----
  const maxScore = Math.max(...scored.map((s) => s.score), 1);
  const normalized = scored.map((s) => ({
    file: s.file,
    score: s.score / maxScore,
  }));

  // ---- 5. Sort descending and filter above threshold ----
  const MIN_THRESHOLD = 0.1;
  normalized.sort((a, b) => b.score - a.score);

  const selected = normalized
    .filter((s) => s.score >= MIN_THRESHOLD)
    .slice(0, limit)
    .map((s) => s.file);

  // ---- 6. Fallback: if no good matches, pick central/top-level files ----
  if (selected.length === 0) {
    const fallback = files.filter((f) => {
      const lower = f.toLowerCase();
      return CENTRAL_FILE_PATTERNS.some((p) => lower.endsWith(p));
    });

    if (fallback.length > 0) {
      return fallback.slice(0, limit);
    }

    // Last resort: shortest paths (shallowest files)
    const byDepth = [...files].sort(
      (a, b) => a.split("/").length - b.split("/").length
    );
    return byDepth.slice(0, limit);
  }

  // Temporary debug logging — remove once validated
  console.log(
    `[selectRelevantFiles] Question: "${question}"`,
    `\n  Active hints: [${[...activePathHints].join(", ")}]`,
    `\n  Top ${selected.length} files:`,
    selected.map((f, i) => `\n    ${i + 1}. ${f} (${normalized.find((n) => n.file === f)?.score.toFixed(2)})`).join("")
  );

  return selected;
}
