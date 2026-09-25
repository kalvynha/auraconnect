#!/usr/bin/env bash
# One-shot setup of a real Firebase / Google Cloud project for AuraConnect.
#
# Run on your own machine, logged in as yourself:
#   gcloud auth login && firebase login
#   ./scripts/gcp-setup.sh YOUR_PROJECT_ID [--deploy]
#
# What it does (idempotent — safe to re-run):
#   1. Checks billing is enabled (Blaze plan is required).
#   2. Enables the Google Cloud APIs AuraConnect uses.
#   3. Adds Firebase to the project (if needed).
#   4. Upgrades Auth to Identity Platform and enables email/password sign-in.
#   5. Creates the Firestore database (nam5) and the default Storage bucket.
#   6. Grants the Cloud Functions runtime service account its roles.
#   7. Registers the iOS + web apps and writes their config files:
#        ios/AuraConnect/Resources/GoogleService-Info.plist
#        web/.env.local
#   8. Points .firebaserc at the project and writes functions/.env.<project>.
#   9. With --deploy: deploys rules, indexes, functions and hosting.
#
# It does NOT sign Google's HIPAA BAA — do that in the Cloud console
# (IAM & Admin → Legal & Compliance) before storing any real patient data.

set -euo pipefail

PROJECT_ID="${1:-}"
DEPLOY="false"
[[ "${2:-}" == "--deploy" ]] && DEPLOY="true"

FIRESTORE_LOCATION="${FIRESTORE_LOCATION:-nam5}"
BUCKET_LOCATION="${BUCKET_LOCATION:-US-CENTRAL1}"
IOS_BUNDLE_ID="${IOS_BUNDLE_ID:-com.auraconnect.app}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '    \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }

[[ -n "$PROJECT_ID" ]] || die "usage: $0 PROJECT_ID [--deploy]"
command -v gcloud >/dev/null   || die "gcloud not found. Install: brew install --cask google-cloud-sdk"
command -v firebase >/dev/null || die "firebase CLI not found. Install: npm install -g firebase-tools"
command -v node >/dev/null     || die "node not found. Install Node 22: brew install node@22"
command -v curl >/dev/null     || die "curl not found"

gcloud auth print-access-token >/dev/null 2>&1 || die "Run 'gcloud auth login' first."
firebase projects:list --json >/dev/null 2>&1   || die "Run 'firebase login' first."

token() { gcloud auth print-access-token; }

# Authenticated call to a Google REST API. Usage: gapi METHOD URL [JSON_BODY]
gapi() {
  local method="$1" url="$2" body="${3:-}"
  local args=(-sS -X "$method" -H "Authorization: Bearer $(token)" -H "x-goog-user-project: $PROJECT_ID" -H "Content-Type: application/json" -w '\n%{http_code}')
  [[ -n "$body" ]] && args+=(-d "$body")
  curl "${args[@]}" "$url"
}
http_code() { tail -n1 <<<"$1"; }
http_body() { sed '$d' <<<"$1"; }

# ---------------------------------------------------------------------------
step "Project $PROJECT_ID"
gcloud projects describe "$PROJECT_ID" --format='value(projectId)' >/dev/null 2>&1 \
  || die "Project '$PROJECT_ID' not found or you lack access. Create it at https://console.firebase.google.com (Add project; turn Google Analytics OFF)."
gcloud config set project "$PROJECT_ID" >/dev/null 2>&1
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
ok "project number $PROJECT_NUMBER"

BILLING="$(gcloud billing projects describe "$PROJECT_ID" --format='value(billingEnabled)' 2>/dev/null || echo "")"
[[ "$BILLING" == "True" ]] || die "Billing is not enabled. Upgrade to the Blaze plan: https://console.firebase.google.com/project/$PROJECT_ID/usage/details"
ok "billing enabled"

