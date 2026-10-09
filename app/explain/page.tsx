"use client";

import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import type { DiffExplanation } from "@/lib/diff-explainer";
import RepoGraph from "@/app/repo/RepoGraph";
import { buildGraph } from "@/lib/graph-builder";
import { buildRepoUrl } from "@/lib/url-builder";
import FeatureUnavailable from "@/components/FeatureUnavailable";

const SAMPLE_DIFF = `diff --git a/lib/qa.ts b/lib/qa.ts
index a1b2c3d..e5f6g7h 100644
--- a/lib/qa.ts
+++ b/lib/qa.ts
@@ -340,6 +340,12 @@ export async function answerQuestion(
+  // Detect function query intent from user question
+  const funcIntent = detectFunctionQueryIntent(input.question);
+  if (funcIntent) {
+    const definitions = getDefinitions(index, funcIntent.functionName);
+    const callSites = getCalls(index, funcIntent.functionName);
+  }
`;

function ExplainDiffInner() {
  const searchParams = useSearchParams();
  const initialRepoUrl = searchParams.get("url") || "";

  const [diff, setDiff] = useState("");
  const [repoUrl, setRepoUrl] = useState(initialRepoUrl);
  const [prUrl, setPrUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isAiUnconfigured, setIsAiUnconfigured] = useState(false);
  const [explanation, setExplanation] = useState<DiffExplanation | null>(null);
  const [showGraph, setShowGraph] = useState(false);

  useEffect(() => {
    if (initialRepoUrl) {
      setRepoUrl(initialRepoUrl);
    }
  }, [initialRepoUrl]);

  // Build subgraph for affected modules
  const affectedGraph = useMemo(() => {
    if (!explanation || !explanation.affectedModules.length) return null;

    // Filter valid paths or file names
    const fileList = explanation.affectedModules.filter(
      (m) => m.includes(".") || m.includes("/")
    );
    const targetFiles = fileList.length > 0 ? fileList : explanation.affectedModules;

    return buildGraph(targetFiles, "detailed");
  }, [explanation]);

  async function handleSubmit(e?: React.FormEvent) {
    if (e) e.preventDefault();
    if (!diff.trim()) return;

    setLoading(true);
    setError(null);
    setIsAiUnconfigured(false);
    setExplanation(null);
    setShowGraph(false);

    try {
      const res = await fetch("/api/explain-diff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          diff: diff.trim(),
          repoUrl: repoUrl.trim() || undefined,
        }),
      });

      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        setIsAiUnconfigured(res.status === 503 || json.error === "AI_NOT_CONFIGURED");
        setError(json.message || json.error || `Failed to explain diff (${res.status})`);
      } else {
        setExplanation(json.explanation);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch diff explanation.");
    } finally {
      setLoading(false);
    }
  }

  function handleLoadSample() {
    setDiff(SAMPLE_DIFF.trim());
  }

  return (
    <main
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "2rem",
        padding: "3rem 2rem",
        maxWidth: "56rem",
        margin: "0 auto",
        color: "#f8fafc",
        minHeight: "100vh",
      }}
    >
      {/* Top Navbar */}
      <nav
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          paddingBottom: "1rem",
          borderBottom: "1px solid rgba(51, 65, 85, 0.4)",
        }}
      >
        <Link
          href="/"
          style={{
            color: "#38bdf8",
            textDecoration: "none",
            fontSize: "1rem",
            fontWeight: 600,
            fontFamily: "ui-monospace, monospace",
          }}
        >
          ← Codebase Atlas
        </Link>
        <div style={{ display: "flex", gap: "1.25rem", alignItems: "center" }}>
          <Link
            href="/explain"
            style={{
              color: "#38bdf8",
              textDecoration: "none",
              fontSize: "0.9rem",
              fontWeight: 600,
            }}
          >
            🔍 Explain Diff
          </Link>
          <Link
            href="/missions"
            style={{
              color: "#94a3b8",
              textDecoration: "none",
              fontSize: "0.9rem",
              fontWeight: 500,
            }}
          >
            🎯 Missions
          </Link>
          <Link
            href="/onboarding"
            style={{
              color: "#94a3b8",
              textDecoration: "none",
              fontSize: "0.9rem",
              fontWeight: 500,
            }}
          >
            🗺️ Onboarding
          </Link>
          <Link
            href="/saved"
            style={{
              color: "#94a3b8",
              textDecoration: "none",
              fontSize: "0.9rem",
              fontWeight: 500,
            }}
          >
            📌 Saved Views
          </Link>
          <Link
            href="/docs"
            style={{
              color: "#94a3b8",
              textDecoration: "none",
              fontSize: "0.9rem",
              fontWeight: 500,
            }}
          >
            📖 Docs
          </Link>
        </div>
      </nav>

      {/* Header section */}
      <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        <h1
          style={{
            margin: 0,
            fontSize: "1.75rem",
            fontWeight: 800,
            letterSpacing: "-0.02em",
            background: "linear-gradient(135deg, #f8fafc 0%, #38bdf8 100%)",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
          }}
        >
          Explain Diff
        </h1>
        <p style={{ margin: 0, color: "#94a3b8", fontSize: "0.95rem" }}>
          Paste a unified diff. Optionally include the repo URL for more context.
        </p>
      </div>

      {/* Input Form Card */}
      <form
        onSubmit={handleSubmit}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "1.25rem",
          padding: "1.5rem",
          borderRadius: "12px",
          background: "rgba(15, 23, 42, 0.85)",
          backdropFilter: "blur(12px)",
          border: "1px solid rgba(56, 189, 248, 0.25)",
          boxShadow: "0 8px 32px rgba(0, 0, 0, 0.4)",
        }}
      >
        {/* Repo & PR URL Inputs */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
            <label
              style={{
                fontSize: "0.78rem",
                fontWeight: 600,
                color: "#cbd5e1",
                fontFamily: "ui-monospace, monospace",
              }}
            >
              Repository URL (Optional)
            </label>
            <input
              type="text"
              placeholder="https://github.com/owner/repository"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              style={{
                padding: "0.6rem 0.85rem",
                borderRadius: "6px",
                background: "rgba(3, 7, 18, 0.8)",
                border: "1px solid rgba(51, 65, 85, 0.6)",
                color: "#f8fafc",
                fontSize: "0.85rem",
                fontFamily: "ui-monospace, monospace",
                outline: "none",
              }}
            />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
            <label
              style={{
                fontSize: "0.78rem",
                fontWeight: 600,
                color: "#cbd5e1",
                fontFamily: "ui-monospace, monospace",
              }}
            >
              Pull Request URL (Optional)
            </label>
            <input
              type="text"
              placeholder="https://github.com/owner/repository/pull/42"
              value={prUrl}
              onChange={(e) => setPrUrl(e.target.value)}
              style={{
                padding: "0.6rem 0.85rem",
                borderRadius: "6px",
                background: "rgba(3, 7, 18, 0.8)",
                border: "1px solid rgba(51, 65, 85, 0.6)",
                color: "#f8fafc",
                fontSize: "0.85rem",
                fontFamily: "ui-monospace, monospace",
                outline: "none",
              }}
            />
          </div>
        </div>

        {/* Diff Textarea */}
        <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <label
              style={{
                fontSize: "0.78rem",
                fontWeight: 600,
                color: "#cbd5e1",
                fontFamily: "ui-monospace, monospace",
              }}
            >
              Unified Diff Patch *
            </label>

            <button
              type="button"
              onClick={handleLoadSample}
              style={{
                background: "transparent",
                border: "none",
                color: "#38bdf8",
                fontSize: "0.75rem",
                cursor: "pointer",
                fontFamily: "ui-monospace, monospace",
                textDecoration: "underline",
              }}
            >
              Load Sample Diff
            </button>
          </div>

          <textarea
            rows={10}
            placeholder={`diff --git a/lib/qa.ts b/lib/qa.ts\n--- a/lib/qa.ts\n+++ b/lib/qa.ts\n@@ -10,3 +10,4 @@\n+ // add new feature`}
            value={diff}
            onChange={(e) => setDiff(e.target.value)}
            style={{
              padding: "0.75rem",
              borderRadius: "6px",
              background: "rgba(3, 7, 18, 0.9)",
              border: "1px solid rgba(51, 65, 85, 0.6)",
              color: "#38bdf8",
              fontSize: "0.85rem",
              fontFamily: "ui-monospace, SFMono-Regular, monospace",
              lineHeight: 1.5,
              resize: "vertical",
              outline: "none",
            }}
          />
        </div>

        {/* Submit Button */}
        <button
          type="submit"
          disabled={loading || !diff.trim()}
          style={{
            alignSelf: "flex-end",
            padding: "0.6rem 1.4rem",
            borderRadius: "6px",
            background: loading || !diff.trim() ? "#334155" : "#38bdf8",
            color: loading || !diff.trim() ? "#94a3b8" : "#0f172a",
            fontWeight: 700,
            fontSize: "0.88rem",
            border: "none",
            cursor: loading || !diff.trim() ? "not-allowed" : "pointer",
            fontFamily: "ui-monospace, monospace",
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
          }}
        >
          {loading ? "Analyzing diff..." : "🔍 Explain Diff"}
        </button>
      </form>

      {/* Error state banner */}
      {error && (
        isAiUnconfigured ? (
          <FeatureUnavailable
            featureName="Diff Explainer"
            message={error}
            requiredEnvVar="GEMINI_API_KEY"
            onRetry={handleSubmit}
          />
        ) : (
          <div
            style={{
              padding: "1rem 1.25rem",
              borderRadius: "8px",
              background: "#450a0a",
              border: "1px solid #991b1b",
              color: "#fca5a5",
              fontSize: "0.9rem",
            }}
          >
            ⚠️ {error}
          </div>
        )
      )}

      {/* Loading banner */}
      {loading && (
        <div
          style={{
            padding: "1.5rem",
            borderRadius: "8px",
            background: "rgba(15, 23, 42, 0.75)",
            border: "1px solid rgba(56, 189, 248, 0.3)",
            color: "#38bdf8",
            fontFamily: "ui-monospace, monospace",
            fontSize: "0.9rem",
            display: "flex",
            alignItems: "center",
            gap: "0.6rem",
          }}
        >
          <span>⏳ Analyzing architectural impact and generating structured explanation…</span>
        </div>
      )}

      {/* Structured Explanation Output */}
      {explanation && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "1.25rem",
            padding: "1.5rem",
            borderRadius: "12px",
            background: "rgba(15, 23, 42, 0.9)",
            border: "1px solid rgba(56, 189, 248, 0.3)",
            boxShadow: "0 8px 32px rgba(0, 0, 0, 0.4)",
          }}
        >
          {/* Summary Section */}
          <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
            <span
              style={{
                fontSize: "0.75rem",
                fontWeight: 700,
                color: "#38bdf8",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                fontFamily: "ui-monospace, monospace",
              }}
            >
              📝 High-Level Summary
            </span>
            <p
              style={{
                margin: 0,
                fontSize: "0.95rem",
                lineHeight: 1.6,
                color: "#f8fafc",
              }}
            >
              {explanation.summary}
            </p>
          </div>

          {/* Affected Modules */}
          {explanation.affectedModules.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
              <span
                style={{
                  fontSize: "0.75rem",
                  fontWeight: 700,
                  color: "#cbd5e1",
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  fontFamily: "ui-monospace, monospace",
                }}
              >
                📁 Affected Modules ({explanation.affectedModules.length})
              </span>

              <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
                {explanation.affectedModules.map((mod, idx) => (
                  <span
                    key={idx}
                    style={{
                      fontSize: "0.8rem",
                      padding: "0.2rem 0.6rem",
                      borderRadius: "4px",
                      background: "rgba(56, 189, 248, 0.12)",
                      color: "#38bdf8",
                      border: "1px solid rgba(56, 189, 248, 0.25)",
                      fontFamily: "ui-monospace, monospace",
                    }}
                  >
                    {mod}
                  </span>
                ))}
              </div>

              {/* Action Buttons: Show in graph & Focus in Main Repo */}
              <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", marginTop: "0.25rem" }}>
                <button
                  type="button"
                  onClick={() => setShowGraph(!showGraph)}
                  style={{
                    padding: "0.45rem 0.85rem",
                    borderRadius: "6px",
                    background: showGraph ? "rgba(56, 189, 248, 0.25)" : "rgba(56, 189, 248, 0.15)",
                    border: "1px solid rgba(56, 189, 248, 0.4)",
                    color: "#38bdf8",
                    fontSize: "0.82rem",
                    fontWeight: 600,
                    cursor: "pointer",
                    fontFamily: "ui-monospace, monospace",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "0.4rem",
                  }}
                >
                  🎯 {showGraph ? "Hide affected modules graph" : "Show affected modules in graph"}
                </button>

                {repoUrl && (
                  <Link
                    href={buildRepoUrl(repoUrl, {
                      focusFiles: explanation.affectedModules,
                      graphMode: "detailed",
                    })}
                    style={{
                      padding: "0.45rem 0.85rem",
                      borderRadius: "6px",
                      background: "rgba(52, 211, 153, 0.15)",
                      border: "1px solid rgba(52, 211, 153, 0.4)",
                      color: "#34d399",
                      fontSize: "0.82rem",
                      fontWeight: 600,
                      textDecoration: "none",
                      fontFamily: "ui-monospace, monospace",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "0.4rem",
                    }}
                  >
                    🗺️ Focus in Main Repo Graph →
                  </Link>
                )}
              </div>

              {/* Embedded Interactive Subgraph */}
              {showGraph && affectedGraph && (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "0.5rem",
                    padding: "1rem",
                    borderRadius: "8px",
                    background: "rgba(3, 7, 18, 0.8)",
                    border: "1px solid rgba(56, 189, 248, 0.3)",
                    marginTop: "0.5rem",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span
                      style={{
                        fontSize: "0.78rem",
                        fontWeight: 700,
                        color: "#38bdf8",
                        fontFamily: "ui-monospace, monospace",
                      }}
                    >
                      🎯 Affected Modules Subgraph ({affectedGraph.nodes.length} nodes)
                    </span>
                    <span style={{ fontSize: "0.72rem", color: "#94a3b8", fontFamily: "ui-monospace, monospace" }}>
                      Highlighted in cyan
                    </span>
                  </div>

                  <RepoGraph
                    nodes={affectedGraph.nodes}
                    edges={affectedGraph.edges}
                    highlightedFiles={explanation.affectedModules}
                  />
                </div>
              )}
            </div>
          )}

          {/* Key Changes */}
          {explanation.keyChanges.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
              <span
                style={{
                  fontSize: "0.75rem",
                  fontWeight: 700,
                  color: "#34d399",
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  fontFamily: "ui-monospace, monospace",
                }}
              >
                🔍 Key Architectural Changes
              </span>
              <ul
                style={{
                  margin: 0,
                  paddingLeft: "1.25rem",
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.35rem",
                  fontSize: "0.9rem",
                  color: "#e2e8f0",
                }}
              >
                {explanation.keyChanges.map((change, idx) => (
                  <li key={idx}>{change}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Risks & Reviewer Notice */}
          {explanation.risks.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
              <span
                style={{
                  fontSize: "0.75rem",
                  fontWeight: 700,
                  color: "#fbbf24",
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  fontFamily: "ui-monospace, monospace",
                }}
              >
                ⚠️ Risks & Reviewer Considerations
              </span>
              <ul
                style={{
                  margin: 0,
                  paddingLeft: "1.25rem",
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.35rem",
                  fontSize: "0.9rem",
                  color: "#fef08a",
                }}
              >
                {explanation.risks.map((risk, idx) => (
                  <li key={idx}>{risk}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </main>
  );
}

export default function ExplainDiffPage() {
  return (
    <Suspense
      fallback={
        <div
          style={{
            padding: "3rem",
            textAlign: "center",
            color: "#38bdf8",
            fontFamily: "ui-monospace, monospace",
          }}
        >
          Loading Explain Diff…
        </div>
      }
    >
      <ExplainDiffInner />
    </Suspense>
  );
}
