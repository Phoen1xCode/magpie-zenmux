import { inferenceKey, signInMethod } from "./authentication.mjs";
import { endpoints, metadataClient } from "./api.mjs";
import { buildModels, modelCatalog, modelsDevCatalog } from "./models.mjs";
import { createInferenceLoader } from "./transport.mjs";
import { accountUsage } from "./usage.mjs";
import {
  PROVIDER_ID,
  PROVIDER_NAME,
  MODEL_TTL,
  MODEL_METADATA_TTL,
  MAX_CONCURRENCY,
} from "./constants.mjs";

export function createZenMuxPlugin(options) {
  const urls = endpoints(options);
  const read = metadataClient();

  return {
    async config(config) {
      config.provider ??= {};
      const provider = (config.provider[PROVIDER_ID] ??= {});
      provider.name ??= PROVIDER_NAME;
      provider.npm ??= urls.messages.npm;
      provider.api ??= urls.messages.url;
      provider.models ??= {};
    },
    provider: {
      id: PROVIDER_ID,
      async models(provider, { auth } = {}) {
        if (!auth) return provider.models;
        inferenceKey(auth);
        // The live list is required; models.dev is optional supplementary
        // metadata. Neither request carries inference or management keys.
        const [catalog, metadata] = await Promise.all([
          read(urls.models, "", MODEL_TTL, modelCatalog),
          read(urls.modelsDev, "", MODEL_METADATA_TTL, modelsDevCatalog).catch(() => ({})),
        ]);
        return buildModels(catalog, urls, metadata);
      },
    },
    auth: {
      provider: PROVIDER_ID,
      maxConcurrency: MAX_CONCURRENCY,
      methods: [signInMethod()],
      loader: (getAuth) => createInferenceLoader(urls, getAuth),
      usage: (getAuth) => accountUsage(getAuth, urls, read),
    },
  };
}
