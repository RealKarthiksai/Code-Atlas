/**
 * scripts/test-200plus-indexing.ts
 *
 * Verifies full repository indexing on a real repo with 200+ files (fastify/fastify).
 * Measures time taken, total files, indexed files, entity count, skipped file breakdown,
 * and confirms that the Top Functions panel reflects the whole repo.
 */

import { executeAnalyzePipeline } from "../app/api/analyze/route";

async function main() {
  const repoUrl = "https://github.com/fastify/fastify";
  console.log(`\n======================================================`);
  console.log(`Testing Full Repository Source File Indexing on 200+ File Repo`);
  console.log(`Repository: ${repoUrl}`);
  console.log(`======================================================\n`);

  const progressEvents: any[] = [];
  const startTime = Date.now();

  const result = await executeAnalyzePipeline(repoUrl, {
    maxFiles: 2000,
    onProgress: (p) => {
      progressEvents.push({ ...p, time: Date.now() - startTime });
      if (p.percentage % 20 === 0 || p.stage === "complete") {
        console.log(`  [Progress ${p.percentage}%] ${p.stage}: ${p.message}`);
      }
    },
  });

  const durationMs = Date.now() - startTime;
  const entityCount = Object.keys(result.functionIndex || {}).length;
  const topFunctions = result.functionCounts?.allFunctions.slice(0, 10) || [];

  console.log(`\n--- Verification Metrics ---`);
  console.log(`Time Taken:             ${(durationMs / 1000).toFixed(2)}s (${durationMs} ms)`);
  console.log(`Total Repo Files:       ${result.totalRepoFiles}`);
  console.log(`Total Eligible Files:   ${result.totalEligibleFiles}`);
  console.log(`Indexed Files:          ${result.indexedFileCount || result.files.length}`);
  console.log(`Max Files Cap:          ${result.maxFilesCap}`);
  console.log(`Cap Hit:                ${result.capHit}`);
  console.log(`Entity Count (AST):     ${entityCount} indexed functions/methods`);
  console.log(`Total Progress Events:  ${progressEvents.length}`);

  console.log(`\n--- Skipped Files Breakdown ---`);
  console.log(`Total Skipped:          ${result.skippedStats?.totalSkipped}`);
  console.log(`  - Vendored:           ${result.skippedStats?.vendored}`);
  console.log(`  - Generated:          ${result.skippedStats?.generated}`);
  console.log(`  - Lockfiles:          ${result.skippedStats?.lockfiles}`);
  console.log(`  - Binary:             ${result.skippedStats?.binary}`);
  console.log(`  - Huge (>500KB):      ${result.skippedStats?.huge}`);
  console.log(`  - Unsupported:        ${result.skippedStats?.unsupported}`);

  console.log(`\n--- Top Functions Panel (Reflects Whole Repository) ---`);
  topFunctions.forEach((fn, idx) => {
    console.log(
      `  ${idx + 1}. ${fn.name.padEnd(25)} Calls: ${String(fn.count).padStart(5)}  Files: ${fn.files.length}`
    );
  });

  // Assertions
  if ((result.indexedFileCount || result.files.length) < 200) {
    console.error(`FAIL: Expected at least 200 indexed files, got ${result.indexedFileCount}`);
    process.exit(1);
  }

  if (entityCount < 500) {
    console.error(`FAIL: Expected at least 500 AST entities, got ${entityCount}`);
    process.exit(1);
  }

  if (topFunctions.length === 0 || topFunctions[0].count < 100) {
    console.error(`FAIL: Top functions does not reflect full repo call counts`);
    process.exit(1);
  }

  console.log(`\n✅ ALL 200+ REPOSITORY INDEXING CHECKS PASSED!\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
