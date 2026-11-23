// The account scope shared by cloud task loading and sidebar placement.
type CloudAccount = { accounts?: { active?: string | null }; account?: { type: string; email?: string | null } | null };

export const cloudSidebarAccount = (state: CloudAccount) =>
  JSON.stringify([state.accounts?.active, state.account?.type === 'chatgpt' ? state.account.email : state.account?.type]);
