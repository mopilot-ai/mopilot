// The specs of the teach-mode and full-control desktop tools (desktop_request_teach_access, desktop_teach_step,
// desktop_teach_batch, desktop_request_full_control, desktop_release_full_control): plain JSON schema any harness can list.
// The tool names and descriptions follow Claude Desktop's computer-use server, with MoPilot's desktop_ prefix.

/**
 * @param {object} o
 * @param {object} o.coord the [x, y] schema of the other desktop tools
 * @param {{ properties: Record<string, any> }} o.item the schema of one action of desktop_batch
 * @param {string[]} o.allowed the actions a teach step may run
 * @param {number} o.maxActions the most actions in one step
 * @returns {import('../contract/registry.cjs').ToolSpec[]}
 */
function teachSpecs({ coord, item, allowed, maxActions }) {
  const step = {
    explanation: {
      type: 'string',
      description:
        'Tooltip body text. Explain what the user is looking at and why it matters. This is the ONLY place the user sees your words; be complete but concise.',
    },
    next_preview: {
      type: 'string',
      description:
        'One line describing exactly what will happen when the user clicks Next. Example: "Next: I\'ll click Create Bucket and type the name." Shown below the explanation in a smaller font.',
    },
    anchor: {
      ...coord,
      description:
        '(x, y) in pixels of the latest desktop_screenshot: where the tooltip arrow points. Omit to center the tooltip with no arrow (for general-context steps).',
    },
    actions: {
      type: 'array',
      maxItems: maxActions,
      items: { ...item, properties: { ...item.properties, action: { type: 'string', enum: allowed } } },
      description:
        'Actions to execute when the user clicks Next. Same item schema as desktop_batch.actions. Empty array is valid for purely explanatory steps. Actions run sequentially and stop on first error.',
    },
  };
  return [
    {
      name: 'desktop_request_teach_access',
      description:
        'Request permission to guide the user through a task step-by-step with on-screen tooltips. Use this INSTEAD OF desktop_request_access when the user wants to LEARN how to do something (phrases like "teach me", "walk me through", "show me how", "help me learn"). On approval a tooltip appears over the apps, and the mouse and keyboard may be used when the user clicks Next. You then call desktop_teach_step repeatedly; each call shows one tooltip and waits for the user to click Next. Same app tiers as desktop_request_access, but no clipboard or system-key options. Teach mode ends automatically when your turn ends.',
      schema: {
        type: 'object',
        properties: {
          apps: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            maxItems: 30,
            description: 'App names ("Notes", "Finder") or bundle ids ("com.apple.Notes")',
          },
          reason: {
            type: 'string',
            description:
              'What you will be teaching. Shown in the approval card as "guide you through {reason}". Keep it short and task-focused.',
          },
        },
        required: ['apps', 'reason'],
      },
      policy: 'observe',
    },
    {
      name: 'desktop_teach_step',
      description:
        "Show one guided-tour tooltip and wait for the user to click Next. On Next, execute the actions, take a fresh screenshot, and return both; you do NOT need a separate screenshot call between steps. The returned image shows the state after your actions ran; anchor the next desktop_teach_step against it. IMPORTANT: the user only sees the tooltip during teach mode. Put ALL narration in `explanation`. Text you emit outside teach steps is NOT visible until teach mode ends. Pack as many actions as possible into each step's `actions` array: the user waits through the whole round trip between clicks, so one step that fills a form beats five steps that fill one field each. Returns {exited:true} if the user clicks Exit; do not call it again after that. Take an initial desktop_screenshot before your FIRST teach step to anchor it.",
      schema: { type: 'object', properties: step, required: ['explanation', 'next_preview', 'actions'] },
      policy: 'act',
    },
    {
      name: 'desktop_teach_batch',
      description:
        "Queue multiple teach steps in one tool call. Parallels desktop_batch: N steps in one model round trip instead of N. Each step still shows a tooltip and waits for the user's Next click, but YOU aren't waiting for a round trip between steps. You can call it multiple times in one tour; treat each batch as one predictable SEGMENT (typically: all the steps on one page). The returned screenshot shows the state after the batch's final actions; anchor the NEXT batch against it. WITHIN a batch, all anchors and click coordinates refer to the PRE-BATCH screenshot; for steps 2+ in a batch, either omit anchor (centered tooltip) or target elements you know won't have moved. Good pattern: batch 5 tooltips on page A (last step navigates), read the returned screenshot, batch 3 tooltips on page B, done. Returns {exited:true, stepsCompleted:N} if the user clicks Exit (do NOT call again after that); {stepsCompleted, stepFailed, ...} if an action errors mid-batch; otherwise {stepsCompleted, results:[...]} plus a final screenshot. Fall back to individual desktop_teach_step calls when you need to react to each intermediate screenshot.",
      schema: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            minItems: 1,
            items: { type: 'object', properties: step, required: ['explanation', 'next_preview', 'actions'] },
            description: 'Ordered steps. Validated upfront: a typo in step 5 errors before any tooltip shows.',
          },
        },
        required: ['steps'],
      },
      policy: 'act',
    },
    {
      name: 'desktop_request_full_control',
      description:
        "Ask the user to approve full-screen control: the real pointer and keyboard, for the screen tools (desktop_screenshot, desktop_left_click, desktop_type, ...). The approval lasts until the chat ends or you call desktop_release_full_control. Background work in a granted app (desktop_app_*) never needs it. Call it when a step can't be done in the background, so the user is asked once, up front, with the reason shown on the card.",
      schema: { type: 'object', properties: {} },
      policy: 'observe',
    },
    {
      name: 'desktop_release_full_control',
      description:
        'Drop back to BACKGROUND control: release the desktop, the screen overlay and the screen-control approval. Ask for full-screen control again if you need it later (the user will be asked again).',
      schema: { type: 'object', properties: {} },
      policy: 'observe',
    },
  ];
}

module.exports = { teachSpecs };
