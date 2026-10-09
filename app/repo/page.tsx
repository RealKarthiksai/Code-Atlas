"use client";

import { Suspense, useState, useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import RepoGraph from "./RepoGraph";
import InfoPanel from "./InfoPanel";
import GraphExplanation from "./GraphExplanation";
import CopyLinkButton from "./CopyLinkButton";
import SaveViewButton from "./SaveViewButton";
import SavedViewsList from "./SavedViewsList";
import FileViewerModal from "./FileViewerModal";
import CreateGuideModal from "./CreateGuideModal";
import OnboardingGuideView from "./OnboardingGuideView";
import RepoDocsList from "./RepoDocsList";
import DocsPageViewModal from "./DocsPageViewModal";
import TopFunctionsPanel from "./TopFunctionsPanel";
import FunctionDetailModal from "./FunctionDetailModal";
import Graph3D from "./Graph3D";
import RepoNavigatorChat from "./RepoNavigatorChat";
import RepoAgentChat from "./RepoAgentChat";
import FeatureUnavailable from "@/components/FeatureUnavailable";
import { getDocsPagesForRepo, type DocsPage } from "@/lib/docs-pages";
import { buildGraph, buildFocusSubgraph, type GraphMode } from "@/lib/graph-builder";
import { buildRepoUrl, parseRepoViewState } from "@/lib/url-builder";
import { type QaCodeSnippet } from "@/lib/qa";
import { type MonorepoInfo } from "@/lib/monorepo";
import { type FunctionDefinition, type FunctionCall } from "@/lib/code-intel";
import {
  getRecentAnalyses,
  addRecentAnalysis,
  formatRepoName,
  type RecentAnalysis,
} from "@/lib/recent-analyses";

// ---------------------------------------------------------------------------
// Types matching the /api/analyze response
// ---------------------------------------------------------------------------

interface GraphNode {
  id: string;
  label: string;
  type: "file" | "folder" | "workspace";
}

interface GraphEdge {
  from: string;
  to: string;
}

import { type FunctionIndexRecord } from "@/lib/ast-intel";
import { type RepoLanguageHint } from "@/lib/language-plugins";

interface AnalyzeResponse {
  overview: string;
  files: string[];
  graph: { nodes: GraphNode[]; edges: GraphEdge[] };
  noSupportedFiles?: boolean;
  repoGuide?: {
    type: "cli" | "react-app" | "express-api" | "other";
    label: string;
    recommendedQuestions: string[];
  };
  monorepoInfo?: MonorepoInfo;
  detectedLanguages?: RepoLanguageHint[];
  functionCounts?: {
    allFunctions: { name: string; count: number; files: string[] }[];
    hooks?: { name: string; count: number; files: string[] }[];
  };
  functionIndex?: FunctionIndexRecord;
  aiConfigured?: boolean;
  aiError?: { error: string; message: string };
}

// ---------------------------------------------------------------------------
// Suspense wrapper (useSearchParams requires a Suspense boundary)
// ---------------------------------------------------------------------------

export default function RepoPage() {
  return (
    <Suspense
      fallback={
        <main
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            minHeight: "100vh",
            color: "#94a3b8",
          }}
        >
          Loading…
        </main>
      }
    >
      <RepoPageInner />
    </Suspense>
  );
}

// ---------------------------------------------------------------------------
// Inner page component
// ---------------------------------------------------------------------------

