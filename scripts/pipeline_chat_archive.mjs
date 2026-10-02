const PROVIDERS = ["ffz_emotes", "bttv_emotes", "7tv_emotes"];

export const collectAvailableEmoteSets = async (loaders, onFailure = () => {}) => {
  const results = await Promise.allSettled(PROVIDERS.map((provider) => loaders[provider]()));
  const available = { unavailableProviders: [] };
  for (let index = 0; index < PROVIDERS.length; index++) {
    const provider = PROVIDERS[index];
    const result = results[index];
    if (result.status === "fulfilled" && Array.isArray(result.value)) available[provider] = result.value;
    else {
      const error = result.reason || new Error(`${provider} returned invalid emotes.`);
      if (error.code === "SOFTUCHIVE_PAUSED" || error.name === "AbortError") throw error;
      available.unavailableProviders.push(provider);
      onFailure(provider, error);
    }
  }
  return available;
};

export const mergeEmoteArchive = (existing, incoming) => {
  const result = { ...(existing || {}), ...incoming };
  for (const provider of PROVIDERS) {
    result[provider] = Array.isArray(incoming?.[provider]) ? incoming[provider]
      : Array.isArray(existing?.[provider]) ? existing[provider] : [];
  }
  // An unavailable chat export must not erase already archived embedded emotes.
  if (!incoming?.embedded_emotes?.length && existing?.embedded_emotes?.length) result.embedded_emotes = existing.embedded_emotes;
  return result;
};

export const validateChatExport = (rawChat) => {
  if (!rawChat || !Array.isArray(rawChat.comments) || rawChat.comments.some((comment) => !comment || typeof comment !== "object")) {
    throw new Error("Twitch chat export is invalid or incomplete; retaining existing replay data.");
  }
  return rawChat;
};
