#!/usr/bin/env bash
set -euo pipefail

# Fetch historical Fly logs through Fly's HTTP Logs API.
#
# Fly does not expose this endpoint through `fly logs`; it is not officially
# supported for external use, so treat this as a best-effort ops helper.
#
# Usage:
#   scripts/fly-logs.sh <start> [end] [-g|--grep PATTERN] [-r|--region REGION] \
#                       [-i|--instance MACHINE_ID] [--app APP]

usage() {
  cat <<'USAGE'
Usage:
  scripts/fly-logs.sh <start> [end] [-g|--grep PATTERN] [-r|--region REGION] \
                      [-i|--instance MACHINE_ID] [--app APP]

Times can be "now", an N[smhd] relative shorthand like "30m", or any
Date-parseable string like "2026-07-01T12:00:00Z".
USAGE
}

die() {
  echo "$*" >&2
  exit 1
}

parse_time_to_ns() {
  node -e '
    const s = process.argv[1];
    let ms;
    if (s === "now") ms = Date.now();
    else if (/^\d+[smhd]$/.test(s)) {
      const n = +s.slice(0, -1);
      const mult = { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[s.slice(-1)];
      ms = Date.now() - n * mult;
    } else ms = Date.parse(s);
    if (Number.isNaN(ms)) {
      console.error(`bad time: ${s}`);
      process.exit(1);
    }
    process.stdout.write(String(BigInt(ms) * 1000000n));
  ' "$1"
}

((BASH_VERSINFO[0] >= 4)) ||
  die "needs bash >= 4 (stock macOS bash is 3.2; use nix/Homebrew bash)"

missing=()
for tool in curl jq node; do
  command -v "$tool" >/dev/null || missing+=("$tool")
done
if ((${#missing[@]} > 0)); then
  die "needs ${missing[*]}"
fi

app="rpguild"
grep_pattern=""
region=""
instance=""
positional=()

while (($#)); do
  case "$1" in
    -g | --grep)
      (($# >= 2)) || die "$1 requires a pattern"
      grep_pattern=$2
      shift 2
      ;;
    -r | --region)
      (($# >= 2)) || die "$1 requires a region"
      region=$2
      shift 2
      ;;
    -i | --instance)
      (($# >= 2)) || die "$1 requires a machine id"
      instance=$2
      shift 2
      ;;
    --app)
      (($# >= 2)) || die "$1 requires an app"
      app=$2
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    --)
      shift
      while (($#)); do
        positional+=("$1")
        shift
      done
      ;;
    -*)
      die "unknown option: $1"
      ;;
    *)
      positional+=("$1")
      shift
      ;;
  esac
done

if ((${#positional[@]} < 1)); then
  usage >&2
  exit 1
fi
if ((${#positional[@]} > 2)); then
  die "too many positional arguments"
fi

if [[ -z ${FLY_API_TOKEN:-} ]]; then
  command -v fly >/dev/null || die "needs fly, or set FLY_API_TOKEN"
fi

token=${FLY_API_TOKEN:-$(fly auth token -q)}
[[ -n $token ]] || die "empty Fly API token"

start_ns=$(parse_time_to_ns "${positional[0]}") || exit 1
end_ns=$(parse_time_to_ns "${positional[1]:-now}") || exit 1
cursor=$start_ns
base_url="https://api.fly.io/api/v1/apps/$app/logs"
declare -A seen

for ((page_num = 1; page_num <= 1000; page_num++)); do
  curl_args=(
    -sS
    --fail
    --get
    "$base_url"
    -H
    "Authorization: FlyV1 $token"
    --data-urlencode
    "next_token=$cursor"
  )
  [[ -z $region ]] || curl_args+=(--data-urlencode "region=$region")
  [[ -z $instance ]] || curl_args+=(--data-urlencode "instance=$instance")

  page=$(curl "${curl_args[@]}")
  rows=$(jq -c '.data[]' <<<"$page")
  [[ -n $rows ]] || break

  while IFS= read -r row; do
    id=$(jq -r '.id' <<<"$row")
    [[ -z ${seen[$id]+x} ]] || continue
    seen[$id]=1

    ts=$(jq -r '.attributes.timestamp' <<<"$row")
    ts_ns=$(parse_time_to_ns "$ts") || exit 1
    ((ts_ns <= end_ns)) || break 2

    msg=$(jq -r '.attributes.message' <<<"$row")
    if [[ -n $grep_pattern ]]; then
      set +e
      printf '%s' "$msg" | grep -qiE -- "$grep_pattern"
      grep_status=$?
      set -e
      if ((grep_status == 1)); then
        continue
      fi
      if ((grep_status != 0)); then
        exit "$grep_status"
      fi
    fi

    log_region=$(jq -r '.attributes.region' <<<"$row")
    log_instance=$(jq -r '.attributes.instance' <<<"$row")
    printf '%s  %s  %s  %s\n' "$ts" "$log_region" "$log_instance" "$msg"
  done <<<"$rows"

  next=$(jq -r '.meta.next_token // ""' <<<"$page")
  [[ -n $next && $next != "$cursor" ]] || break
  cursor=$next
done

if ((page_num > 1000)); then
  die "stopped after 1000 log pages"
fi
