// Offers repository-scoped repair authority, status and reconciliation without a model-supplied task or parent conversation.
const { MAIN_REPAIR_SPECS, MAIN_REPAIR_TOOLS } = require('../../../shared/mainRepairTools.mjs');
function registerMainRepairTools(registry, { owner, service }) {
  const disposers = MAIN_REPAIR_SPECS.map(([name, policy, description, properties, required, method]) =>
    registry.register({
      name,
      policy,
      description,
      schema: { type: 'object', properties, required, additionalProperties: false },
      authorizesItself: policy === 'act',
      handler: async (args, ctx) => {
        const id = owner(ctx);
        if (!id) throw new Error('The caller does not own this chat segment');
        const api = service();
        if (!api) throw new Error('Main repair is not ready yet');
        return api[method](id, args, ctx);
      },
    }),
  );
  return () => disposers.forEach((dispose) => dispose());
}
module.exports = { registerMainRepairTools, MAIN_REPAIR_TOOLS };
