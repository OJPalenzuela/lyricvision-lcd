# Code Signing Research

Status: v0.1.0 ships unsigned. No signing date is set and no signed
build is promised here.

## What to expect unsigned

Windows SmartScreen warns about an unknown publisher for the
installer and the app. Reputation builds over time as signed builds
circulate; unsigned builds do not accumulate that reputation.

Proceed only with installers from the project Releases page. See
[Release checklist](release-checklist.md) for the public blocker note.

## Options

- Organization Validation (OV): verifies the organization identity
  before issuing the certificate. Common choice for small teams.
- Extended Validation (EV): stricter identity checks, historically
  faster SmartScreen reputation. Requires a hardware token workflow.

Examples of public certificate authorities include DigiCert and
Sectigo, among others. Pricing varies by vendor, validation level,
and term; confirm current pricing with the vendor before budgeting.

## What signing changes

- Shows a known publisher instead of an unknown publisher warning.
- Lets SmartScreen reputation attach to the certificate over time.
- Keeps install friction lower on clean Windows machines.

## What signing does not change

- Does not fix USB conflicts, missing lyrics, or panel support.
- Does not replace clean-machine validation or hardware testing.
- Does not imply a security audit of the app or bridge code.

## Recommendation

Investigate an OV certificate before any broad promotion, and keep
shipping unsigned only to testers who understand the SmartScreen
flow. Track signing as a public blocker in the checklist. No vendor
is endorsed and no timeline is promised; compare current terms
directly with each authority before deciding.

See [Release checklist](release-checklist.md) and the
[Release notes draft](release-notes-v0.1.0.md).
