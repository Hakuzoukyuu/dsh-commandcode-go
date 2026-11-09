/**
 * dsh-commandcode-go — a DeepSeek Harness LLM adapter for the Command Code Go
 * subscription.
 *
 * Command Code's Go plan has no official API.  This plugin registers an
 * in-process provider that speaks the same undocumented alpha protocol as the
 * Command Code CLI, so no local HTTP proxy or separate process is needed.
 */

import { createAdapter } from "./adapter.js";
import { createCatalog } from "./catalog.js";
import { Config, NAMESPACE, ROUTE } from "./config.js";
import { USAGE_PATH, readUsage } from "./usage.js";

export { Config } from "./config.js";
export { USAGE_PATH } from "./usage.js";
export const name = NAMESPACE;
export const inject = ["llm", "settings"];

const USAGE_CACHE_TTL_MS = 20_000;
const USAGE_ERROR_CACHE_TTL_MS = 5_000;

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/** Read-only usage endpoint behind the floating widget; never exposes the key. */
function registerUsageRoute(ctx, getConfig, logger) {
  let cache = null;
  const resource = async () => {
    const now = Date.now();
    const config = getConfig();
    const base = {
      widgetEnabled: config.usageWidget,
      refreshSeconds: config.usageRefreshSeconds,
    };
    const ttl = cache && cache.body.ok === false ? USAGE_ERROR_CACHE_TTL_MS : USAGE_CACHE_TTL_MS;
    if (cache && now - cache.at < ttl) return jsonResponse({ ...cache.body, ...base });
    const view = await readUsage({ config, logger, now });
    cache = { at: now, body: view };
    return jsonResponse({ ...view, ...base });
  };
  ctx.effect(
    () => ctx.webServer.register({ kind: "exact", path: USAGE_PATH, resource }),
    "dsh-commandcode-go: usage endpoint",
  );
}

function settingsValue(ctx) {
  try {
    if (typeof ctx.settings?.get === "function") return ctx.settings.get(NAMESPACE);
    if (typeof ctx.settings?.describe === "function") {
      return ctx.settings.describe().find((entry) => entry.ns === NAMESPACE)?.value;
    }
  } catch {
    // The settings service may not be ready during plugin activation.
  }
  return undefined;
}

export default {
  name,
  inject,
  apply(ctx, config) {
    const initial = Config(config ?? {});
    const getConfig = () => {
      const live = settingsValue(ctx);
      return live === undefined ? initial : Config(live);
    };
    const logger = ctx.logger;
    const catalog = createCatalog({ getConfig, logger });
    const adapter = createAdapter({
      getConfig,
      catalog,
      getAttachments: () => ctx.get?.("attachments") ?? ctx.attachments,
      logger,
    });
    ctx.llm.registerAdapter([ROUTE], adapter);

    // The Web carrier is optional: headless profiles simply never see the widget.
    if (typeof ctx.inject === "function") {
      ctx.inject(["webServer"], (webCtx) => registerUsageRoute(webCtx, getConfig, logger));
    }
  },
};
