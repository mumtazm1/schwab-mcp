# Schwab MCP Worker

## Critical Workflow Rules

**NEVER skip these steps when debugging or making changes:**

### 1. After ANY code change:
```bash
npm run deploy   # ALWAYS deploy before expecting changes to take effect
```
Then verify the deployment succeeded (check Version ID in output).

### 2. When checking KV data:
```bash
# ALWAYS use --remote flag - without it you're checking LOCAL storage, not production
npx wrangler kv key list --namespace-id b69ec1c5f9a54faa8b7a20bcad5b9748 --remote
```

### 3. After deploying:
```bash
mcporter daemon restart   # Restart mcporter so Jiminy reconnects
mcporter list             # Verify tool count (should show 23 tools for schwab)
```

### 4. Verification checklist:
- [ ] Code changes saved to files
- [ ] `npm run deploy` executed successfully
- [ ] `mcporter daemon restart` executed
- [ ] `mcporter list` shows expected tool count (23 tools)
- [ ] Tail logs to confirm worker is using new code: `npx wrangler tail --format pretty`

**Do NOT assume changes are live until you have verified deployment.**

---

## Overview

This is a Cloudflare Worker that provides MCP (Model Context Protocol) access to the Schwab brokerage API. It handles OAuth authentication and exposes trading tools.

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────┐
│ MCP Client  │────▶│ Cloudflare Worker│────▶│ Schwab API  │
│ (mcp-remote)│     │ (DurableMCP)     │     │             │
└─────────────┘     └──────────────────┘     └─────────────┘
       │                    │
       │                    ▼
       │              ┌──────────┐
       │              │    KV    │
       │              │ (tokens) │
       │              └──────────┘
       ▼
