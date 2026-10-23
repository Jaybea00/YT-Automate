import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The depth model's runtime loads native code: Node requires it directly instead of bundling it
  serverExternalPackages: ["@huggingface/transformers", "onnxruntime-node"],
};

export default nextConfig;
