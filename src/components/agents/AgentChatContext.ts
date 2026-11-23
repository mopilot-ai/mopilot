// The MoPilot chat whose transcript or agent page is rendering, shared without a component import cycle.
import { createContext } from 'react';

export const AgentChatContext = createContext('');
