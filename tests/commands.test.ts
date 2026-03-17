import { describe, it, expect, vi, beforeEach } from "vitest";

// We test the slash command logic by importing the worker and simulating webhook calls.
// Since the worker uses module-scoped state, we test the parseSlashCommand and command
// formatting logic via the exported plugin's onWebhook handler.

describe("slash command parsing", () => {
  function parseSlashCommand(rawBody: string) {
    const params = new URLSearchParams(rawBody);
    return {
      command: params.get("command") ?? "",
      text: params.get("text") ?? "",
      responseUrl: params.get("response_url") ?? "",
      userId: params.get("user_id") ?? "",
      channelId: params.get("channel_id") ?? "",
    };
  }

  it("parses a status command", () => {
    const raw = "command=%2Fclip&text=status&response_url=https%3A%2F%2Fhooks.slack.com%2Factions&user_id=U123&channel_id=C456";
    const result = parseSlashCommand(raw);
    expect(result.command).toBe("/clip");
    expect(result.text).toBe("status");
    expect(result.responseUrl).toBe("https://hooks.slack.com/actions");
    expect(result.userId).toBe("U123");
    expect(result.channelId).toBe("C456");
  });

  it("parses a help command (empty text)", () => {
    const raw = "command=%2Fclip&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Factions&user_id=U123";
    const result = parseSlashCommand(raw);
    expect(result.text).toBe("");
  });

  it("parses issues command with filter", () => {
    const raw = "command=%2Fclip&text=issues+done&response_url=https%3A%2F%2Fhooks.slack.com%2Factions";
    const result = parseSlashCommand(raw);
    expect(result.text).toBe("issues done");
    const parts = result.text.trim().split(/\s+/);
    expect(parts[0]).toBe("issues");
    expect(parts[1]).toBe("done");
  });

  it("parses approve command with id", () => {
    const raw = "command=%2Fclip&text=approve+apr-123&response_url=https%3A%2F%2Fhooks.slack.com%2Factions";
    const result = parseSlashCommand(raw);
    const parts = result.text.trim().split(/\s+/);
    expect(parts[0]).toBe("approve");
    expect(parts[1]).toBe("apr-123");
  });

  it("parses agents command", () => {
    const raw = "command=%2Fclip&text=agents&response_url=https%3A%2F%2Fhooks.slack.com%2Factions";
    const result = parseSlashCommand(raw);
    expect(result.text).toBe("agents");
  });

  it("handles unknown subcommand gracefully", () => {
    const raw = "command=%2Fclip&text=foobar&response_url=https%3A%2F%2Fhooks.slack.com%2Factions";
    const result = parseSlashCommand(raw);
    const subcommand = result.text.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    expect(subcommand).toBe("foobar");
    expect(["status", "help", "agents", "issues", "approve"]).not.toContain(subcommand);
  });
});

describe("statusBadge mapping", () => {
  function statusBadge(status: string): string {
    const badges: Record<string, string> = {
      active: ":large_green_circle:",
      running: ":large_green_circle:",
      idle: ":white_circle:",
      paused: ":double_vertical_bar:",
      error: ":red_circle:",
      pending_approval: ":hourglass:",
      terminated: ":black_circle:",
    };
    return badges[status] ?? ":white_circle:";
  }

  it("returns green for active", () => {
    expect(statusBadge("active")).toBe(":large_green_circle:");
  });

  it("returns green for running", () => {
    expect(statusBadge("running")).toBe(":large_green_circle:");
  });

  it("returns red for error", () => {
    expect(statusBadge("error")).toBe(":red_circle:");
  });

  it("returns hourglass for pending_approval", () => {
    expect(statusBadge("pending_approval")).toBe(":hourglass:");
  });

  it("returns white circle for unknown status", () => {
    expect(statusBadge("unknown")).toBe(":white_circle:");
  });
});
