/**
 * Special results a tool handler can return instead of plain structured data.
 */

/** A complete tools/call result, passed through as is (content, structuredContent, isError, _meta). */
export class ToolResult {
  constructor(result) {
    this.result = result;
  }
}

/** MCP 2026-07-28 multi round-trip: ask the client for input, then expect a retry. */
export class InputRequired {
  constructor({ inputRequests, requestState }) {
    this.inputRequests = inputRequests;
    this.requestState = requestState;
  }
}
