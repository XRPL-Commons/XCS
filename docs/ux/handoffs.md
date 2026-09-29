# Links and screen lists for implementation issues

Ready-to-use handoff text; not posted to GitHub. Link to the committed design on the eventual #29
branch/PR when publishing; a working-directory path is not a reviewable GitHub URL. The user deferred
participant sessions on 2026-09-23 and authorized moving on. Keep that unperformed criterion visible
in #29; do not present the empty [session register](./usability.md) as validated research.

| Issue                                                | Design to link                                                                           | Screens implemented                                                          | Shared dependencies                                           |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------- |
| [#30](https://github.com/XRPL-Commons/XCS/issues/30) | [Admin journey](./admin/README.md), `docs/ux/admin/wireframes.en.excalidraw`             | A1 queue; A2 application review; A3 verifier permissions; A4 audit           | #25/#26/#27, #28 boundary, accepted admin UX                  |
| [#31](https://github.com/XRPL-Commons/XCS/issues/31) | [Issuer journey](./issuer/README.md), `docs/ux/issuer/wireframes.en.excalidraw`          | I1 apply; I2 status; I3 schema; I4 invite; I5 issue; I6 credential lifecycle | #25/#26/#27/#30, private hosting decision, accepted issuer UX |
| [#32](https://github.com/XRPL-Commons/XCS/issues/32) | [Recipient journey](./recipient/README.md), `docs/ux/recipient/wireframes.en.excalidraw` | R1 claim; R2 wallet; R3 inbox; R4 consent/review/accept; R5 presentations    | #25/#26/#27/#31, accepted recipient UX                        |
| [#33](https://github.com/XRPL-Commons/XCS/issues/33) | [Verifier journey](./verifier/README.md), `docs/ux/verifier/wireframes.en.excalidraw`    | V1 application/status; V2 public result; V3 authorized result; V4 history    | #25/#26/#27/#30/#32, accepted verifier UX                     |

All four issues must link the [shared patterns](./shared/README.md), the matching bilingual screen
exports and the actual usability evidence. F1–F3 are reusable states, not independent new journeys.
API and server authorization tests belong in their implementation issues; static wireframes do
not demonstrate those controls.

## Maintainer checklist

- [ ] Confirm that implementation follows accepted ADR 0004: designated verifier, current global
      approval, recipient grant, no automatic sharing expiry, no issuer allowlist or admin override.
- [ ] Run and record two sessions per role; revise and retest material problems.
- [ ] Publish the reviewed design and put stable design links plus the screen lists above into #30–33.
- [ ] Confirm that implementation scope preserves the protocol, independent verification dimensions,
      wallet custody, exact public lookup, and authorized private fields.
- [ ] Record the user's decision to proceed without participant sessions; do not mark research passed.
