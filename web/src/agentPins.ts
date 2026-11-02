import { apiErrorMessage } from "./bridgeApi";
import type { BridgeHttpUrl } from "./bridgeApi";
import { fetchWithTimeout } from "./fetchWithTimeout";
import { isRecord } from "./isRecord";
import type { BridgeCapabilities } from "./bridge";

export type AgentPinContext = {
  pane_label?: string;
  pane_title?: string;
  agent?: string;
  display_agent?: string;
  cwd?: string;
  foreground_cwd?: string;
};

export type AgentPin = {
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
  tab_id: string;
  created_at: string;
  context: AgentPinContext;
};

export type AgentPinsListResponse = {
  session_key: string;
  pins: AgentPin[];
};

export type { BridgeHttpUrl } from "./bridgeApi";

export class AgentPinsApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "AgentPinsApiError";
    this.status = status;
  }
}

export function supportsAgentPins(capabilities: BridgeCapabilities | null | undefined) {
  return capabilities?.agent_pins?.version === 1;
}

export async function fetchAgentPins(
  httpUrl: BridgeHttpUrl,
): Promise<AgentPinsListResponse> {
  const response = await fetchWithTimeout(httpUrl("/api/agent-pins"));
  return parseAgentPinsResponse(response);
}

export function pinAgent(httpUrl: BridgeHttpUrl, paneId: string) {
  return sendAgentPinMutation(httpUrl, `/api/agent-pins/${encodeURIComponent(paneId)}/pin`);
}

export function unpinAgent(httpUrl: BridgeHttpUrl, paneId: string) {
  return sendAgentPinMutation(httpUrl, `/api/agent-pins/${encodeURIComponent(paneId)}/unpin`);
}

export function agentPinKey(bridgeId: string, paneId: string) {
  return `${bridgeId}:${paneId}`;
}

export function agentPinKeys(bridgeId: string, response: AgentPinsListResponse | null | undefined) {
  return new Set((response?.pins ?? []).map((pin) => agentPinKey(bridgeId, pin.pane_id)));
}

async function sendAgentPinMutation(httpUrl: BridgeHttpUrl, path: string) {
  const response = await fetchWithTimeout(httpUrl(path), { method: "POST" });
  return parseAgentPinsResponse(response);
}

async function parseAgentPinsResponse(response: Response) {
  if (!response.ok) {
    throw await agentPinsApiError(response);
  }
  return parseAgentPinsListResponse(await response.json());
}

export function parseAgentPinsListResponse(value: unknown): AgentPinsListResponse {
  if (!isRecord(value) || typeof value.session_key !== "string" || !Array.isArray(value.pins)) {
    throw new Error("agent pins response is invalid");
  }
  return {
    session_key: value.session_key,
    pins: value.pins.map(parseAgentPin),
  };
}

function parseAgentPin(value: unknown): AgentPin {
  if (
    !isRecord(value) ||
    typeof value.pane_id !== "string" ||
    typeof value.terminal_id !== "string" ||
    typeof value.workspace_id !== "string" ||
    typeof value.tab_id !== "string" ||
    typeof value.created_at !== "string"
  ) {
    throw new Error("agent pin record is invalid");
  }
  return {
    pane_id: value.pane_id,
    terminal_id: value.terminal_id,
    workspace_id: value.workspace_id,
    tab_id: value.tab_id,
    created_at: value.created_at,
    context: parseAgentPinContext(value.context),
  };
}

const agentPinContextFields = [
  "pane_label",
  "pane_title",
  "agent",
  "display_agent",
  "cwd",
  "foreground_cwd",
] as const;

function parseAgentPinContext(value: unknown): AgentPinContext {
  if (!isRecord(value)) {
    return {};
  }
  const context: AgentPinContext = {};
  for (const field of agentPinContextFields) {
    const fieldValue = value[field];
    if (typeof fieldValue === "string") {
      context[field] = fieldValue;
    }
  }
  return context;
}


async function agentPinsApiError(response: Response) {
  const message = await apiErrorMessage(response);
  return new AgentPinsApiError(
    message ?? `agent pins failed: ${response.status}`,
    response.status,
  );
}
