import { describe, expect, it } from "@effect/vitest";
import { isPathUsableOnPlatform, partitionDroppedComposerFiles } from "./composerDroppedFiles";

function makeFile(name: string, type: string): File {
  return new File(["contents"], name, { type });
}

describe("isPathUsableOnPlatform", () => {
  it("accepts each platform's own absolute paths", () => {
    expect(isPathUsableOnPlatform("/Users/me/notes.md", "darwin")).toBe(true);
    expect(isPathUsableOnPlatform("/home/me/notes.md", "linux")).toBe(true);
    expect(isPathUsableOnPlatform("C:\\Users\\me\\notes.md", "windows")).toBe(true);
    expect(isPathUsableOnPlatform("\\\\share\\notes.md", "windows")).toBe(true);
  });

  it("rejects a path shaped for a different platform", () => {
    // The WSL-hosted local backend: a Windows drag, a Linux filesystem.
    expect(isPathUsableOnPlatform("C:\\Users\\me\\notes.md", "linux")).toBe(false);
    expect(isPathUsableOnPlatform("/home/me/notes.md", "windows")).toBe(false);
  });

  it("accepts any absolute path when the platform is unknown", () => {
    expect(isPathUsableOnPlatform("/Users/me/notes.md", null)).toBe(true);
    expect(isPathUsableOnPlatform("C:\\Users\\me\\notes.md", "unknown")).toBe(true);
    expect(isPathUsableOnPlatform("notes.md", null)).toBe(false);
  });
});

describe("partitionDroppedComposerFiles", () => {
  const resolvePath = (file: File) => `/Users/me/Downloads/${file.name}`;

  it("links non-image files and leaves images to be attached", () => {
    const image = makeFile("shot.png", "image/png");
    const document = makeFile("notes.md", "text/markdown");

    const result = partitionDroppedComposerFiles({
      files: [image, document],
      resolvePath,
      environmentOs: "darwin",
    });

    expect(result.imageFiles).toEqual([image]);
    expect(result.fileLinks).toEqual(["[notes.md](/Users/me/Downloads/notes.md)"]);
    expect(result.unlinkableFiles).toEqual([]);
  });

  it("escapes link destinations that need it", () => {
    const result = partitionDroppedComposerFiles({
      files: [makeFile("quarterly report.pdf", "application/pdf")],
      resolvePath,
      environmentOs: "darwin",
    });

    expect(result.fileLinks).toEqual([
      "[quarterly report.pdf](/Users/me/Downloads/quarterly%20report.pdf)",
    ]);
  });

  it("cannot link when the host exposes no path", () => {
    const document = makeFile("notes.md", "text/markdown");

    const result = partitionDroppedComposerFiles({
      files: [document],
      resolvePath: null,
      environmentOs: "darwin",
    });

    expect(result.fileLinks).toEqual([]);
    expect(result.unlinkableFiles).toEqual([document]);
  });

  it("cannot link a file the environment's filesystem would not find", () => {
    const document = makeFile("notes.md", "text/markdown");

    const result = partitionDroppedComposerFiles({
      files: [document],
      resolvePath: () => "C:\\Users\\me\\notes.md",
      environmentOs: "linux",
    });

    expect(result.fileLinks).toEqual([]);
    expect(result.unlinkableFiles).toEqual([document]);
  });

  it("cannot link a file the shell has no path for", () => {
    const document = makeFile("notes.md", "text/markdown");

    const result = partitionDroppedComposerFiles({
      files: [document],
      resolvePath: () => null,
      environmentOs: "darwin",
    });

    expect(result.unlinkableFiles).toEqual([document]);
  });
});
