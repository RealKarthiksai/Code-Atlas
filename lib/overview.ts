/**
 * lib/overview.ts
 *
 * Generates a short AI-powered overview of a GitHub repository
 * using the Gemini API (via native fetch, no SDK required).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The structured input we send to the LLM. */
export interface OverviewInput {
  repoUrl: string;
  /** Top-level folder names within the analysis scope. */
  folders: string[];
  /** A small sample of TypeScript file paths (≤20). */
  sampleFiles: string[];
}

// ---------------------------------------------------------------------------
// Gemini API types (minimal, just what we need)
// ---------------------------------------------------------------------------

interface GeminiCandidate {
  content: { parts: { text: string }[] };
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  error?: { message: string };
}

// ---------------------------------------------------------------------------
export class AiNotConfiguredError extends Error {
  readonly code = "AI_NOT_CONFIGURED";
  constructor(message = "Set GEMINI_API_KEY to enable this feature") {
    super(message);
    this.name = "AiNotConfiguredError";
  }
}

const GEMINI_MODEL = "gemini-3.1-flash-lite-preview";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a ≤150-word plain-English overview of a repository.
 *
 * Uses a single Gemini API call. Throws AiNotConfiguredError if GEMINI_API_KEY
 * is not set, or Error if the upstream Gemini API request fails.
 *
 * @param input.repoUrl    - Full GitHub URL
 * @param input.folders    - Top-level folder names in scope
 * @param input.sampleFiles - Up to 20 representative TS file paths
 */
export async function generateOverview(input: OverviewInput): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new AiNotConfiguredError();
  }

  const prompt = buildPrompt(input);

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: 300,
          temperature: 0.3,
        },
      }),
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    console.error(`Gemini API error (${res.status}):`, errText);
    throw new Error(`Gemini API error (${res.status}): ${errText}`);
  }

  const data = (await res.json()) as GeminiResponse;

  if (data.error) {
    console.error("Gemini API returned error:", data.error.message);
    throw new Error(`Gemini API returned error: ${data.error.message}`);
  }

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!text) {
    throw new Error("Gemini returned empty overview response.");
  }
  return text;
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

function buildPrompt(input: OverviewInput): string {
  const { repoUrl, folders, sampleFiles } = input;

  const folderList =
    folders.length > 0
      ? folders.join(", ")
      : "(no sub-folders — files are at the root)";

  const fileList = sampleFiles.map((f) => `  - ${f}`).join("\n");

  return `You are a senior software engineer. Given the following information about a GitHub repository, write a concise overview in plain English (150 words max).

Repository URL: ${repoUrl}

Top-level folders: ${folderList}

Sample source files (TS/JS):
${fileList}

Instructions:
- Identify the likely tech stack (frameworks, languages, tools) based on file paths.
- Describe the main parts of the codebase and their probable purpose.
- If something is not clear from the file paths alone, say "not clear" rather than guessing.
- Do NOT use markdown formatting — plain text only.
- Keep it under 150 words.`;
}
