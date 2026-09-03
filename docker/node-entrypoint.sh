#!/bin/sh
set -eu

fail() {
  printf 'xcs-entrypoint: %s\n' "$1" >&2
  exit 1
}

load_secret() {
  variable_name="$1"
  file_variable_name="${variable_name}_FILE"
  direct_value="$(printenv "$variable_name" 2>/dev/null || true)"
  file_path="$(printenv "$file_variable_name" 2>/dev/null || true)"

  if [ -n "$direct_value" ] && [ -n "$file_path" ]; then
    fail "$variable_name and $file_variable_name are mutually exclusive"
  fi
  if [ -z "$file_path" ]; then
    return
  fi
  if [ ! -f "$file_path" ] || [ ! -r "$file_path" ]; then
    fail "$file_variable_name must reference a readable regular file"
  fi

  secret_size="$(wc -c < "$file_path" | tr -d ' ')"
  if [ "$secret_size" -eq 0 ] || [ "$secret_size" -gt 16384 ]; then
    fail "$file_variable_name must contain between 1 and 16384 bytes"
  fi

  secret_value="$(cat "$file_path")"
  if [ -z "$secret_value" ]; then
    fail "$file_variable_name must contain a non-empty value"
  fi
  case "$secret_value" in
    *'
'*) fail "$file_variable_name must contain one line" ;;
  esac
  export "$variable_name=$secret_value"
  unset "$file_variable_name"
}

# This is an explicit allowlist: arbitrary *_FILE environment variables are not
# interpreted, and secret values are never included in diagnostics.
for secret_variable in \
  XCS_DATABASE_PASSWORD \
  XCS_POSTGRES_ADMIN_PASSWORD \
  XCS_INDEXER_DATABASE_PASSWORD \
  XCS_API_DATABASE_PASSWORD \
  XCS_MONITOR_DATABASE_PASSWORD \
  XCS_INTERNAL_API_TOKEN \
  XCS_METRICS_TOKEN \
  XCS_RPC_URL_PRIMARY \
  XCS_RPC_URL_SECONDARY \
  XCS_PINNING_IP_HASH_SECRET \
  NUXT_API_INTERNAL_TOKEN
do
  load_secret "$secret_variable"
done

if [ -n "${XCS_DATABASE_URL_TARGET:-}" ]; then
  case "$XCS_DATABASE_URL_TARGET" in
    XCS_BOOTSTRAP_DATABASE_URL | XCS_INDEXER_DATABASE_URL | XCS_DATABASE_URL) ;;
    *) fail 'XCS_DATABASE_URL_TARGET is not an allowed database URL variable' ;;
  esac

  existing_database_url="$(printenv "$XCS_DATABASE_URL_TARGET" 2>/dev/null || true)"
  if [ -z "$existing_database_url" ]; then
    if [ -z "${XCS_DATABASE_PASSWORD:-}" ]; then
      fail 'XCS_DATABASE_PASSWORD or XCS_DATABASE_PASSWORD_FILE is required'
    fi
    # The single-quoted template literal below belongs to JavaScript.
    # shellcheck disable=SC2016
    database_url="$({
      XCS_DATABASE_USER="${XCS_DATABASE_USER:?XCS_DATABASE_USER is required}" \
      XCS_DATABASE_PASSWORD="$XCS_DATABASE_PASSWORD" \
      XCS_DATABASE_HOST="${XCS_DATABASE_HOST:-postgres}" \
      XCS_DATABASE_PORT="${XCS_DATABASE_PORT:-5432}" \
      XCS_DATABASE_NAME="${XCS_DATABASE_NAME:-xcs}" \
        node -e '
          const url = new URL("postgres://placeholder.invalid")
          // WHATWG URL setters preserve literal percent signs. Pre-encoding
          // prevents a password such as "value%word" from creating malformed
          // credentials while still letting URL serialize the other fields.
          url.username = encodeURIComponent(process.env.XCS_DATABASE_USER)
          url.password = encodeURIComponent(process.env.XCS_DATABASE_PASSWORD)
          url.hostname = process.env.XCS_DATABASE_HOST
          url.port = process.env.XCS_DATABASE_PORT
          url.pathname = `/${encodeURIComponent(process.env.XCS_DATABASE_NAME)}`
          process.stdout.write(url.toString())
        '
    })"
    export "$XCS_DATABASE_URL_TARGET=$database_url"
  fi
  unset XCS_DATABASE_PASSWORD
fi

exec "$@"