# ---------------------------------------------------------------------------
step "Enabling Google Cloud APIs (this can take a few minutes)"
gcloud services enable \
  firebase.googleapis.com \
  identitytoolkit.googleapis.com \
  firestore.googleapis.com \
  firebasestorage.googleapis.com \
  storage.googleapis.com \
  firebaserules.googleapis.com \
  cloudfunctions.googleapis.com \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  eventarc.googleapis.com \
  pubsub.googleapis.com \
  cloudscheduler.googleapis.com \
  cloudtasks.googleapis.com \
  aiplatform.googleapis.com \
  fcm.googleapis.com \
  fcmregistrations.googleapis.com \
  firebaseinstallations.googleapis.com \
  firebasehosting.googleapis.com \
  cloudresourcemanager.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  --project "$PROJECT_ID"
ok "APIs enabled"

# ---------------------------------------------------------------------------
step "Firebase"
if firebase projects:list --json | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    const r=JSON.parse(s).result||[];process.exit(r.some(p=>p.projectId===process.argv[1])?0:1)})' "$PROJECT_ID"; then
  ok "Firebase already enabled"
else
  firebase projects:addfirebase "$PROJECT_ID"
  ok "Firebase added"
fi

# ---------------------------------------------------------------------------
step "Authentication (Identity Platform + email/password)"
RES="$(gapi GET "https://identitytoolkit.googleapis.com/admin/v2/projects/$PROJECT_ID/config")"
if [[ "$(http_code "$RES")" == "200" ]] && grep -q '"subtype": *"IDENTITY_PLATFORM"' <<<"$(http_body "$RES")"; then
  ok "already on Identity Platform"
else
  RES="$(gapi POST "https://identitytoolkit.googleapis.com/v2/projects/$PROJECT_ID/identityPlatform:initializeAuth" '{}')"
  case "$(http_code "$RES")" in
    200) ok "upgraded to Identity Platform" ;;
    *)   warn "could not upgrade automatically ($(http_code "$RES")). Do it in the console: https://console.firebase.google.com/project/$PROJECT_ID/authentication/settings" ;;
  esac
fi
RES="$(gapi PATCH "https://identitytoolkit.googleapis.com/admin/v2/projects/$PROJECT_ID/config?updateMask=signIn.email.enabled,signIn.email.passwordRequired" \
  '{"signIn":{"email":{"enabled":true,"passwordRequired":true}}}')"
[[ "$(http_code "$RES")" == "200" ]] && ok "email/password sign-in enabled" \
  || warn "enable Email/Password manually: https://console.firebase.google.com/project/$PROJECT_ID/authentication/providers ($(http_code "$RES"))"
warn "Turn on MFA when ready: Authentication → Settings → Multi-factor authentication"

# ---------------------------------------------------------------------------
step "Firestore ($FIRESTORE_LOCATION)"
if gcloud firestore databases describe --database='(default)' --project "$PROJECT_ID" >/dev/null 2>&1; then
  ok "database already exists"
else
  gcloud firestore databases create --database='(default)' --location="$FIRESTORE_LOCATION" --type=firestore-native --project "$PROJECT_ID"
  ok "database created"
fi

# ---------------------------------------------------------------------------
step "Cloud Storage default bucket"
RES="$(gapi GET "https://firebasestorage.googleapis.com/v1alpha/projects/$PROJECT_ID/defaultBucket")"
if [[ "$(http_code "$RES")" == "200" ]]; then
  ok "default bucket exists"
else
  RES="$(gapi POST "https://firebasestorage.googleapis.com/v1alpha/projects/$PROJECT_ID/defaultBucket" \
    "{\"location\":\"$BUCKET_LOCATION\",\"storageClass\":\"STANDARD\"}")"
  if [[ "$(http_code "$RES")" == "200" ]]; then
    ok "default bucket created"
  else
    warn "could not create the bucket automatically ($(http_code "$RES")). Click 'Get started' at https://console.firebase.google.com/project/$PROJECT_ID/storage then re-run this script."
  fi
fi

