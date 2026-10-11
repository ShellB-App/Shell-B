# Security

Shell:B's whole point is that your AI, your memories and your files stay on your machine. A hole in that promise is
the most important kind of bug we can have. Thank you for looking.

## Reporting a vulnerability

Please **don't open a public issue** for anything that could let someone read, change or run what they shouldn't.
Instead:

1. Use GitHub's private reporting: **[Report a vulnerability](https://github.com/ShellB-App/Shell-B/security/advisories/new)**.
2. Or email the maintainer at the address on the [EveAeternam](https://github.com/EveAeternam) profile, with
   `Shell:B security` in the subject.

Tell us what you found, how to reproduce it, and what it lets an attacker do. A proof of concept is welcome; please
don't run it against anyone else's Shell:B.

You'll get an acknowledgement within a few days. Fixes ship as soon as they're ready (Shell:B deploys continuously),
and the changelog entry credits you unless you'd rather it didn't.

## What counts

Anything that breaks one of these promises:

- **One owner.** Only the owner's password, passkey or admin key opens the app. Guests see only their own cell. API
  keys reach only what the key allows, and persona keys never see the owner's memory.
- **Sealed execution.** Code the agents run stays in the Docker sandbox: no network, dropped capabilities, its own
  `/work`. Artifacts and screensavers render in sandboxed frames. Guest cells can't reach the host or each other.
- **Approvals.** Nothing leaves the machine or changes it without an approval card: pushes, emails, deploys of Shell:B
  herself, browser form submissions, schedules agents create.
- **No leaks.** Secrets stay encrypted at rest and out of logs, backups and git. Share links expose only what they
  were made for. Nothing phones home.
- **Path and ID hygiene.** Every file or project ID from the client is validated before it touches the filesystem.

Things like a prompt that makes a local model say something rude, or a model that can be talked into using a tool it
legitimately has, are model-behaviour questions rather than security holes, though we still like to hear about them in
[Discussions](https://github.com/ShellB-App/Shell-B/discussions).

## Hardening a deployment

- Keep Shell:B on `127.0.0.1` (the default) and reach it over HTTPS through Tailscale or a tunnel. The Manual's
  [Access & networking](docs/MANUAL.md#access--networking) section walks through both.
- Put an identity layer (Tailscale, Cloudflare Access, or your own) in front of any public hostname. The guest gateway
  and the API are the only things designed to face the internet with just their own credentials.
- Turn on two-step sign-in or a passkey for the owner account (Settings → Account).
- Rotate any key you paste into Shell:B if you ever share a backup.

Supported: the current `main` branch. Older snapshots get fixes only by moving forward.
