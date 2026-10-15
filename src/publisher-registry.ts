/** Reviewed publisher attribution only. Numeric model limits remain catalog data.
 * Rules use exact, complete model IDs: no prefix, alias or suffix inference.
 */
export interface PublisherRule {
  providerId: string;
  modelIds: readonly string[];
  verifiedAt: string;
  sources: readonly string[];
}

export const PUBLISHER_RULES: readonly PublisherRule[] = [{
  providerId: "zai",
  modelIds: ["glm-5.3"],
  verifiedAt: "2026-10-15",
  sources: [
    "https://docs.z.ai/guides/llm/glm-5.3",
    "https://docs.z.ai/api-reference/introduction",
  ],
}];

export function publisherRule(modelId: string): PublisherRule | undefined {
  return PUBLISHER_RULES.find((rule) => rule.modelIds.includes(modelId));
}

export function metadataProvenance(
  providerId: string,
  modelId: string,
  options: { metadataOnly: boolean; explicitProvider?: boolean; directTarget?: boolean; fallback?: boolean },
) {
  const rule = publisherRule(modelId);
  const official = !options.explicitProvider && !options.directTarget && options.metadataOnly && rule?.providerId === providerId;
  return {
    providerId: options.fallback ? "conservative-defaults" : providerId,
    modelId,
    reason: options.fallback
      ? "conservative-defaults" as const
      : options.explicitProvider
        ? "explicit-provider" as const
        : options.directTarget
          ? "direct-catalog" as const
          : official
            ? "official-reference" as const
            : options.metadataOnly
              ? "catalog-reference" as const
              : "direct-catalog" as const,
    evidence: official ? [...rule.sources] : [],
    ...(official ? { verifiedAt: rule.verifiedAt } : {}),
  };
}