function RepoPageInner() {
  const searchParams = useSearchParams();

  // Safely parse and validate URL view state with fallback defaults
  const { repoUrl, graphMode: urlGraphMode, focusFile, focusFiles: urlFocusFiles, lines, doc, func } =
    parseRepoViewState(searchParams);
  const rawFocusFiles = searchParams.get("focusFiles");

  // --- Analyze state ---
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<AnalyzeResponse | null>(null);

  // --- Q&A state ---
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const [referencedFiles, setReferencedFiles] = useState<string[]>([]);
  const [focusFiles, setFocusFiles] = useState<string[]>([]);
  const [summary, setSummary] = useState<string | null>(null);
  const [codeSnippets, setCodeSnippets] = useState<QaCodeSnippet[]>([]);
  const [askError, setAskError] = useState<string | null>(null);
  const [qaFunctionName, setQaFunctionName] = useState<string | null>(null);
  const [qaDefinitions, setQaDefinitions] = useState<FunctionDefinition[]>([]);
  const [qaCallSites, setQaCallSites] = useState<FunctionCall[]>([]);

  // --- Graph Section Ref & Highlighted Files ---
  const graphSectionRef = useRef<HTMLDivElement>(null);
  const [highlightedFiles, setHighlightedFiles] = useState<string[]>(
    urlFocusFiles.length > 0 ? urlFocusFiles : focusFile ? [focusFile] : []
  );
  const [viewModalFile, setViewModalFile] = useState<string | null>(focusFile);

  // --- Graph Mode state ("high-level" | "detailed") ---
  const [graphMode, setGraphMode] = useState<GraphMode>(urlGraphMode);

  // --- Dimension Mode state ("2D" | "3D") ---
  const [dimensionMode, setDimensionMode] = useState<"2D" | "3D">("2D");

  // --- Main Repo Tab state ("overview" | "docs" | "navigator" | "agent") ---
  const [activeTab, setActiveTab] = useState<"overview" | "docs" | "navigator" | "agent">("overview");

  // --- Saved views refresh key (bumped when a new view is saved) ---
  const [savedViewsRefreshKey, setSavedViewsRefreshKey] = useState(0);

  // --- Onboarding guide modal state & refresh key ---
  const [createGuideOpen, setCreateGuideOpen] = useState(false);
  const [onboardingGuideRefreshKey, setOnboardingGuideRefreshKey] = useState(0);
  const questionInputRef = useRef<HTMLTextAreaElement>(null);

  // --- Living Docs page selection state ---
  const [selectedDocsPage, setSelectedDocsPage] = useState<DocsPage | null>(null);

  // --- Function detail selection state ---
  const [selectedFunctionName, setSelectedFunctionName] = useState<string | null>(func);

  // Rebuild graph dynamically based on active graphMode and file list
  const activeGraph = data ? buildGraph(data.files, graphMode, data.monorepoInfo, data.functionIndex, highlightedFiles) : null;

  // Build isolated flow subgraph when focusFiles are present from Q&A
  const focusSubgraph = data && focusFiles.length > 0
    ? buildFocusSubgraph(data.files, focusFiles)
    : null;

  function handleModeToggle(newMode: GraphMode) {
    setGraphMode(newMode);
    if (repoUrl) {
      const newUrl = buildRepoUrl(repoUrl, {
        graphMode: newMode,
        focusFile,
        focusFiles: highlightedFiles.length > 0 ? highlightedFiles : undefined,
      });
      window.history.replaceState({}, "", newUrl);
    }
  }

  function handleShowInGraph() {
    setGraphMode("detailed");
    const targets = focusFiles.length > 0 ? focusFiles : referencedFiles;
    if (targets.length > 0) {
      setHighlightedFiles(targets);
    }
    if (repoUrl) {
      const newUrl = buildRepoUrl(repoUrl, {
        graphMode: "detailed",
        focusFiles: targets,
      });
      window.history.replaceState({}, "", newUrl);
    }
    if (graphSectionRef.current) {
      graphSectionRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function handleOpenInFullGraph() {
    if (!repoUrl || focusFiles.length === 0) return;
    setGraphMode("detailed");
    setHighlightedFiles(focusFiles);
    const newUrl = buildRepoUrl(repoUrl, {
      graphMode: "detailed",
      focusFiles,
    });
    window.history.replaceState({}, "", newUrl);
    if (graphSectionRef.current) {
      graphSectionRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function handleApplyStepView(newMode: GraphMode, targets: string[]) {
    setGraphMode(newMode);
    setHighlightedFiles(targets);
    if (repoUrl) {
      const newUrl = buildRepoUrl(repoUrl, {
        graphMode: newMode,
        focusFiles: targets,
      });
      window.history.replaceState({}, "", newUrl);
    }
    if (graphSectionRef.current) {
      graphSectionRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function handleSelectQuestion(q: string) {
    setQuestion(q);
    if (questionInputRef.current) {
      questionInputRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
      questionInputRef.current.focus();
    }
  }

  function handleSelectFunctionCall(functionName: string) {
    setSelectedFunctionName(functionName);
    if (repoUrl) {
      const newUrl = buildRepoUrl(repoUrl, {
        func: functionName,
        graphMode,
        focusFiles: highlightedFiles,
      });
      window.history.replaceState({}, "", newUrl);
    }
  }

  useEffect(() => {
    if (func) {
      setSelectedFunctionName(func);
    }
  }, [func]);

  function handleOpenDocsPage(page: DocsPage) {
    setSelectedDocsPage(page);
    if (repoUrl) {
      const newUrl = buildRepoUrl(repoUrl, {
        doc: page.slug,
        graphMode: page.graphMode,
        focusFiles: page.focusFiles,
      });
      window.history.replaceState({}, "", newUrl);
    }
  }

  // Load doc from URL param on mount / parameter change
  useEffect(() => {
    if (repoUrl && doc) {
      const pages = getDocsPagesForRepo(repoUrl);
      const found = pages.find((p) => p.slug === doc);
      if (found) {
        setSelectedDocsPage(found);
      }
    }
  }, [repoUrl, doc]);

  function handleJumpToCode(file: string, startLine: number, endLine: number) {
    if (!repoUrl) return;
    setGraphMode("detailed");
    setHighlightedFiles([file]);
    setViewModalFile(file);
    const newUrl = buildRepoUrl(repoUrl, {
      graphMode: "detailed",
      focusFile: file,
      lines: `${startLine}-${endLine}`,
    });
    window.history.replaceState({}, "", newUrl);
  }

  // Handle URL query parameters sync on load or navigation
  useEffect(() => {
    setGraphMode(urlGraphMode);
    const combined = urlFocusFiles.length > 0 ? urlFocusFiles : focusFile ? [focusFile] : [];
    if (combined.length > 0) {
      setHighlightedFiles(combined);
    }
  }, [urlGraphMode, focusFile, rawFocusFiles]);

  // --- Recent Analyses state ---
  const [recents, setRecents] = useState<RecentAnalysis[]>([]);

  useEffect(() => {
    setRecents(getRecentAnalyses());
  }, []);

  // --- Fetch repository analysis on mount ---
  useEffect(() => {
    if (!repoUrl) {
      setLoading(false);
      return;
    }

    let cancelled = false;

    async function analyze() {
      setLoading(true);
      setError(null);

      try {
        const res = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repoUrl }),
        });

        const json = await res.json();

        if (cancelled) return;

        if (!res.ok || json.error) {
          setError(json.message ?? json.error ?? `Analysis request failed with status ${res.status}`);
        } else {
          setData(json as AnalyzeResponse);
          if (repoUrl) {
            const updated = addRecentAnalysis(repoUrl);
            setRecents(updated);
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Unknown error during analysis.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    analyze();
    return () => {
      cancelled = true;
    };
  }, [repoUrl]);

  // --- Handler: submit question to /api/ask ---
  async function handleAsk(overrideQuestion?: string) {
    const targetQuestion = (overrideQuestion || question).trim();
    if (!targetQuestion || asking || !repoUrl) return;

    if (overrideQuestion) {
      setQuestion(overrideQuestion);
    }

    setAsking(true);
    setAskError(null);
    setAnswer(null);
    setReferencedFiles([]);
    setFocusFiles([]);
    setSummary(null);
    setCodeSnippets([]);
    setQaFunctionName(null);
    setQaDefinitions([]);
    setQaCallSites([]);

    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoUrl, question: targetQuestion }),
      });

      const json = await res.json();

      if (!res.ok || json.error) {
        setAskError(json.error ?? `Q&A request failed with status ${res.status}`);
      } else {
        setAnswer(json.answer);
        setReferencedFiles(json.referencedFiles || []);
        setFocusFiles(json.focusFiles || []);
        setSummary(json.summary || null);
        setCodeSnippets(json.codeSnippets || []);
        setQaFunctionName(json.functionName || null);
        setQaDefinitions(json.definitions || []);
        setQaCallSites(json.callSites || []);
      }
    } catch (err) {
      setAskError(err instanceof Error ? err.message : "Failed to fetch Q&A answer.");
    } finally {
      setAsking(false);
    }
  }

  // --- Missing or invalid URL ---
  if (!repoUrl) {
    return (
      <main
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          minHeight: "100vh",
          padding: "2rem",
          gap: "1.5rem",
        }}
      >
        <div
          style={{
            padding: "1.5rem",
            borderRadius: "8px",
            background: "#450a0a",
            border: "1px solid #991b1b",
            color: "#fca5a5",
            maxWidth: "36rem",
            textAlign: "center",
          }}
        >
          <h2 style={{ fontSize: "1.25rem", fontWeight: 700, color: "#fecaca", marginBottom: "0.75rem" }}>
            Missing Repository URL
          </h2>
          <p style={{ margin: 0, lineHeight: 1.6 }}>
            Please go back and enter a valid GitHub repository URL.
          </p>
          <p style={{ margin: "0.75rem 0 0", fontSize: "0.9rem", color: "#fecaca" }}>
            Expected format:{" "}
            <code style={{ fontFamily: "monospace" }}>
              /repo?url=https%3A%2F%2Fgithub.com%2Fowner%2Frepo
            </code>
          </p>
        </div>
        <a
          href="/"
          style={{
            display: "inline-block",
            padding: "0.6rem 1.5rem",
            borderRadius: "6px",
            background: "#2563eb",
            color: "#ffffff",
            textDecoration: "none",
            fontWeight: 600,
          }}
        >
          ← Go to Home
        </a>
      </main>
    );
  }

  return (
    <main
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "2rem",
        padding: "2rem",
        maxWidth: "64rem",
        margin: "0 auto",
      }}
    >
      {/* 1. Header */}
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          flexWrap: "wrap",
          gap: "1rem",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
          <h1 style={{ fontSize: "1.75rem", fontWeight: 700 }}>Repository</h1>
          <p style={{ wordBreak: "break-all", color: "#94a3b8", margin: 0 }}>{repoUrl}</p>
          {data?.detectedLanguages && data.detectedLanguages.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", marginTop: "0.3rem" }}>
              {data.detectedLanguages.map((lang, idx) => (
                <span
                  key={idx}
                  title={lang.reason}
                  style={{
                    fontSize: "0.72rem",
                    padding: "0.15rem 0.5rem",
                    borderRadius: "4px",
                    background: lang.confidence === "high" ? "rgba(56, 189, 248, 0.15)" : "rgba(148, 163, 184, 0.15)",
                    border: lang.confidence === "high" ? "1px solid rgba(56, 189, 248, 0.35)" : "1px solid rgba(148, 163, 184, 0.3)",
                    color: lang.confidence === "high" ? "#38bdf8" : "#cbd5e1",
                    fontWeight: 600,
                    fontFamily: "ui-monospace, monospace",
                  }}
                >
                  ⚙️ {lang.language} ({lang.confidence})
                </span>
              ))}
            </div>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
          <Link
            href="/missions"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.4rem",
              padding: "0.5rem 0.85rem",
              borderRadius: "6px",
              background: "#1e293b",
              border: "1px solid #334155",
              color: "#38bdf8",
              fontSize: "0.875rem",
              fontWeight: 500,
              textDecoration: "none",
            }}
          >
            🎯 Missions
          </Link>
          <Link
            href="/onboarding"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.4rem",
              padding: "0.5rem 0.85rem",
              borderRadius: "6px",
              background: "#1e293b",
              border: "1px solid #334155",
              color: "#38bdf8",
              fontSize: "0.875rem",
              fontWeight: 500,
              textDecoration: "none",
            }}
          >
            🗺️ Onboarding
          </Link>
          <Link
            href="/saved"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.4rem",
              padding: "0.5rem 0.85rem",
              borderRadius: "6px",
              background: "#1e293b",
              border: "1px solid #334155",
              color: "#38bdf8",
              fontSize: "0.875rem",
              fontWeight: 500,
              textDecoration: "none",
            }}
          >
            📌 Saved Views
          </Link>
          <Link
            href="/docs"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.4rem",
              padding: "0.5rem 0.85rem",
              borderRadius: "6px",
              background: "#1e293b",
              border: "1px solid #334155",
              color: "#38bdf8",
              fontSize: "0.875rem",
              fontWeight: 500,
              textDecoration: "none",
            }}
          >
            📖 Docs
          </Link>
          <CopyLinkButton
            label="Copy link to this view"
            repoUrl={repoUrl}
            graphMode={graphMode}
            focusFile={focusFile}
            focusFiles={highlightedFiles}
          />
          <SaveViewButton
            repoUrl={repoUrl}
            graphMode={graphMode}
            focusFiles={highlightedFiles.length > 0 ? highlightedFiles : focusFiles.length > 0 ? focusFiles : undefined}
            onSaved={() => setSavedViewsRefreshKey((k) => k + 1)}
          />
          <button
            onClick={() => setCreateGuideOpen(true)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.4rem",
              padding: "0.5rem 0.85rem",
              borderRadius: "6px",
              background: "rgba(15, 23, 42, 0.85)",
              border: "1px solid rgba(56, 189, 248, 0.25)",
              color: "#38bdf8",
              fontSize: "0.85rem",
              fontWeight: 500,
              cursor: "pointer",
              fontFamily: "ui-monospace, monospace",
              transition: "border-color 0.2s, background 0.2s",
            }}
            onMouseOver={(e) => {
              (e.currentTarget as HTMLButtonElement).style.borderColor = "rgba(56, 189, 248, 0.5)";
              (e.currentTarget as HTMLButtonElement).style.background = "rgba(15, 23, 42, 1)";
            }}
            onMouseOut={(e) => {
              (e.currentTarget as HTMLButtonElement).style.borderColor = "rgba(56, 189, 248, 0.25)";
              (e.currentTarget as HTMLButtonElement).style.background = "rgba(15, 23, 42, 0.85)";
            }}
          >
            🗺️ Create guide
          </button>
          <Link
            href={`/explain?url=${encodeURIComponent(repoUrl)}`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.4rem",
              padding: "0.5rem 0.85rem",
              borderRadius: "6px",
              background: "rgba(15, 23, 42, 0.85)",
              border: "1px solid rgba(56, 189, 248, 0.25)",
              color: "#38bdf8",
              fontSize: "0.85rem",
              fontWeight: 500,
              textDecoration: "none",
              fontFamily: "ui-monospace, monospace",
            }}
          >
            🔍 Explain diff
          </Link>
        </div>
      </header>

      {/* 2. Analyze Loading State */}
      {loading && (
        <div
          style={{
            padding: "1.5rem",
            borderRadius: "8px",
            background: "#1e293b",
            border: "1px solid #334155",
            color: "#94a3b8",
          }}
        >
          Analyzing repository structure and generating AI overview…
        </div>
      )}

      {/* 3. Analyze Error State Banner */}
      {error && (
        <div
          style={{
            padding: "1.5rem",
            borderRadius: "8px",
            background: "#450a0a",
            border: "1px solid #991b1b",
            color: "#fca5a5",
            display: "flex",
            flexDirection: "column",
            gap: "0.75rem",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <span style={{ fontSize: "1.25rem" }}>⚠️</span>
            <h2 style={{ fontSize: "1.1rem", fontWeight: 700, color: "#fecaca" }}>
              Unable to analyze repository
            </h2>
          </div>

          <p style={{ margin: 0, lineHeight: 1.5, color: "#fee2e2" }}>{error}</p>

          <div
            style={{
              marginTop: "0.25rem",
              padding: "0.75rem 1rem",
              borderRadius: "6px",
              background: "rgba(0, 0, 0, 0.25)",
              border: "1px solid rgba(239, 68, 68, 0.3)",
              fontSize: "0.9rem",
              color: "#fecaca",
            }}
          >
            💡 <strong>Expected GitHub URL format:</strong>{" "}
            <code style={{ fontFamily: "monospace" }}>https://github.com/owner/repository</code>
          </div>

          <div style={{ marginTop: "0.5rem" }}>
            <a
              href="/"
              style={{
                display: "inline-block",
                padding: "0.5rem 1rem",
                borderRadius: "6px",
                background: "#ef4444",
                color: "#ffffff",
                textDecoration: "none",
                fontWeight: 600,
                fontSize: "0.9rem",
              }}
            >
              ← Try another repository URL
            </a>
          </div>
        </div>
      )}

      {/* 4. Analyze Success View */}
      {data && (
        <section style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
          {/* Focused files indicator banner */}
          {(focusFile || urlFocusFiles.length > 0) && (
            <div
              style={{
                padding: "0.75rem 1.25rem",
                borderRadius: "8px",
                background: "#1e293b",
                border: "1px solid #f59e0b",
                color: "#fbbf24",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: "1rem",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <span style={{ fontSize: "1.1rem" }}>🎯</span>
                <span style={{ fontSize: "0.95rem" }}>
                  Focused {urlFocusFiles.length > 1 ? `Files (${urlFocusFiles.length})` : "File"}:{" "}
                  <code style={{ color: "#ffffff", fontFamily: "monospace" }}>
                    {focusFile || urlFocusFiles.join(", ")}
                    {lines ? ` (L${lines})` : ""}
                  </code>
                </span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <button
                  onClick={() => setViewModalFile(focusFile || urlFocusFiles[0])}
                  style={{
                    padding: "0.3rem 0.75rem",
                    borderRadius: "4px",
                    background: "#2563eb",
                    border: "none",
                    color: "#ffffff",
                    fontSize: "0.8rem",
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  📖 View Code
                </button>
                <a
                  href={repoUrl ? buildRepoUrl(repoUrl, { graphMode }) : "/"}
                  style={{
                    padding: "0.3rem 0.75rem",
                    borderRadius: "4px",
                    background: "rgba(245, 158, 11, 0.2)",
                    border: "1px solid #f59e0b",
                    color: "#fbbf24",
                    textDecoration: "none",
                    fontSize: "0.8rem",
                    fontWeight: 600,
                  }}
                >
                  Clear Focus
                </a>
              </div>
            </div>
          )}

          {/* Repository Main Navigation Tabs */}
          <div
            style={{
              display: "flex",
              gap: "0.5rem",
              borderBottom: "1px solid rgba(51, 65, 85, 0.5)",
              paddingBottom: "0.5rem",
            }}
          >
            <button
              onClick={() => setActiveTab("overview")}
              style={{
                padding: "0.55rem 1.15rem",
                borderRadius: "6px",
                border: "none",
                background: activeTab === "overview" ? "rgba(56, 189, 248, 0.2)" : "transparent",
                color: activeTab === "overview" ? "#38bdf8" : "#94a3b8",
                borderBottom: activeTab === "overview" ? "2px solid #38bdf8" : "2px solid transparent",
                fontWeight: 700,
                fontSize: "0.9rem",
                cursor: "pointer",
                fontFamily: "ui-monospace, monospace",
                display: "flex",
                alignItems: "center",
                gap: "0.4rem",
                transition: "color 0.2s, background 0.2s",
              }}
            >
              📊 Overview
            </button>

            <button
              onClick={() => setActiveTab("docs")}
              style={{
                padding: "0.55rem 1.15rem",
                borderRadius: "6px",
                border: "none",
                background: activeTab === "docs" ? "rgba(56, 189, 248, 0.2)" : "transparent",
                color: activeTab === "docs" ? "#38bdf8" : "#94a3b8",
                borderBottom: activeTab === "docs" ? "2px solid #38bdf8" : "2px solid transparent",
                fontWeight: 700,
                fontSize: "0.9rem",
                cursor: "pointer",
                fontFamily: "ui-monospace, monospace",
                display: "flex",
                alignItems: "center",
                gap: "0.4rem",
                transition: "color 0.2s, background 0.2s",
              }}
            >
              📖 Living Docs
            </button>

            <button
              onClick={() => setActiveTab("navigator")}
              style={{
                padding: "0.55rem 1.15rem",
                borderRadius: "6px",
                border: "none",
                background: activeTab === "navigator" ? "rgba(56, 189, 248, 0.2)" : "transparent",
                color: activeTab === "navigator" ? "#38bdf8" : "#94a3b8",
                borderBottom: activeTab === "navigator" ? "2px solid #38bdf8" : "2px solid transparent",
                fontWeight: 700,
                fontSize: "0.9rem",
                cursor: "pointer",
                fontFamily: "ui-monospace, monospace",
                display: "flex",
                alignItems: "center",
                gap: "0.4rem",
                transition: "color 0.2s, background 0.2s",
              }}
            >
              🧭 Navigator
            </button>

            <button
              onClick={() => setActiveTab("agent")}
              style={{
                padding: "0.55rem 1.15rem",
                borderRadius: "6px",
                border: "none",
                background: activeTab === "agent" ? "rgba(251, 191, 36, 0.2)" : "transparent",
                color: activeTab === "agent" ? "#fbbf24" : "#94a3b8",
                borderBottom: activeTab === "agent" ? "2px solid #fbbf24" : "2px solid transparent",
                fontWeight: 700,
                fontSize: "0.9rem",
                cursor: "pointer",
                fontFamily: "ui-monospace, monospace",
                display: "flex",
                alignItems: "center",
                gap: "0.4rem",
                transition: "color 0.2s, background 0.2s",
              }}
            >
              🤖 Agent
            </button>
          </div>

          {/* Agent Tab Content */}
          {activeTab === "agent" && (
            <RepoAgentChat
              repoUrl={repoUrl}
              files={data.files}
              onFocusFiles={(focusFileList) => {
                setHighlightedFiles(focusFileList);
                setActiveTab("overview");
                if (graphSectionRef.current) {
                  graphSectionRef.current.scrollIntoView({ behavior: "smooth" });
                }
              }}
              onShowFunction={(funcName) => {
                handleSelectFunctionCall(funcName);
              }}
              onOpenDocsPage={(docSlug) => {
                const pages = getDocsPagesForRepo(repoUrl);
                const target = pages.find((p) => p.slug === docSlug);
                if (target) {
                  handleOpenDocsPage(target);
                }
              }}
              onSelectQuestion={(qText) => {
                handleSelectQuestion(qText);
              }}
              onOpenFile={(filePath) => {
                setViewModalFile(filePath);
              }}
            />
          )}

          {/* Navigator Tab Content */}
          {activeTab === "navigator" && (
            <RepoNavigatorChat
              repoUrl={repoUrl}
              files={data.files}
              onFocusFiles={(focusFileList) => {
                setHighlightedFiles(focusFileList);
                setActiveTab("overview");
                if (graphSectionRef.current) {
                  graphSectionRef.current.scrollIntoView({ behavior: "smooth" });
                }
              }}
              onShowFunction={(funcName) => {
                handleSelectFunctionCall(funcName);
              }}
              onOpenDocsPage={(docSlug) => {
                const pages = getDocsPagesForRepo(repoUrl);
                const target = pages.find((p) => p.slug === docSlug);
                if (target) {
                  handleOpenDocsPage(target);
                }
              }}
            />
          )}

          {/* Docs Tab Content */}
          {activeTab === "docs" && (
            <RepoDocsList
              repoUrl={repoUrl}
              onOpenDocsPage={handleOpenDocsPage}
            />
          )}

          {/* Overview Tab Content */}
          {activeTab === "overview" && (
            <>
              {/* Metadata info cards */}
              <InfoPanel
                repoUrl={repoUrl}
                filesCount={data.files.length}
                nodesCount={activeGraph?.nodes.length ?? 0}
                edgesCount={activeGraph?.edges.length ?? 0}
              />

              {/* Living Documentation for this repo */}
              <RepoDocsList
                repoUrl={repoUrl}
                onOpenDocsPage={handleOpenDocsPage}
              />
            </>
          )}

          {/* Most Used Functions & Hooks Panel */}
          {data.functionCounts && (
            <TopFunctionsPanel
              repoUrl={repoUrl}
              functionCounts={data.functionCounts}
              onSelectFunction={handleSelectFunctionCall}
            />
          )}

          {/* Onboarding Guide for this repo */}
          <OnboardingGuideView
            repoUrl={repoUrl}
            refreshKey={onboardingGuideRefreshKey}
            onApplyStepView={handleApplyStepView}
            onSelectQuestion={handleSelectQuestion}
            onCreateGuideClick={() => setCreateGuideOpen(true)}
          />

          {/* Saved Views for this repo */}
          <SavedViewsList repoUrl={repoUrl} refreshKey={savedViewsRefreshKey} />

          {data.noSupportedFiles || data.files.length === 0 ? (
            <div
              style={{
                padding: "1.5rem",
                borderRadius: "8px",
                background: "#1e293b",
                border: "1px solid #eab308",
                color: "#fef08a",
                display: "flex",
                flexDirection: "column",
                gap: "0.75rem",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <span style={{ fontSize: "1.25rem" }}>ℹ️</span>
                <h2 style={{ fontSize: "1.1rem", fontWeight: 700, color: "#fef08a", margin: 0 }}>
                  No TypeScript or JavaScript Files Found
                </h2>
              </div>
              <p style={{ margin: 0, lineHeight: 1.6, color: "#cbd5e1" }}>
                This repository doesn’t contain any TypeScript or JavaScript files, so Codebase Atlas can’t build a graph or overview for it yet.
              </p>
              <p style={{ margin: 0, fontSize: "0.9rem", color: "#94a3b8" }}>
                💡 <em>You can still try asking questions about the repo below, but some features may be limited.</em>
              </p>
            </div>
          ) : (
            <>
              {/* Monorepo Workspace Badge/Note Card */}
              {data.monorepoInfo?.isMonorepo && data.monorepoInfo.workspaces && (
                <div
                  style={{
                    padding: "1rem 1.25rem",
                    borderRadius: "8px",
                    background: "rgba(168, 85, 247, 0.12)",
                    border: "1px solid rgba(168, 85, 247, 0.4)",
                    color: "#e9d5ff",
                    display: "flex",
                    flexDirection: "column",
                    gap: "0.5rem",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    <span style={{ fontSize: "1.1rem" }}>📦</span>
                    <h3 style={{ fontSize: "0.95rem", fontWeight: 700, color: "#c084fc", margin: 0, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                      Monorepo Architecture ({data.monorepoInfo.workspaces.length} Workspaces)
                    </h3>
                  </div>
                  <p style={{ margin: 0, fontSize: "0.9rem", lineHeight: 1.5, color: "#f3e8ff" }}>
                    This is a monorepo with workspaces:{" "}
                    <strong>{data.monorepoInfo.workspaces.map((w) => w.name).slice(0, 6).join(", ")}</strong>
                    {data.monorepoInfo.workspaces.length > 6 ? ` and ${data.monorepoInfo.workspaces.length - 6} more` : ""}.
                  </p>
                </div>
              )}

              {/* AI Overview card */}
              {(() => {
                const isAiMissing =
                  data.aiConfigured === false ||
                  data.aiError?.error === "AI_NOT_CONFIGURED" ||
                  (!data.overview && data.aiError);

                if (isAiMissing) {
                  return (
                    <FeatureUnavailable
                      featureName="AI Overview"
                      message={data.aiError?.message || "Set GEMINI_API_KEY to enable this feature"}
                      requiredEnvVar="GEMINI_API_KEY"
                    />
                  );
                }

                if (!data.overview) {
                  return null;
                }

                return (
                  <div
                    style={{
                      padding: "1.25rem",
                      borderRadius: "8px",
                      background: "#1e293b",
                      border: "1px solid #334155",
                    }}
                  >
                    <h2
                      style={{
                        fontSize: "1rem",
                        fontWeight: 600,
                        marginBottom: "0.5rem",
                        color: "#38bdf8",
                      }}
                    >
                      ✨ AI Overview of This Repository
                    </h2>
                    <p
                      style={{
                        margin: 0,
                        lineHeight: 1.6,
                        fontSize: "0.95rem",
                        color: "#cbd5e1",
                      }}
                    >
                      {data.overview}
                    </p>
                  </div>
                );
              })()}

              {/* Interactive Force Graph */}
              {activeGraph && (
                <div ref={graphSectionRef} style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      flexWrap: "wrap",
                      gap: "0.75rem",
                    }}
                  >
                    <h2
                      style={{
                        fontSize: "1.25rem",
                        fontWeight: 600,
                      }}
                    >
                      Dependency Graph
                    </h2>

                    <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
                      {/* 2D / 3D Dimension Toggle */}
                      <div
                        style={{
                          display: "flex",
                          background: "#1e293b",
                          padding: "0.25rem",
                          borderRadius: "6px",
                          border: "1px solid #334155",
                          gap: "0.25rem",
                        }}
                      >
                        <button
                          onClick={() => setDimensionMode("2D")}
                          style={{
                            padding: "0.35rem 0.75rem",
                            borderRadius: "4px",
                            border: "none",
                            background: dimensionMode === "2D" ? "#38bdf8" : "transparent",
                            color: dimensionMode === "2D" ? "#0f172a" : "#94a3b8",
                            fontSize: "0.8rem",
                            fontWeight: 600,
                            cursor: "pointer",
                            fontFamily: "ui-monospace, monospace",
                            transition: "background 0.2s, color 0.2s",
                          }}
                        >
                          2D
                        </button>
                        <button
                          onClick={() => setDimensionMode("3D")}
                          style={{
                            padding: "0.35rem 0.75rem",
                            borderRadius: "4px",
                            border: "none",
                            background: dimensionMode === "3D" ? "#38bdf8" : "transparent",
                            color: dimensionMode === "3D" ? "#0f172a" : "#94a3b8",
                            fontSize: "0.8rem",
                            fontWeight: 600,
                            cursor: "pointer",
                            fontFamily: "ui-monospace, monospace",
                            transition: "background 0.2s, color 0.2s",
                          }}
                        >
                          3D
                        </button>
                      </div>

                      {/* Mode Toggle (high-level / detailed) */}
                      <div
                        style={{
                          display: "flex",
                          background: "#1e293b",
                          padding: "0.25rem",
                          borderRadius: "6px",
                          border: "1px solid #334155",
                          gap: "0.25rem",
                        }}
                      >
                        <button
                          onClick={() => setGraphMode("high-level")}
                          style={{
                            padding: "0.35rem 0.75rem",
                            borderRadius: "4px",
                            border: "none",
                            background: graphMode === "high-level" ? "#38bdf8" : "transparent",
                            color: graphMode === "high-level" ? "#0f172a" : "#94a3b8",
                            fontSize: "0.8rem",
                            fontWeight: 600,
                            cursor: "pointer",
                            fontFamily: "ui-monospace, monospace",
                            transition: "background 0.2s, color 0.2s",
                          }}
                        >
                          High-Level
                        </button>
                        <button
                          onClick={() => setGraphMode("detailed")}
                          style={{
                            padding: "0.35rem 0.75rem",
                            borderRadius: "4px",
                            border: "none",
                            background: graphMode === "detailed" ? "#38bdf8" : "transparent",
                            color: graphMode === "detailed" ? "#0f172a" : "#94a3b8",
                            fontSize: "0.8rem",
                            fontWeight: 600,
                            cursor: "pointer",
                            fontFamily: "ui-monospace, monospace",
                            transition: "background 0.2s, color 0.2s",
                          }}
                        >
                          Detailed
                        </button>
                      </div>
                    </div>
                  </div>

                  <GraphExplanation />
                  {dimensionMode === "3D" ? (
                    <Graph3D
                      nodes={activeGraph.nodes}
                      edges={activeGraph.edges}
                      highlightedFiles={highlightedFiles.length > 0 ? highlightedFiles : focusFiles}
                      onNodeClick={(nodeId, type) => {
                        if (type === "file") {
                          setViewModalFile(nodeId);
                        }
                      }}
                      onFallbackTo2D={() => setDimensionMode("2D")}
                    />
                  ) : (
                    <RepoGraph
                      nodes={activeGraph.nodes}
                      edges={activeGraph.edges}
                      focusFile={focusFile}
                      highlightedFiles={highlightedFiles}
                      activeMode={graphMode}
                      onModeChange={handleModeToggle}
                      onNodeClick={(nodeId, type) => {
                        if (type === "file") {
                          setViewModalFile(nodeId);
                        }
                      }}
                    />
                  )}
                </div>
              )}
            </>
          )}
        </section>
      )}

      {/* 5. Q&A Section */}
      <section
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "1rem",
          borderTop: "1px solid #334155",
          paddingTop: "2rem",
        }}
      >
        <h2 style={{ fontSize: "1.25rem", fontWeight: 600 }}>
          Ask a question about this repository
        </h2>

        {/* Recommended Questions ("Try asking:") */}
        {data?.repoGuide && data.repoGuide.recommendedQuestions.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
              <span style={{ fontSize: "0.85rem", color: "#94a3b8", fontWeight: 600 }}>
                💡 Try asking ({data.repoGuide.label}):
              </span>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
              {data.repoGuide.recommendedQuestions.map((rq) => (
                <button
                  key={rq}
                  onClick={() => handleAsk(rq)}
                  disabled={asking}
                  style={{
                    padding: "0.35rem 0.75rem",
                    borderRadius: "20px",
                    background: asking ? "#1e293b" : "rgba(56, 189, 248, 0.1)",
                    border: "1px solid #38bdf8",
                    color: "#38bdf8",
                    fontSize: "0.85rem",
                    fontWeight: 500,
                    cursor: asking ? "not-allowed" : "pointer",
                  }}
                >
                  {rq} →
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Input box and action button */}
        <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          <textarea
            ref={questionInputRef}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="e.g. How is routing set up? Where are the main components located?"
            rows={3}
            style={{
              width: "100%",
              padding: "0.75rem",
              borderRadius: "6px",
              border: "1px solid #334155",
              background: "#1e293b",
              color: "#f8fafc",
              fontSize: "0.95rem",
              resize: "vertical",
            }}
          />
          <div>
            <button
              onClick={() => handleAsk()}
              disabled={asking || !question.trim()}
              style={{
                padding: "0.6rem 1.5rem",
                borderRadius: "6px",
                border: "none",
                background: asking || !question.trim() ? "#475569" : "#2563eb",
                color: "#ffffff",
                fontWeight: 600,
                cursor: asking || !question.trim() ? "not-allowed" : "pointer",
              }}
            >
              {asking ? "Thinking..." : "Ask Question"}
            </button>
          </div>
        </div>

        {/* Ask Loading State */}
        {asking && (
          <div
            style={{
              padding: "1rem",
              borderRadius: "6px",
              background: "#1e293b",
              border: "1px solid #334155",
              color: "#94a3b8",
            }}
          >
            Searching repository context and generating answer…
          </div>
        )}

        {/* Ask Error State */}
        {askError && (
          <div
            style={{
              padding: "1rem",
              borderRadius: "6px",
              background: "#450a0a",
              border: "1px solid #991b1b",
              color: "#fca5a5",
            }}
          >
            <strong>Q&amp;A Error:</strong> {askError}
          </div>
        )}

        {/* Ask Answer Display */}
        {answer && (
          <div
            style={{
              padding: "1.25rem",
              borderRadius: "8px",
              background: "#1e293b",
              border: "1px solid #334155",
              color: "#f8fafc",
              display: "flex",
              flexDirection: "column",
              gap: "1rem",
            }}
          >
            {/* Flow Summary Card if present */}
            {summary && (
              <div
                style={{
                  padding: "0.85rem 1rem",
                  borderRadius: "6px",
                  background: "rgba(37, 99, 235, 0.15)",
                  border: "1px solid rgba(59, 130, 246, 0.4)",
                  color: "#93c5fd",
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.4rem",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                  <span style={{ fontSize: "1rem" }}>🌊</span>
                  <h4 style={{ fontSize: "0.85rem", fontWeight: 700, color: "#bfdbfe", margin: 0, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                    Workflow Overview
                  </h4>
                </div>
                <p style={{ margin: 0, fontSize: "0.9rem", lineHeight: 1.5, color: "#e0f2fe" }}>
                  {summary}
                </p>
              </div>
            )}

            <div>
              <h3
                style={{
                  fontSize: "1rem",
                  fontWeight: 600,
                  color: "#38bdf8",
                  marginBottom: "0.5rem",
                }}
              >
                Answer
              </h3>
              <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.6, fontSize: "0.95rem" }}>
                {answer}
              </div>
            </div>

            {/* Function Intelligence Section if definitions or callSites present */}
            {(qaFunctionName || qaDefinitions.length > 0 || qaCallSites.length > 0) && (
              <div
                style={{
                  padding: "1rem 1.1rem",
                  borderRadius: "8px",
                  background: "rgba(3, 7, 18, 0.8)",
                  border: "1px solid rgba(56, 189, 248, 0.3)",
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.85rem",
                }}
              >
                {/* Header & Show in Graph Button */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    flexWrap: "wrap",
                    gap: "0.5rem",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    <span style={{ fontSize: "1.1rem" }}>⚡</span>
                    <h4
                      style={{
                        margin: 0,
                        fontSize: "0.95rem",
                        fontWeight: 700,
                        color: "#38bdf8",
                        fontFamily: "ui-monospace, monospace",
                      }}
                    >
                      Function Intelligence: {qaFunctionName ? `\`${qaFunctionName}\`` : "Detected Symbol"}
                    </h4>
                  </div>

                  <button
                    onClick={() => {
                      const defFiles = qaDefinitions.map((d) => d.file);
                      const callerFiles = qaCallSites.map((c) => c.file);
                      const all = Array.from(new Set([...defFiles, ...callerFiles]));
                      if (all.length > 0) {
                        handleApplyStepView("detailed", all);
                      }
                    }}
                    style={{
                      padding: "0.4rem 0.85rem",
                      borderRadius: "6px",
                      border: "1px solid rgba(56, 189, 248, 0.4)",
                      background: "rgba(56, 189, 248, 0.15)",
                      color: "#38bdf8",
                      fontSize: "0.82rem",
                      fontWeight: 600,
                      cursor: "pointer",
                      fontFamily: "ui-monospace, monospace",
                    }}
                  >
                    🎯 Show in graph
                  </button>
                </div>

                {/* Definitions */}
                {qaDefinitions.length > 0 && (
                  <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
                    <span
                      style={{
                        fontSize: "0.75rem",
                        fontWeight: 700,
                        color: "#94a3b8",
                        textTransform: "uppercase",
                        letterSpacing: "0.05em",
                        fontFamily: "ui-monospace, monospace",
                      }}
                    >
                      Definitions ({qaDefinitions.length})
                    </span>
                    <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
                      {qaDefinitions.map((def, idx) => (
                        <button
                          key={idx}
                          onClick={() => handleJumpToCode(def.file, def.lineStart, def.lineEnd || def.lineStart)}
                          style={{
                            textAlign: "left",
                            padding: "0.4rem 0.65rem",
                            borderRadius: "5px",
                            background: "rgba(15, 23, 42, 0.9)",
                            border: "1px solid rgba(51, 65, 85, 0.6)",
                            color: "#38bdf8",
                            fontSize: "0.82rem",
                            fontFamily: "ui-monospace, monospace",
                            cursor: "pointer",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                          }}
                        >
                          <span>
                            📄 <strong>{def.file}</strong> (lines {def.lineStart}{def.lineEnd ? `–${def.lineEnd}` : ""})
                          </span>
                          {def.isExport && (
                            <span
                              style={{
                                fontSize: "0.65rem",
                                padding: "0.1rem 0.3rem",
                                borderRadius: "3px",
                                background: "rgba(52, 211, 153, 0.15)",
                                color: "#34d399",
                                border: "1px solid rgba(52, 211, 153, 0.3)",
                              }}
                            >
                              EXPORTED
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Call Sites */}
                {qaCallSites.length > 0 && (
                  <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
                    <span
                      style={{
                        fontSize: "0.75rem",
                        fontWeight: 700,
                        color: "#94a3b8",
                        textTransform: "uppercase",
                        letterSpacing: "0.05em",
                        fontFamily: "ui-monospace, monospace",
                      }}
                    >
                      Called in ({qaCallSites.length})
                    </span>
                    <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
                      {qaCallSites.map((call, idx) => (
                        <button
                          key={idx}
                          onClick={() => handleJumpToCode(call.file, call.line, call.line)}
                          style={{
                            textAlign: "left",
                            padding: "0.4rem 0.65rem",
                            borderRadius: "5px",
                            background: "rgba(15, 23, 42, 0.9)",
                            border: "1px solid rgba(51, 65, 85, 0.6)",
                            color: "#cbd5e1",
                            fontSize: "0.82rem",
                            fontFamily: "ui-monospace, monospace",
                            cursor: "pointer",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                          }}
                        >
                          <span>
                            📞 <strong>{call.file}</strong> (line {call.line})
                          </span>
                          {call.callerFunction && (
                            <span style={{ fontSize: "0.72rem", color: "#38bdf8" }}>
                              inside <code style={{ color: "#f8fafc" }}>{call.callerFunction}()</code>
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Relevant Code Snippets Section */}
            {codeSnippets.length > 0 && (
              <div
                style={{
                  borderTop: "1px solid #334155",
                  paddingTop: "1rem",
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.75rem",
                }}
              >
                <h4
                  style={{
                    fontSize: "0.85rem",
                    fontWeight: 600,
                    color: "#38bdf8",
                    margin: 0,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    display: "flex",
                    alignItems: "center",
                    gap: "0.4rem",
                  }}
                >
                  <span>💻</span> Relevant Code Snippets ({codeSnippets.length})
                </h4>

                <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                  {codeSnippets.map((s, idx) => (
                    <div
                      key={idx}
                      style={{
                        borderRadius: "6px",
                        background: "#0f172a",
                        border: "1px solid #334155",
                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          padding: "0.4rem 0.75rem",
                          background: "#1e293b",
                          borderBottom: "1px solid #334155",
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          fontSize: "0.85rem",
                          flexWrap: "wrap",
                          gap: "0.5rem",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                          <a
                            href={
                              repoUrl
                                ? buildRepoUrl(repoUrl, {
                                    graphMode: "detailed",
                                    focusFile: s.file,
                                    lines: `${s.lines[0]}-${s.lines[1]}`,
                                  })
                                : "#"
                            }
                            style={{
                              color: "#38bdf8",
                              fontFamily: "monospace",
                              textDecoration: "none",
                              fontWeight: 600,
                            }}
                          >
                            📄 {s.file}
                          </a>
                          <span style={{ color: "#94a3b8", fontFamily: "monospace", fontSize: "0.8rem" }}>
                            (lines {s.lines[0]}–{s.lines[1]})
                          </span>
                        </div>
                        <button
                          onClick={() => handleJumpToCode(s.file, s.lines[0], s.lines[1])}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "0.3rem",
                            padding: "0.25rem 0.65rem",
                            borderRadius: "4px",
                            background: "#2563eb",
                            border: "none",
                            color: "#ffffff",
                            fontSize: "0.75rem",
                            fontWeight: 600,
                            cursor: "pointer",
                          }}
                        >
                          🎯 Jump to code
                        </button>
                      </div>
                      <pre
                        style={{
                          margin: 0,
                          padding: "0.75rem",
                          fontSize: "0.85rem",
                          fontFamily: "monospace",
                          color: "#e2e8f0",
                          overflowX: "auto",
                          whiteSpace: "pre-wrap",
                          lineHeight: 1.5,
                        }}
                      >
                        {s.code}
                      </pre>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Flow Focused Subgraph Section */}
            {focusSubgraph && focusSubgraph.nodes.length > 0 && (
              <div
                style={{
                  borderTop: "1px solid #334155",
                  paddingTop: "1rem",
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.75rem",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "0.5rem" }}>
                  <h4
                    style={{
                      fontSize: "0.85rem",
                      fontWeight: 600,
                      color: "#38bdf8",
                      margin: 0,
                      textTransform: "uppercase",
                      letterSpacing: "0.05em",
                      display: "flex",
                      alignItems: "center",
                      gap: "0.4rem",
                    }}
                  >
                    <span>🌊</span> Focused Flow Subgraph ({focusSubgraph.nodes.length} Nodes)
                  </h4>
                  <span style={{ fontSize: "0.8rem", color: "#94a3b8" }}>
                    Relevant dependency neighborhood topology
                  </span>
                </div>

                <RepoGraph
                  nodes={focusSubgraph.nodes}
                  edges={focusSubgraph.edges}
                  highlightedFiles={focusFiles}
                />

                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <button
                    onClick={handleOpenInFullGraph}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "0.4rem",
                      padding: "0.4rem 0.85rem",
                      borderRadius: "6px",
                      background: "#2563eb",
                      border: "none",
                      color: "#ffffff",
                      fontSize: "0.85rem",
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    🗺️ Open in full graph
                  </button>
                </div>
              </div>
            )}

            {/* Referenced Files section */}
            {referencedFiles.length > 0 && (
              <div
                style={{
                  borderTop: "1px solid #334155",
                  paddingTop: "0.75rem",
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.5rem",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: "0.5rem",
                  }}
                >
                  <h4
                    style={{
                      fontSize: "0.8rem",
                      fontWeight: 600,
                      color: "#94a3b8",
                      margin: 0,
                      textTransform: "uppercase",
                      letterSpacing: "0.05em",
                    }}
                  >
                    Referenced Files ({referencedFiles.length})
                  </h4>
                  <button
                    onClick={handleShowInGraph}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "0.4rem",
                      padding: "0.35rem 0.75rem",
                      borderRadius: "6px",
                      background: "#2563eb",
                      border: "none",
                      color: "#ffffff",
                      fontSize: "0.85rem",
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    🔍 Show in graph
                  </button>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
                  {referencedFiles.map((file) => (
                    <a
                      key={file}
                      href={repoUrl ? buildRepoUrl(repoUrl, { graphMode, focusFile: file }) : "#"}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "0.3rem",
                        padding: "0.35rem 0.65rem",
                        borderRadius: "4px",
                        background: "#0f172a",
                        border: "1px solid #334155",
                        color: "#38bdf8",
                        textDecoration: "none",
                        fontSize: "0.85rem",
                        fontFamily: "monospace",
                      }}
                    >
                      📄 {file}
                    </a>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      {/* 6. Other Recent Analyses Section */}
      {recents.filter((r) => r.repoUrl.toLowerCase() !== repoUrl?.toLowerCase()).length > 0 && (
        <section
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "0.75rem",
            borderTop: "1px solid #334155",
            paddingTop: "2rem",
          }}
        >
          <h2 style={{ fontSize: "1rem", fontWeight: 600, color: "#94a3b8" }}>
            Other Recent Analyses
          </h2>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
            {recents
              .filter((r) => r.repoUrl.toLowerCase() !== repoUrl?.toLowerCase())
              .map((item) => (
                <a
                  key={item.repoUrl}
                  href={`/repo?url=${encodeURIComponent(item.repoUrl)}`}
                  style={{
                    padding: "0.4rem 0.85rem",
                    borderRadius: "6px",
                    background: "#1e293b",
                    border: "1px solid #334155",
                    color: "#38bdf8",
                    textDecoration: "none",
                    fontSize: "0.85rem",
                    fontWeight: 500,
                  }}
                >
                  {formatRepoName(item.repoUrl)}
                </a>
              ))}
          </div>
        </section>
      )}
      {/* File Viewer Modal */}
      {viewModalFile && repoUrl && (
        <FileViewerModal
          repoUrl={repoUrl}
          focusFile={viewModalFile}
          lines={lines}
          onClose={() => setViewModalFile(null)}
        />
      )}

      {/* Create Onboarding Guide Modal */}
      {repoUrl && (
        <CreateGuideModal
          repoUrl={repoUrl}
          currentGraphMode={graphMode}
          currentFocusFiles={highlightedFiles.length > 0 ? highlightedFiles : focusFiles}
          isOpen={createGuideOpen}
          onClose={() => setCreateGuideOpen(false)}
          onGuideSaved={() => setOnboardingGuideRefreshKey((k) => k + 1)}
        />
      )}

      {/* Living Docs Page View Modal */}
      {selectedDocsPage && (
        <DocsPageViewModal
          page={selectedDocsPage}
          onClose={() => {
            setSelectedDocsPage(null);
            if (repoUrl) {
              const newUrl = buildRepoUrl(repoUrl, {
                graphMode,
                focusFiles: highlightedFiles,
              });
              window.history.replaceState({}, "", newUrl);
            }
          }}
          onOpenInGraph={handleApplyStepView}
          onSelectQuestion={handleSelectQuestion}
        />
      )}

      {/* Function Detail Modal */}
      {selectedFunctionName && (
        <FunctionDetailModal
          functionName={selectedFunctionName}
          detail={data?.functionIndex?.[selectedFunctionName]}
          onClose={() => {
            setSelectedFunctionName(null);
            if (repoUrl) {
              const newUrl = buildRepoUrl(repoUrl, {
                graphMode,
                focusFiles: highlightedFiles,
              });
              window.history.replaceState({}, "", newUrl);
            }
          }}
          onOpenInGraph={handleApplyStepView}
          onJumpToCode={handleJumpToCode}
        />
      )}
    </main>
  );
}
