// The one line of help under an effect where the owner writes a rule, the same words on Mac and phone. A "tell me now" rule beats a quiet rule only for a sender it names (not the checks for phishing, quiet hours or the daily cap). A rule view carries it as `help`; the new-rule form has no rule view yet, so it reads this constant by the chosen effect.
export const MOMO_RULE_HELP: Partial<Record<string, string>> = {
  tell_now: "Name the sender's domain or address. It beats a quiet rule for that sender.",
};
