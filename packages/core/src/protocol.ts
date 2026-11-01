export type ErrorCode = "not_connected" | "profile_required" | "permission_denied" | "permission_required"
  | "security_check_failed" | "oob" | "stale_ref" | "attach_failed" | "protected_page"
  | "detached_by_user" | "stopped_by_user" | "tab_not_in_session" | "timeout" | "invalid_args" | "internal";

export type ContentBlock = { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: "image/jpeg" | "image/png" };

export type ToolName =
  "tabs_list" | "tabs_create" | "tabs_close" | "navigate" | "read_page" | "get_page_text" | "form_input" | "computer"
  | "profiles_list" | "profile_select";

export interface ToolCall { id: string; session_id: string; tool: ToolName; args: Record<string, unknown> }

export type ToolResult = { id: string; session_id: string; content: ContentBlock[] }
  | { id: string; session_id: string; error: { code: ErrorCode; message: string } };

// host → extension
export type HostToExt = ({ type: "tool_call" } & ToolCall)
  | { type: "session_open"; session_id: string; client_name: string }
  | { type: "session_close"; session_id: string }
  | { type: "tool_cancel"; id: string; session_id: string };

// extension → host
export type ExtToHost = { type: "hello"; profile_id: string; profile_label: string; extension_version: string }
  | ({ type: "tool_result" } & ToolResult)
  | { type: "tool_pending"; id: string; session_id: string; extend_ms: number }
  | { type: "profile_label"; profile_label: string };

// mcp ⇄ host（socket）
export type McpToHost = { type: "open"; client_name: string }
  | { type: "call"; id: string; tool: ToolName; args: Record<string, unknown> }
  | { type: "cancel"; id: string };

export type HostToMcp = { type: "opened"; session_id: string; profile_id: string; profile_label: string }
  | ({ type: "result" } & Omit<ToolResult, "session_id">)
  | { type: "pending"; id: string; extend_ms: number };
