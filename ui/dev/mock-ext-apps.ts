type HostStyles = {
  variables?: Record<string, string>;
};

export type McpUiHostContext = {
  displayMode?: "inline" | "fullscreen";
  availableDisplayModes?: Array<"inline" | "fullscreen">;
  styles?: HostStyles;
  theme?: "light" | "dark";
  tool_input?: Record<string, unknown>;
};

type SizeChangedPayload = { height?: number; width?: number };
type UpdateModelContextPayload = { content?: Array<{ type: string; text?: string }> };
type RequestDisplayModePayload = { mode: "inline" | "fullscreen" };
type CallServerToolPayload = { name: string; arguments?: Record<string, unknown> };

function parseHostContext(): McpUiHostContext {
  const params = new URLSearchParams(window.location.search);
  const pdfPath = params.get("pdf_path") || "example-fw9.pdf";
  const page = Number(params.get("page") || "1");
  const displayMode = (params.get("display_mode") || "inline") as "inline" | "fullscreen";
  const theme = (params.get("theme") || "light") as "light" | "dark";

  return {
    displayMode,
    availableDisplayModes: ["inline", "fullscreen"],
    theme,
    tool_input: {
      pdf_path: pdfPath,
      page: Number.isFinite(page) ? page : 1,
      display_mode: displayMode,
    },
  };
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `HTTP ${response.status}`);
  }
  return await response.json() as T;
}

export function applyDocumentTheme(_theme?: string) {}
export function applyHostStyleVariables(_vars?: Record<string, string>) {}

export class App {
  ontoolresult?: (result: any) => void | Promise<void>;
  onerror?: (err: unknown) => void;
  onhostcontextchanged?: (ctx: McpUiHostContext) => void;

  #hostContext: McpUiHostContext;

  constructor(_info: unknown, _capabilities?: unknown, _options?: unknown) {
    this.#hostContext = parseHostContext();
  }

  async connect() {
    queueMicrotask(() => {
      try {
        this.onhostcontextchanged?.(this.#hostContext);
      } catch (err) {
        this.onerror?.(err);
      }
    });

    const toolInput = this.#hostContext.tool_input as { pdf_path?: string; page?: number } | undefined;
    if (toolInput?.pdf_path) {
      try {
        const result = await this.callServerTool({
          name: "display_pdf",
          arguments: {
            pdf_path: toolInput.pdf_path,
            ...(toolInput.page ? { page: toolInput.page } : {}),
          },
        });
        await this.ontoolresult?.(result);
      } catch (err) {
        this.onerror?.(err);
      }
    }
  }

  getHostContext() {
    return this.#hostContext;
  }

  async callServerTool({ name, arguments: args = {} }: CallServerToolPayload) {
    return await postJson<any>("/__dev__/tool", { name, arguments: args });
  }

  sendSizeChanged(_payload: SizeChangedPayload) {}

  updateModelContext(_payload: UpdateModelContextPayload) {}

  async requestDisplayMode({ mode }: RequestDisplayModePayload) {
    this.#hostContext = {
      ...this.#hostContext,
      displayMode: mode,
    };
    this.onhostcontextchanged?.(this.#hostContext);
    return { mode };
  }
}
