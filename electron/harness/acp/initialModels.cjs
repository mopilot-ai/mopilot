// Optional native model discovery belongs to the process's own account and ends with that process.
async function initialModels(agent, q, reportIgnored) {
  if (typeof q.readModels !== 'function') return;
  try {
    agent.initialModels = await q.readModels(agent);
  } catch (error) {
    // A failed optional listing never signs in or replaces the session's own model catalog.
    reportIgnored(`list ${q.label} models`, error);
  }
}

module.exports = { initialModels };
