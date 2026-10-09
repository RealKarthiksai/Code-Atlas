/**
 * scripts/test-rate-limit.ts
 *
 * Simulates GitHub returning HTTP 403 with x-ratelimit-reset header,
 * proving that GitHubRateLimitError is thrown and /api/analyze returns HTTP 429.
 */

import { fetchRepoTree, GitHubRateLimitError } from "../lib/github";
import { POST as analyzePost } from "../app/api/analyze/route";

async function run() {
  console.log("=== TEST 1: fetchRepoTree throws typed GitHubRateLimitError on HTTP 403 ===");
  
  const originalFetch = global.fetch;
  const mockResetEpoch = Math.floor(Date.now() / 1000) + 1800; // 30 minutes from now

  // Mock fetch to simulate GitHub 403 rate limit
  global.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    return new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
      status: 403,
      headers: {
        "x-ratelimit-reset": mockResetEpoch.toString(),
        "content-type": "application/json",
      },
    });
  };

  try {
    await fetchRepoTree("facebook", "react");
    console.error("FAIL: Expected fetchRepoTree to throw GitHubRateLimitError");
    process.exit(1);
  } catch (err: any) {
    if (err instanceof GitHubRateLimitError && err.code === "RATE_LIMITED") {
      console.log("PASS: Successfully caught GitHubRateLimitError!");
      console.log("  error.code:", err.code);
      console.log("  error.resetEpoch:", err.resetEpoch);
      console.log("  error.resetTime:", err.resetTime);
      console.log("  error.message:", err.message);
    } else {
      console.error("FAIL: Caught unexpected error:", err);
      process.exit(1);
    }
  }

  console.log("\n=== TEST 2: /api/analyze returns HTTP 429 on RATE_LIMITED ===");
  const fakeReq = new Request("http://localhost:3002/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoUrl: "https://github.com/facebook/react" }),
  });

  const analyzeRes = await analyzePost(fakeReq);
  const status = analyzeRes.status;
  const data = await analyzeRes.json();

  console.log("  HTTP status:", status);
  console.log("  Response body:", JSON.stringify(data, null, 2));

  if (status === 429 && data.error === "RATE_LIMITED" && data.message && data.resetTime) {
    console.log("PASS: /api/analyze returned HTTP 429 with actionable resetTime and message!");
  } else {
    console.error("FAIL: /api/analyze did not return expected 429 structure");
    process.exit(1);
  }

  // Restore fetch
  global.fetch = originalFetch;
  console.log("\nAll rate-limit verification checks PASSED!");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
