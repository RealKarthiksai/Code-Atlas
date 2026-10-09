/**
 * scratch/demo_qa_tags.ts
 *
 * Live Q&A demonstration showing how AST entity tagging + DSA HashMap lookup
 * handles user queries ("login", "orders") offline out-of-the-box.
 */

import { answerQuestion } from "../lib/qa";

const sampleFiles = [
  {
    path: "src/pages/auth/Login.tsx",
    content: `
      import React, { useState } from "react";
      import { AuthService } from "../../services/AuthService";

      export function LoginPage() {
        const [token, setToken] = useState("");
        const auth = new AuthService();

        const handleLogin = async () => {
          if (!token) return;
          await auth.validateUserToken(token);
        };

        return <button onClick={handleLogin}>Log In</button>;
      }
    `,
  },
  {
    path: "src/services/AuthService.ts",
    content: `
      import { SessionStore } from "../store/SessionStore";

      export class AuthService {
        private session = new SessionStore();

        async validateUserToken(token: string) {
          if (!token || token.length < 5) {
            throw new Error("Invalid authentication token");
          }
          return this.session.createSession(token);
        }
      }
    `,
  },
  {
    path: "src/store/SessionStore.ts",
    content: `
      export class SessionStore {
        async createSession(token: string) {
          return { token, active: true, createdAt: new Date() };
        }
      }
    `,
  },
];

async function runDemo() {
  console.log("=========================================================");
  console.log("   CODEBASE ATLAS: LIVE LOCAL TAGGER & Q&A DEMO          ");
  console.log("=========================================================\n");

  const query = "login";
  console.log(`User Input Query: "${query}"\n`);

  const result = await answerQuestion({
    repoUrl: "local-demo",
    question: query,
    snippets: sampleFiles,
    files: sampleFiles.map((s) => s.path),
    folders: ["src", "src/pages", "src/services", "src/store"],
  });

  console.log("---------------- GENERATED SUBGRAPH ANSWER ----------------");
  console.log(result.answer);
  console.log("\n---------------- REFERENCED FOCUS FILES ----------------");
  console.log("Referenced Files:", result.referencedFiles);
  console.log("Focus Files for Graph Highlighting:", result.focusFiles);
  console.log("=========================================================");
}

runDemo();
