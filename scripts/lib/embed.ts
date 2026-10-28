// Local sentence embeddings (all-MiniLM-L6-v2, 384 dims). Downloaded once, then cached.
import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

let extractor: Promise<FeatureExtractionPipeline> | null = null;

export async function embed(text: string): Promise<number[]> {
  extractor ??= pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { dtype: "fp32" });
  const out = await (await extractor)(text, { pooling: "mean", normalize: true });
  return Array.from(out.data as Float32Array);
}

export function cosine(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s; // vectors are normalized
}
