# XRPL Connect rc.2 — Crossmark session network

`xrpl-connect@1.0.0-rc.2.patch` changes only the package's ESM entry consumed by Nuxt and the
web tests. CommonJS/UMD consumers are not patched. The package version stays pinned to rc.2;
pnpm records the patch hash in the lockfile and Docker copies it before frozen installation.

Crossmark 0.2.19's public extension source (`static/js/948.bundle.js`) constructs SignIn
results with `network: repo.Node.getBasicNode(selectedNode)`. Its separate NETWORK command
reads the background `services.state.Node.getBasicNode()`, gated on a signed-in app. That
getter reads `Base.flat.user.node`, but background `Base.forceStateSet()` replaces `Base.state`
without updating `flat`. The getter can therefore remain incomplete or stale after approval;
this is not merely a slow response. rc.2 used that getter both for connecting and before signing.

The patch parses the fresh approval network and retains the raw lookup only for legacy SignIn
responses that omit it. Account refresh and pre-signature checks instead validate the
[documented SDK session network](https://docs.crossmark.io/session), which the SDK updates from
SignIn responses and network-change events. Address refresh still queries Crossmark, and the
application's account/network-change invalidation remains active. A missing or malformed session
network fails closed, including a late SDK detection response that overwrites it. There is no
fallback to the adapter's previous network and no default Testnet value. Transaction signatures
and exact requested fields are still verified before XCS submits through its validated RPC.

`crossmarkNetwork.test.ts` and `crossmark.production.spec.ts` cover the protocol boundary.
The latter runs the real SDK with isolated extension messages, not a real wallet approval, and
checks schema preparation against the running API and public Testnet without submitting.
Remove the patch when an upstream release handles the approval network and passes these gates.
