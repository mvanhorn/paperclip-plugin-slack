import { describe, it, expect } from "vitest";
import {
  formatIssueCreated,
  formatIssueDone,
  formatApprovalCreated,
  formatApprovalResolved,
  formatAgentError,
  formatAgentConnected,
  formatBudgetThreshold,
  formatOnboardingMilestone,
  formatDailyDigest,
} from "../src/formatters.js";
import type { PluginEvent } from "@paperclipai/plugin-sdk";

function mockEvent(overrides: Record<string, unknown> = {}): PluginEvent {
  return {
    eventType: "issue.created",
    entityId: "iss-123",
    companyId: "co-1",
    occurredAt: new Date().toISOString(),
    payload: { identifier: "PROJ-42", title: "Test issue", ...overrides },
  } as PluginEvent;
}

describe("formatIssueCreated", () => {
  it("includes identifier and title in text", () => {
    const msg = formatIssueCreated(mockEvent());
    expect(msg.text).toBe("New issue: PROJ-42 - Test issue");
  });

  it("falls back to entityId when no identifier", () => {
    const msg = formatIssueCreated(mockEvent({ identifier: undefined }));
    expect(msg.text).toContain("iss-123");
  });

  it("includes metadata fields when available", () => {
    const msg = formatIssueCreated(mockEvent({
      status: "open",
      priority: "high",
      assigneeName: "Alice",
      projectName: "Backend",
    }));
    const fieldsBlock = msg.blocks?.find((b: Record<string, unknown>) => b.fields);
    expect(fieldsBlock).toBeDefined();
    const fields = (fieldsBlock as Record<string, unknown>).fields as Array<{ text: string }>;
    expect(fields.some((f) => f.text.includes("open"))).toBe(true);
    expect(fields.some((f) => f.text.includes("high"))).toBe(true);
    expect(fields.some((f) => f.text.includes("Alice"))).toBe(true);
  });

  it("includes description snippet", () => {
    const msg = formatIssueCreated(mockEvent({ description: "A long description about this issue" }));
    const section = msg.blocks?.[0] as Record<string, unknown>;
    const text = (section.text as Record<string, unknown>).text as string;
    expect(text).toContain("A long description");
  });

  it("includes View Issue button", () => {
    const msg = formatIssueCreated(mockEvent());
    const section = msg.blocks?.[0] as Record<string, unknown>;
    const accessory = section.accessory as Record<string, unknown>;
    expect(accessory.type).toBe("button");
    expect(accessory.url).toContain("/issues/iss-123");
  });
});

describe("formatIssueDone", () => {
  it("includes completion text", () => {
    const msg = formatIssueDone(mockEvent());
    expect(msg.text).toContain("PROJ-42");
    const section = msg.blocks?.[0] as Record<string, unknown>;
    const text = (section.text as Record<string, unknown>).text as string;
    expect(text).toContain("completed");
  });
});

describe("formatApprovalCreated", () => {
  it("includes approve and reject buttons", () => {
    const msg = formatApprovalCreated(mockEvent({
      type: "deploy",
      approvalId: "apr-1",
      issueIds: ["ISS-1"],
    }));
    const actionsBlock = msg.blocks?.find((b: Record<string, unknown>) => b.type === "actions");
    expect(actionsBlock).toBeDefined();
    const elements = (actionsBlock as Record<string, unknown>).elements as Array<Record<string, unknown>>;
    expect(elements.length).toBe(3);
    expect(elements[0].action_id).toBe("approval_approve");
    expect(elements[0].style).toBe("primary");
    expect(elements[1].action_id).toBe("approval_reject");
    expect(elements[1].style).toBe("danger");
    expect(elements[2].url).toContain("/approvals/apr-1");
  });

  it("shows issue count in fallback text", () => {
    const msg = formatApprovalCreated(mockEvent({
      type: "deploy",
      issueIds: ["ISS-1", "ISS-2"],
    }));
    expect(msg.text).toContain("2 issue(s)");
  });
});

