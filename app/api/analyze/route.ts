/**
 * /api/analyze
 *
 * Analyzes repository structure, indexing all supported source files
 * with a configurable cap (default 2000), skipping vendored/generated/binary/huge (>500KB) files,
 * and supporting real-time SSE progress streaming.
 */

import {
  parseGitHubUrl,
  fetchRepoTreeWithBranch,
  buildAnalyzeResult,
  GitHubRateLimitError,
  type AnalyzeResult,
} from "@/lib/github";
import { generateOverview, AiNotConfiguredError } from "@/lib/overview";
import {
  fetchRepoContents,
  type FetchProgressEvent,
} from "@/lib/repo-content-fetcher";

export interface PipelineOptions {
  maxFiles?: number;
  onProgress?: (event: FetchProgressEvent) => void;
}

/**
 * Core analysis pipeline that indexes all eligible source files.
 */
export async function executeAnalyzePipeline(
  repoUrl: string,
  options: PipelineOptions = {}
): Promise<AnalyzeResult> {
  // 1. Parse GitHub URL
  const { owner, repo } = parseGitHubUrl(repoUrl);

  options.onProgress?.({
    stage: "fetching",
    message: "Fetching repository tree from GitHub...",
    fetched: 0,
    parsed: 0,
    total: 0,
    percentage: 5,
  });

  // 2. Fetch full recursive tree & branch name
  const { tree, branch } = await fetchRepoTreeWithBranch(owner, repo);

  // 3. Build filtered analysis result (caps source files, tracks skipped stats)
  const result: AnalyzeResult = buildAnalyzeResult(tree, {
    maxFiles: options.maxFiles,
  });

  const totalSourceFiles = result.files.length;

  // 4. Fetch content for all indexed source files (tarball or bounded concurrency pool)
  if (totalSourceFiles > 0) {
    const fetchRes = await fetchRepoContents(owner, repo, result.files, {
      branch,
      concurrency: 8,
      onProgress: options.onProgress,
    });

    result.functionCounts = fetchRes.functionCounts;
    result.functionIndex = fetchRes.functionIndex;
  }

  // 5. Generate AI overview (using representative sample for prompt context)
  const folders = result.graph.nodes
    .filter((n) => n.type === "folder")
    .map((n) => n.label);
  const sampleFiles = result.files.slice(0, 15);

  try {
    result.overview = await generateOverview({
      repoUrl,
      folders,
      sampleFiles,
    });
    result.aiConfigured = true;
  } catch (err: unknown) {
    if (err instanceof AiNotConfiguredError || (err as any)?.code === "AI_NOT_CONFIGURED") {
      result.overview = "";
      result.aiConfigured = false;
      result.aiError = {
        error: "AI_NOT_CONFIGURED",
        message: "Set GEMINI_API_KEY to enable this feature",
      };
    } else {
      result.overview = "";
      result.aiError = {
        error: "AI_ERROR",
        message: err instanceof Error ? err.message : "Failed to generate AI overview.",
      };
    }
  }

  return result;
}

/**
 * Creates a Server-Sent Events (SSE) stream for real-time progress updates.
 */
function createSseStream(repoUrl: string, maxFiles?: number): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      function sendEvent(data: Record<string, unknown>) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      }

      try {
        const result = await executeAnalyzePipeline(repoUrl, {
          maxFiles,
          onProgress: (p) => {
            sendEvent({ type: "progress", ...p });
          },
        });

        sendEvent({ type: "complete", result });
        controller.close();
      } catch (err: unknown) {
        if (err instanceof GitHubRateLimitError || (err as any)?.code === "RATE_LIMITED") {
          const rateLimitErr = err as GitHubRateLimitError;
          sendEvent({
            type: "error",
            error: "RATE_LIMITED",
            message: rateLimitErr.message,
            resetTime: rateLimitErr.resetTime,
          });
        } else {
          const message = err instanceof Error ? err.message : "Analysis failed";
          sendEvent({
            type: "error",
            error: message,
            message,
          });
        }
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

/**
 * GET /api/analyze?repoUrl=...&stream=true&maxFiles=...
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const repoUrl = url.searchParams.get("repoUrl");
  const isStream = url.searchParams.get("stream") === "true";
  const maxFilesParam = url.searchParams.get("maxFiles");
  const maxFiles = maxFilesParam ? parseInt(maxFilesParam, 10) : undefined;

  if (!repoUrl) {
    return Response.json({ error: "repoUrl query parameter is required." }, { status: 400 });
  }

  if (isStream) {
    return createSseStream(repoUrl, maxFiles);
  }

  try {
    const result = await executeAnalyzePipeline(repoUrl, { maxFiles });
    return Response.json(result);
  } catch (err: unknown) {
    return handleError(err);
  }
}

/**
 * POST /api/analyze
 */
export async function POST(request: Request) {
  let body: { repoUrl?: string; maxFiles?: number; stream?: boolean };

  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { repoUrl, maxFiles, stream } = body;

  if (!repoUrl) {
    return Response.json({ error: "repoUrl is required." }, { status: 400 });
  }

  const acceptHeader = request.headers.get("accept") || "";
  const isStream = stream === true || acceptHeader.includes("text/event-stream");

  if (isStream) {
    return createSseStream(repoUrl, maxFiles);
  }

  try {
    const result = await executeAnalyzePipeline(repoUrl, { maxFiles });
    return Response.json(result);
  } catch (err: unknown) {
    return handleError(err);
  }
}

function handleError(err: unknown): Response {
  if (err instanceof GitHubRateLimitError || (err as any)?.code === "RATE_LIMITED") {
    const rateLimitErr = err as GitHubRateLimitError;
    return Response.json(
      {
        error: "RATE_LIMITED",
        message: rateLimitErr.message,
        resetTime: rateLimitErr.resetTime,
      },
      { status: 429 }
    );
  }

  const message = err instanceof Error ? err.message : "Unknown error occurred.";
  let status = 500;
  if (message.includes("Invalid GitHub repository URL") || message.includes("404")) {
    status = 400;
  } else if (message.includes("403")) {
    status = 429;
  }

  return Response.json({ error: message, message }, { status });
}
