// Minimal mock of the OpenCode v2 PluginContext used by the offline suites.
//
// The v1 tests used to call `definePlugin(region).server(input, options)` and
// assert on the returned `{ config, auth, tool }` hook bag. In v2 there is no
// such bag: `setup(ctx)` registers everything through transform editors and
// hooks on the context. This helper runs those editors against in-memory
// editors and records every registration so the tests can assert on v2 state.
//
// It deliberately implements only the slice of Context that setupV2 touches
// (options, integration, provider, aisdk, tool, model). Anything else would be
// dead weight and would hide a missing dependency if setup starts using it.

const REGISTRATION = Object.freeze({ dispose: async () => {} });

/**
 * Build a mock v2 context plus the captured registration state.
 *
 * @param {Record<string, unknown>} options - injected as `ctx.options`; this is
 *   how v2 callers override a region's defaults (there is no second argument
 *   to a `server()` hook any more).
 */
export function createV2Context(options = {}) {
  const state = {
    /** @type {Array<{info: any, models: any[], sourceConnection?: any}>} */
    providers: [],
    /** @type {Map<string, {id: string, name: string}>} */
    integrations: new Map(),
    /** @type {Array<any>} */
    methods: [],
    /** @type {Array<any>} */
    tools: [],
    /** @type {Map<string, Array<{cb: Function, opts?: any}>>} */
    hooks: new Map(),
    /** @type {{providerID: string, modelID: string} | undefined} */
    defaultModel: undefined,
  };

  const integrationEditor = {
    list: () => [...state.integrations.values()],
    get: (id) => state.integrations.get(id),
    update(id, update) {
      let ref = state.integrations.get(id);
      if (!ref) {
        ref = { id, name: id };
        state.integrations.set(id, ref);
      }
      update(ref);
    },
    remove: (id) => state.integrations.delete(id),
    method: {
      list: (integrationID) =>
        state.methods
          .filter((m) => !integrationID || m.integrationID === integrationID)
          .map((m) => m.method),
      update: (input) => state.methods.push(input),
      remove: (integrationID, method) => {
        state.methods = state.methods.filter(
          (m) => !(m.integrationID === integrationID && m.method === method),
        );
      },
    },
  };

  const providerEditor = {
    list: () => state.providers,
    get: (id) => state.providers.find((p) => p.info.id === id),
    add: (input) => state.providers.push(input),
    update(id, update) {
      const found = providerEditor.get(id);
      if (found) update(found.info);
    },
    remove: (id) => {
      state.providers = state.providers.filter((p) => p.info.id !== id);
    },
    models: { set() {}, update() {}, remove() {} },
  };

  const toolEditor = {
    list: () => state.tools,
    get: (id) => state.tools.find((t) => t.name === id),
    add: (tool) => state.tools.push(tool),
    update(id, update) {
      const found = toolEditor.get(id);
      if (found) update(found);
    },
    remove: (id) => {
      state.tools = state.tools.filter((t) => t.name !== id);
    },
    namespace() {},
  };

  const modelEditor = {
    default: {
      get: () => state.defaultModel,
      set: (providerID, modelID) => {
        state.defaultModel = { providerID, modelID };
      },
    },
    list: () => [],
    get: () => undefined,
    update() {},
    remove() {},
    provider: { list: () => state.providers, get: (id) => providerEditor.get(id) },
  };

  const transform = (editor) => async (callback) => {
    callback(editor);
    return REGISTRATION;
  };

  const ctx = {
    options,
    integration: {
      transform: transform(integrationEditor),
      reload: async () => {},
      // The language hook reads these to merge a live connection's credential.
      // The offline suites never have one, so returning nothing exercises the
      // own-store / env fallback instead.
      connection: {
        active: async () => undefined,
        resolve: async () => undefined,
        status: async () => {},
      },
    },
    provider: { transform: transform(providerEditor), reload: async () => {} },
    tool: {
      transform: transform(toolEditor),
      reload: async () => {},
      list: async () => state.tools,
      hook: async () => REGISTRATION,
    },
    model: { transform: transform(modelEditor), reload: async () => {} },
    aisdk: {
      hook: async (name, cb, opts) => {
        const list = state.hooks.get(name) ?? [];
        list.push({ cb, opts });
        state.hooks.set(name, list);
        return REGISTRATION;
      },
    },
  };

  return { ctx, state };
}

/**
 * Fire the captured `language` hook for one provider and return the
 * WorkBuddyLanguageModel the plugin installed on the event. This is how the
 * tests reach storeName / baseUrl / providerID options: in v2 they are bound
 * in the hook closure, not exposed on the provider record.
 */
export async function runLanguageHook(state, providerID, modelID = "hy3") {
  const entry = (state.hooks.get("language") ?? []).find(
    (h) => !h.opts || h.opts.providerID === providerID,
  );
  if (!entry) throw new Error(`no language hook registered for ${providerID}`);
  const event = { model: { providerID, id: modelID } };
  await entry.cb(event);
  if (!event.language) throw new Error(`language hook for ${providerID} installed no model`);
  return event.language;
}
