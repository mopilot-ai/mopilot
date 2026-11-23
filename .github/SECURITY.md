# Security policy

## Report a vulnerability privately

Do not report a security problem in a public issue, pull request or discussion.

- Use **Security → Report a vulnerability** on this repository when GitHub offers it. Only you and the maintainers
  see the report.
- Otherwise, email **admin@mopilot.ai** with `Security:` at the start of the subject.

Include:

- the part of MoPilot affected (desktop app, Host, relay, phone app or pairing, built-in browser, Chrome extension,
  an agent adapter, sign-in or update checks);
- the MoPilot version or commit, and your operating system;
- steps to reproduce or a proof of concept;
- the impact: what an attacker gains, and what they need first (a local account, the same network, a malicious
  repository or web page, a paired device, a compromised relay).

Leave real credentials, tokens and chat contents out of the report. Describe them instead.

## Scope

MoPilot runs coding agents against local folders, remote Hosts and paired phones, and relays messages between
devices. In scope, for example:

- a credential, token or pairing key reaching a process, device, page or log that should not have it;
- a renderer, web page, deep link, extension message or remote Host crossing an IPC or RPC trust boundary;
- command or path injection through repository content, branch or file names, links or agent output;
- relay or pairing weaknesses that expose message contents or let a device impersonate another;
- an update or download check that accepts an unsigned or substituted build.

Out of scope: vulnerabilities in third-party agent CLIs, model providers, your own Git or SSH tools, or upstream
dependencies, unless MoPilot's use of them makes the problem worse. Report those to their maintainers.

## Supported versions

Fixes land on `main` and ship in the next release. Check that a problem reproduces on the latest release or on
`main` before you report it.

## Disclosure

Give the maintainers a reasonable chance to ship a fix before you publish details. We will confirm receipt, keep you
informed, and credit you in the advisory if you want.