# ---------------------------------------------------------------------------
step "IAM for the Cloud Functions runtime"
RUNTIME_SA="$PROJECT_NUMBER-compute@developer.gserviceaccount.com"
for ROLE in roles/aiplatform.user roles/cloudtasks.enqueuer roles/iam.serviceAccountTokenCreator roles/iam.serviceAccountUser roles/firebaseauth.admin; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:$RUNTIME_SA" --role="$ROLE" --condition=None --quiet >/dev/null
  ok "$ROLE → $RUNTIME_SA"
done

# ---------------------------------------------------------------------------
step "Registering apps"
# Prints the id of the first app of PLATFORM whose bundle id / display name matches, or nothing.
find_app() {
  firebase apps:list "$1" --project "$PROJECT_ID" --json | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      const [plat,key]=process.argv.slice(1);
      const apps=(JSON.parse(s).result||[]);
      const a=apps.find(x=> plat==="IOS" ? x.bundleId===key : x.displayName===key);
      if(a) process.stdout.write(a.appId)})' "$1" "$2"
}

IOS_APP_ID="$(find_app IOS "$IOS_BUNDLE_ID")"
if [[ -z "$IOS_APP_ID" ]]; then
  IOS_APP_ID="$(firebase apps:create IOS "AuraConnect iOS" --bundle-id "$IOS_BUNDLE_ID" --project "$PROJECT_ID" --json \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).result.appId))')"
  ok "iOS app created ($IOS_APP_ID)"
else
  ok "iOS app exists ($IOS_APP_ID)"
fi
mkdir -p "$REPO_ROOT/ios/AuraConnect/Resources"
rm -f "$REPO_ROOT/ios/AuraConnect/Resources/GoogleService-Info.plist"
firebase apps:sdkconfig IOS "$IOS_APP_ID" --project "$PROJECT_ID" \
  --out "$REPO_ROOT/ios/AuraConnect/Resources/GoogleService-Info.plist" >/dev/null
ok "wrote ios/AuraConnect/Resources/GoogleService-Info.plist"

WEB_APP_ID="$(find_app WEB "AuraConnect Web")"
if [[ -z "$WEB_APP_ID" ]]; then
  WEB_APP_ID="$(firebase apps:create WEB "AuraConnect Web" --project "$PROJECT_ID" --json \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).result.appId))')"
  ok "web app created ($WEB_APP_ID)"
else
  ok "web app exists ($WEB_APP_ID)"
fi
firebase apps:sdkconfig WEB "$WEB_APP_ID" --project "$PROJECT_ID" --json | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    const r=JSON.parse(s).result;
    const c=r.sdkConfig||JSON.parse(r.fileContents.slice(r.fileContents.indexOf("{"),r.fileContents.lastIndexOf("}")+1));
    const lines=[
      "# Generated by scripts/gcp-setup.sh — Firebase web config (not secret, but project-specific)",
      "VITE_FIREBASE_API_KEY="+c.apiKey,
      "VITE_FIREBASE_AUTH_DOMAIN="+c.authDomain,
      "VITE_FIREBASE_PROJECT_ID="+c.projectId,
      "VITE_FIREBASE_STORAGE_BUCKET="+(c.storageBucket||""),
      "VITE_FIREBASE_MESSAGING_SENDER_ID="+c.messagingSenderId,
      "VITE_FIREBASE_APP_ID="+c.appId,
      "VITE_USE_EMULATORS=false",""];
    require("fs").writeFileSync(process.argv[1],lines.join("\n"))})' "$REPO_ROOT/web/.env.local"
ok "wrote web/.env.local"

# ---------------------------------------------------------------------------
step "Local project config"
cat >"$REPO_ROOT/.firebaserc" <<EOF
{
  "projects": {
    "default": "$PROJECT_ID"
  }
}
EOF
ok ".firebaserc → $PROJECT_ID"
FN_ENV="$REPO_ROOT/functions/.env.$PROJECT_ID"
touch "$FN_ENV"
# Sets KEY=VALUE in the functions env file, replacing any existing line for KEY.
set_param() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  grep -v "^$key=" "$FN_ENV" >"$tmp" || true
  echo "$key=$value" >>"$tmp"
  mv "$tmp" "$FN_ENV"
}
has_param() { grep -q "^$1=" "$FN_ENV"; }