describe("formatApprovalResolved", () => {
  it("shows approved state", () => {
    const msg = formatApprovalResolved("apr-1", true, "U123");
    expect(msg.text).toContain("Approved");
    const section = msg.blocks?.[0] as Record<string, unknown>;
    const text = (section.text as Record<string, unknown>).text as string;
    expect(text).toContain(":white_check_mark:");
  });

  it("shows rejected state", () => {
    const msg = formatApprovalResolved("apr-1", false, "U123");
    expect(msg.text).toContain("Rejected");
    const section = msg.blocks?.[0] as Record<string, unknown>;
    const text = (section.text as Record<string, unknown>).text as string;
    expect(text).toContain(":x:");
  });
});

describe("formatAgentError", () => {
  it("includes agent name and error in code block", () => {
    const msg = formatAgentError(mockEvent({
      agentName: "Builder",
      error: "Connection refused",
    }));
    expect(msg.text).toContain("Builder");
    const section = msg.blocks?.[0] as Record<string, unknown>;
    const text = (section.text as Record<string, unknown>).text as string;
    expect(text).toContain("```Connection refused```");
  });

  it("truncates long error messages at 500 chars", () => {
    const longError = "x".repeat(600);
    const msg = formatAgentError(mockEvent({ error: longError }));
    const section = msg.blocks?.[0] as Record<string, unknown>;
    const text = (section.text as Record<string, unknown>).text as string;
    expect(text).toContain("x".repeat(500));
    expect(text).not.toContain("x".repeat(501));
  });
});

describe("formatAgentConnected", () => {
  it("includes agent name with check emoji", () => {
    const msg = formatAgentConnected(mockEvent({ agentName: "Deployer" }));
    const section = msg.blocks?.[0] as Record<string, unknown>;
    const text = (section.text as Record<string, unknown>).text as string;
    expect(text).toContain("Deployer");
    expect(text).toContain(":white_check_mark:");
  });
});

describe("formatBudgetThreshold", () => {
  it("shows percentage and dollar amounts", () => {
    const msg = formatBudgetThreshold(mockEvent({
      agentName: "Coder",
      percentUsed: 90,
      spent: 45,
      budget: 50,
    }));
    expect(msg.text).toContain("90%");
    const section = msg.blocks?.[0] as Record<string, unknown>;
    const text = (section.text as Record<string, unknown>).text as string;
    expect(text).toContain("$45");
    expect(text).toContain("$50");
  });
});

describe("formatOnboardingMilestone", () => {
  it("includes milestone text and tada emoji", () => {
    const msg = formatOnboardingMilestone(mockEvent({
      agentName: "NewAgent",
      milestone: "first successful run",
    }));
    const section = msg.blocks?.[0] as Record<string, unknown>;
    const text = (section.text as Record<string, unknown>).text as string;
    expect(text).toContain("first successful run");
    expect(text).toContain(":tada:");
  });
});

describe("formatDailyDigest", () => {
  it("renders fields grid with all stats", () => {
    const msg = formatDailyDigest({
      tasksCompleted: 5,
      tasksCreated: 3,
      agentsActive: 2,
      totalCost: "12.50",
      topAgent: "Builder",
    });
    const fieldsBlock = msg.blocks?.find((b: Record<string, unknown>) => b.fields);
    expect(fieldsBlock).toBeDefined();
    const fields = (fieldsBlock as Record<string, unknown>).fields as Array<{ text: string }>;
    expect(fields.some((f) => f.text.includes("5"))).toBe(true);
    expect(fields.some((f) => f.text.includes("$12.50"))).toBe(true);
  });

  it("includes top performer when provided", () => {
    const msg = formatDailyDigest({
      tasksCompleted: 0,
      tasksCreated: 0,
      agentsActive: 0,
      totalCost: "0.00",
      topAgent: "Star",
    });
    const topBlock = msg.blocks?.find((b: Record<string, unknown>) => {
      const text = (b as Record<string, unknown>).text as Record<string, unknown> | undefined;
      return text && String(text.text ?? "").includes("Star");
    });
    expect(topBlock).toBeDefined();
  });

  it("omits top performer when empty", () => {
    const msg = formatDailyDigest({
      tasksCompleted: 0,
      tasksCreated: 0,
      agentsActive: 0,
      totalCost: "0.00",
      topAgent: "",
    });
    const hasTopPerformer = msg.blocks?.some((b: Record<string, unknown>) => {
      const text = (b as Record<string, unknown>).text as Record<string, unknown> | undefined;
      return text && String(text.text ?? "").includes("Top performer");
    });
    expect(hasTopPerformer).toBe(false);
  });
});
