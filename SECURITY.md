# Security Policy

## Supported versions

Durianflow is currently pre-release software. Security fixes are made on the
latest `main` revision and, when one exists, the latest published Windows
release. Older builds should be replaced rather than patched in place.

## Reporting a vulnerability

Use the repository's **Security** tab and select **Report a vulnerability** to
submit a private GitHub security advisory. Do not include exploit details,
recordings, transcripts, API tokens, model files, or other sensitive material
in a public issue.

If private reporting is not enabled for the repository, contact the project
maintainer through their GitHub profile and request a private reporting
channel. Public issues are appropriate only after a fix is available and the
maintainer agrees that disclosure is safe.

Include:

- affected version, commit, or installer checksum;
- Windows version and the exact reproduction steps;
- the impact and realistic attack prerequisites;
- a proof of concept that contains no private audio or transcript data; and
- any mitigation or fix you have identified.

We will acknowledge reports within seven calendar days, provide a status
update within 21 days, and coordinate disclosure after a fix or mitigation is
available. These are response targets, not a guarantee of an immediate fix.

## Security boundaries

Durianflow processes dictation locally, but local processing is not a security
boundary against an administrator, malware, a compromised user account, or an
unlocked Windows session. Dictation text can be present briefly in memory and
on the clipboard. When automatic paste is enabled, the foreground target can
change between recording and completion; the application must fall back to
copy-only behavior whenever it cannot verify the target.

Official packaged models are release-controlled artifacts. Custom models are
deliberately user-managed: a user who can modify the local configuration can
change that policy. Custom models therefore do not carry the provenance
guarantees of official models.

## Scope

In scope are the Electron desktop app, bundled Python sidecar, model
installation/verification, release artifacts, and repository automation.
Third-party inference-model accuracy, physical device access, and vulnerabilities
in an unmodified Windows installation are outside the project's direct scope,
but reports about their interaction with Durianflow are welcome.