has_param GEMINI_MODEL || set_param GEMINI_MODEL gemini-2.5-flash
has_param VERTEX_LOCATION || set_param VERTEX_LOCATION us-central1
has_param INVITE_REQUIRE_VERIFIED_EMAIL || set_param INVITE_REQUIRE_VERIFIED_EMAIL true

# Event triggers must run in the same region as the Firestore database / Storage bucket.
FS_LOC="$(gcloud firestore databases describe --database='(default)' --project "$PROJECT_ID" --format='value(locationId)' 2>/dev/null || echo "")"
case "$FS_LOC" in
  nam5|"") FS_REGION="us-central1" ;;
  eur3)    FS_REGION="europe-west1" ;;
  *)       FS_REGION="$FS_LOC" ;;
esac
set_param FIRESTORE_TRIGGER_REGION "$FS_REGION"
ok "Firestore is in ${FS_LOC:-unknown} → triggers in $FS_REGION"

BUCKET="$(http_body "$(gapi GET "https://firebasestorage.googleapis.com/v1alpha/projects/$PROJECT_ID/defaultBucket")" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).bucket.name.split("/").pop())}catch{}})')"
if [[ -n "$BUCKET" ]]; then
  BUCKET_LOC="$(gcloud storage buckets describe "gs://$BUCKET" --format='value(location)' 2>/dev/null | tr '[:upper:]' '[:lower:]')"
  case "$BUCKET_LOC" in
    us|"") ST_REGION="us-central1" ;;   # US multi-region buckets accept us-central1 triggers
    eu)    ST_REGION="europe-west1" ;;
    *)     ST_REGION="$BUCKET_LOC" ;;
  esac
  set_param STORAGE_TRIGGER_REGION "$ST_REGION"
  ok "bucket $BUCKET is in ${BUCKET_LOC:-unknown} → trigger in $ST_REGION"
else
  warn "default bucket not found; STORAGE_TRIGGER_REGION left unchanged"
fi
ok "wrote functions/.env.$PROJECT_ID"

# ---------------------------------------------------------------------------
if [[ "$DEPLOY" == "true" ]]; then
  step "Deploying (first deploy of a new project can take ~10 minutes)"
  (cd "$REPO_ROOT/functions" && npm ci)
  (cd "$REPO_ROOT/web" && npm ci && npm run build)
  cd "$REPO_ROOT"
  if ! firebase deploy --only firestore,storage,functions,hosting --project "$PROJECT_ID" --force; then
    warn "Deploy failed. On a brand-new project this is usually Eventarc/Cloud Build permissions still propagating."
    warn "Wait 2–3 minutes and re-run: firebase deploy --only functions --project $PROJECT_ID"
    exit 1
  fi
  ok "deployed"
fi

# ---------------------------------------------------------------------------
step "Done"
cat <<EOF
  Console:      https://console.firebase.google.com/project/$PROJECT_ID
  Web console:  $( [[ "$DEPLOY" == "true" ]] && echo "https://$PROJECT_ID.web.app" || echo "cd web && npm run dev  (or re-run with --deploy)" )
  iOS:          cd ios && xcodegen generate && open AuraConnect.xcodeproj  (use the "AuraConnect" scheme)

  Still manual:
   • Sign Google's HIPAA BAA before any real PHI (Cloud console → IAM & Admin → Legal & Compliance)
   • Push: upload an APNs .p8 key in Project settings → Cloud Messaging
   • Turn on MFA in Authentication → Settings
   • Enable Data Access audit logs for Firestore + Storage (IAM & Admin → Audit Logs)
EOF
