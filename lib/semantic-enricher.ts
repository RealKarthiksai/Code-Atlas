/**
 * lib/semantic-enricher.ts
 *
 * AI Semantic Enrichment Layer for Codebase Atlas (V5).
 * Enriches deterministic AST / CPG nodes with architectural layer & semantic metadata:
 *   - layer: "frontend" | "backend" | "routing" | "auth-security" | "types" | "utility" | "general"
 *   - tagIds: string[] (e.g. ["AUTH", "LOGIN", "UI", "FN", "DB"])
 *   - domains: string[] (e.g. ["auth", "login", "orders", "fleet"])
 *   - features: string[] (e.g. ["user-authentication", "permission-guard"])
 *   - concepts: string[] (e.g. ["security", "e-commerce"])
 *   - actions: string[] (e.g. ["create", "validate", "save"])
 *   - confidence: number (0.0 - 1.0)
 */

import { type CodeNode } from "./graph-builder";
import { extractTagsRuleBased } from "./local-ai-tagger";

export type ArchitectureLayer =
  | "frontend"
  | "backend"
  | "routing"
  | "auth-security"
  | "types"
  | "utility"
  | "general";

export interface EnrichedCodeNode extends CodeNode {
  semantic: {
    layer: ArchitectureLayer;
    tagIds: string[];
    domains: string[];
    features: string[];
    concepts: string[];
    actions: string[];
    confidence: number;
  };
}

/**
 * Classifies an AST entity node into its architectural layer and domain tags.
 */
export function enrichGraphNodes(nodes: CodeNode[]): EnrichedCodeNode[] {
  return nodes.map((node) => {
    const text = (node.name + " " + node.path + " " + node.label).toLowerCase();
    const domains: string[] = [];
    const features: string[] = [];
    const concepts: string[] = [];
    const actions: string[] = [];
    let layer: ArchitectureLayer = "general";

    // Extract compact tag IDs (FN, AUTH, LOGIN, UI, DB, etc.)
    const tagIds = extractTagsRuleBased(node.name + " " + node.path, node.path);

    // 1. Layer classification
    if (node.path.endsWith(".tsx") || text.includes("component") || text.includes("page") || text.includes("view") || text.includes("ui") || text.includes("app.tsx")) {
      layer = "frontend";
    } else if (text.includes("service") || text.includes("repository") || text.includes("db") || text.includes("api") || text.includes("controller") || text.includes("store")) {
      layer = "backend";
    } else if (text.includes("route") || text.includes("router") || text.includes("guard") || text.includes("middleware")) {
      layer = "routing";
    } else if (text.includes("auth") || text.includes("login") || text.includes("token") || text.includes("permission") || text.includes("session")) {
      layer = "auth-security";
    } else if (node.type === "interface" || text.includes("type") || node.path.includes("/types/")) {
      layer = "types";
    } else if (text.includes("util") || text.includes("helper") || text.includes("format")) {
      layer = "utility";
    }

    // 2. Domain classification
    if (text.includes("login") || text.includes("signin")) {
      domains.push("login");
      features.push("login-flow");
    }
    if (text.includes("auth") || text.includes("user") || text.includes("session") || text.includes("token") || text.includes("permission")) {
      domains.push("auth");
      features.push("user-authentication");
      concepts.push("security");
    }
    if (text.includes("order") || text.includes("checkout")) {
      domains.push("orders");
      features.push("order-management");
      concepts.push("e-commerce");
    }
    if (text.includes("pay") || text.includes("billing")) {
      domains.push("payments");
      features.push("payment-processing");
    }
    if (text.includes("fleet") || text.includes("device") || text.includes("mission") || text.includes("operation")) {
      domains.push("operations");
      features.push("fleet-management");
    }
    if (text.includes("notify") || text.includes("email") || text.includes("alert")) {
      domains.push("notifications");
      features.push("alerting");
    }

    if (text.includes("create") || text.includes("save") || text.includes("insert")) actions.push("create");
    if (text.includes("validate") || text.includes("check") || text.includes("verify") || text.includes("login")) actions.push("validate");
    if (text.includes("send") || text.includes("dispatch")) actions.push("dispatch");

    return {
      ...node,
      semantic: {
        layer,
        tagIds,
        domains: Array.from(new Set(domains)),
        features: Array.from(new Set(features)),
        concepts: Array.from(new Set(concepts)),
        actions: Array.from(new Set(actions)),
        confidence: 0.95,
      },
    };
  });
}
