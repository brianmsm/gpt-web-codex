import { expect, test } from "bun:test";
import {
  IMAGE_PREVIEW_HTML,
  IMAGE_PREVIEW_RESOURCE_URI,
  LEGACY_IMAGE_PREVIEW_RESOURCE_URIS,
} from "../src/standalone/image-preview";

interface FakeElement {
  hidden: boolean;
  disabled: boolean;
  textContent: string;
  src: string;
  alt: string;
  listeners: Map<string, Array<() => void>>;
  addEventListener(type: string, listener: () => void): void;
}

function createElement(): FakeElement {
  return {
    hidden: false,
    disabled: false,
    textContent: "",
    src: "",
    alt: "",
    listeners: new Map(),
    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) ?? [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    },
  };
}

function createStorage() {
  const values = new Map<string, string>();
  return {
    getItem(key: string) { return values.get(key) ?? null; },
    setItem(key: string, value: string) { values.set(key, value); },
    removeItem(key: string) { values.delete(key); },
    peek(key: string) { return values.get(key) ?? null; },
  };
}

interface PreviewMetrics {
  renderFrom: number;
  renderImage: number;
  restoreCalls: number;
}

function mountPreview(
  openai?: Record<string, unknown>,
  storage = { localStorage: createStorage(), sessionStorage: createStorage() },
  metrics?: PreviewMetrics,
) {
  const elements = Object.fromEntries(
    ["card", "preview", "name", "detail", "status", "statusText", "retry"].map(id => [id, createElement()]),
  ) as Record<string, FakeElement>;
  const listeners = new Map<string, Array<(event: { source?: unknown; data?: unknown; detail?: unknown }) => void>>();
  const messages: Array<Record<string, any>> = [];
  const parent = { postMessage(message: Record<string, unknown>) { messages.push(message); } };
  let nextTimer = 1;
  const timers = new Map<number, () => void>();
  const fakeWindow = {
    ...(openai ? { openai } : {}),
    ...(metrics ? { __previewMetrics: metrics } : {}),
    ...storage,
    parent,
    addEventListener(type: string, listener: (event: { source?: unknown; data?: unknown; detail?: unknown }) => void) {
      const current = listeners.get(type) ?? [];
      current.push(listener);
      listeners.set(type, current);
    },
  };
  if (openai) {
    openai.__dispatchGlobalsForTest = (globals: unknown) => {
      for (const listener of listeners.get("openai:set_globals") ?? []) listener({ detail: { globals } });
    };
    openai.__dispatchToolResultForTest = (params: unknown) => {
      for (const listener of listeners.get("message") ?? []) {
        listener({ source: parent, data: { jsonrpc: "2.0", method: "ui/notifications/tool-result", params } });
      }
    };
  }
  const fakeDocument = {
    referrer: "https://chatgpt.com/c/test-conversation",
    getElementById(id: string) { return elements[id]; },
  };
  let script = /<script>([\s\S]*)<\/script>/.exec(IMAGE_PREVIEW_HTML)?.[1];
  if (!script) throw new Error("Image preview script is missing");
  if (metrics) {
    script = script
      .replace(
        "const renderFrom = (globals) => {",
        "const renderFrom = (globals) => { window.__previewMetrics.renderFrom += 1;",
      )
      .replace(
        "const renderImage = (image) => {",
        "const renderImage = (image) => { window.__previewMetrics.renderImage += 1;",
      )
      .replace(
        "const callRestoreTool = async (previewId) => {",
        "const callRestoreTool = async (previewId) => { window.__previewMetrics.restoreCalls += 1;",
      );
  }
  const execute = new Function("window", "document", "setTimeout", "clearTimeout", script);
  execute(
    fakeWindow,
    fakeDocument,
    (callback: () => void) => {
      const id = nextTimer++;
      timers.set(id, callback);
      return id;
    },
    (id: number) => timers.delete(id),
  );
  return {
    elements,
    messages,
    storage,
    dispatchMessage(data: Record<string, unknown>) {
      for (const listener of listeners.get("message") ?? []) listener({ source: parent, data });
    },
    dispatchGlobals(globals: unknown) {
      for (const listener of listeners.get("openai:set_globals") ?? []) listener({ detail: { globals } });
    },
    clickRetry() {
      for (const listener of elements.retry.listeners.get("click") ?? []) listener();
    },
    runTimers() {
      const callbacks = [...timers.values()];
      timers.clear();
      callbacks.forEach(callback => callback());
    },
  };
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

const PREVIEW_A = "11111111-1111-4111-8111-111111111111";
const PREVIEW_B = "22222222-2222-4222-8222-222222222222";
const PREVIEW_C = "33333333-3333-4333-8333-333333333333";

function previewMetadata(previewId: string, name = "preview.png", dataUrl = "data:image/png;base64,aW1hZ2U=") {
  return {
    preview_id: previewId,
    name,
    mime_type: "image/png",
    bytes: 5,
    width: 1,
    height: 1,
    data_url: dataUrl,
  };
}

function previewToolResult(previewId: string, name = "preview.png", dataUrl = "data:image/png;base64,aW1hZ2U=") {
  return {
    structuredContent: { preview_id: previewId, name, mime_type: "image/png", bytes: 5, width: 1, height: 1 },
    _meta: { webgpt_image_preview: previewMetadata(previewId, name, dataUrl) },
  };
}

test("image preview lifecycle uses a new v13 resource while keeping v12 and older resources addressable", () => {
  expect(IMAGE_PREVIEW_RESOURCE_URI).toBe("ui://webgpt-luna/image-preview-v13.html");
  expect(LEGACY_IMAGE_PREVIEW_RESOURCE_URIS).toContain("ui://webgpt-luna/image-preview-v12.html");
  expect(IMAGE_PREVIEW_HTML).not.toContain("localStorage");
  expect(IMAGE_PREVIEW_HTML).not.toContain("sessionStorage");
  expect(IMAGE_PREVIEW_HTML).toContain('name="webgpt-preview-resource"');
});

test("image preview persists one small widget snapshot and restores only its own id after iframe recreation", async () => {
  const dataUrl = "data:image/png;base64,aW1hZ2U=";
  let widgetState: unknown;
  let stateWrites = 0;
  const first = mountPreview({
    toolResponseMetadata: {
      mcp_tool_result: {
        _meta: { webgpt_image_preview: previewMetadata(PREVIEW_A, "refresh.png", dataUrl) },
      },
    },
    setWidgetState(value: unknown) {
      stateWrites += 1;
      widgetState = value;
    },
  });
  expect(first.elements.preview.src).toBe(dataUrl);
  expect(stateWrites).toBe(1);
  expect(widgetState).toEqual({
    webgpt_image_preview: {
      preview_id: PREVIEW_A,
      name: "refresh.png",
      mime_type: "image/png",
      bytes: 5,
      width: 1,
      height: 1,
    },
  });
  expect(first.messages.some(message => message.method === "ui/initialize")).toBe(false);

  const restoreIds: string[] = [];
  const restoredOpenai = {
    widgetState,
    async callTool(name: string, args: { preview_id: string }) {
      expect(name).toBe("file_image_preview_restore");
      restoreIds.push(args.preview_id);
      return previewToolResult(PREVIEW_A, "refresh.png", dataUrl);
    },
  };
  const restored = mountPreview(restoredOpenai);
  await flushPromises();
  expect(restored.messages.some(message => message.method === "ui/initialize")).toBe(false);
  expect(restored.messages.some(message => message.method === "tools/call")).toBe(false);
  expect(restoreIds).toEqual([PREVIEW_A]);
  expect(restored.elements.preview.src).toBe(dataUrl);
  expect(restored.elements.card.hidden).toBe(false);
  expect(restored.elements.status.hidden).toBe(true);
});

test("metadata-only file preview result renders through exactly one app-only restore", async () => {
  const metrics: PreviewMetrics = { renderFrom: 0, renderImage: 0, restoreCalls: 0 };
  let stateWrites = 0;
  const openai = {
    toolResponseMetadata: {
      mcp_tool_result: {
        _meta: {
          webgpt_image_preview: {
            preview_id: PREVIEW_A,
            name: "metadata-only.png",
            mime_type: "image/png",
            bytes: 5,
            width: 1,
            height: 1,
          },
        },
      },
    },
    setWidgetState() { stateWrites += 1; },
    async callTool(name: string, args: { preview_id: string }) {
      expect(name).toBe("file_image_preview_restore");
      expect(args).toEqual({ preview_id: PREVIEW_A });
      return previewToolResult(PREVIEW_A, "metadata-only.png");
    },
  };
  const mounted = mountPreview(
    openai,
    { localStorage: createStorage(), sessionStorage: createStorage() },
    metrics,
  );
  await flushPromises();

  expect(metrics.restoreCalls).toBe(1);
  expect(metrics.renderImage).toBe(1);
  expect(stateWrites).toBe(1);
  expect(mounted.elements.preview.src).toBe("data:image/png;base64,aW1hZ2U=");
});

test("image preview keeps the standard MCP Apps initialization fallback", async () => {
  const mounted = mountPreview();
  const initialize = mounted.messages.find(message => message.method === "ui/initialize");
  expect(initialize).toMatchObject({
    method: "ui/initialize",
    params: {
      protocolVersion: "2025-06-18",
      appCapabilities: {},
      appInfo: { name: "webgpt-image-preview", version: "0.3.0" },
    },
  });
  expect(initialize?.params).not.toHaveProperty("capabilities");
  expect(initialize?.params).not.toHaveProperty("clientInfo");
  mounted.dispatchMessage({ jsonrpc: "2.0", id: initialize?.id, result: {} });
  await flushPromises();
  expect(mounted.messages.some(message => message.method === "ui/notifications/initialized")).toBe(true);
});

test("a card without its own preview id ignores historical ledger state", async () => {
  const storage = { localStorage: createStorage(), sessionStorage: createStorage() };
  const oldLedgerKey = "webgpt-image-preview-ledger:ui://webgpt-luna/image-preview-v12.html:test-conversation";
  const newLedgerKey = "webgpt-image-preview-ledger:ui://webgpt-luna/image-preview-v13.html:test-conversation";
  storage.localStorage.setItem(oldLedgerKey, JSON.stringify([PREVIEW_A, PREVIEW_B]));
  storage.localStorage.setItem(newLedgerKey, JSON.stringify([PREVIEW_C]));

  const mounted = mountPreview(undefined, storage);
  const initialize = mounted.messages.find(message => message.method === "ui/initialize");
  mounted.dispatchMessage({ jsonrpc: "2.0", id: initialize?.id, result: {} });
  await flushPromises();
  mounted.runTimers();
  await flushPromises();

  expect(mounted.messages.some(message => message.method === "tools/call")).toBe(false);
  expect(mounted.elements.preview.src).toBe("");
  expect(mounted.elements.statusText.textContent).toBe("当前工具结果没有可显示的图片。");
  expect(storage.localStorage.peek(oldLedgerKey)).toBe(JSON.stringify([PREVIEW_A, PREVIEW_B]));
  expect(storage.localStorage.peek(newLedgerKey)).toBe(JSON.stringify([PREVIEW_C]));
});

test("a card without card-scoped state does not adopt an arbitrary preview id from globals", async () => {
  const restoreIds: string[] = [];
  const mounted = mountPreview({
    async callTool(_name: string, args: { preview_id: string }) {
      restoreIds.push(args.preview_id);
      return previewToolResult(args.preview_id);
    },
  });
  mounted.dispatchGlobals({ structuredContent: { preview_id: PREVIEW_B } });
  mounted.dispatchGlobals({ image_preview_id: PREVIEW_C });
  await flushPromises();
  expect(restoreIds).toEqual([]);
  expect(mounted.elements.preview.src).toBe("");
});

test("one card never restores another preview and repeated events cannot create concurrent restores", async () => {
  const restoreIds: string[] = [];
  let resolveRestore: ((value: unknown) => void) | undefined;
  const mounted = mountPreview({
    widgetState: { webgpt_image_preview: { preview_id: PREVIEW_A, name: "a.png", mime_type: "image/png", bytes: 5 } },
    callTool(_name: string, args: { preview_id: string }) {
      restoreIds.push(args.preview_id);
      return new Promise(resolve => { resolveRestore = resolve; });
    },
  });
  await flushPromises();
  expect(restoreIds).toEqual([PREVIEW_A]);

  for (let index = 0; index < 5; index += 1) {
    mounted.dispatchGlobals({ widgetState: { webgpt_image_preview: { preview_id: PREVIEW_A } } });
    mounted.dispatchMessage({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: { structuredContent: { preview_id: PREVIEW_A } },
    });
  }
  mounted.dispatchMessage({
    jsonrpc: "2.0",
    method: "ui/notifications/tool-result",
    params: previewToolResult(PREVIEW_B, "b.png", "data:image/png;base64,Yg=="),
  });
  await flushPromises();
  expect(restoreIds).toEqual([PREVIEW_A]);
  expect(mounted.elements.preview.src).toBe("");

  resolveRestore?.(previewToolResult(PREVIEW_A, "a.png", "data:image/png;base64,YQ=="));
  await flushPromises();
  expect(mounted.elements.preview.src).toBe("data:image/png;base64,YQ==");

  mounted.dispatchMessage({
    jsonrpc: "2.0",
    method: "ui/notifications/tool-result",
    params: previewToolResult(PREVIEW_B, "b.png", "data:image/png;base64,Yg=="),
  });
  await flushPromises();
  expect(restoreIds).toEqual([PREVIEW_A]);
  expect(mounted.elements.preview.src).toBe("data:image/png;base64,YQ==");
});

test("failed restore remains failed across globals and tool-result reentry until explicit Retry", async () => {
  let restoreCalls = 0;
  const mounted = mountPreview({
    widgetState: { webgpt_image_preview: { preview_id: PREVIEW_A } },
    async callTool() {
      restoreCalls += 1;
      throw new Error("preview expired");
    },
  });
  await flushPromises();
  expect(restoreCalls).toBe(1);
  expect(mounted.elements.retry.hidden).toBe(false);

  for (let index = 0; index < 5; index += 1) {
    mounted.dispatchGlobals({ widgetState: { webgpt_image_preview: { preview_id: PREVIEW_A } } });
    mounted.dispatchMessage({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: { structuredContent: { preview_id: PREVIEW_A } },
    });
    await flushPromises();
  }
  expect(restoreCalls).toBe(1);

  mounted.clickRetry();
  await flushPromises();
  expect(restoreCalls).toBe(2);
  expect(mounted.elements.retry.hidden).toBe(false);
});

test("identical image events persist widget state only once", async () => {
  const writes: unknown[] = [];
  const metadata = previewMetadata(PREVIEW_A, "dedup.png");
  const mounted = mountPreview({
    toolResponseMetadata: { mcp_tool_result: { _meta: { webgpt_image_preview: metadata } } },
    setWidgetState(value: unknown) { writes.push(value); },
  });
  expect(writes).toHaveLength(1);

  for (let index = 0; index < 5; index += 1) {
    mounted.dispatchGlobals({ toolResponseMetadata: { mcp_tool_result: { _meta: { webgpt_image_preview: metadata } } } });
    mounted.dispatchMessage({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: previewToolResult(PREVIEW_A, "dedup.png"),
    });
  }
  await flushPromises();
  expect(writes).toHaveLength(1);
});

test("pending widget state flushes once when the bridge appears and cancels delayed retries", () => {
  const metadata = previewMetadata(PREVIEW_A, "delayed-bridge.png");
  const openai: Record<string, unknown> = {
    toolResponseMetadata: { mcp_tool_result: { _meta: { webgpt_image_preview: metadata } } },
  };
  const mounted = mountPreview(openai);
  let writes = 0;
  openai.setWidgetState = () => { writes += 1; };

  mounted.dispatchGlobals({ toolResponseMetadata: openai.toolResponseMetadata });
  expect(writes).toBe(1);
  mounted.runTimers();
  expect(writes).toBe(1);
});

test("widget-state persistence is safe under synchronous host reentry", () => {
  const openai: Record<string, unknown> = {
    toolResponseMetadata: {
      mcp_tool_result: { _meta: { webgpt_image_preview: previewMetadata(PREVIEW_A, "reentrant.png") } },
    },
  };
  const mounted = mountPreview(openai);
  let calls = 0;
  openai.setWidgetState = () => {
    calls += 1;
    mounted.dispatchGlobals({});
  };

  expect(() => mounted.dispatchGlobals({})).not.toThrow();
  mounted.runTimers();
  expect(calls).toBe(1);
});

test("separate rehydrated cards restore exactly their own preview once", async () => {
  const requested: string[] = [];
  const mounted = [PREVIEW_A, PREVIEW_B, PREVIEW_C].map(previewId => mountPreview({
    widgetState: { webgpt_image_preview: { preview_id: previewId } },
    async callTool(_name: string, args: { preview_id: string }) {
      requested.push(args.preview_id);
      return previewToolResult(args.preview_id, args.preview_id + ".png");
    },
  }));
  await flushPromises();
  expect(requested).toEqual([PREVIEW_A, PREVIEW_B, PREVIEW_C]);
  for (const [index, card] of mounted.entries()) {
    expect(card.elements.preview.src).toBe("data:image/png;base64,aW1hZ2U=");
    expect(card.elements.name.textContent).toBe([PREVIEW_A, PREVIEW_B, PREVIEW_C][index] + ".png");
  }
});

test("100 identical globals after synchronous setWidgetState reentry converge without repeated renders or persistence", async () => {
  const metrics: PreviewMetrics = { renderFrom: 0, renderImage: 0, restoreCalls: 0 };
  const metadata = previewMetadata(PREVIEW_A, "feedback-loop.png");
  let stateWrites = 0;
  const openai: Record<string, unknown> = {
    toolResponseMetadata: { mcp_tool_result: { _meta: { webgpt_image_preview: metadata } } },
  };
  openai.setWidgetState = (value: unknown) => {
    stateWrites += 1;
    openai.widgetState = value;
    const dispatch = openai.__dispatchGlobalsForTest as ((globals: unknown) => void) | undefined;
    dispatch?.({ widgetState: value, toolResponseMetadata: openai.toolResponseMetadata });
  };
  const mounted = mountPreview(
    openai,
    { localStorage: createStorage(), sessionStorage: createStorage() },
    metrics,
  );

  for (let index = 0; index < 100; index += 1) {
    mounted.dispatchGlobals({ widgetState: openai.widgetState, toolResponseMetadata: openai.toolResponseMetadata });
  }
  await flushPromises();

  expect(metrics.renderFrom).toBe(102);
  expect(metrics.renderImage).toBe(1);
  expect(metrics.restoreCalls).toBe(0);
  expect(stateWrites).toBe(1);
  expect(mounted.elements.preview.src).toBe(metadata.data_url);
});

test("restore tool-result reentry plus 100 identical globals stays at one restore and one image render", async () => {
  const metrics: PreviewMetrics = { renderFrom: 0, renderImage: 0, restoreCalls: 0 };
  const persistedState = {
    webgpt_image_preview: {
      preview_id: PREVIEW_A,
      name: "restored.png",
      mime_type: "image/png",
      bytes: 5,
      width: 1,
      height: 1,
    },
  };
  const result = previewToolResult(PREVIEW_A, "restored.png");
  let stateWrites = 0;
  const openai: Record<string, unknown> = {
    widgetState: persistedState,
    setWidgetState() { stateWrites += 1; },
  };
  openai.callTool = async () => {
    const dispatch = openai.__dispatchToolResultForTest as ((params: unknown) => void) | undefined;
    dispatch?.(result);
    return result;
  };
  const mounted = mountPreview(
    openai,
    { localStorage: createStorage(), sessionStorage: createStorage() },
    metrics,
  );
  await flushPromises();

  for (let index = 0; index < 100; index += 1) {
    mounted.dispatchGlobals({ widgetState: persistedState });
    mounted.dispatchMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: result });
  }
  await flushPromises();

  expect(metrics.renderFrom).toBe(101);
  expect(metrics.renderImage).toBe(1);
  expect(metrics.restoreCalls).toBe(1);
  expect(stateWrites).toBe(0);
  expect(mounted.elements.preview.src).toBe("data:image/png;base64,aW1hZ2U=");
});
