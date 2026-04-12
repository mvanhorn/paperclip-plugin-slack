import { describe, it, expect } from "vitest";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import {
  formatIssueCreated,
  formatIssueDone,
  formatIssueStatusChanged,
} from "../src/formatters.js";

function mockEvent(eventType: string, payload: Record<string, unknown> = {}): PluginEvent {
  return {
    eventType,
    entityId: "issue-123",
    companyId: "company-1",
    occurredAt: "2026-04-12T10:00:00.000Z",
    payload: {
      identifier: "DGG-123",
      title: "Notifier duplication investigation",
      status: "in_progress",
      assigneeName: "Badtz Dev",
      ...payload,
    },
  } as PluginEvent;
}

function firstSectionText(message: { blocks?: Array<Record<string, unknown>> }): string {
  const firstSection = message.blocks?.find((b) => b.type === "section" && b.text) as
    | Record<string, unknown>
    | undefined;
  if (!firstSection) return "";
  return String((firstSection.text as Record<string, unknown>).text ?? "");
}

describe("DGG-646 notifier compose dedup", () => {
  it("issue.created fallback text should not duplicate title already in block body", () => {
    const msg = formatIssueCreated(mockEvent("issue.created"));
    const section = firstSectionText(msg);

    expect(msg.text).toContain("새 이슈");
    expect(msg.text).not.toContain("Notifier duplication investigation");
    expect(section).toContain("Notifier duplication investigation");
  });

  it("issue.status_changed fallback text should only carry status headline", () => {
    const msg = formatIssueStatusChanged(
      mockEvent("issue.status_changed", {
        description: "## Execution Update\n- Notifier duplication investigation",
      }),
    );
    const section = firstSectionText(msg);

    expect(msg.text).toContain("진행 중");
    expect(msg.text).not.toContain("Notifier duplication investigation");
    expect(section).toContain("Notifier duplication investigation");
  });

  it("issue.done fallback text should not repeat title rendered in block", () => {
    const msg = formatIssueDone(
      mockEvent("issue.done", {
        description: "## Execution Update\n- Notifier duplication investigation",
      }),
    );
    const section = firstSectionText(msg);

    expect(msg.text).toContain("완료");
    expect(msg.text).not.toContain("Notifier duplication investigation");
    expect(section).toContain("Notifier duplication investigation");
  });
});
