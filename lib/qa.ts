/**
 * lib/qa.ts
 *
 * Generates an AI-powered answer to user questions about a repository
 * using the Gemini API with a structured, context-aware prompt.
 * Supports flow-question classification, focusFiles extraction, flow summaries,
 * and key code snippets.
 */

import {
  analyzeFile,
  buildCodeIndex,
  getDefinitions,
  getCalls,
  type FunctionDefinition,
  type FunctionCall,
  type CodeIndex,
  type FileIntelligence,
} from "./code-intel";

import { type BuiltGraph, buildGraph, traverseTransitiveNeighborhood } from "./graph-builder";
import { enrichGraphNodes, type EnrichedCodeNode } from "./semantic-enricher";

export interface Snippet {
  path: string;
  content: string;
}

export interface AskQuestionInput {
  repoUrl: string;
  question: string;
  folders: string[];
  files: string[];
  snippets: Snippet[];
  codeIndex?: CodeIndex;
  builtGraph?: BuiltGraph;
}

export interface QaCodeSnippet {
  file: string;
  lines: [number, number]; // 1-based start and end line numbers
  code: string;
}

export interface QaResult {
  answer: string;
  referencedFiles: string[];
  focusFiles?: string[];
  summary?: string;
  isFlowQuestion?: boolean;
  codeSnippets?: QaCodeSnippet[];
  functionName?: string;
  definitions?: FunctionDefinition[];
  callSites?: FunctionCall[];
}

