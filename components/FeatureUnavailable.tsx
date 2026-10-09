"use client";

import React from "react";

export interface FeatureUnavailableProps {
  featureName?: string;
  message?: string;
  requiredEnvVar?: string;
  onRetry?: () => void;
  style?: React.CSSProperties;
}

/**
 * Shared fallback banner/card for features that require external AI/API configuration.
 * Fails loudly with an actionable message instead of fabricating data.
 */
export default function FeatureUnavailable({
  featureName = "AI Feature",
  message = "Set GEMINI_API_KEY to enable this feature",
  requiredEnvVar = "GEMINI_API_KEY",
  onRetry,
  style,
}: FeatureUnavailableProps) {
  return (
    <div
      style={{
        padding: "1.25rem",
        borderRadius: "8px",
        background: "rgba(30, 27, 75, 0.4)",
        border: "1px solid rgba(239, 68, 68, 0.4)",
        color: "#fca5a5",
        display: "flex",
        flexDirection: "column",
        gap: "0.6rem",
        ...style,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <span style={{ fontSize: "1.1rem" }}>⚡</span>
        <h3
          style={{
            margin: 0,
            fontSize: "0.95rem",
            fontWeight: 700,
            color: "#fecaca",
          }}
        >
          {featureName} Unavailable (AI Not Configured)
        </h3>
      </div>

      <p
        style={{
          margin: 0,
          lineHeight: 1.5,
          fontSize: "0.88rem",
          color: "#fee2e2",
        }}
      >
        {message}
      </p>

      <div
        style={{
          fontSize: "0.8rem",
          color: "#94a3b8",
          background: "rgba(15, 23, 42, 0.6)",
          padding: "0.5rem 0.75rem",
          borderRadius: "4px",
          border: "1px solid rgba(51, 65, 85, 0.5)",
          fontFamily: "ui-monospace, monospace",
        }}
      >
        Add <code>{requiredEnvVar}</code> to your <code>.env.local</code> file and restart the server.
      </div>

      {onRetry && (
        <button
          onClick={onRetry}
          style={{
            alignSelf: "flex-start",
            marginTop: "0.25rem",
            padding: "0.35rem 0.85rem",
            borderRadius: "5px",
            background: "#dc2626",
            color: "#ffffff",
            border: "none",
            cursor: "pointer",
            fontSize: "0.82rem",
            fontWeight: 600,
            display: "inline-flex",
            alignItems: "center",
            gap: "0.35rem",
          }}
        >
          🔄 Retry
        </button>
      )}
    </div>
  );
}
