/**
 * Pure helpers for semantic thread search: message chunking for embedding and
 * Float32 vector packing/scoring shared by the index and the indexer.
 *
 * @module embeddingText
 */

export const EMBEDDING_CHUNK_MAX_CHARS = 1000;
export const EMBEDDING_CHUNK_OVERLAP_CHARS = 200;
/** Very long messages (pasted logs, huge diffs) are truncated, not fully indexed. */
export const EMBEDDING_MAX_CHUNKS_PER_MESSAGE = 24;
/** Chunks shorter than this carry no useful signal (e.g. "ok", "thanks"). */
const MIN_CHUNK_CHARS = 3;

/**
 * Split message text into overlapping chunks for embedding.
 *
 * Prefers paragraph, then sentence/line boundaries near the target size so a
 * chunk stays self-contained; falls back to a hard cut for unbroken text.
 */
export function chunkTextForEmbedding(text: string): ReadonlyArray<string> {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length < MIN_CHUNK_CHARS) {
    return [];
  }
  if (normalized.length <= EMBEDDING_CHUNK_MAX_CHARS) {
    return [normalized];
  }

  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length && chunks.length < EMBEDDING_MAX_CHUNKS_PER_MESSAGE) {
    let end = Math.min(start + EMBEDDING_CHUNK_MAX_CHARS, normalized.length);
    if (end < normalized.length) {
      // Cut at the last sentence end or word boundary in the final quarter of
      // the window, keeping chunks close to the target size.
      const windowFloor = start + Math.floor(EMBEDDING_CHUNK_MAX_CHARS * 0.75);
      const window = normalized.slice(windowFloor, end);
      let cut = -1;
      for (const boundary of [". ", "! ", "? "]) {
        const at = window.lastIndexOf(boundary);
        if (at >= 0) {
          cut = Math.max(cut, at + 2);
        }
      }
      if (cut < 0) {
        const lastSpace = window.lastIndexOf(" ");
        cut = lastSpace >= 0 ? lastSpace + 1 : -1;
      }
      if (cut > 0) {
        end = windowFloor + cut;
      }
    }
    const chunk = normalized.slice(start, end).trim();
    if (chunk.length >= MIN_CHUNK_CHARS) {
      chunks.push(chunk);
    }
    if (end >= normalized.length) {
      break;
    }
    start = Math.max(end - EMBEDDING_CHUNK_OVERLAP_CHARS, start + 1);
  }
  return chunks;
}

/** Pack an embedding into the little-endian Float32 blob stored in SQLite. */
export function packEmbedding(vector: Float32Array): Uint8Array {
  return new Uint8Array(
    vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength),
  );
}

/** Unpack a stored blob; returns null for malformed lengths or sentinel rows. */
export function unpackEmbedding(bytes: Uint8Array): Float32Array | null {
  if (bytes.byteLength === 0 || bytes.byteLength % 4 !== 0) {
    return null;
  }
  if (bytes.byteOffset % 4 === 0) {
    return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  }
  const copy = new Uint8Array(bytes);
  return new Float32Array(copy.buffer, 0, copy.byteLength / 4);
}

/** Dot product; equals cosine similarity for the normalized vectors we store. */
export function dotProduct(left: Float32Array, right: Float32Array): number {
  const length = Math.min(left.length, right.length);
  let sum = 0;
  for (let index = 0; index < length; index += 1) {
    sum += left[index]! * right[index]!;
  }
  return sum;
}

/**
 * Build a display snippet from a semantically matched chunk. Unlike lexical
 * snippets there is no literal query substring to center on, so this is a
 * plain prefix bounded to the contract's 240-char snippet limit.
 */
export function buildSemanticSnippet(chunkText: string): string {
  const normalized = chunkText.replace(/\s+/g, " ").trim();
  if (normalized.length <= 240) {
    return normalized;
  }
  return `${normalized.slice(0, 239)}…`;
}
