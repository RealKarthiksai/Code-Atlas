"use client";

import { useState, useRef, useEffect } from "react";
import type { AgentAction, ChangePlan, PRExplanation, Tour, TourStep } from "@/app/api/agent/route";
import FeatureUnavailable from "@/components/FeatureUnavailable";

// ---------------------------------------------------------------------------
// Types & Props
// ---------------------------------------------------------------------------

export interface AgentMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  actions?: AgentAction[];
  changePlan?: ChangePlan;
  prExplanation?: PRExplanation;
  tour?: Tour;
  isError?: boolean;
  isAiUnconfigured?: boolean;
  failedQuery?: string;
}

interface RepoAgentChatProps {
  repoUrl: string;
  files: string[];
  onFocusFiles?: (files: string[]) => void;
  onShowFunction?: (functionName: string) => void;
  onOpenDocsPage?: (slug: string) => void;
  onSelectQuestion?: (question: string) => void;
  onOpenFile?: (filePath: string) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function RepoAgentChat({
  repoUrl,
  files,
  onFocusFiles,
  onShowFunction,
  onOpenDocsPage,
  onSelectQuestion,
  onOpenFile,
}: RepoAgentChatProps) {
  const [messages, setMessages] = useState<AgentMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      content:
        "Hello! I am your Autonomous Codebase Agent. Ask me to explain a PR, plan a change, or start an interactive guided tour.",
      timestamp: new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
      actions: [
        {
          label: "🚩 Start guided tour",
          payload: { type: "startTour", data: {} },
        },
        {
          label: "📖 Open Overview docs",
          payload: { type: "openDocsPage", data: { slug: "overview" } },
        },
      ],
    },
  ]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [tourStepIndex, setTourStepIndex] = useState(0);
  const chatBottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending]);

  function handleActionClick(action: AgentAction) {
    const { type, data } = action.payload;

    if (type === "startTour") {
      handleSend(undefined, "Start guided tour");
      return;
    }

    if (type === "focusFiles" && onFocusFiles) {
      const fileList = Array.isArray(data?.files) ? data.files : typeof data === "string" ? [data] : [];
      if (fileList.length > 0) onFocusFiles(fileList);
    } else if (type === "focusStepFiles" && onFocusFiles) {
      const fileList = Array.isArray(data?.files) ? data.files : [];
      if (fileList.length > 0) onFocusFiles(fileList);
    } else if (type === "openFile" && onOpenFile) {
      const filePath = data?.path || data?.file || data;
      if (typeof filePath === "string" && filePath) {
        if (onFocusFiles) onFocusFiles([filePath]);
        onOpenFile(filePath);
      }
    } else if (type === "showFunction" && onShowFunction) {
      const fn = data?.functionName || data?.name || data;
      if (typeof fn === "string" && fn) onShowFunction(fn);
    } else if (type === "openDocsPage" && onOpenDocsPage) {
      const slug = data?.slug || data;
      if (typeof slug === "string" && slug) onOpenDocsPage(slug);
    } else if (type === "suggestQuestions") {
      const questions = Array.isArray(data?.questions) ? data.questions : Array.isArray(data) ? data : [];
      if (questions.length > 0 && onSelectQuestion) {
        onSelectQuestion(questions[0]);
      }
    }
  }

  async function handleSend(e?: React.FormEvent, customQuery?: string) {
    if (e) e.preventDefault();
    const textToSend = customQuery || input.trim();
    if (!textToSend || sending) return;

    const userMsg: AgentMessage = {
      id: Date.now().toString(),
      role: "user",
      content: textToSend,
      timestamp: new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
    };

    const updatedMessages = [...messages, userMsg];
    setMessages(updatedMessages);
    if (!customQuery) setInput("");
    setSending(true);

    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoUrl,
          messages: updatedMessages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
        }),
      });

      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        const isAiUnconfigured = res.status === 503 || json.error === "AI_NOT_CONFIGURED";
        const errorMsg = json.message || json.error || `Request failed with status ${res.status}`;
        const botMsg: AgentMessage = {
          id: (Date.now() + 1).toString(),
          role: "assistant",
          content: errorMsg,
          isError: true,
          isAiUnconfigured,
          failedQuery: textToSend,
          timestamp: new Date().toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          }),
        };
        setMessages((prev) => [...prev, botMsg]);
        return;
      }

      const replyText = json.content || "";
      const replyActions = Array.isArray(json.actions) ? json.actions : [];
      const replyChangePlan = json.changePlan as ChangePlan | undefined;
      const replyPRExplanation = json.prExplanation as PRExplanation | undefined;
      const replyTour = json.tour as Tour | undefined;

      if (replyTour) {
        setTourStepIndex(0);
      }

      const botMsg: AgentMessage = {
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content: replyText,
        timestamp: new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
        actions: replyActions,
        changePlan: replyChangePlan,
        prExplanation: replyPRExplanation,
        tour: replyTour,
      };

      setMessages((prev) => [...prev, botMsg]);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Failed to connect to agent service.";
      const botMsg: AgentMessage = {
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content: errorMsg,
        isError: true,
        failedQuery: textToSend,
        timestamp: new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
      };
      setMessages((prev) => [...prev, botMsg]);
    } finally {
      setSending(false);
    }
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "580px",
        borderRadius: "12px",
        background: "rgba(15, 23, 42, 0.85)",
        backdropFilter: "blur(12px)",
        border: "1px solid rgba(251, 191, 36, 0.3)",
        boxShadow: "0 8px 32px rgba(0, 0, 0, 0.4)",
        overflow: "hidden",
      }}
    >
      {/* Top Agent Header */}
      <div
        style={{
          padding: "1rem 1.25rem",
          background: "rgba(3, 7, 18, 0.6)",
          borderBottom: "1px solid rgba(51, 65, 85, 0.4)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
          <span style={{ fontSize: "1.2rem" }}>🚩</span>
          <div>
            <h3
              style={{
                margin: 0,
                fontSize: "0.95rem",
                fontWeight: 700,
                color: "#fbbf24",
                fontFamily: "ui-monospace, monospace",
              }}
            >
              Repo Agent & Guided Tour
            </h3>
            <span
              style={{
                fontSize: "0.72rem",
                color: "#94a3b8",
                fontFamily: "ui-monospace, monospace",
              }}
            >
              Guided Walkthrough • {files.length} codebase files
            </span>
          </div>
        </div>

        <button
          onClick={() => handleSend(undefined, "Start guided tour")}
          disabled={sending}
          style={{
            fontSize: "0.72rem",
            padding: "0.3rem 0.65rem",
            borderRadius: "5px",
            background: "rgba(251, 191, 36, 0.15)",
            color: "#fbbf24",
            border: "1px solid rgba(251, 191, 36, 0.4)",
            fontWeight: 700,
            fontFamily: "ui-monospace, monospace",
            cursor: "pointer",
            display: "inline-flex",
            alignItems: "center",
            gap: "0.3rem",
          }}
        >
          🚩 Start Guided Tour
        </button>
      </div>

      {/* Messages Scroll Area */}
      <div
        style={{
          flex: 1,
          padding: "1.25rem",
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: "1.1rem",
        }}
      >
        {messages.map((msg) => {
          const isUser = msg.role === "user";
          return (
            <div
              key={msg.id}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: isUser ? "flex-end" : "flex-start",
                gap: "0.3rem",
              }}
            >
              <div
                style={{
                  maxWidth: "88%",
                  padding: "0.75rem 1rem",
                  borderRadius: isUser ? "12px 12px 2px 12px" : "12px 12px 12px 2px",
                  background: isUser
                    ? "rgba(56, 189, 248, 0.2)"
                    : msg.isError
                    ? "#450a0a"
                    : "rgba(30, 41, 59, 0.9)",
                  border: isUser
                    ? "1px solid rgba(56, 189, 248, 0.4)"
                    : msg.isError
                    ? "1px solid #991b1b"
                    : "1px solid rgba(251, 191, 36, 0.3)",
                  color: isUser ? "#38bdf8" : msg.isError ? "#fca5a5" : "#f8fafc",
                  fontSize: "0.88rem",
                  lineHeight: 1.55,
                  whiteSpace: "pre-wrap",
                  fontFamily: isUser ? "ui-monospace, monospace" : "inherit",
                }}
              >
                {msg.isError ? (
                  msg.isAiUnconfigured ? (
                    <FeatureUnavailable
                      featureName="Repo Agent"
                      message={msg.content}
                      onRetry={msg.failedQuery ? () => handleSend(undefined, msg.failedQuery) : undefined}
                      style={{ border: "none", background: "transparent", padding: 0 }}
                    />
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                        <span>⚠️</span>
                        <span style={{ fontWeight: 600 }}>{msg.content}</span>
                      </div>
                      {msg.failedQuery && (
                        <button
                          onClick={() => handleSend(undefined, msg.failedQuery)}
                          style={{
                            alignSelf: "flex-start",
                            padding: "0.3rem 0.75rem",
                            borderRadius: "4px",
                            background: "#dc2626",
                            color: "#ffffff",
                            border: "none",
                            cursor: "pointer",
                            fontSize: "0.8rem",
                            fontWeight: 600,
                          }}
                        >
                          🔄 Retry
                        </button>
                      )}
                    </div>
                  )
                ) : (
                  msg.content
                )}

                {/* Structured Guided Tour Card */}
                {!isUser && msg.tour && msg.tour.steps && msg.tour.steps.length > 0 && (
                  (() => {
                    const currentStep: TourStep = msg.tour.steps[tourStepIndex] || msg.tour.steps[0];
                    const isFirst = tourStepIndex === 0;
                    const isLast = tourStepIndex === msg.tour.steps.length - 1;

                    return (
                      <div
                        style={{
                          marginTop: "0.85rem",
                          padding: "1rem",
                          borderRadius: "8px",
                          background: "rgba(3, 7, 18, 0.8)",
                          border: "1px solid rgba(251, 191, 36, 0.45)",
                          display: "flex",
                          flexDirection: "column",
                          gap: "0.85rem",
                        }}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                            <span style={{ fontSize: "1rem" }}>🚩</span>
                            <strong style={{ color: "#fbbf24", fontSize: "0.88rem", fontFamily: "ui-monospace, monospace" }}>
                              Guided Tour • Step {tourStepIndex + 1} of {msg.tour.steps.length}
                            </strong>
                          </div>
                          <span style={{ fontSize: "0.72rem", color: "#94a3b8", fontFamily: "ui-monospace, monospace" }}>
                            {Math.round(((tourStepIndex + 1) / msg.tour.steps.length) * 100)}% Complete
                          </span>
                        </div>

                        {/* Step Title & Summary */}
                        <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
                          <h4 style={{ margin: 0, fontSize: "0.92rem", color: "#38bdf8", fontWeight: 700 }}>
                            {currentStep.title}
                          </h4>
                          <p style={{ margin: 0, fontSize: "0.83rem", color: "#e2e8f0", lineHeight: 1.5 }}>
                            {currentStep.summary}
                          </p>
                        </div>

                        {/* Step Action Buttons */}
                        <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                          {currentStep.focusFiles && currentStep.focusFiles.length > 0 && (
                            <button
                              onClick={() => onFocusFiles && onFocusFiles(currentStep.focusFiles!)}
                              style={{
                                padding: "0.22rem 0.6rem",
                                borderRadius: "4px",
                                background: "rgba(56, 189, 248, 0.15)",
                                border: "1px solid rgba(56, 189, 248, 0.4)",
                                color: "#38bdf8",
                                fontSize: "0.74rem",
                                fontWeight: 600,
                                cursor: "pointer",
                                fontFamily: "ui-monospace, monospace",
                              }}
                            >
                              🎯 Show focused files ({currentStep.focusFiles.length})
                            </button>
                          )}

                          <button
                            onClick={() => onOpenDocsPage && onOpenDocsPage(currentStep.docsSlug || "overview")}
                            style={{
                              padding: "0.22rem 0.6rem",
                              borderRadius: "4px",
                              background: "rgba(52, 211, 153, 0.15)",
                              border: "1px solid rgba(52, 211, 153, 0.4)",
                              color: "#34d399",
                              fontSize: "0.74rem",
                              fontWeight: 600,
                              cursor: "pointer",
                              fontFamily: "ui-monospace, monospace",
                            }}
                          >
                            📖 Open docs ({currentStep.docsSlug || "overview"})
                          </button>
                        </div>

                        {/* Suggested Questions for Step */}
                        {currentStep.suggestedQuestions && currentStep.suggestedQuestions.length > 0 && (
                          <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
                            <span style={{ fontSize: "0.72rem", color: "#fbbf24", fontWeight: 700, fontFamily: "ui-monospace, monospace" }}>
                              ❓ Try these questions:
                            </span>
                            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem" }}>
                              {currentStep.suggestedQuestions.map((qText, qIdx) => (
                                <button
                                  key={qIdx}
                                  onClick={() => handleSend(undefined, qText)}
                                  style={{
                                    padding: "0.25rem 0.55rem",
                                    borderRadius: "4px",
                                    background: "rgba(251, 191, 36, 0.12)",
                                    border: "1px solid rgba(251, 191, 36, 0.3)",
                                    color: "#fbbf24",
                                    fontSize: "0.74rem",
                                    cursor: "pointer",
                                    fontFamily: "ui-monospace, monospace",
                                    textAlign: "left",
                                  }}
                                >
                                  {qText}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Tour Step Controls */}
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            marginTop: "0.4rem",
                            paddingTop: "0.5rem",
                            borderTop: "1px solid rgba(51, 65, 85, 0.5)",
                          }}
                        >
                          <button
                            disabled={isFirst}
                            onClick={() => setTourStepIndex((prev) => Math.max(0, prev - 1))}
                            style={{
                              padding: "0.3rem 0.75rem",
                              borderRadius: "5px",
                              background: isFirst ? "rgba(51, 65, 85, 0.3)" : "rgba(30, 41, 59, 0.9)",
                              border: "1px solid rgba(148, 163, 184, 0.3)",
                              color: isFirst ? "#64748b" : "#f8fafc",
                              fontSize: "0.76rem",
                              fontWeight: 600,
                              cursor: isFirst ? "not-allowed" : "pointer",
                              fontFamily: "ui-monospace, monospace",
                            }}
                          >
                            ← Previous Step
                          </button>

                          <button
                            onClick={() => {
                              if (!isLast) {
                                setTourStepIndex((prev) => prev + 1);
                              } else {
                                handleSend(undefined, "I finished the guided tour!");
                              }
                            }}
                            style={{
                              padding: "0.3rem 0.75rem",
                              borderRadius: "5px",
                              background: isLast ? "#34d399" : "#fbbf24",
                              border: "none",
                              color: "#0f172a",
                              fontSize: "0.76rem",
                              fontWeight: 700,
                              cursor: "pointer",
                              fontFamily: "ui-monospace, monospace",
                            }}
                          >
                            {isLast ? "Finish Tour 🎉" : "Next Step →"}
                          </button>
                        </div>
                      </div>
                    );
                  })()
                )}

                {/* Structured PR Explanation Card */}
                {!isUser && msg.prExplanation && (
                  <div
                    style={{
                      marginTop: "0.85rem",
                      padding: "1rem",
                      borderRadius: "8px",
                      background: "rgba(3, 7, 18, 0.75)",
                      border: "1px solid rgba(56, 189, 248, 0.4)",
                      display: "flex",
                      flexDirection: "column",
                      gap: "0.85rem",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                      <span style={{ fontSize: "1rem" }}>🔍</span>
                      <strong style={{ color: "#38bdf8", fontSize: "0.88rem", fontFamily: "ui-monospace, monospace" }}>
                        PR & Diff Explanation
                      </strong>
                    </div>

                    <p style={{ margin: 0, fontSize: "0.85rem", color: "#e2e8f0", lineHeight: 1.5 }}>
                      {msg.prExplanation.summary}
                    </p>

                    {/* Affected Modules */}
                    {msg.prExplanation.affectedModules && msg.prExplanation.affectedModules.length > 0 && (
                      <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
                        <span
                          style={{
                            fontSize: "0.72rem",
                            fontWeight: 700,
                            color: "#cbd5e1",
                            textTransform: "uppercase",
                            letterSpacing: "0.05em",
                            fontFamily: "ui-monospace, monospace",
                          }}
                        >
                          📁 Affected Modules ({msg.prExplanation.affectedModules.length})
                        </span>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.3rem" }}>
                          {msg.prExplanation.affectedModules.map((mod, mIdx) => (
                            <button
                              key={mIdx}
                              onClick={() => {
                                if (onFocusFiles) onFocusFiles([mod]);
                                if (onOpenFile) onOpenFile(mod);
                              }}
                              style={{
                                padding: "0.18rem 0.5rem",
                                borderRadius: "4px",
                                background: "rgba(56, 189, 248, 0.15)",
                                border: "1px solid rgba(56, 189, 248, 0.35)",
                                color: "#38bdf8",
                                fontSize: "0.74rem",
                                fontFamily: "ui-monospace, monospace",
                                cursor: "pointer",
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "0.25rem",
                              }}
                            >
                              📄 {mod}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Key Changes */}
                    {msg.prExplanation.keyChanges && msg.prExplanation.keyChanges.length > 0 && (
                      <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
                        <span
                          style={{
                            fontSize: "0.72rem",
                            fontWeight: 700,
                            color: "#34d399",
                            textTransform: "uppercase",
                            letterSpacing: "0.05em",
                            fontFamily: "ui-monospace, monospace",
                          }}
                        >
                          🔍 Key Changes
                        </span>
                        <ul style={{ margin: 0, paddingLeft: "1.1rem", fontSize: "0.8rem", color: "#e2e8f0", display: "flex", flexDirection: "column", gap: "0.2rem" }}>
                          {msg.prExplanation.keyChanges.map((change, cIdx) => (
                            <li key={cIdx}>{change}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* Risks & Reviewer Notes */}
                    {msg.prExplanation.risks && msg.prExplanation.risks.length > 0 && (
                      <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
                        <span
                          style={{
                            fontSize: "0.72rem",
                            fontWeight: 700,
                            color: "#fbbf24",
                            textTransform: "uppercase",
                            letterSpacing: "0.05em",
                            fontFamily: "ui-monospace, monospace",
                          }}
                        >
                          ⚠️ Risks & Reviewer Notes
                        </span>
                        <ul style={{ margin: 0, paddingLeft: "1.1rem", fontSize: "0.8rem", color: "#fef08a", display: "flex", flexDirection: "column", gap: "0.2rem" }}>
                          {msg.prExplanation.risks.map((risk, rIdx) => (
                            <li key={rIdx}>{risk}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* PR Action Buttons */}
                    <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", marginTop: "0.3rem" }}>
                      {msg.prExplanation.affectedModules && msg.prExplanation.affectedModules.length > 0 && (
                        <button
                          onClick={() => onFocusFiles && onFocusFiles(msg.prExplanation!.affectedModules)}
                          style={{
                            padding: "0.2rem 0.55rem",
                            borderRadius: "4px",
                            background: "rgba(56, 189, 248, 0.15)",
                            border: "1px solid rgba(56, 189, 248, 0.4)",
                            color: "#38bdf8",
                            fontSize: "0.72rem",
                            fontWeight: 600,
                            cursor: "pointer",
                            fontFamily: "ui-monospace, monospace",
                          }}
                        >
                          🎯 Show affected files in graph
                        </button>
                      )}

                      <button
                        onClick={() => onOpenDocsPage && onOpenDocsPage("overview")}
                        style={{
                          padding: "0.2rem 0.55rem",
                          borderRadius: "4px",
                          background: "rgba(52, 211, 153, 0.15)",
                          border: "1px solid rgba(52, 211, 153, 0.4)",
                          color: "#34d399",
                          fontSize: "0.72rem",
                          fontWeight: 600,
                          cursor: "pointer",
                          fontFamily: "ui-monospace, monospace",
                        }}
                      >
                        📖 Open related docs
                      </button>
                    </div>
                  </div>
                )}

                {/* Structured Change Plan Card */}
                {!isUser && msg.changePlan && (
                  <div
                    style={{
                      marginTop: "0.85rem",
                      padding: "1rem",
                      borderRadius: "8px",
                      background: "rgba(3, 7, 18, 0.75)",
                      border: "1px solid rgba(251, 191, 36, 0.4)",
                      display: "flex",
                      flexDirection: "column",
                      gap: "0.85rem",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                      <span style={{ fontSize: "1rem" }}>📋</span>
                      <strong style={{ color: "#fbbf24", fontSize: "0.88rem", fontFamily: "ui-monospace, monospace" }}>
                        Implementation Plan Summary
                      </strong>
                    </div>

                    <p style={{ margin: 0, fontSize: "0.85rem", color: "#e2e8f0", lineHeight: 1.5 }}>
                      {msg.changePlan.summary}
                    </p>

                    {/* Step-by-step instructions */}
                    {msg.changePlan.steps && msg.changePlan.steps.length > 0 && (
                      <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
                        <span
                          style={{
                            fontSize: "0.72rem",
                            fontWeight: 700,
                            color: "#38bdf8",
                            textTransform: "uppercase",
                            letterSpacing: "0.05em",
                            fontFamily: "ui-monospace, monospace",
                          }}
                        >
                          Step-By-Step Instructions ({msg.changePlan.steps.length})
                        </span>

                        {msg.changePlan.steps.map((step, sIdx) => (
                          <div
                            key={sIdx}
                            style={{
                              padding: "0.6rem 0.85rem",
                              borderRadius: "6px",
                              background: "rgba(15, 23, 42, 0.85)",
                              border: "1px solid rgba(51, 65, 85, 0.6)",
                              display: "flex",
                              flexDirection: "column",
                              gap: "0.35rem",
                            }}
                          >
                            <span style={{ fontSize: "0.83rem", fontWeight: 700, color: "#f8fafc" }}>
                              {step.title}
                            </span>
                            <span style={{ fontSize: "0.8rem", color: "#cbd5e1", lineHeight: 1.45 }}>
                              {step.description}
                            </span>

                            {/* Clickable file chips */}
                            {step.files && step.files.length > 0 && (
                              <div style={{ display: "flex", flexWrap: "wrap", gap: "0.3rem", marginTop: "0.2rem" }}>
                                {step.files.map((file, fIdx) => (
                                  <button
                                    key={fIdx}
                                    onClick={() => {
                                      if (onFocusFiles) onFocusFiles([file]);
                                      if (onOpenFile) onOpenFile(file);
                                    }}
                                    style={{
                                      padding: "0.18rem 0.5rem",
                                      borderRadius: "4px",
                                      background: "rgba(56, 189, 248, 0.15)",
                                      border: "1px solid rgba(56, 189, 248, 0.35)",
                                      color: "#38bdf8",
                                      fontSize: "0.74rem",
                                      fontFamily: "ui-monospace, monospace",
                                      cursor: "pointer",
                                      display: "inline-flex",
                                      alignItems: "center",
                                      gap: "0.25rem",
                                    }}
                                  >
                                    📄 {file}
                                  </button>
                                ))}
                              </div>
                            )}

                            {/* Action buttons per step */}
                            <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", marginTop: "0.3rem" }}>
                              {step.files && step.files.length > 0 && (
                                <button
                                  onClick={() => onFocusFiles && onFocusFiles(step.files)}
                                  style={{
                                    padding: "0.2rem 0.5rem",
                                    borderRadius: "4px",
                                    background: "rgba(56, 189, 248, 0.15)",
                                    border: "1px solid rgba(56, 189, 248, 0.4)",
                                    color: "#38bdf8",
                                    fontSize: "0.72rem",
                                    fontWeight: 600,
                                    cursor: "pointer",
                                    fontFamily: "ui-monospace, monospace",
                                  }}
                                >
                                  🎯 Show step files in graph
                                </button>
                              )}

                              <button
                                onClick={() => onOpenDocsPage && onOpenDocsPage("overview")}
                                style={{
                                  padding: "0.2rem 0.5rem",
                                  borderRadius: "4px",
                                  background: "rgba(52, 211, 153, 0.15)",
                                  border: "1px solid rgba(52, 211, 153, 0.4)",
                                  color: "#34d399",
                                  fontSize: "0.72rem",
                                  fontWeight: 600,
                                  cursor: "pointer",
                                  fontFamily: "ui-monospace, monospace",
                                }}
                              >
                                📖 Open relevant docs
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Risks Section */}
                    {msg.changePlan.risks && msg.changePlan.risks.length > 0 && (
                      <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
                        <span
                          style={{
                            fontSize: "0.72rem",
                            fontWeight: 700,
                            color: "#fbbf24",
                            textTransform: "uppercase",
                            letterSpacing: "0.05em",
                            fontFamily: "ui-monospace, monospace",
                          }}
                        >
                          ⚠️ Risks & Watch Items
                        </span>
                        <ul
                          style={{
                            margin: 0,
                            paddingLeft: "1.1rem",
                            fontSize: "0.8rem",
                            color: "#fef08a",
                            display: "flex",
                            flexDirection: "column",
                            gap: "0.2rem",
                          }}
                        >
                          {msg.changePlan.risks.map((risk, rIdx) => (
                            <li key={rIdx}>{risk}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}

                {/* Assistant Action Buttons */}
                {!isUser && msg.actions && msg.actions.length > 0 && (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "0.4rem",
                      marginTop: "0.6rem",
                      paddingTop: "0.5rem",
                      borderTop: "1px solid rgba(51, 65, 85, 0.5)",
                    }}
                  >
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
                      {msg.actions.map((act, aIdx) => {
                        if (act.payload.type === "suggestQuestions") {
                          const qList: string[] = Array.isArray(act.payload.data?.questions)
                            ? act.payload.data.questions
                            : Array.isArray(act.payload.data)
                            ? act.payload.data
                            : [];

                          return (
                            <div key={aIdx} style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem", width: "100%" }}>
                              {qList.map((qText, qIdx) => (
                                <button
                                  key={qIdx}
                                  onClick={() => handleSend(undefined, qText)}
                                  style={{
                                    padding: "0.35rem 0.65rem",
                                    borderRadius: "5px",
                                    background: "rgba(251, 191, 36, 0.12)",
                                    border: "1px solid rgba(251, 191, 36, 0.35)",
                                    color: "#fbbf24",
                                    fontSize: "0.78rem",
                                    fontWeight: 600,
                                    cursor: "pointer",
                                    fontFamily: "ui-monospace, monospace",
                                    textAlign: "left",
                                  }}
                                >
                                  ❓ {qText}
                                </button>
                              ))}
                            </div>
                          );
                        }

                        return (
                          <button
                            key={aIdx}
                            onClick={() => handleActionClick(act)}
                            style={{
                              padding: "0.35rem 0.75rem",
                              borderRadius: "5px",
                              background: "rgba(251, 191, 36, 0.15)",
                              border: "1px solid rgba(251, 191, 36, 0.4)",
                              color: "#fbbf24",
                              fontSize: "0.78rem",
                              fontWeight: 600,
                              cursor: "pointer",
                              fontFamily: "ui-monospace, monospace",
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "0.3rem",
                              transition: "background 0.2s, border-color 0.2s",
                            }}
                            onMouseOver={(e) => {
                              (e.currentTarget as HTMLButtonElement).style.background =
                                "rgba(251, 191, 36, 0.3)";
                            }}
                            onMouseOut={(e) => {
                              (e.currentTarget as HTMLButtonElement).style.background =
                                "rgba(251, 191, 36, 0.15)";
                            }}
                          >
                            ⚡ {act.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              <span
                style={{
                  fontSize: "0.68rem",
                  color: "#64748b",
                  fontFamily: "ui-monospace, monospace",
                }}
              >
                {isUser ? "You" : "Agent"} • {msg.timestamp}
              </span>
            </div>
          );
        })}

        {sending && (
          <div
            style={{
              alignSelf: "flex-start",
              padding: "0.6rem 0.9rem",
              borderRadius: "12px 12px 12px 2px",
              background: "rgba(30, 41, 59, 0.6)",
              border: "1px solid rgba(251, 191, 36, 0.3)",
              color: "#fbbf24",
              fontSize: "0.82rem",
              fontFamily: "ui-monospace, monospace",
            }}
          >
            <span>⏳ Agent is generating guided tour step…</span>
          </div>
        )}

        <div ref={chatBottomRef} />
      </div>

      {/* Input Box Bar */}
      <form
        onSubmit={handleSend}
        style={{
          padding: "0.85rem 1.25rem",
          background: "rgba(3, 7, 18, 0.6)",
          borderTop: "1px solid rgba(51, 65, 85, 0.4)",
          display: "flex",
          gap: "0.75rem",
        }}
      >
        <input
          type="text"
          placeholder="Start guided tour, explain PR, or ask questions..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={sending}
          style={{
            flex: 1,
            padding: "0.65rem 0.85rem",
            borderRadius: "6px",
            background: "rgba(15, 23, 42, 0.9)",
            border: "1px solid rgba(51, 65, 85, 0.6)",
            color: "#f8fafc",
            fontSize: "0.85rem",
            fontFamily: "ui-monospace, monospace",
            outline: "none",
          }}
        />
        <button
          type="submit"
          disabled={sending || !input.trim()}
          style={{
            padding: "0.65rem 1.25rem",
            borderRadius: "6px",
            background: sending || !input.trim() ? "#334155" : "#fbbf24",
            color: sending || !input.trim() ? "#94a3b8" : "#0f172a",
            fontWeight: 700,
            fontSize: "0.85rem",
            border: "none",
            cursor: sending || !input.trim() ? "not-allowed" : "pointer",
            fontFamily: "ui-monospace, monospace",
          }}
        >
          Submit
        </button>
      </form>
    </div>
  );
}