┌─────────────┐
│ ~/.mcp-auth │
│ (local)     │
└─────────────┘
```

## Two OAuth Layers

**CRITICAL**: There are TWO separate OAuth flows:

### 1. mcp-remote → Worker (OAuthProvider)
- **Purpose**: Authenticates the MCP client to the worker
- **Tokens stored**: `~/.mcp-auth/mcp-remote-{version}/{hash}_tokens.json`
- **Keys in KV**: `client:{clientId}`, `grant:{schwabUserId}:{grantId}`
- **When it happens**: Every time mcp-remote connects without valid local tokens

### 2. Worker → Schwab API (Schwab OAuth)
- **Purpose**: Authenticates the worker to call Schwab API
- **Tokens stored**: Cloudflare KV under `token:{schwabUserId}`
- **When it happens**: After mcp-remote OAuth, user is redirected to Schwab login
- **User sees**: Schwab login page, 2FA, account selection

## How Token Lookup Works

When the DO's `init()` runs, it needs to find Schwab tokens in KV. The lookup uses props from the OAuth grant:
1. `props.schwabUserId` - set during OAuth callback in `completeAuthorization()`
2. `props.clientId` - set from mcp-remote session

The grant's `encryptedProps` contains both IDs, which the OAuthProvider decrypts and passes to the DO.

## Known Bug: workers-mcp init() Race Condition

**Issue**: The `workers-mcp` library's `mount()` function doesn't await `_init()` before calling `onSSE()`:
```javascript
object._init(c.executionCtx.props);  // NOT awaited!
return await object.onSSE(c.req.raw);
```

This means tools registered during async `init()` might not be visible when the client queries `tools/list`.

**Fix** (in `src/index.ts`): Override `onSSE()` to wait for init to complete:
```typescript
async onSSE(event: any) {
    // Wait for init to complete
    let attempts = 0
    while (!this.client && attempts < 50) {
        await new Promise(resolve => setTimeout(resolve, 100))
        attempts++
    }
    // ... rest of method
}
```

## Key Files

- `src/index.ts` - DurableMCP class, tool registration, token loading, onSSE fix
- `src/auth/handler.ts` - OAuth endpoints (/authorize, /callback)
- `src/auth/client.ts` - Schwab auth client initialization
- `src/shared/kvTokenStore.ts` - KV token storage (uses direct KV.put)
- `wrangler.jsonc` - Cloudflare config, KV namespace binding

## KV Namespace

- **Binding**: `OAUTH_KV`
- **Namespace ID**: `b69ec1c5f9a54faa8b7a20bcad5b9748`

### Key Patterns in KV
- `token:{schwabUserId}` - Schwab API tokens (access_token, refresh_token, expiresAt)
- `client:{clientId}` - OAuth client registration (from mcp-remote)
- `grant:{schwabUserId}:{grantId}` - OAuth grants with encryptedProps

## Debugging

### Check if tokens exist in KV
```bash
# IMPORTANT: Use --remote flag! Without it, wrangler checks LOCAL storage
npx wrangler kv key list --namespace-id b69ec1c5f9a54faa8b7a20bcad5b9748 --remote
```

### Check specific token
```bash
npx wrangler kv key get "token:{id}" --namespace-id b69ec1c5f9a54faa8b7a20bcad5b9748 --remote
```

### Tail worker logs
```bash
npx wrangler tail --format pretty
```

**Note**: Durable Object logs may not appear in wrangler tail. Use debug tools or direct KV inspection instead.

### Check local mcp-remote tokens
```bash
cat ~/.mcp-auth/mcp-remote-*/*tokens.json
cat ~/.mcp-auth/mcp-remote-*/*client_info.json
```

## Common Issues

### Issue: Only "status" tool available (not all 23 tools)

**Possible causes**:
1. **workers-mcp race condition**: onSSE is called before init completes
   - **Fix**: Ensure the onSSE override with wait loop is in place
2. **Token not found**: Props don't have the right schwabUserId
   - **Debug**: Call `mcporter call schwab status` or add a debug tool to inspect props
3. **Init exception**: Something fails during initialization
   - **Check**: Look for errors in the catch block, ensure init doesn't re-throw

### Issue: OAuth keeps failing/looping
**Cause**: Multiple mcp-remote processes competing, or mcporter interfering
**Fix**:
```bash
pkill -f mcp-remote
pkill -f mcporter
rm -rf ~/.mcp-auth/
# Then do ONE clean OAuth
npx -y mcp-remote https://schwab-mcp-owais.owais-ce6.workers.dev/sse
# Complete OAuth in browser, then start mcporter
mcporter daemon start
```

### Issue: KV appears empty but tokens exist
**Cause**: Using `wrangler kv key list` without `--remote` checks LOCAL storage
**Fix**: Always use `--remote` flag

## Deployment

```bash
cd /home/owais/Projects/schwab-mcp
npm run deploy
```

## Environment Variables (in Cloudflare)

- `SCHWAB_CLIENT_ID` - Schwab API client ID
- `SCHWAB_CLIENT_SECRET` - Schwab API client secret
- `SCHWAB_REDIRECT_URI` - OAuth callback URL (https://schwab-mcp-owais.owais-ce6.workers.dev/callback)
- `COOKIE_ENCRYPTION_KEY` - For secure cookies
- `LOG_LEVEL` - Logging level (debug, info, warn, error)

## mcporter / OpenClaw Integration

mcporter config at `/home/owais/.openclaw/config/mcporter.json` includes:
```json
"schwab": {
  "command": "npx",
  "args": ["-y", "mcp-remote", "https://schwab-mcp-owais.owais-ce6.workers.dev/sse"]
}
```

mcporter spawns mcp-remote which handles the OAuth and MCP protocol.

## Schwab Token Expiry

- **Access tokens**: 30 minutes
- **Refresh tokens**: 7 days

The SDK's EnhancedTokenManager handles automatic refresh. If refresh token expires, full re-authentication is required.

## Token Migration

Each OAuth flow creates a new `schwabUserId`. The grant's `encryptedProps` contains both `schwabUserId` and `clientId`, ensuring the DO can always find tokens after OAuth completes.
