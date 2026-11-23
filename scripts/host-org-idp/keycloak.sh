#!/usr/bin/env bash
# A throwaway Keycloak (open-source OIDC IdP) for Host organization access (#3361 Tier 2): one container, set up the same way each run (realm, public PKCE client, test users, groups, an 8 h access token, a lease-hours claim, a gateway audience). Dev and test fixture only: every credential here is a dummy, and it listens on loopback only.
#   scripts/host-org-idp/keycloak.sh up     start it and set it up (idempotent: a realm already there is deleted and made again)
#   scripts/host-org-idp/keycloak.sh down   remove the container
#   scripts/host-org-idp/keycloak.sh disable <user>   the admin disables a user and ends their sessions (the revoke check)
#   KC_TOKEN_SECONDS=90 scripts/host-org-idp/keycloak.sh up   access tokens that last 90 s (the renewal check)
set -euo pipefail

ENGINE="${CONTAINER_ENGINE:-$(command -v docker || command -v podman || true)}"
NAME="${KC_CONTAINER:-mopilot-test-keycloak}"
IMAGE="${KC_IMAGE:-quay.io/keycloak/keycloak:26.0}"
PORT="${KC_PORT:-8080}"
REALM="${KC_REALM:-mopilot-test}"
CLIENT="${KC_CLIENT:-mopilot-desktop}"
AUDIENCE="${KC_AUDIENCE:-mopilot-gateway}"
LEASE_HOURS="${KC_LEASE_HOURS:-8}"
# a check of renewal on a short clock can make access tokens last seconds instead of the lease hours
TOKEN_SECONDS="${KC_TOKEN_SECONDS:-}"
# dummy credentials: this IdP only ever runs on loopback for tests
ADMIN_USER=admin
ADMIN_PASS=admin-dummy-pass
USER_PASS=user-dummy-pass

[ -n "$ENGINE" ] || { echo "Needs docker or podman." >&2; exit 1; }
kc() { "$ENGINE" exec "$NAME" /opt/keycloak/bin/kcadm.sh "$@"; }

up() {
  if ! "$ENGINE" ps --format '{{.Names}}' | grep -qx "$NAME"; then
    "$ENGINE" rm -f "$NAME" >/dev/null 2>&1 || true
    "$ENGINE" run -d --name "$NAME" -p "127.0.0.1:${PORT}:8080" \
      -e KC_BOOTSTRAP_ADMIN_USERNAME="$ADMIN_USER" -e KC_BOOTSTRAP_ADMIN_PASSWORD="$ADMIN_PASS" \
      "$IMAGE" start-dev --http-port=8080 --hostname="http://127.0.0.1:${PORT}" >/dev/null
  fi
  for _ in $(seq 1 90); do
    curl -fsS "http://127.0.0.1:${PORT}/realms/master/.well-known/openid-configuration" >/dev/null 2>&1 && break
    sleep 2
  done
  kc config credentials --server http://127.0.0.1:8080 --realm master --user "$ADMIN_USER" --password "$ADMIN_PASS" >/dev/null
  kc delete "realms/$REALM" >/dev/null 2>&1 || true
  local seconds="${TOKEN_SECONDS:-$((LEASE_HOURS * 3600))}"
  # access tokens live as long as a lease; the offline session (the refresh token the app keeps) outlives many leases
  kc create realms -s realm="$REALM" -s enabled=true -s accessTokenLifespan="$seconds" \
    -s ssoSessionIdleTimeout=86400 -s ssoSessionMaxLifespan=86400 -s offlineSessionIdleTimeout=2592000 -s revokeRefreshToken=false >/dev/null
  # a public client: authorization code with PKCE S256 only, redirect to any loopback port (RFC 8252)
  kc create clients -r "$REALM" -s clientId="$CLIENT" -s publicClient=true -s standardFlowEnabled=true \
    -s directAccessGrantsEnabled=false -s 'redirectUris=["http://127.0.0.1*"]' -s 'webOrigins=[]' \
    -s 'attributes={"pkce.code.challenge.method":"S256","post.logout.redirect.uris":"+"}' >/dev/null
  local cid
  cid=$(kc get clients -r "$REALM" -q clientId="$CLIENT" --fields id --format csv --noquotes)
  # the gateway checks this audience and reads the lease hours the admin set
  kc create "clients/$cid/protocol-mappers/models" -r "$REALM" -s name=gateway-audience -s protocol=openid-connect \
    -s protocolMapper=oidc-audience-mapper -s "config={\"included.custom.audience\":\"$AUDIENCE\",\"access.token.claim\":\"true\",\"id.token.claim\":\"false\"}" >/dev/null
  kc create "clients/$cid/protocol-mappers/models" -r "$REALM" -s name=lease-hours -s protocol=openid-connect \
    -s protocolMapper=oidc-hardcoded-claim-mapper -s "config={\"claim.name\":\"lease_hours\",\"claim.value\":\"$LEASE_HOURS\",\"jsonType.label\":\"int\",\"access.token.claim\":\"true\",\"id.token.claim\":\"false\"}" >/dev/null
  kc create "clients/$cid/protocol-mappers/models" -r "$REALM" -s name=groups -s protocol=openid-connect \
    -s protocolMapper=oidc-group-membership-mapper -s 'config={"claim.name":"groups","full.path":"false","access.token.claim":"true","id.token.claim":"true"}' >/dev/null
  kc create groups -r "$REALM" -s name=mopilot-users >/dev/null
  kc create groups -r "$REALM" -s name=mopilot-admins >/dev/null
  for spec in alice:mopilot-users bob:mopilot-admins carol:mopilot-users; do
    local user="${spec%%:*}" group="${spec##*:}"
    kc create users -r "$REALM" -s username="$user" -s enabled=true -s email="$user@example.test" -s emailVerified=true \
      -s firstName="$user" -s lastName=Test >/dev/null
    kc set-password -r "$REALM" --username "$user" --new-password "$USER_PASS" >/dev/null
    local uid gid
    uid=$(kc get users -r "$REALM" -q username="$user" --fields id --format csv --noquotes)
    gid=$(kc get groups -r "$REALM" -q search="$group" --fields id --format csv --noquotes | head -1)
    kc update "users/$uid/groups/$gid" -r "$REALM" -s realm="$REALM" -s userId="$uid" -s groupId="$gid" -n >/dev/null
  done
  echo "issuer=http://127.0.0.1:${PORT}/realms/${REALM} client=${CLIENT} audience=${AUDIENCE} users=alice,bob,carol lease_hours=${LEASE_HOURS}"
}

disable() {
  local user="$1" uid
  kc config credentials --server http://127.0.0.1:8080 --realm master --user "$ADMIN_USER" --password "$ADMIN_PASS" >/dev/null
  uid=$(kc get users -r "$REALM" -q username="$user" --fields id --format csv --noquotes)
  kc update "users/$uid" -r "$REALM" -s enabled=false
  kc create "users/$uid/logout" -r "$REALM" -s realm="$REALM" -s user="$uid" >/dev/null
  # offline sessions (the app's refresh token) end too
  for c in $(kc get "users/$uid/consents" -r "$REALM" --fields clientId --format csv --noquotes 2>/dev/null); do
    kc delete "users/$uid/consents/$c" -r "$REALM" >/dev/null 2>&1 || true
  done
  echo "disabled $user"
}

case "${1:-}" in
  up) up ;;
  down) "$ENGINE" rm -f "$NAME" >/dev/null && echo removed ;;
  disable) disable "${2:?user}" ;;
  *) echo "usage: $0 up|down|disable <user>" >&2; exit 2 ;;
esac
