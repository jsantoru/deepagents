# DeepAgents — Gateway & Auth Architecture

*Decisions made for API Gateway, Cognito, Spring proxy, and the external vs UI API split.*

---

## TL;DR

- **Cognito** is the single identity provider — for UI users, M2M clients, and enterprise IdP federation
- **AWS API Gateway** is the only public entry point — handles auth enforcement, rate limiting, and API keys
- **Spring** is a wildcard proxy — one rule, forwards everything to Python, no per-endpoint config
- **Python backend** is private — only reachable from Spring, never directly from API GW or the internet
- **External API surface** is controlled exclusively in API GW config — adding a Python endpoint doesn't expose it externally

---

## System Shape

```
                     Cognito User Pool
                    ┌─────────────────────────────────────────┐
                    │  UI users (auth code + PKCE)            │
                    │  M2M clients (client credentials)       │
                    │  Enterprise IdPs (OIDC/SAML federation) │
                    └─────────────────────────────────────────┘
                                      │ Cognito JWTs (all paths)
                                      ▼
Browser UI ──────────────────▶ AWS API Gateway ◀────── External Developers
                               ┌──────────────────────────────────────────┐
                               │  /ui/*   JWT only · no API key           │
                               │  /v1/*   JWT + API key · usage plans     │
                               └──────────────────┬───────────────────────┘
                                                  │ all routes
                                                  ▼
                                           Spring Proxy
                                     (wildcard /** → Python)
                                     add X-User-* headers
                                                  │
                                                  ▼
                                          Python Backend
                                      (private VPC · reads
                                       X-User-* headers only)
```

---

## Identity — Cognito as Single IdP

### Why Cognito instead of Keycloak

Keycloak requires a server to run, patch, and scale. Cognito is fully managed and integrates natively with API GW — the JWT authorizer needs zero additional config.

Cognito handles every client type already present in the system:

| Client type | Flow | Token |
|---|---|---|
| UI users | Authorization Code + PKCE | Cognito JWT |
| Scripts / services | Client Credentials | Cognito JWT |
| Enterprise customers with own IdP | OIDC / SAML federation into Cognito | Cognito JWT |

Everything downstream — API GW authorizer, Spring, Python — sees only Cognito JWTs. The flow that produced the token is invisible to them.

### Enterprise customer IdP federation

Enterprise customers who manage their own users in Okta, Azure AD, or their own Keycloak do not get a second user directory. Their IdP is registered as an OIDC or SAML provider in Cognito:

```
Enterprise user logs in
  → Cognito hosted UI → "Login with <customer IdP>"
  → customer's IdP handles credential check
  → Cognito issues a Cognito JWT
  → API GW, Spring, Python: unchanged
```

Users live in the customer's own directory. Cognito brokers identity. No user data duplication.

### Cognito vs Keycloak trade-offs

| | Cognito | Keycloak |
|---|---|---|
| Ops burden | Zero | Run, patch, scale yourself |
| Login UI customization | CSS only | Full control |
| Fine-grained authorization | Groups only (use Verified Permissions for more) | Built-in roles and policies |
| API GW integration | Native | Requires Lambda authorizer |
| Enterprise IdP federation | OIDC + SAML built-in | Plugin-based |
| Token customization | Lambda pre-token trigger | Full |
| Cost | $0.0055/MAU after 50k free | Server cost |

For most deployments the ops savings and native integration outweigh the UI customization limit. The only reason to keep Keycloak is if complex custom auth flows or pixel-perfect login UI are requirements.

---

## AWS API Gateway — Two Route Groups, One Backend

API GW is the single public entry point. All traffic — UI and external developers — enters here. Routes are split into two groups with different policies. Both groups forward to the same Spring proxy.

### External API (`/v1/*`)

The public developer-facing product. Small, stable, versioned surface. Adding a route here is a deliberate product decision.

| Policy | Setting |
|---|---|
| Auth | JWT authorizer (Cognito) + API key required |
| Rate limiting | Usage plans per API key |
| Versioning | `/v1/` prefix — breaking changes require a new version |
| Initial surface | 3 endpoints (see below) |

Initial external endpoints:

```
POST /v1/conversations
POST /v1/conversations/{id}/turns
GET  /v1/runs/{id}
```

### UI API (`/ui/*`)

The internal surface for the web application. Full endpoint set available. No API key. JWT auth only — the UI user's Cognito token is sufficient.

| Policy | Setting |
|---|---|
| Auth | JWT authorizer (Cognito) only |
| Rate limiting | None (or a generous global throttle) |
| Versioning | None — internal, refactor freely |
| Surface | All Python backend endpoints |

### Forwarding to Spring

Both route groups forward to the same Spring integration. API GW injects validated JWT claims into the request context before forwarding:

```
$context.authorizer.claims.sub   → X-User-Id header
$context.authorizer.claims.email → X-User-Email header
```

Spring reads these headers. Spring does not re-validate the JWT.

---

## Spring — Wildcard Proxy

Spring's entire job is to be the single, stable path to the Python backend. No per-endpoint routing config. One rule:

```yaml
spring:
  cloud:
    gateway:
      routes:
        - id: python-backend
          uri: http://python-backend:8000
          predicates:
            - Path=/**
          filters:
            - AddRequestHeader=X-Internal-Token, ${internal.token}
```

Spring adds `X-Internal-Token` — a shared secret that Python checks to confirm the request came through Spring and not from a direct call. That is the entire application-level security boundary.

### Adding a new Python endpoint

```
Add endpoint to Python
  → immediately reachable by UI (Spring forwards /**)
  → NOT reachable externally (no API GW route exists for it)
  → add to /v1/* in API GW when deliberately ready to expose
```

No Spring deploy required. No Spring config change. The only gate on external exposure is API GW config — the right place for that decision.

### Why keep Spring at all

Spring is owned by another team and is the stable internal routing contract. Other services and future UI clients integrate against Spring, not directly against Python. The Python backend is an implementation detail behind that contract — it can be replaced, split, or scaled without changing anything upstream.

If Spring did not already exist as a team boundary, API GW could route directly to Python via VPC link and Spring would be unnecessary.

---

## Python Backend — Private, Header-Driven Auth

Python is not on the public internet. It is only reachable from Spring via VPC internal routing.

Auth in Python is two lines:

```python
if request.headers.get("X-Internal-Token") != settings.internal_token:
    raise HTTPException(status_code=403)

user_id = request.headers["X-User-Id"]
email   = request.headers.get("X-User-Email")
```

No JWT library. No Cognito SDK. No Keycloak. Python trusts Spring because the network ensures only Spring can reach it, and the internal token is a tripwire that catches any misconfiguration in that network assumption.

---

## API Key Model

AWS API GW usage plans are tied to API keys. Two models are viable:

| Model | When to use |
|---|---|
| One API key per external client / integration | Per-client rate limiting and credit tracking. Each script, service, or customer integration gets its own key. |
| One API key for the whole frontend app | Global frontend throttle only. All UI users share the quota. Simpler operationally. |

The external developer API uses per-client keys — that's the product model (credits, rate limits, audit). The UI route group does not require an API key at all.

---

## Network Isolation

| Component | Reachable from |
|---|---|
| Python backend | Spring only (VPC internal) |
| Spring proxy | API GW only (VPC link or security group) |
| AWS API GW | Public internet |
| Cognito | Public internet (token issuance) |

Python has no public URL. Spring has no public URL. The only public surface is API GW. If network isolation breaks down, the `X-Internal-Token` check in Python is the application-layer backstop.

---

## Programmatic Access (M2M)

Scripts, CI pipelines, and service integrations use the Cognito client credentials flow. No browser, no user:

```bash
# Get a token
curl -X POST https://cognito-idp.{region}.amazonaws.com/{pool_id}/oauth2/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials&client_id={id}&client_secret={secret}"

# Call the API
curl https://api.example.com/v1/conversations \
  -H "Authorization: Bearer {access_token}" \
  -H "x-api-key: {api_key}" \
  -d '{"message": "..."}'
```

The token is a Cognito JWT. API GW validates it identically to a UI user's token. The only difference is the `x-api-key` header and the `/v1/` route prefix.

---

## Decision Log

| Decision | Choice | Reason |
|---|---|---|
| IdP | Cognito User Pools | Native API GW integration, zero ops, federation handles enterprise IdPs |
| Keycloak | Removed | No self-hosted IdP needed when Cognito covers all client types |
| Public entry point | AWS API GW only | Single choke point for auth, rate limiting, and surface control |
| Spring role | Wildcard proxy only (`/**`) | No per-endpoint config — new Python endpoints are free |
| Spring purpose | Kept for team boundary | Other teams integrate against Spring as stable contract |
| Python auth | X-Internal-Token header check | Network isolation is the real boundary; header is a tripwire |
| External API | `/v1/*` routes in API GW | Deliberate gate — adding a Python endpoint doesn't expose it externally |
| UI API | `/ui/*` routes in API GW, JWT only | Full surface, no API key friction for internal use |
| Enterprise customers | Cognito IdP federation | Users stay in customer's own directory, Cognito brokers |
| M2M auth | Cognito client credentials | Same Cognito JWT as user tokens, API GW validates identically |

---

## Out of Scope

- Multi-region deployment
- Cognito advanced security features (adaptive auth, compromised credential detection)
- Fine-grained authorization beyond Cognito groups — add Amazon Verified Permissions if needed
- API GW caching
- Custom domain setup
- WAF rules
