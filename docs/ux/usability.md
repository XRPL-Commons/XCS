# Usability protocol and evidence register

Status: not conducted. No dates, participants, observations or approval are asserted by this file.
The wireframes are hypotheses, not validated user research. On 2026-09-23 the user explicitly
deferred these sessions and requested work on the next issue. Implementation may proceed on that
basis; the two-people-per-role research criterion is deferred, not passed or waived as evidence.

## Recruitment and safe setup

Recruit two administrators who review organizations, two training/qualification issuers, two
learners/recipients with limited ledger experience, and two people who check attestations. Note
relevant experience without storing names, emails, identity documents or recordings in Git. If one
person tests several roles, justify their fit and disclose the overlap rather than claiming eight
independent participants. Obtain consent for notes; any recordings stay outside the repository
under an agreed retention policy. Participation and retention dates are not invented here.

Use the offline gallery or editable Excalidraw boards with fictional records. The facilitator moves
between screens and describes external identity/wallet outcomes; this is a moderated static
walkthrough, not a clickable production test. No real login, wallet signature, tokens or upload.
Use both locales across the sample, record which one each person used, and inspect mobile at
390 × 844 plus desktop. QR areas are placeholders and must not be scanned as real links.

## Session script (25–35 minutes)

1. Explain that the design is being tested, not the participant. Ask them to think aloud. Do not
   explain ledger vocabulary first: note whether the design requires it.
2. Give the role's task in the matching journey README without naming controls or explaining the
   intended path. Ask at each step: “What do you expect to happen?”
3. Record task completion, time, hesitations, wrong turns, requests for help, terminology and any
   accidental disclosure prediction. Separate observed behavior from the facilitator's interpretation.
4. Introduce wallet unavailable, invite expired and indexer unavailable as applicable. For admin and
   verifier, verify they are not wrongly sent to wallet setup or recipient invitation handling.
5. Ask the person to explain visibility, application approval versus issuer trust, pending versus
   confirmed, and link revocation versus credential revocation in their own words.
6. Debrief: one confusing moment, one missing piece, proposed wording. Record a concrete screen or
   copy change, or explain why a suggestion was not adopted. Recheck material changes with users.

## Task-specific observations

| Role      | Main task                                                      | Signals to record                                                                                      |
| --------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Admin     | Approve one issuer, decline another, suspend a verifier        | Decision under one minute for complete evidence; no private-claim override or endorsement inference    |
| Issuer    | Template → invite → linked learner → private issuance          | No raw UID/address typing; correct public-field prediction; no duplicate issuance on recovery          |
| Recipient | Email → claim → wallet → accept → public presentation          | At most five app screens to acceptance; external handoff effort; reject needs no content fetch         |
| Verifier  | Public view → authorized full view; interpret failure variants | Correct first-glance result on phone; no trust score; no expectation of private access from link alone |

Completion requires recording all four journeys and all three failure categories, including why a
failure is not applicable to a role. Do not count a designer or automated screenshot as a role user.

## Session register

Fill a row only after an actual session; preserve anonymity. “Pending” is not a date or evidence.

| Session | Role      | Date / locale / device | Participant fit | Observation evidence | Revision and recheck |
| ------- | --------- | ---------------------- | --------------- | -------------------- | -------------------- |
| A-01    | Admin     | Pending                | Pending         | Not conducted        | Pending              |
| A-02    | Admin     | Pending                | Pending         | Not conducted        | Pending              |
| I-01    | Issuer    | Pending                | Pending         | Not conducted        | Pending              |
| I-02    | Issuer    | Pending                | Pending         | Not conducted        | Pending              |
| R-01    | Recipient | Pending                | Pending         | Not conducted        | Pending              |
| R-02    | Recipient | Pending                | Pending         | Not conducted        | Pending              |
| V-01    | Verifier  | Pending                | Pending         | Not conducted        | Pending              |
| V-02    | Verifier  | Pending                | Pending         | Not conducted        | Pending              |

Per-session notes template:

```text
Session ID / actual date / design commit / locale / viewport:
Role fit and relevant experience (anonymous):
Consent for notes obtained:
Task / start and finish / result / assistance:
Observed hesitation or incorrect prediction (screen ID):
Failure states tried and recovery observed:
Participant wording (only with consent; no PII):
Interpretation (separate from observation):
Change made (screen/copy ID and commit), or reason not to change:
Recheck outcome / unresolved question / owner:
```

## Accepted decisions and remaining implementation questions

| Decision                                             | Current draft                                                                                                                  | Acceptance owner / state                                          |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| Role-based portal boundary                           | Admin approval gates issuer/verifier portal access, not protocol validity; current Studio remains                              | ADR 0004 accepted; implementation pending                         |
| Private-sharing audience                             | Recipient selects a specific globally approved verifier; authenticated stable identity required                                | ADR 0004 accepted; usability wording to test                      |
| Full-scope authorization                             | Current approval AND recipient grant AND matching audience/scope; admin has no override                                        | ADR 0004 accepted; server implementation pending                  |
| Sharing duration and approval scope                  | No automatic expiry/renewal and no per-issuer allowlist                                                                        | ADR 0004 accepted; no TTL or single-use control in this design    |
| Visibility default and template public fields        | Proposed private issuance default; recipient cannot retract previously public data                                             | Product / pending                                                 |
| Invite account binding                               | Authenticated holder may explicitly claim without email matching; first claim binds atomically; issuer reviews actual claimant | ADR 0004 accepted; expiry and resend implementation still pending |
| Private storage and integrity provenance             | Never use public hosting; do not hash a subset as full payload                                                                 | #31/#33 owners / pending                                          |
| Retention, appeal contact and mail delivery behavior | No invented retention period, appeal endpoint or delivery guarantee                                                            | #25/#30 owners / pending                                          |

The accepted ADR decisions supersede older expiry and allowlist wording in the issues. Remaining
questions are implementation gates, not a claim that documentation work requires production approval.
