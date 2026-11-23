# Run the Mobile Remote relay

The relay moves encrypted messages between paired devices. You can deploy the relay and check service health
with this repository. End-to-end pairing also needs an account service that issues device tokens and clients
that use it. The source edition ships with the MoPilot account integration disabled and no default relay.

## Start the relay

Use Docker and a TLS reverse proxy. Create a local settings file from
[`relay/selfhost.env.example`](../../relay/selfhost.env.example). Set a unique database password and replace the
example signing configuration with your own issuer and verification key or JWKS URL. Give the relay only the
verification key. Keep issuer signing credentials with your account service.

```sh
cp relay/selfhost.env.example relay/selfhost.env
# Edit relay/selfhost.env before starting the service.
docker compose -f relay/docker-compose.selfhost.yml --env-file relay/selfhost.env up -d --build
curl http://127.0.0.1:8787/healthz
curl http://127.0.0.1:8787/readyz
```

See [relay configuration](../../relay/README.md#configuration-environment) for the token audiences, networking
and storage settings. Keep the relay's metrics and database on a private network. Clients use a `wss://` relay
address and must trust that deployment. Push delivery, if enabled, requires credentials belonging to your mobile build.

The relay sees operational metadata, including device and pair identifiers and message timing. Protect access to
its database and logs. The pairing protocol has received internal review.
