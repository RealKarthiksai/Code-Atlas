/**
 * scripts/test-cap.ts
 *
 * Verifies that configuring a low maxFiles cap (e.g. 50 files) sets capHit: true,
 * indexes exactly 50 files, and accurately reports totalEligibleFiles > 50.
 */

import { executeAnalyzePipeline } from "../app/api/analyze/route";

async function main() {
  const repoUrl = "https://github.com/fastify/fastify";
  const result = await executeAnalyzePipeline(repoUrl, { maxFiles: 50 });

  console.log("=== Cap Test Verification ===");
  console.log("Total Eligible Files: ", result.totalEligibleFiles);
  console.log("Indexed File Count:   ", result.indexedFileCount);
  console.log("Max Files Cap:        ", result.maxFilesCap);
  console.log("Cap Hit:              ", result.capHit);
  console.log("Files in result:      ", result.files.length);

  if (result.capHit !== true) {
    console.error("FAIL: Expected capHit to be true");
    process.exit(1);
  }

  if (result.indexedFileCount !== 50 || result.files.length !== 50) {
    console.error(`FAIL: Expected 50 files, got ${result.indexedFileCount}`);
    process.exit(1);
  }

  if ((result.totalEligibleFiles || 0) < 200) {
    console.error(`FAIL: Expected totalEligibleFiles >= 200, got ${result.totalEligibleFiles}`);
    process.exit(1);
  }

  console.log("\nPASS: Indexing cap correctly enforces cap limit and reports capHit!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