interface GeminiCandidate {
  content: { parts: { text: string }[] };
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  error?: { message: string };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FALLBACK_ANSWER =
  "Sorry, I couldn't generate an answer right now. Please verify your GEMINI_API_KEY or try again later.";

const GEMINI_MODEL = "gemini-3.1-flash-lite-preview";

const MAX_PROMPT_CHARS = 24_000;
const MAX_SNIPPET_CHARS = 3_000;

// ---------------------------------------------------------------------------
// Flow Classification Helper
// ---------------------------------------------------------------------------

const FLOW_KEYWORDS = [
  "flow",
  "how does",
  "how do",
  "how work",
  "how works",
  "where is",
  "where are",
  "where handled",
  "workflow",
  "pipeline",
  "process",
  "step",
  "execution",
  "sequence",
  "lifecycle",
  "trace",
  "architecture",
];

/**
 * Detects if a user question is asking about execution flow, workflow, or component handling.
 */
export function isFlowQuestion(question: string): boolean {
  const lower = question.toLowerCase();
  return FLOW_KEYWORDS.some((kw) => lower.includes(kw));
}

// ---------------------------------------------------------------------------
// Function Intent Classification Helper
// ---------------------------------------------------------------------------

export interface FunctionQueryIntent {
  intent: "definition" | "callers" | "general";
  functionName: string;
}

/**
 * Detects if a user question is asking about a specific function definition or call sites.
 */
export function detectFunctionQueryIntent(question: string): FunctionQueryIntent | null {
  const q = question.trim();

  // Pattern 1: Definition queries
  const defPatterns = [
    /where\s+is\s+(?:function\s+|method\s+)?['`"]?([a-zA-Z_$][a-zA-Z0-9_$]*)['`"]?\s+defined/i,
    /definition\s+of\s+(?:function\s+|method\s+)?['`"]?([a-zA-Z_$][a-zA-Z0-9_$]*)['`"]?/i,
    /find\s+definition\s+(?:of|for)\s+['`"]?([a-zA-Z_$][a-zA-Z0-9_$]*)['`"]?/i,
    /where\s+defined\s+['`"]?([a-zA-Z_$][a-zA-Z0-9_$]*)['`"]?/i,
  ];

  for (const p of defPatterns) {
    const m = q.match(p);
    if (m && m[1]) {
      return { intent: "definition", functionName: m[1] };
    }
  }

  // Pattern 2: Callers / Usage queries
  const callerPatterns = [
    /where\s+is\s+(?:function\s+|method\s+)?['`"]?([a-zA-Z_$][a-zA-Z0-9_$]*)['`"]?\s+called/i,
    /who\s+calls\s+(?:function\s+|method\s+)?['`"]?([a-zA-Z_$][a-zA-Z0-9_$]*)['`"]?/i,
    /show\s+(?:me\s+)?callers\s+(?:of|for)\s+['`"]?([a-zA-Z_$][a-zA-Z0-9_$]*)['`"]?/i,
    /callers\s+of\s+['`"]?([a-zA-Z_$][a-zA-Z0-9_$]*)['`"]?/i,
    /calls\s+to\s+['`"]?([a-zA-Z_$][a-zA-Z0-9_$]*)['`"]?/i,
    /where\s+used\s+['`"]?([a-zA-Z_$][a-zA-Z0-9_$]*)['`"]?/i,
  ];

  for (const p of callerPatterns) {
    const m = q.match(p);
    if (m && m[1]) {
      return { intent: "callers", functionName: m[1] };
    }
  }

  // Pattern 3: General function queries
  const generalPatterns = [
    /(?:how\s+does|what\s+does)\s+(?:function\s+|method\s+)?['`"]?([a-zA-Z_$][a-zA-Z0-9_$]*)['`"]?\s+(?:work|do|execute)/i,
  ];

  for (const p of generalPatterns) {
    const m = q.match(p);
    if (m && m[1]) {
      return { intent: "general", functionName: m[1] };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// System instruction
// ---------------------------------------------------------------------------

const SYSTEM_INSTRUCTION = `You are an assistant helping a developer understand a specific GitHub repository.
You are given the repository URL, a set of file paths, and selected file contents.
Answer the question ONLY using this context.
If something is not clear from the provided context, say so explicitly instead of guessing.

Answer style rules:
- Use 1–3 short paragraphs for your main explanation.
- Reference specific file paths (e.g. \`lib/parse.ts\`) and function/class names when relevant.
- At the very end of your response, output a JSON block like:
\`\`\`json
{
  "summary": "2-4 sentence overview explaining how this flow works",
  "focusFiles": ["lib/parse.ts", "commands/parse.ts"],
  "referencedFiles": ["lib/parse.ts", "commands/parse.ts"],
  "snippets": [
    {
      "file": "lib/parse.ts",
      "lines": [10, 22],
      "code": "export function parse(input) {\\n  return execute(input);\\n}"
    }
  ]
}
\`\`\`

JSON fields:
- "summary": A 2-4 sentence explanation of the workflow or architecture asked about.
- "focusFiles": The 2-6 most critical file paths involved in this execution flow.
- "referencedFiles": All file paths mentioned anywhere in your answer.
- "snippets": Up to 3 key code snippets (max 12 lines each) with file path, [startLine, endLine] (1-based), and trimmed code string.`;

// ---------------------------------------------------------------------------
// Helper: Parse text answer & JSON block
// ---------------------------------------------------------------------------

export function parseQaResponse(rawText: string, question = ""): QaResult {
  if (!rawText) {
    return { answer: FALLBACK_ANSWER, referencedFiles: [], isFlowQuestion: false, codeSnippets: [] };
  }

  let text = rawText;
  let referencedFiles: string[] = [];
  let focusFiles: string[] = [];
  let summary: string | undefined;
  let codeSnippets: QaCodeSnippet[] = [];

  const isFlow = isFlowQuestion(question);

  // Match JSON block at end of response ```json { ... } ```
  const jsonBlockRegex = /```(?:json)?\s*\n?\s*(\{[\s\S]*?"referencedFiles"[\s\S]*?\})\s*\n?```/i;
  const match = rawText.match(jsonBlockRegex);

  if (match) {
    try {
      const parsed = JSON.parse(match[1]);

      if (Array.isArray(parsed.referencedFiles)) {
        referencedFiles = parsed.referencedFiles.filter(
          (f: unknown): f is string => typeof f === "string" && f.trim().length > 0
        );
      }

      if (Array.isArray(parsed.focusFiles)) {
        focusFiles = parsed.focusFiles.filter(
          (f: unknown): f is string => typeof f === "string" && f.trim().length > 0
        );
      }

      if (typeof parsed.summary === "string" && parsed.summary.trim().length > 0) {
        summary = parsed.summary.trim();
      }

      const rawSnippets = parsed.snippets || parsed.codeSnippets;
      if (Array.isArray(rawSnippets)) {
        codeSnippets = rawSnippets
          .filter((s: unknown): s is Record<string, unknown> => typeof s === "object" && s !== null)
          .map((s) => {
            const file = typeof s.file === "string" ? s.file : "";
            const lines: [number, number] =
              Array.isArray(s.lines) && s.lines.length >= 2
                ? [Number(s.lines[0]) || 1, Number(s.lines[1]) || 1]
                : [1, 1];
            const code = typeof s.code === "string" ? s.code.trim() : "";
            return { file, lines, code };
          })
          .filter((s) => s.file.length > 0 && s.code.length > 0);
      }
    } catch {
      // ignore parse failure
    }
    text = rawText.replace(jsonBlockRegex, "").trim();
  } else {
    // Fallback regex for unformatted JSON `{ ... }` at end
    const fallbackMatch = rawText.match(/(\{[\s\S]*?"referencedFiles"[\s\S]*?\})/i);
    if (fallbackMatch) {
      try {
        const parsed = JSON.parse(fallbackMatch[1]);

        if (Array.isArray(parsed.referencedFiles)) {
          referencedFiles = parsed.referencedFiles.filter(
            (f: unknown): f is string => typeof f === "string" && f.trim().length > 0
          );
        }

        if (Array.isArray(parsed.focusFiles)) {
          focusFiles = parsed.focusFiles.filter(
            (f: unknown): f is string => typeof f === "string" && f.trim().length > 0
          );
        }

        if (typeof parsed.summary === "string" && parsed.summary.trim().length > 0) {
          summary = parsed.summary.trim();
        }

        const rawSnippets = parsed.snippets || parsed.codeSnippets;
        if (Array.isArray(rawSnippets)) {
          codeSnippets = rawSnippets
            .filter((s: unknown): s is Record<string, unknown> => typeof s === "object" && s !== null)
            .map((s) => {
              const file = typeof s.file === "string" ? s.file : "";
              const lines: [number, number] =
                Array.isArray(s.lines) && s.lines.length >= 2
                  ? [Number(s.lines[0]) || 1, Number(s.lines[1]) || 1]
                  : [1, 1];
              const code = typeof s.code === "string" ? s.code.trim() : "";
              return { file, lines, code };
            })
            .filter((s) => s.file.length > 0 && s.code.length > 0);
        }
      } catch {
        // ignore
      }
      text = rawText.replace(fallbackMatch[0], "").trim();
    }
  }

  if (focusFiles.length === 0) {
    focusFiles = [...referencedFiles];
  }

  return {
    answer: text,
    referencedFiles,
    focusFiles,
    summary,
    isFlowQuestion: isFlow,
    codeSnippets,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Answer a user's question about a codebase based on graph context
 * and file snippets. Returns structured answer text, referenced file paths,
 * flow focus metadata, and code snippets.
 */
export async function answerQuestion(
  input: AskQuestionInput
): Promise<QaResult> {
  // 1. Build or use provided CodeIndex
  let index: CodeIndex;
  if (input.codeIndex) {
    index = input.codeIndex;
  } else {
    const intelList: FileIntelligence[] = (input.snippets || []).map((s) =>
      analyzeFile({ path: s.path, content: s.content })
    );
    index = buildCodeIndex(intelList);
  }

  // 2. Check for function-level query intent
  const funcIntent = detectFunctionQueryIntent(input.question);

  let functionName: string | undefined;
  let definitions: FunctionDefinition[] = [];
  let callSites: FunctionCall[] = [];

  if (funcIntent) {
    functionName = funcIntent.functionName;
    definitions = getDefinitions(index, functionName);
    callSites = getCalls(index, functionName);
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    if (funcIntent && functionName) {
      return buildDeterministicFunctionResponse(functionName, definitions, callSites);
    }
    return buildDeterministicSubgraphResponse(input);
  }

  const userPrompt = buildUserPrompt(
    input,
    funcIntent && functionName ? { functionName, definitions, callSites } : undefined
  );

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: {
            parts: [{ text: SYSTEM_INSTRUCTION }],
          },
          contents: [{ parts: [{ text: userPrompt }] }],
          generationConfig: {
            maxOutputTokens: 1000,
            temperature: 0.2,
          },
        }),
      }
    );

    if (!res.ok) {
      const errText = await res.text();
      console.error(`Gemini Q&A API error (${res.status}):`, errText);
      if (funcIntent && functionName) {
        return buildDeterministicFunctionResponse(functionName, definitions, callSites);
      }
      return buildDeterministicSubgraphResponse(input);
    }

    const data = (await res.json()) as GeminiResponse;

    if (data.error) {
      console.error("Gemini Q&A API error:", data.error.message);
      if (funcIntent && functionName) {
        return buildDeterministicFunctionResponse(functionName, definitions, callSites);
      }
      return buildDeterministicSubgraphResponse(input);
    }

    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
    const parsed = parseQaResponse(rawText, input.question);

    return {
      ...parsed,
      functionName,
      definitions: definitions.length > 0 ? definitions : undefined,
      callSites: callSites.length > 0 ? callSites : undefined,
    };
  } catch (err) {
    console.error("Failed to generate Q&A response:", err);
    if (funcIntent && functionName) {
      return buildDeterministicFunctionResponse(functionName, definitions, callSites);
    }
    return buildDeterministicSubgraphResponse(input);
  }
}

// ---------------------------------------------------------------------------
// Deterministic Function Response Helper (when LLM unavailable or offline)
// ---------------------------------------------------------------------------

function buildDeterministicFunctionResponse(
  functionName: string,
  definitions: FunctionDefinition[],
  callSites: FunctionCall[]
): QaResult {
  const lines: string[] = [];
  const refFilesSet = new Set<string>();

  if (definitions.length > 0) {
    lines.push(`**\`${functionName}\`** is defined in:`);
    for (const d of definitions) {
      refFilesSet.add(d.file);
      lines.push(`- \`${d.file}\`${d.lineEnd ? ` (lines ${d.lineStart}–${d.lineEnd})` : ` (line ${d.lineStart})`}`);
    }
  } else {
    lines.push(`No definition for **\`${functionName}\`** was found in the indexed code files.`);
  }

  lines.push("");

  if (callSites.length > 0) {
    lines.push(`It is called in:`);
    for (const c of callSites) {
      refFilesSet.add(c.file);
      const callerStr = c.callerFunction ? ` inside \`${c.callerFunction}\`` : "";
      lines.push(`- \`${c.file}\` (line ${c.line}${callerStr})`);
    }
  } else {
    lines.push(`No call sites for **\`${functionName}\`** were found in the indexed code files.`);
  }

  const referencedFiles = Array.from(refFilesSet);

  return {
    answer: lines.join("\n"),
    referencedFiles,
    focusFiles: referencedFiles,
    summary: `Definition and call sites for function ${functionName}`,
    isFlowQuestion: true,
    functionName,
    definitions,
    callSites,
  };
}

/**
 * Generates a rich, deterministic out-of-the-box response using AST entity tags
 * and graph neighborhood traversal when Gemini API key is offline or unconfigured.
 */
function buildDeterministicSubgraphResponse(
  input: AskQuestionInput
): QaResult {
  const { question, snippets, builtGraph } = input;
  const qLower = question.toLowerCase();

  // 1. Build & enrich graph nodes with layer & domain tags
  const graph = builtGraph || buildGraph(snippets, "detailed");
  const enrichedNodes = enrichGraphNodes(graph.nodes);

  // 2. Identify target matching entities (by name, path, or layer/domain tags)
  const matchedNodes = enrichedNodes.filter((n) => {
    if (n.type === "folder") return false;
    const nameLower = n.name.toLowerCase();
    const pathLower = n.path.toLowerCase();
    const terms = qLower.split(/\s+/).filter((t) => t.length > 2);
    const isNameMatch = terms.some((term) => nameLower.includes(term) || pathLower.includes(term));
    const isDomainMatch = n.semantic.domains.some((d) => qLower.includes(d));
    return isNameMatch || isDomainMatch;
  });

  const seedNodes = matchedNodes.length > 0 ? matchedNodes : enrichedNodes.filter((n) => n.type === "file").slice(0, 5);
  const seedIds = seedNodes.map((n) => n.id);

  // 3. Transitive neighborhood expansion (up to 2 hops)
  const relevanceList = traverseTransitiveNeighborhood(graph, seedIds, 2);
  const connectedNodeIds = Array.from(new Set(relevanceList.map((r) => r.entityId)));

  const connectedNodes = enrichedNodes.filter((n) => connectedNodeIds.includes(n.id) || seedIds.includes(n.id));

  // 4. Categorize files & nodes by Architecture Layer Tags
  const layerGroups: Record<string, EnrichedCodeNode[]> = {};
  const refFilesSet = new Set<string>();

  for (const node of connectedNodes) {
    if (node.type !== "folder") {
      refFilesSet.add(node.path);
      const layer = node.semantic.layer;
      if (!layerGroups[layer]) layerGroups[layer] = [];
      layerGroups[layer].push(node);
    }
  }

  if (refFilesSet.size === 0) {
    snippets.slice(0, 5).forEach((s) => refFilesSet.add(s.path));
  }

  const referencedFiles = Array.from(refFilesSet);
  const focusFiles = referencedFiles.slice(0, 6);

  // 5. Build structured Markdown answer text
  const answerLines: string[] = [];
  answerLines.push(`### 🔍 Subgraph Code Intelligence for: *"${question}"*`);
  answerLines.push(`> **AST Entity Retrieval & Neighborhood Expansion** (Identified **${connectedNodes.length} code entities** across **${referencedFiles.length} files**)\n`);

  answerLines.push(`#### 📦 Architectural Layer & Domain Tags`);
  for (const [layer, nodes] of Object.entries(layerGroups)) {
    const layerLabel =
      layer === "frontend" ? "🎨 Frontend UI" :
      layer === "backend" ? "⚙️ Backend Service" :
      layer === "auth-security" ? "🔒 Auth & Security" :
      layer === "routing" ? "🚦 Routing & Middleware" :
      layer === "types" ? "🔷 Types & Interfaces" : "📄 Core Module";

    answerLines.push(`- **${layerLabel}**:`);
    for (const node of nodes.slice(0, 6)) {
      const tagBadge = node.semantic.tagIds && node.semantic.tagIds.length > 0
        ? ` ${node.semantic.tagIds.map((t) => `\`@TAG:${t}\``).join(" ")}`
        : "";
      const domainsTag = node.semantic.domains.length > 0 ? ` \`[${node.semantic.domains.join(", ")}]\`` : "";
      const lineStr = node.startLine ? ` *(lines ${node.startLine}–${node.endLine || node.startLine})*` : "";
      answerLines.push(`  - \`${node.name}\`${tagBadge}${domainsTag} in \`${node.path}\`${lineStr}`);
    }
  }

