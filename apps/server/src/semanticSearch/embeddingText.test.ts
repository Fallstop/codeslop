import { describe, expect, it } from "vite-plus/test";

import {
  EMBEDDING_CHUNK_MAX_CHARS,
  EMBEDDING_MAX_CHUNKS_PER_MESSAGE,
  buildSemanticSnippet,
  chunkTextForEmbedding,
  dotProduct,
  packEmbedding,
  unpackEmbedding,
} from "./embeddingText.ts";

describe("chunkTextForEmbedding", () => {
  it("returns no chunks for whitespace-only text", () => {
    expect(chunkTextForEmbedding("   \n\t ")).toEqual([]);
    expect(chunkTextForEmbedding("a")).toEqual([]);
  });

  it("returns one normalized chunk for short text", () => {
    expect(chunkTextForEmbedding("  hello\n  world  ")).toEqual(["hello world"]);
  });

  it("splits long text into overlapping chunks bounded by the max size", () => {
    const sentence = "The quick brown fox jumps over the lazy dog. ";
    const text = sentence.repeat(120);
    const chunks = chunkTextForEmbedding(text);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(EMBEDDING_CHUNK_MAX_CHARS);
    }
    // Overlap: the start of chunk 2 re-appears near the end of chunk 1.
    expect(chunks[0]!.endsWith(chunks[1]!.slice(0, 40))).toBe(false);
    expect(text.replace(/\s+/g, " ").includes(chunks[1]!.slice(0, 40))).toBe(true);
  });

  it("prefers sentence boundaries for cuts", () => {
    const sentence = "Sentences end with punctuation and a space. ";
    const chunks = chunkTextForEmbedding(sentence.repeat(60));
    expect(chunks[0]!.endsWith(".")).toBe(true);
  });

  it("caps the number of chunks for pathological inputs", () => {
    const chunks = chunkTextForEmbedding("x".repeat(200_000));
    expect(chunks.length).toBeLessThanOrEqual(EMBEDDING_MAX_CHUNKS_PER_MESSAGE);
  });
});

describe("embedding packing", () => {
  it("round-trips vectors through the blob encoding", () => {
    const vector = Float32Array.from([0.25, -1.5, 3.125, 0]);
    const unpacked = unpackEmbedding(packEmbedding(vector));
    expect(unpacked).not.toBeNull();
    expect([...unpacked!]).toEqual([...vector]);
  });

  it("rejects empty and misaligned blobs", () => {
    expect(unpackEmbedding(new Uint8Array(0))).toBeNull();
    expect(unpackEmbedding(new Uint8Array(7))).toBeNull();
  });

  it("copies when the blob view is not 4-byte aligned", () => {
    const vector = Float32Array.from([1, 2]);
    const packed = packEmbedding(vector);
    const padded = new Uint8Array(packed.byteLength + 1);
    padded.set(packed, 1);
    const misaligned = new Uint8Array(padded.buffer, 1, packed.byteLength);
    expect([...unpackEmbedding(misaligned)!]).toEqual([1, 2]);
  });
});

describe("dotProduct", () => {
  it("computes cosine similarity for normalized vectors", () => {
    const left = Float32Array.from([1, 0]);
    const right = Float32Array.from([Math.SQRT1_2, Math.SQRT1_2]);
    expect(dotProduct(left, left)).toBeCloseTo(1);
    expect(dotProduct(left, right)).toBeCloseTo(Math.SQRT1_2);
    expect(dotProduct(left, Float32Array.from([0, 1]))).toBeCloseTo(0);
  });
});

describe("buildSemanticSnippet", () => {
  it("normalizes whitespace and bounds length to the 240-char contract", () => {
    expect(buildSemanticSnippet("  a\n b ")).toBe("a b");
    const long = buildSemanticSnippet("word ".repeat(200));
    expect(long.length).toBeLessThanOrEqual(240);
    expect(long.endsWith("…")).toBe(true);
  });
});
