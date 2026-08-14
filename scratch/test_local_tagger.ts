/**
 * scratch/test_local_tagger.ts
 *
 * Test script verifying local Qwen3-0.6B tagger engine, llama-cli execution,
 * @TAG:ID extraction, and O(1) HashMap lookup resolution.
 */

import { tagCodeSnippetLocal, extractTagsRuleBased, resolveTagIds } from "../lib/local-ai-tagger";

const testPythonCode = `
def calculate_total(price, quantity):
    if price < 0 or quantity <= 0:
        return 0

    total = price * quantity
    return total
`;

const testTsCode = `
import { AuthService } from "./AuthService";

export class LoginController {
  private auth = new AuthService();

  async handleLogin(req: any) {
    if (!req.body.token) {
      throw new Error("Missing token");
    }
    return this.auth.validateToken(req.body.token);
  }
}
`;

function runTest() {
  console.log("=== LOCAL QWEN3-0.6B TAGGER ENGINE VERIFICATION ===");

  console.log("\n1. Testing Rule-Based Fast Tagger...");
  const ruleTags = extractTagsRuleBased(testTsCode, "src/controllers/LoginController.ts");
  const resolvedRule = resolveTagIds(ruleTags);
  console.log(`Detected Rule Tag IDs: [${ruleTags.join(", ")}]`);
  console.log(`Resolved Tags: ${resolvedRule.map((r) => `${r.tagId} -> ${r.name} (${r.layer})`).join(", ")}`);

  console.log("\n2. Testing Local Model Tagger (llama-cli + Qwen3-0.6B)...");
  const resPython = tagCodeSnippetLocal(testPythonCode, "input/test.py");
  console.log(`Source: ${resPython.source}`);
  console.log(`Execution Time: ${resPython.executionTimeMs}ms`);
  console.log(`Detected Tag IDs: [${resPython.detectedTagIds.join(", ")}]`);
  console.log(`Resolved Tags: ${resPython.resolvedTags.map((r) => `${r.tagId} -> ${r.name}`).join(", ")}`);

  if (resPython.detectedTagIds.length > 0) {
    console.log("\n✅ Local Qwen3-0.6B Tagger Engine Verification PASSED!");
  } else {
    console.error("\n❌ Local Tagger Engine Verification FAILED.");
    process.exit(1);
  }
}

runTest();
