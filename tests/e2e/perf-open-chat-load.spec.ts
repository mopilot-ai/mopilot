// Opening an unloaded chat while 30 other chats stream (#2963).
// e2e-runner: bench — 21 minutes idle, longer under load: it runs only when named (scripts/ci-cuj.mjs --spec)
import { openChatBench } from './fixtures/openChatBench';

openChatBench(true, 3);
