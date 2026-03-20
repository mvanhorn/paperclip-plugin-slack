import { describe, it, expect } from "vitest";
import { BUILTIN_WATCH_TEMPLATES } from "../src/proactive-suggestions.js";
import { isMediaFile, isAudioFile } from "../src/media-pipeline.js";

describe("BUILTIN_WATCH_TEMPLATES", () => {
  it("has 5 built-in templates", () => {
    expect(BUILTIN_WATCH_TEMPLATES.length).toBe(5);
  });

  it("each template has required fields", () => {
    for (const t of BUILTIN_WATCH_TEMPLATES) {
      expect(t.name).toBeTruthy();
      expect(t.eventPattern).toBeTruthy();
      expect(t.prompt).toBeTruthy();
      expect(t.description).toBeTruthy();
    }
  });

  it("includes sales-related templates", () => {
    const names = BUILTIN_WATCH_TEMPLATES.map((t) => t.name);
    expect(names).toContain("new-lead-follow-up");
    expect(names).toContain("deal-stalled");
  });

  it("includes ops templates", () => {
    const names = BUILTIN_WATCH_TEMPLATES.map((t) => t.name);
    expect(names).toContain("agent-error-diagnosis");
    expect(names).toContain("budget-warning");
  });
});

describe("media type detection", () => {
  it("detects audio files", () => {
    expect(isMediaFile("audio/mpeg")).toBe(true);
    expect(isMediaFile("audio/wav")).toBe(true);
    expect(isMediaFile("audio/ogg")).toBe(true);
    expect(isAudioFile("audio/mpeg")).toBe(true);
  });

  it("detects video files", () => {
    expect(isMediaFile("video/mp4")).toBe(true);
    expect(isMediaFile("video/webm")).toBe(true);
  });

  it("rejects non-media files", () => {
    expect(isMediaFile("text/plain")).toBe(false);
    expect(isMediaFile("application/json")).toBe(false);
    expect(isMediaFile("image/png")).toBe(false);
  });

  it("distinguishes audio from video", () => {
    expect(isAudioFile("audio/mpeg")).toBe(true);
    expect(isAudioFile("video/mp4")).toBe(false);
  });
});
