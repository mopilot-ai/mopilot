// Validated ACP model catalogs shared by native discovery and the read-only Settings list.
export function acpModelCatalog(value) {
  const models = value?.availableModels;
  if (
    !Array.isArray(models) ||
    !models.length ||
    !models.every(
      (model) =>
        typeof model?.modelId === 'string' && model.modelId.length > 0 && (model.name === undefined || typeof model.name === 'string'),
    )
  )
    return null;
  return { availableModels: models.map((model) => ({ ...model, name: model.name ?? model.modelId })) };
}
