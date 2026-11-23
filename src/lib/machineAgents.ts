// Which of a machine's agents its row names, core agents first, and which ones a Sign in or Install action is for (test agents never). Shared by Settings › My machines (src/lib/machineStatus.ts) and the composer's machine menu.
export { CORE_AGENTS, shownAgents, shownWithWanted, signinAgents, missingAgents, needsSignin } from '../../shared/host/machineLine.mjs';
