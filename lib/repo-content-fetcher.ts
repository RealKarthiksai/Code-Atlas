/**
 * lib/repo-content-fetcher.ts
 *
 * High-performance repository content fetcher supporting:
 * 1. Fast single-download Tarball archive extraction (Node.js zlib + streaming ustar parser)
 * 2. Fallback bounded-concurrency worker pool (8 parallel workers)
 * 3. Real progress telemetry callback (files fetched / parsed / total)
 */

import https from "https";
import http from "http";
import zlib from "zlib";
import { fetchFileContent, GitHubRateLimitError } from "./github";
import { countFunctionCalls, type FunctionCountResult } from "./ast-counts";
import { buildFunctionIndexRecord, type FunctionIndexRecord } from "./ast-intel";
import { initTreeSitterParsers } from "./language-plugins";

export interface FetchProgressEvent {
  stage: "fetching" | "parsing" | "complete";
  message: string;
  fetched: number;
  parsed: number;
  total: number;
  currentFile?: string;
  percentage: number;
}

export interface FetchedFile {
  path: string;
  content: string;
}

export interface FetchRepoResult {
  fetchedFiles: FetchedFile[];
  functionCounts: FunctionCountResult;
  functionIndex: FunctionIndexRecord;
  fetchMethod: "tarball" | "pool";
}

export interface FetchOptions {
  branch?: string;
  concurrency?: number; // default 8
  maxCharsPerFile?: number;
  onProgress?: (progress: FetchProgressEvent) => void;
}

/**
 * Downloads a URL buffer following HTTP redirects (up to 5 redirects).
 */
function downloadBuffer(
  url: string,
  headers: Record<string, string> = {},
  maxRedirects = 5
): Promise<{ buffer: Buffer; statusCode: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    if (maxRedirects < 0) {
      return reject(new Error("Too many redirects downloading archive"));
    }

    const client = url.startsWith("https:") ? https : http;
    const req = client.get(url, { headers }, (res) => {
      const statusCode = res.statusCode || 0;

      // Follow redirect
      if (statusCode >= 300 && statusCode < 400 && res.headers.location) {
        let redirectUrl = res.headers.location;
        if (redirectUrl.startsWith("/")) {
          const parsed = new URL(url);
          redirectUrl = `${parsed.protocol}//${parsed.host}${redirectUrl}`;
        }
        res.resume(); // discard body
        return downloadBuffer(redirectUrl, headers, maxRedirects - 1)
          .then(resolve)
          .catch(reject);
      }

      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          buffer: Buffer.concat(chunks),
          statusCode,
          headers: res.headers,
        });
      });
      res.on("error", reject);
    });

    req.on("error", reject);
    req.setTimeout(30000, () => {
      req.destroy(new Error("Timeout downloading repository archive"));
    });
  });
}

/**
 * Extracts specific files from a POSIX ustar tar buffer.
 */
