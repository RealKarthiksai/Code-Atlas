import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["web-tree-sitter", "tree-sitter-wasms"],
};

export default nextConfig;
