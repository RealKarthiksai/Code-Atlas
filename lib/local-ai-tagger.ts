/**
 * lib/local-ai-tagger.ts
 *
 * Local Qwen3-0.6B Model Tagger Engine for Codebase Atlas.
 * Executes local llama-cli (/home/karthik/local-ai-lab/llama.cpp/build/bin/llama-cli)
 * with local model Qwen3-0.6B (/home/karthik/local-ai-lab/models/qwen3-0.6b/Qwen3-0.6B-Q8_0.gguf)
 * to annotate AST code entities with compact tag IDs (@TAG:AUTH, @TAG:LOGIN, @TAG:UI, @TAG:FN).
 * Resolves tag IDs via O(1) HashMap lookup table (lib/tag-dictionary.json).
 */

import { execFileSync } from "child_process";
import fs from "fs";
import tagDictionary from "./tag-dictionary.json";

export interface ResolvedTagInfo {
  tagId: string;
  name: string;
  layer: string;
  domain: string;
  description: string;
}

export interface TaggingResult {
  annotatedCode: string;
  detectedTagIds: string[];
  resolvedTags: ResolvedTagInfo[];
  executionTimeMs: number;
  source: "local-qwen3" | "fast-fallback";
}

const LLAMA_CLI_PATH = "/home/karthik/local-ai-lab/llama.cpp/build/bin/llama-cli";
const QWEN_MODEL_PATH = "/home/karthik/local-ai-lab/models/qwen3-0.6b/Qwen3-0.6B-Q8_0.gguf";

const SYSTEM_PROMPT = `Analyze the provided source code and identify semantic and structural concepts.
You MUST ONLY use these tag IDs:
FN = function
VAR = variable
IN = input
COND = conditional
VAL = validation
CALC = calculation
ERR = error-handling
RET = return-value
AUTH = authentication
LOGIN = login-flow
UI = frontend-ui
API = api-endpoint
DB = database-access
ROUTING = routing-guard
TYPE = type-definition
NOTIF = notification-dispatch
ORDER = order-management
PAY = payment-processing

Insert tags into the code using this exact format:
# @TAG:ID

Do not invent tag IDs. Do not explain the code. Do not modify original code logic.

Example:
# @TAG:FN
# @TAG:AUTH
function validateUserToken(token) {
  # @TAG:VAL
  if (!token) return false;
  # @TAG:RET
  return true;
}
`;

/**
 * Resolves a list of raw tag IDs (e.g. ["AUTH", "LOGIN", "FN"]) via HashMap lookup.
 */
export function resolveTagIds(tagIds: string[]): ResolvedTagInfo[] {
  const dictionary = tagDictionary as Record<string, { name: string; layer: string; domain: string; description: string }>;
  const resolved: ResolvedTagInfo[] = [];

  for (const rawId of tagIds) {
    const cleanId = rawId.toUpperCase().trim();
    if (dictionary[cleanId]) {
      const info = dictionary[cleanId];
      resolved.push({
        tagId: cleanId,
        name: info.name,
        layer: info.layer,
        domain: info.domain,
        description: info.description,
      });
    }
  }

  return resolved;
}

/**
 * Deterministic fast rule-based tag extractor fallback (<5ms).
 */
export function extractTagsRuleBased(codeSnippet: string, filePath = ""): string[] {
  const text = (codeSnippet + " " + filePath).toLowerCase();
  const tagSet = new Set<string>();

  if (text.includes("function") || text.includes("const ") || text.includes("=>") || text.includes("class ")) tagSet.add("FN");
  if (text.includes("login") || text.includes("signin")) {
    tagSet.add("LOGIN");
    tagSet.add("AUTH");
  }
  if (text.includes("auth") || text.includes("token") || text.includes("permission") || text.includes("session") || text.includes("guard")) {
    tagSet.add("AUTH");
  }
  if (filePath.endsWith(".tsx") || text.includes("render") || text.includes("jsx") || text.includes("component") || text.includes("view")) {
    tagSet.add("UI");
  }
  if (text.includes("route") || text.includes("router") || text.includes("navigate") || text.includes("page")) {
    tagSet.add("ROUTING");
    tagSet.add("API");
  }
  if (text.includes("save") || text.includes("db") || text.includes("repository") || text.includes("store")) {
    tagSet.add("DB");
  }
  if (text.includes("if ") || text.includes("switch") || text.includes("?") || text.includes("case ")) {
    tagSet.add("COND");
    tagSet.add("VAL");
  }
  if (text.includes("type ") || text.includes("interface ") || text.includes(".d.ts")) {
    tagSet.add("TYPE");
  }
  if (text.includes("order") || text.includes("cart") || text.includes("checkout")) {
    tagSet.add("ORDER");
  }
  if (text.includes("notify") || text.includes("email") || text.includes("send")) {
    tagSet.add("NOTIF");
  }

  return Array.from(tagSet);
}

/**
 * Annotates a code snippet using local Qwen3-0.6B via llama-cli (single turn -st).
 * Falls back to fast rule-based tagger if llama-cli fails or times out.
 */
export function tagCodeSnippetLocal(codeSnippet: string, filePath = ""): TaggingResult {
  const startTime = Date.now();
  const hasLocalModel = fs.existsSync(LLAMA_CLI_PATH) && fs.existsSync(QWEN_MODEL_PATH);

  if (hasLocalModel && codeSnippet.trim().length > 0) {
    try {
      const promptText = `/no-think\n\n${SYSTEM_PROMPT}\nCode to annotate:\n\`\`\`\n${codeSnippet.slice(0, 1200)}\n\`\`\`\n`;

      const output = execFileSync(
        LLAMA_CLI_PATH,
        [
          "-m", QWEN_MODEL_PATH,
          "-st",
          "-sys", "You are a code annotation tool. Insert # @TAG:ID comments using only valid tag IDs. Do not output thinking blocks.",
          "-p", promptText,
          "-n", "300",
          "--temp", "0.1",
          "--no-display-prompt",
        ],
        {
          encoding: "utf-8",
          timeout: 5000,
          stdio: ["pipe", "pipe", "ignore"],
        }
      );

      const matches = Array.from(output.matchAll(/@TAG:([A-Z]+)/g)).map((m) => m[1]);
      const detectedTagIds = Array.from(new Set(matches));

      if (detectedTagIds.length > 0) {
        return {
          annotatedCode: output,
          detectedTagIds,
          resolvedTags: resolveTagIds(detectedTagIds),
          executionTimeMs: Date.now() - startTime,
          source: "local-qwen3",
        };
      }
    } catch {
      // Fallback on timeout or error
    }
  }

  // Fast Fallback Tagger
  const fallbackIds = extractTagsRuleBased(codeSnippet, filePath);
  return {
    annotatedCode: codeSnippet,
    detectedTagIds: fallbackIds,
    resolvedTags: resolveTagIds(fallbackIds),
    executionTimeMs: Date.now() - startTime,
    source: "fast-fallback",
  };
}
