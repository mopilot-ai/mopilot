# Authentication before Host updates

Every app-driven Host update, including the distribution and revocation stages of key rotation, opens a fresh authenticated session before probing the machine or uploading files. Authentication proves this Mac still holds a key paired with that exact Host and renews the Host's last-seen record. The temporary session and tunnel lease close before SSH update work starts.

The 180-day update eligibility gate remains in place. Heartbeats and SSH reachability do not renew it. A still-paired app can renew it by authenticating; an expired update-eligibility timestamp alone is not a reason to pair again.

Only an explicit unknown-client or missing-pairing refusal marks the machine as **Pair again**. The row's explanation directs the person to add the machine again with its pairing code. Transport errors remain **Update failed** with retry. A successful pairing clears the prior update state. This does not restore a revoked signing key or change provider/agent sign-out semantics.

An update captures the machine's address, socket, Host identity and this Mac's signing key. After every asynchronous phase, including rejected phases, it checks those values and current Host access before continuing or reporting success. Removed or replaced operations cannot overwrite a newer update's state.
