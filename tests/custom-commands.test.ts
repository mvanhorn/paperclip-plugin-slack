import { describe, it, expect } from "vitest";
import { parseCommand } from "../src/custom-commands.js";

describe("parseCommand", () => {
  it("parses a simple command", () => {
    const result = parseCommand("!deploy");
    expect(result).toEqual({ name: "deploy", args: [] });
  });

  it("parses a command with args", () => {
    const result = parseCommand("!deploy staging v2.1.0");
    expect(result).toEqual({ name: "deploy", args: ["staging", "v2.1.0"] });
  });

  it("returns null for non-command text", () => {
    expect(parseCommand("hello world")).toBeNull();
    expect(parseCommand("")).toBeNull();
    expect(parseCommand("  ")).toBeNull();
  });

  it("lowercases command name", () => {
    const result = parseCommand("!Deploy");
    expect(result?.name).toBe("deploy");
  });

  it("handles whitespace", () => {
    const result = parseCommand("  !test   arg1  arg2  ");
    expect(result).toEqual({ name: "test", args: ["arg1", "arg2"] });
  });
});