  if (relevanceList.length > 0) {
    answerLines.push(`\n#### 🔗 Transitive Dependency Neighborhood`);
    for (let i = 0; i < Math.min(6, relevanceList.length); i++) {
      const rel = relevanceList[i];
      const cleanPath = rel.path.map((p) => p.split("::").pop()).join(" ➔ ");
      answerLines.push(`- **Hop ${rel.distance}**: \`${cleanPath}\``);
    }
  }

  // Build Code Snippets
  const codeSnippets: QaCodeSnippet[] = [];
  for (const s of snippets.slice(0, 3)) {
    if (refFilesSet.has(s.path)) {
      const lineCount = s.content.split("\n").length;
      codeSnippets.push({
        file: s.path,
        lines: [1, Math.min(25, lineCount)],
        code: s.content.slice(0, 800),
      });
    }
  }

  return {
    answer: answerLines.join("\n"),
    referencedFiles,
    focusFiles,
    summary: `Identified ${connectedNodes.length} code entities and dependency neighborhood for "${question}"`,
    isFlowQuestion: isFlowQuestion(question),
    codeSnippets,
  };
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

function buildUserPrompt(
  input: AskQuestionInput,
  funcContext?: {
    functionName: string;
    definitions: FunctionDefinition[];
    callSites: FunctionCall[];
  }
): string {
  const { repoUrl, question, folders, files, snippets } = input;

  const topFolders =
    folders.length > 0
      ? folders.slice(0, 20).join(", ")
      : "(root level only)";

  let prompt = `## Repository
URL: ${repoUrl}
Top-level folders: ${topFolders}
Total source files (TS/JS): ${files.length}

`;

  if (funcContext && funcContext.functionName) {
    prompt += `## Code Intelligence Index (AST Extracted)
Target Function: \`${funcContext.functionName}\`

`;
    if (funcContext.definitions.length > 0) {
      prompt += `Definitions:\n`;
      prompt += funcContext.definitions
        .map((d) => `- ${d.file} (lines ${d.lineStart}–${d.lineEnd || d.lineStart}) [Export: ${d.isExport}]`)
        .join("\n");
      prompt += "\n\n";
    } else {
      prompt += `Definitions: None found in indexed files.\n\n`;
    }

    if (funcContext.callSites.length > 0) {
      prompt += `Call Sites:\n`;
      prompt += funcContext.callSites
        .map((c) => `- ${c.file} (line ${c.line}${c.callerFunction ? `, caller: ${c.callerFunction}` : ""})`)
        .join("\n");
      prompt += "\n\n";
    } else {
      prompt += `Call Sites: None found in indexed files.\n\n`;
    }
  }

  if (input.builtGraph) {
    const seedFiles = snippets.map((s) => s.path);
    const relevanceList = traverseTransitiveNeighborhood(input.builtGraph, seedFiles, 2);

    prompt += `### RETRIEVAL EVIDENCE PAYLOAD\n`;
    prompt += `Query: "${question}"\n\n`;
    prompt += `#### Relevant Entities & Transitive Paths (Top ${Math.min(15, relevanceList.length)}):\n`;

    for (let i = 0; i < Math.min(15, relevanceList.length); i++) {
      const rel = relevanceList[i];
      prompt += `${i + 1}. ${rel.entityId} (distance: ${rel.distance}, path: ${rel.path.join(" -> ")})\n`;
    }
    prompt += "\n";
  }

  const fileListLimit = 40;
  const displayFiles = files.slice(0, fileListLimit);
  prompt += `## File paths (showing ${displayFiles.length} of ${files.length})\n`;
  prompt += displayFiles.map((f) => `- ${f}`).join("\n");
  if (files.length > fileListLimit) {
    prompt += `\n- … and ${files.length - fileListLimit} more`;
  }
  prompt += "\n\n";

  prompt += `## Relevant file contents (${snippets.length} files)\n\n`;

  if (snippets.length === 0) {
    prompt +=
      "(No file content could be retrieved. Answer based on file paths and structure only.)\n\n";
  } else {
    let totalChars = prompt.length;

    for (const s of snippets) {
      const trimmed =
        s.content.length > MAX_SNIPPET_CHARS
          ? s.content.slice(0, MAX_SNIPPET_CHARS) + "\n...[truncated]"
          : s.content;

      const block = `### ${s.path}\n\`\`\`\n${trimmed}\n\`\`\`\n\n`;

      if (totalChars + block.length > MAX_PROMPT_CHARS) {
        prompt += `(Remaining snippets omitted to stay within context limits.)\n\n`;
        break;
      }

      prompt += block;
      totalChars += block.length;
    }
  }

  prompt += `## Question\n${question}\n`;

  return prompt;
}
