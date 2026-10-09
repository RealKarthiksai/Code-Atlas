/**
 * POST /api/analyze
 *
 * Accepts { repoUrl: string }, fetches the repo's file tree from GitHub,
 * collects TypeScript files, generates an AI overview, and returns a
 * basic graph structure.
 */
import {
  parseGitHubUrl,
  fetchRepoTree,
  buildAnalyzeResult,
  fetchFileContent,
  GitHubRateLimitError,
} from "@/lib/github";
import { generateOverview, AiNotConfiguredError } from "@/lib/overview";
import { countFunctionCalls } from "@/lib/ast-counts";
import { buildFunctionIndexRecord } from "@/lib/ast-intel";

export async function POST(request: Request) {
  let body: { repoUrl?: string };

  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "Invalid JSON body." },
      { status: 400 }
    );
  }

  const { repoUrl } = body;

  if (!repoUrl) {
    return Response.json(
      { error: "repoUrl is required." },
      { status: 400 }
    );
  }

  try {
    // 1. Parse the GitHub URL into owner/repo
    const { owner, repo } = parseGitHubUrl(repoUrl);

    // 2. Fetch the full recursive tree via the Git Trees API (one request)
    const tree = await fetchRepoTree(owner, repo);

    // 3. Build the analysis result (TS files + graph)
    const result: any = buildAnalyzeResult(tree);

    // 4. Concurrently fetch content for sample files to calculate function/hook counts & detailed index
    const sampleFiles = result.files.slice(0, 15);
    const snippetPromises = sampleFiles.map(async (filePath: string) => {
      const content = await fetchFileContent(owner, repo, filePath, 4000);
      return content ? { path: filePath, content } : null;
    });

    const snippetResults = await Promise.all(snippetPromises);
    const fetchedFiles = snippetResults.filter(
      (s): s is { path: string; content: string } => s !== null
    );

    if (fetchedFiles.length > 0) {
      result.functionCounts = countFunctionCalls(fetchedFiles);
      result.functionIndex = buildFunctionIndexRecord(fetchedFiles);
    }

    // 5. Generate an AI overview (if configured)
    const folders = result.graph.nodes
      .filter((n: any) => n.type === "folder")
      .map((n: any) => n.label);

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

    return Response.json(result);
  } catch (err: unknown) {
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

    const message =
      err instanceof Error ? err.message : "Unknown error occurred.";

    let status = 500;
    if (
      message.includes("Invalid GitHub repository URL") ||
      message.includes("404")
    ) {
      status = 400;
    } else if (message.includes("403")) {
      status = 429;
    }

    return Response.json({ error: message, message }, { status });
  }
}