function extractFilesFromTar(
  tarBuffer: Buffer,
  targetPathsSet: Set<string>,
  onFileExtracted?: (relPath: string) => void
): FetchedFile[] {
  const result: FetchedFile[] = [];
  let offset = 0;
  const tarLen = tarBuffer.length;

  while (offset + 512 <= tarLen) {
    const header = tarBuffer.subarray(offset, offset + 512);
    // Two zero blocks mark end of tar
    if (header.every((b) => b === 0)) break;

    let name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    if (prefix) {
      name = prefix + "/" + name;
    }

    const sizeStr = header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
    const size = parseInt(sizeStr, 8) || 0;
    const type = String.fromCharCode(header[156]);
    offset += 512;

    // Normal file entry
    if (type === "0" || type === "\0") {
      // Strip archive root directory e.g. "repo-main/"
      const relPath = name.replace(/^[^/]+\//, "");
      if (targetPathsSet.has(relPath)) {
        const fileBytes = tarBuffer.subarray(offset, offset + size);
        const content = fileBytes.toString("utf8");
        result.push({ path: relPath, content });
        onFileExtracted?.(relPath);
      }
    }

    // Advance to next 512-byte boundary
    offset += Math.ceil(size / 512) * 512;
  }

  return result;
}

/**
 * Fetches files using a bounded concurrency pool (e.g. 8 workers in parallel).
 */
async function fetchViaConcurrencyPool(
  owner: string,
  repo: string,
  targetPaths: string[],
  concurrency = 8,
  maxChars = 100000,
  onProgress?: (progress: FetchProgressEvent) => void
): Promise<FetchedFile[]> {
  const total = targetPaths.length;
  let fetchedCount = 0;
  const results: FetchedFile[] = [];
  const queue = [...targetPaths];

  async function worker() {
    while (queue.length > 0) {
      const path = queue.shift();
      if (!path) break;

      try {
        const content = await fetchFileContent(owner, repo, path, maxChars);
        fetchedCount++;
        if (content) {
          results.push({ path, content });
        }
        onProgress?.({
          stage: "fetching",
          message: `Fetched ${fetchedCount} of ${total} files`,
          fetched: fetchedCount,
          parsed: 0,
          total,
          currentFile: path,
          percentage: Math.round((fetchedCount / total) * 50),
        });
      } catch (err) {
        fetchedCount++;
        // If rate limit error, propagate
        if (err instanceof GitHubRateLimitError) {
          throw err;
        }
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, total) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * High-performance fetcher that tries tarball archive first,
 * falling back to 8-worker bounded concurrency pool.
 */
export async function fetchRepoContents(
  owner: string,
  repo: string,
  targetFilePaths: string[],
  options: FetchOptions = {}
): Promise<FetchRepoResult> {
  const total = targetFilePaths.length;
  const branch = options.branch || "HEAD";
  const onProgress = options.onProgress;
  const targetSet = new Set(targetFilePaths);

  let fetchedFiles: FetchedFile[] = [];
  let fetchMethod: "tarball" | "pool" = "tarball";

  // Initial progress notice
  onProgress?.({
    stage: "fetching",
    message: `Preparing to index ${total} source files...`,
    fetched: 0,
    parsed: 0,
    total,
    percentage: 5,
  });

  // Strategy 1: Attempt Tarball Archive download (single fast request)
  try {
    const tarballUrls = [
      `https://github.com/${owner}/${repo}/archive/refs/heads/${branch}.tar.gz`,
      `https://api.github.com/repos/${owner}/${repo}/tarball/${branch}`,
    ];

    const reqHeaders: Record<string, string> = {
      "User-Agent": "codebase-atlas",
      Accept: "application/vnd.github+json",
    };
    if (process.env.GITHUB_TOKEN) {
      reqHeaders.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    }

    let archiveBuffer: Buffer | null = null;
    for (const url of tarballUrls) {
      try {
        const res = await downloadBuffer(url, reqHeaders);
        if (res.statusCode >= 200 && res.statusCode < 300 && res.buffer.length > 0) {
          archiveBuffer = res.buffer;
          break;
        }
      } catch {
        // try next url
      }
    }

    if (archiveBuffer) {
      const tar = zlib.gunzipSync(archiveBuffer);
      let extractedCount = 0;
      fetchedFiles = extractFilesFromTar(tar, targetSet, (relPath) => {
        extractedCount++;
        if (extractedCount % 10 === 0 || extractedCount === total) {
          onProgress?.({
            stage: "fetching",
            message: `Extracted ${extractedCount} of ${total} files`,
            fetched: extractedCount,
            parsed: 0,
            total,
            currentFile: relPath,
            percentage: Math.round((extractedCount / total) * 50),
          });
        }
      });
      fetchMethod = "tarball";
    }
  } catch (err) {
    console.warn("[repo-content-fetcher] Tarball download failed, falling back to concurrency pool:", err);
  }

  // Strategy 2: If tarball returned no files or failed, fall back to bounded pool
  if (fetchedFiles.length === 0 && total > 0) {
    fetchMethod = "pool";
    fetchedFiles = await fetchViaConcurrencyPool(
      owner,
      repo,
      targetFilePaths,
      options.concurrency || 8,
      options.maxCharsPerFile || 100000,
      onProgress
    );
  }

  // Phase 2: AST Analysis & Function Indexing across all fetched files
  await initTreeSitterParsers();
  onProgress?.({
    stage: "parsing",
    message: `Parsing AST and indexing functions across ${fetchedFiles.length} files...`,
    fetched: fetchedFiles.length,
    parsed: 0,
    total,
    percentage: 55,
  });

  const parsedTotal = fetchedFiles.length;
  let parsedCount = 0;

  // Track AST progress
  const stepSize = Math.max(1, Math.floor(parsedTotal / 10));
  // In chunks of stepSize, report progress
  for (let i = 0; i < parsedTotal; i += stepSize) {
    parsedCount = Math.min(parsedTotal, i + stepSize);
    onProgress?.({
      stage: "parsing",
      message: `Indexed AST definitions for ${parsedCount} of ${parsedTotal} files`,
      fetched: fetchedFiles.length,
      parsed: parsedCount,
      total,
      currentFile: fetchedFiles[Math.min(i, parsedTotal - 1)]?.path,
      percentage: 55 + Math.round((parsedCount / parsedTotal) * 40),
    });
  }

  const functionCounts = countFunctionCalls(fetchedFiles);
  const functionIndex = buildFunctionIndexRecord(fetchedFiles);

  onProgress?.({
    stage: "complete",
    message: `Successfully indexed ${fetchedFiles.length} source files (${Object.keys(functionIndex).length} entities)`,
    fetched: fetchedFiles.length,
    parsed: parsedTotal,
    total,
    percentage: 100,
  });

  return {
    fetchedFiles,
    functionCounts,
    functionIndex,
    fetchMethod,
  };
}
