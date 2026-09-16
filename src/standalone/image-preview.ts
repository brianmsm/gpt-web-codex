export const IMAGE_PREVIEW_RESOURCE_URI = "ui://webgpt-luna/image-preview-v13.html";
export const LEGACY_IMAGE_PREVIEW_RESOURCE_URIS = [
  "ui://webgpt-luna/image-preview-v12.html",
  "ui://webgpt-luna/image-preview-v11.html",
  "ui://webgpt-luna/image-preview-v10.html",
  "ui://webgpt-luna/image-preview-v9.html",
  "ui://webgpt-luna/image-preview-v8.html",
  "ui://webgpt-luna/image-preview-v7.html",
] as const;
export const IMAGE_PREVIEW_MIME_TYPE = "text/html;profile=mcp-app";

export const IMAGE_PREVIEW_HTML = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="webgpt-preview-resource" content="__WEBGPT_PREVIEW_NAMESPACE__">
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; background: transparent; color: CanvasText; }
    .card { overflow: hidden; border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 14px; background: color-mix(in srgb, Canvas 96%, CanvasText 4%); }
    .stage { display: grid; min-height: 180px; max-height: 560px; place-items: center; padding: 12px; background: repeating-conic-gradient(color-mix(in srgb, CanvasText 5%, transparent) 0 25%, transparent 0 50%) 0 / 20px 20px; }
    img { display: block; max-width: 100%; max-height: 536px; border-radius: 8px; object-fit: contain; }
    .meta { display: flex; min-width: 0; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; font-size: 12px; }
    .name { overflow: hidden; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
    .detail { flex: none; color: color-mix(in srgb, CanvasText 62%, transparent); }
    .status { padding: 18px; color: color-mix(in srgb, CanvasText 68%, transparent); text-align: center; }
    .retry { margin-top: 12px; padding: 7px 12px; border: 1px solid color-mix(in srgb, CanvasText 22%, transparent); border-radius: 8px; background: color-mix(in srgb, Canvas 92%, CanvasText 8%); color: CanvasText; cursor: pointer; }
    .retry:disabled { cursor: wait; opacity: .6; }
    [hidden] { display: none !important; }
  </style>
</head>
<body>
  <main id="card" class="card" hidden>
    <div class="stage"><img id="preview" alt="本地图片预览"></div>
    <div class="meta"><span id="name" class="name"></span><span id="detail" class="detail"></span></div>
  </main>
  <div id="status" class="status">
    <div id="statusText">Preparing image preview...</div>
    <button id="retry" class="retry" type="button" hidden>重新加载图片</button>
  </div>
  <script>
    (() => {
      const card = document.getElementById("card");
      const preview = document.getElementById("preview");
      const name = document.getElementById("name");
      const detail = document.getElementById("detail");
      const status = document.getElementById("status");
      const statusText = document.getElementById("statusText");
      const retry = document.getElementById("retry");
      const pendingRequests = new Map();
      let nextRequestId = 1;
      let initialized = false;
      let ownedPreviewId = null;
      let renderedPreviewId = null;
      let renderedDataUrl = null;
      let renderedName = null;
      let renderedMimeType = null;
      let renderedBytes = null;
      let renderedWidth = null;
      let renderedHeight = null;
      let restoreState = "idle";
      let pendingRestore = false;
      let pendingPreviewState = null;
      let pendingPreviewStateKey = null;
      let lastPersistedStateKey = null;
      let stateWriteInFlightKey = null;
      let stateRetryTimer = null;
      let stateRetryAttempt = 0;

      const previewIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      const validPreviewId = (value) => typeof value === "string" && previewIdPattern.test(value) ? value : null;
      const formatBytes = (bytes) => bytes < 1024 ? bytes + " B" : bytes < 1048576 ? (bytes / 1024).toFixed(1) + " KB" : (bytes / 1048576).toFixed(1) + " MB";
      const walk = (value, match) => {
        const seen = new Set();
        const queue = [value];
        for (let visited = 0; queue.length && visited < 240; visited += 1) {
          let item = queue.shift();
          if (typeof item === "string" && item.trim().startsWith("{")) {
            try { item = JSON.parse(item); } catch {}
          }
          if (!item || typeof item !== "object" || seen.has(item)) continue;
          seen.add(item);
          const found = match(item);
          if (found) return found;
          if (Array.isArray(item)) queue.push(...item);
          else queue.push(...Object.values(item));
        }
      };
      const findPreviewRecord = (value, expectedId) => walk(value, (item) => {
        const candidate = item.webgpt_image_preview;
        if (!candidate || typeof candidate !== "object") return;
        const previewId = validPreviewId(candidate.preview_id);
        if (!previewId || (expectedId && previewId !== expectedId)) return;
        return { ...candidate, preview_id: previewId };
      });
      const findPreviewId = (value, expectedId) => {
        const record = findPreviewRecord(value, expectedId);
        if (record) return record.preview_id;
        return walk(value, (item) => {
          const previewId = validPreviewId(item.preview_id) || validPreviewId(item.image_preview_id);
          if (!previewId || (expectedId && previewId !== expectedId)) return;
          return previewId;
        }) || null;
      };
      const findNativeImage = (value) => walk(value, (item) => {
        if (item.type !== "image" || typeof item.data !== "string" || typeof item.mimeType !== "string") return;
        return {
          name: "image",
          mime_type: item.mimeType,
          bytes: Math.floor(item.data.length * 0.75),
          data_url: "data:" + item.mimeType + ";base64," + item.data,
        };
      });
      const findJobStatus = (value) => walk(value, (item) => {
        if (typeof item.status === "string" && typeof item.job_id === "string") return item;
      });
      const extractPreview = (value, expectedId) => {
        const matchingRecord = findPreviewRecord(value, expectedId);
        if (matchingRecord?.data_url) return matchingRecord;
        const previewId = matchingRecord?.preview_id || findPreviewId(value, expectedId);
        if (!previewId) return null;
        const anyRecord = findPreviewRecord(value, null);
        const nativeImage = !anyRecord || anyRecord.preview_id === previewId ? findNativeImage(value) : null;
        if (nativeImage) return { ...(matchingRecord || {}), ...nativeImage, preview_id: previewId };
        return matchingRecord || { preview_id: previewId };
      };
      const previewState = (image) => ({
        webgpt_image_preview: {
          preview_id: image.preview_id,
          name: image.name || "image",
          mime_type: image.mime_type,
          bytes: image.bytes || 0,
          width: image.width,
          height: image.height,
        },
      });
      const stateKey = (state) => JSON.stringify(state);
      const primePersistedState = (value) => {
        const image = extractPreview(value, ownedPreviewId);
        if (!image?.preview_id || image.preview_id !== ownedPreviewId) return;
        lastPersistedStateKey = stateKey(previewState(image));
      };
      const request = (method, params) => {
        const id = nextRequestId++;
        window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            pendingRequests.delete(id);
            reject(new Error("Host request timed out"));
          }, 15000);
          pendingRequests.set(id, { resolve, reject, timeout });
        });
      };
      const cancelStateRetry = () => {
        if (stateRetryTimer !== null) clearTimeout(stateRetryTimer);
        stateRetryTimer = null;
        stateRetryAttempt = 0;
      };
      const flushPreviewState = () => {
        const api = window.openai;
        if (!pendingPreviewState || !pendingPreviewStateKey || stateWriteInFlightKey || typeof api?.setWidgetState !== "function") return false;
        const state = pendingPreviewState;
        const key = pendingPreviewStateKey;
        const previousPersistedKey = lastPersistedStateKey;
        pendingPreviewState = null;
        pendingPreviewStateKey = null;
        stateWriteInFlightKey = key;
        lastPersistedStateKey = key;
        let succeeded = false;
        try {
          api.setWidgetState(state);
          succeeded = true;
          return true;
        } catch {
          if (lastPersistedStateKey === key) lastPersistedStateKey = previousPersistedKey;
          if (!pendingPreviewState) {
            pendingPreviewState = state;
            pendingPreviewStateKey = key;
          }
          return false;
        } finally {
          stateWriteInFlightKey = null;
          if (succeeded) {
            if (pendingPreviewState) {
              stateRetryAttempt = 0;
              scheduleStateFlush();
            } else {
              cancelStateRetry();
            }
          }
        }
      };
      const scheduleStateFlush = () => {
        if (!pendingPreviewState || stateRetryTimer !== null) return;
        const delays = [50, 250, 1000, 2500];
        const delay = delays[stateRetryAttempt];
        if (delay === undefined) return;
        stateRetryTimer = setTimeout(() => {
          stateRetryTimer = null;
          if (flushPreviewState()) return;
          stateRetryAttempt += 1;
          scheduleStateFlush();
        }, delay);
      };
      const persistPreviewState = (image) => {
        if (!image?.preview_id || image.preview_id !== ownedPreviewId) return;
        const state = previewState(image);
        const key = stateKey(state);
        if (key === lastPersistedStateKey || key === pendingPreviewStateKey || key === stateWriteInFlightKey) return;
        pendingPreviewState = state;
        pendingPreviewStateKey = key;
        if (!flushPreviewState()) scheduleStateFlush();
      };
      const setOwner = (previewId) => {
        if (!previewId) return false;
        if (!ownedPreviewId) {
          ownedPreviewId = previewId;
          restoreState = "idle";
          return true;
        }
        return ownedPreviewId === previewId;
      };
      const isSameRenderedImage = (image) => {
        const previewId = validPreviewId(image?.preview_id);
        return Boolean(previewId
          && renderedPreviewId === previewId
          && renderedDataUrl === image.data_url
          && renderedName === (image.name || "image")
          && renderedMimeType === (image.mime_type || null)
          && renderedBytes === (image.bytes || 0)
          && renderedWidth === (image.width ?? null)
          && renderedHeight === (image.height ?? null));
      };
      const renderImage = (image) => {
        const previewId = validPreviewId(image?.preview_id);
        if (!previewId || !image?.data_url || !setOwner(previewId) || previewId !== ownedPreviewId) return false;
        preview.src = image.data_url;
        preview.alt = "Local image preview: " + (image.name || "image");
        name.textContent = image.name || "image";
        detail.textContent = [image.mime_type, formatBytes(image.bytes || 0)].filter(Boolean).join(" · ");
        status.hidden = true;
        retry.hidden = true;
        card.hidden = false;
        renderedPreviewId = previewId;
        renderedDataUrl = image.data_url;
        renderedName = image.name || "image";
        renderedMimeType = image.mime_type || null;
        renderedBytes = image.bytes || 0;
        renderedWidth = image.width ?? null;
        renderedHeight = image.height ?? null;
        restoreState = "rendered";
        persistPreviewState(image);
        return true;
      };
      const showRestoring = () => {
        if (renderedPreviewId === ownedPreviewId) return;
        status.hidden = false;
        statusText.textContent = "正在恢复图片预览…";
        retry.hidden = true;
      };
      const showRestoreError = (error) => {
        if (renderedPreviewId === ownedPreviewId) return;
        status.hidden = false;
        statusText.textContent = "图片预览恢复失败：" + (error?.message || String(error));
        retry.hidden = !ownedPreviewId;
        retry.disabled = false;
      };
      const callRestoreTool = async (previewId) => {
        if (typeof window.openai?.callTool === "function") {
          return await window.openai.callTool("file_image_preview_restore", { preview_id: previewId });
        }
        return await request("tools/call", {
          name: "file_image_preview_restore",
          arguments: { preview_id: previewId },
        });
      };
      const restoreOwnedPreview = async (force = false) => {
        const previewId = ownedPreviewId;
        if (!previewId) return;
        if (!initialized) {
          pendingRestore = true;
          return;
        }
        if (renderedPreviewId === previewId || restoreState === "restoring") return;
        if (restoreState === "failed" && !force) return;
        restoreState = "restoring";
        showRestoring();
        retry.disabled = true;
        try {
          const result = await callRestoreTool(previewId);
          const image = extractPreview(result, previewId);
          if (!image?.data_url || image.preview_id !== previewId) {
            throw new Error("本地缓存没有返回当前卡片的可显示图片");
          }
          if (!isSameRenderedImage(image) && !renderImage(image)) {
            throw new Error("本地缓存没有返回当前卡片的可显示图片");
          }
        } catch (error) {
          if (ownedPreviewId === previewId && renderedPreviewId !== previewId) {
            restoreState = "failed";
            showRestoreError(error);
          }
        } finally {
          retry.disabled = false;
        }
      };
      const consumePayload = (value, allowOwnership, persistedState = false) => {
        const expectedId = ownedPreviewId;
        let image = extractPreview(value, expectedId);
        if (!image && !expectedId && allowOwnership) image = extractPreview(value, null);
        const previewId = validPreviewId(image?.preview_id);
        if (!previewId) return false;
        if (!ownedPreviewId) {
          if (!allowOwnership || !setOwner(previewId)) return false;
        }
        if (previewId !== ownedPreviewId) return false;
        if (persistedState) primePersistedState(value);
        if (image.data_url) {
          if (isSameRenderedImage(image)) return true;
          return renderImage(image);
        }
        return true;
      };
      const hostSources = (globals) => {
        const api = window.openai || {};
        const hostGlobals = globals && typeof globals === "object" ? globals : {};
        return [
          { value: api.widgetState, persisted: true },
          { value: hostGlobals.widgetState, persisted: true },
          { value: api.toolResponseMetadata, persisted: false },
          { value: hostGlobals.toolResponseMetadata, persisted: false },
          { value: api.toolOutput, persisted: false },
          { value: hostGlobals.toolOutput, persisted: false },
        ];
      };
      const renderFrom = (globals) => {
        const seen = new Set();
        let foundOwnPreview = false;
        for (const source of hostSources(globals)) {
          if (!source.value || seen.has(source.value)) continue;
          seen.add(source.value);
          foundOwnPreview = consumePayload(source.value, true, source.persisted) || foundOwnPreview;
        }
        if (!ownedPreviewId) {
          const legacyJob = hostSources(globals).map(source => findJobStatus(source.value)).find(Boolean);
          if (legacyJob?.status === "completed") statusText.textContent = "任务已完成，但没有返回可显示的图片。";
          else if (legacyJob?.status) statusText.textContent = "Luna 任务状态：" + legacyJob.status + "，正在等待图片产物…";
        }
        if (ownedPreviewId && renderedPreviewId !== ownedPreviewId && restoreState === "idle") void restoreOwnedPreview();
        return foundOwnPreview;
      };

      retry.addEventListener("click", () => {
        if (!ownedPreviewId || restoreState === "restoring") return;
        renderedPreviewId = null;
        renderedDataUrl = null;
        restoreState = "idle";
        card.hidden = true;
        preview.src = "";
        void restoreOwnedPreview(true);
      });
      preview.addEventListener("error", () => {
        if (!ownedPreviewId) return;
        renderedPreviewId = null;
        renderedDataUrl = null;
        restoreState = "failed";
        card.hidden = true;
        showRestoreError(new Error("图片数据无法解码"));
      });
      preview.addEventListener("load", () => {
        try { window.openai?.notifyIntrinsicHeight?.(); } catch {}
      });
      window.addEventListener("openai:set_globals", (event) => {
        if (!initialized && window.openai) initialized = true;
        renderFrom(event.detail?.globals);
        flushPreviewState();
      });
      window.addEventListener("message", (event) => {
        if (event.source !== window.parent) return;
        const message = event.data;
        if (!message || message.jsonrpc !== "2.0") return;
        if (message.id !== undefined && pendingRequests.has(message.id)) {
          const pending = pendingRequests.get(message.id);
          pendingRequests.delete(message.id);
          clearTimeout(pending.timeout);
          if (message.error) pending.reject(new Error(message.error.message || "Host request failed"));
          else pending.resolve(message.result);
          return;
        }
        if (message.method === "ui/notifications/tool-result") {
          consumePayload(message.params, true);
          if (ownedPreviewId && renderedPreviewId !== ownedPreviewId && restoreState === "idle") void restoreOwnedPreview();
        }
      }, { passive: true });

      const finishStartup = () => {
        initialized = true;
        flushPreviewState();
        const shouldRestore = pendingRestore;
        pendingRestore = false;
        if (ownedPreviewId && renderedPreviewId !== ownedPreviewId && (shouldRestore || restoreState === "idle")) {
          void restoreOwnedPreview();
        } else if (!ownedPreviewId) {
          statusText.textContent = "当前工具结果没有可显示的图片。";
        }
      };

      if (window.openai) {
        renderFrom();
        finishStartup();
      } else {
        request("ui/initialize", {
          protocolVersion: "2025-06-18",
          appCapabilities: {},
          appInfo: { name: "webgpt-image-preview", version: "0.3.0" },
        }).then(() => {
          window.parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized" }, "*");
          finishStartup();
        }).catch(showRestoreError);
      }
    })();
  </script>
</body>
</html>`;
