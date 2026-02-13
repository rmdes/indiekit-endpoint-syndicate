# CLAUDE.md - indiekit-endpoint-syndicate

## Package Overview

**Package:** `@rmdes/indiekit-endpoint-syndicate`
**Version:** 1.0.0-beta.29
**Type:** Indiekit endpoint plugin
**Purpose:** Syndication endpoint that triggers syndication to external services (Mastodon, Bluesky, LinkedIn, etc.)

This is a **fork of @indiekit/endpoint-syndicate** with critical bug fixes and batch syndication support. It receives webhooks or manual triggers, finds posts awaiting syndication in MongoDB, calls syndicator plugins, and updates posts with syndicated URLs via Micropub.

## Key Differences from Upstream

### Critical Bug Fixes

1. **Array.isArray Bug (utils.js:114)**
   - **Upstream:** `Array.isArray` (function reference, always truthy)
   - **Fixed:** `Array.isArray(syndicateTo)` (actually calls the function)
   - **Impact:** Upstream always treated `syndicateTo` as an array, causing incorrect behavior when it's a string

2. **Partial Syndication Bug (utils.js:22-25)**
   - **Upstream:** Filter excluded posts with existing `syndication` property
   - **Problem:** Skipped partially syndicated posts (e.g., posted to Mastodon but not yet to Bluesky)
   - **Fixed:** Removed `"properties.syndication": { $exists: false }` filter
   - **Reason:** `syndicateToTargets()` already calls `hasSyndicationUrl()` to skip completed targets

### Feature Additions

1. **Batch Mode**
   - Process ALL pending posts when `source_url` is not provided
   - Respects 2-second delay between posts for rate limiting
   - Returns detailed results array with success/failure for each post

2. **Enhanced Error Handling**
   - Per-post error tracking in batch mode
   - Failed targets still update post (removes from `mp-syndicate-to`)
   - Detailed console logging for debugging

## Architecture

### Data Flow

```
Webhook or Manual Trigger (POST /syndicate)
    ↓
Extract bearer token (from header, body, or query)
    ↓
Query MongoDB for posts with mp-syndicate-to property
    ↓
For each post:
    syndicateToTargets() → Call syndicator plugins
    ↓
    Collect syndicated URLs and failed targets
    ↓
    Update post via Micropub (add syndication URLs, remove mp-syndicate-to)
    ↓
Return success/failure results
```

### Token Flow

**Netlify Webhook (webhook signature):**
1. Request has `x-webhook-signature` header
2. Verify JWT signature with `WEBHOOK_SECRET`
3. Sign new short-lived token with `SECRET` and `update` scope
4. Use token for Micropub update

**Direct Access Token:**
1. Extract from `request.body.access_token` or `request.query.token`
2. Use directly for Micropub update

## Key Files

### index.js
- Main plugin class `SyndicateEndpoint`
- Registers public POST route at `/syndicate` (no auth required - token verified in controller)
- Stores `mountPath` in `application._syndicationEndpointPath` for use by other plugins
- Default mount path: `/syndicate`

### lib/controllers/syndicate.js
Core syndication controller:
- `post()` - Main entry point (handles both single-post and batch mode)
- `syndicatePost()` - Syndicate a single post and update via Micropub
- `delay()` - Rate limiting helper (2 seconds between posts)

**POST Modes:**
1. **Single Post Mode** (when `source_url` is provided)
   - Finds post with matching URL
   - Syndicates to targets
   - Updates post via Micropub
   - Optionally redirects to `redirect_uri` with success message

2. **Batch Mode** (when `source_url` is NOT provided)
   - Finds ALL posts with `mp-syndicate-to` property
   - Processes each post sequentially with 2-second delay
   - Returns detailed results array
   - Used for mass syndication or cron jobs

### lib/utils.js
Database and syndication helpers:

**getPostData(postsCollection, url):**
- If `url` provided: Find post with matching `properties.url`
- If no URL: Find most recent published post with `mp-syndicate-to`
- **BUG FIX:** Removed `syndication` filter to allow partial syndication

**getAllPostData(postsCollection):**
- Find ALL posts with `mp-syndicate-to` property
- Sorted by `published` date (newest first)
- Excludes drafts (`post-status !== "draft"`)

**hasSyndicationUrl(syndicatedUrls, syndicateTo):**
- Check if target already returned a syndication URL
- Compares origin of URLs (e.g., `https://mastodon.social` vs `https://bsky.app`)

**getSyndicationTarget(syndicationTargets, syndicateTo):**
- Find syndicator plugin matching the target URL
- Matches by origin (e.g., `https://bsky.app` matches `https://bsky.app/@username`)

**syndicateToTargets(publication, properties):**
- Main syndication logic
- Iterates over `mp-syndicate-to` URLs
- Calls `target.syndicate(properties, publication)` for each target
- Collects syndicated URLs and failed targets
- **BUG FIX:** Fixed `Array.isArray(syndicateTo)` check

### lib/token.js
Token extraction and verification:

**findBearerToken(request):**
- **Priority 1:** Webhook signature (`x-webhook-signature` header + `body.url`)
  - Verify JWT from Netlify
  - Sign new short-lived token (10 min expiry, `update` scope)
- **Priority 2:** Access token in body (`body.access_token`)
- **Priority 3:** Token in query (`query.token`)
- Throws `InvalidRequestError` if no token found

**verifyToken(signature):**
- Verify JWT issued by Netlify using `WEBHOOK_SECRET`
- Requires `HS256` algorithm and `netlify` issuer

**signToken(verifiedToken, url):**
- Create short-lived JWT (10 min) with `update` scope
- Signed with `SECRET` env var
- Used for Micropub update requests

## Configuration

### Constructor Options (indiekit.config.js)
```javascript
import SyndicateEndpoint from "@rmdes/indiekit-endpoint-syndicate";

export default {
  plugins: [
    new SyndicateEndpoint({
      mountPath: "/syndicate"  // Default: /syndicate
    })
  ]
};
```

### Environment Variables
- `SECRET` - JWT signing secret (required for token generation)
- `WEBHOOK_SECRET` - Netlify webhook verification secret (required for webhook mode)

### Syndicator Plugins
This endpoint works with syndicator plugins (e.g., `@rmdes/indiekit-syndicator-bluesky`, `@rmdes/indiekit-syndicator-mastodon`):

```javascript
import Blueskyyndicator from "@rmdes/indiekit-syndicator-bluesky";
import MastodonSyndicator from "@rmdes/indiekit-syndicator-mastodon";

export default {
  plugins: [
    new Blueskyyndicator({ ... }),
    new MastodonSyndicator({ ... }),
    new SyndicateEndpoint()
  ]
};
```

Each syndicator must implement:
- `get info()` - Returns `{ uid: "https://bsky.app/@username", name: "Bluesky" }`
- `async syndicate(properties, publication)` - Returns syndicated URL or null

## Inter-Plugin Relationships

### Dependencies
- **@indiekit/indiekit** - Core plugin API
- **@indiekit/error** - IndiekitError for error handling
- **express** - Routing
- **jsonwebtoken** - JWT verification/signing for Netlify webhooks

### Upstream Integration Points
- **Stores endpoint path:** `application._syndicationEndpointPath` (used by other plugins)
- **Reads syndicators:** `publication.syndicationTargets` (array of syndicator plugins)
- **Reads database:** `application.collections.get("posts")` (MongoDB posts collection)
- **Reads Micropub endpoint:** `application.micropubEndpoint` (for post updates)

### Downstream Integration Points
- **Called by Netlify:** After build deploy (webhook signature verification)
- **Called by cron:** Scheduled batch syndication (token in query/body)
- **Called by UI:** Manual syndication trigger (e.g., from post edit page)

### Data Flow with Other Plugins

1. **Micropub Endpoint** creates post with `mp-syndicate-to` property
2. **This plugin** receives trigger (webhook, cron, manual)
3. **This plugin** queries posts collection for pending posts
4. **Syndicator plugins** (Bluesky, Mastodon, etc.) post to external services
5. **This plugin** updates post via Micropub with syndicated URLs
6. **Micropub Endpoint** removes `mp-syndicate-to` and adds `syndication` URLs

## Request/Response Formats

### Single Post Request
```http
POST /syndicate?source_url=https://example.com/posts/hello-world&token=YOUR_TOKEN
```

or

```http
POST /syndicate
Content-Type: application/json

{
  "syndication": {
    "source_url": "https://example.com/posts/hello-world",
    "redirect_uri": "/posts"
  },
  "access_token": "YOUR_TOKEN"
}
```

### Single Post Response
```json
{
  "success": "Post updated",
  "success_description": "Added syndication https://bsky.app/profile/user/post/123. The following target(s) did not return a URL: https://mastodon.social/@user"
}
```

### Batch Mode Request
```http
POST /syndicate?token=YOUR_TOKEN
```

### Batch Mode Response
```json
{
  "success": "OK",
  "success_description": "Processed 5 post(s): 4 succeeded, 1 failed",
  "results": [
    {
      "url": "https://example.com/posts/post-1",
      "success": true,
      "syndicatedUrls": [
        "https://bsky.app/profile/user/post/123",
        "https://mastodon.social/@user/456"
      ]
    },
    {
      "url": "https://example.com/posts/post-2",
      "success": true,
      "syndicatedUrls": ["https://bsky.app/profile/user/post/789"],
      "failedTargets": ["https://mastodon.social/@user"]
    },
    {
      "url": "https://example.com/posts/post-3",
      "success": false,
      "error": "Micropub update failed: 401 Unauthorized"
    }
  ]
}
```

### Netlify Webhook Request
```http
POST /syndicate
X-Webhook-Signature: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
Content-Type: application/json

{
  "url": "https://example.com",
  "build_id": "123456"
}
```

## Known Gotchas

### Webhook Signature vs Access Token
The token extraction logic has **three priority levels**:
1. Webhook signature (highest priority)
2. Access token in body
3. Token in query

If you pass both a webhook signature AND an access token, the webhook signature wins. This can cause unexpected behavior if the webhook signature is invalid but the access token is valid.

### Partial Syndication Handling
**Upstream bug:** Posts with existing `syndication` property were skipped, even if they had pending targets in `mp-syndicate-to`.

**Example scenario:**
- Post created with `mp-syndicate-to: ["https://bsky.app", "https://mastodon.social"]`
- First syndication run succeeds for Bluesky, adds `syndication: ["https://bsky.app/..."]`
- Post still has `mp-syndicate-to: ["https://mastodon.social"]` (failed target)
- **Upstream:** Second syndication run skips post (has `syndication` property)
- **This fork:** Second syndication run processes post (no `syndication` filter)

### Array vs String in mp-syndicate-to
The `mp-syndicate-to` property can be either:
- Array: `["https://bsky.app", "https://mastodon.social"]`
- String: `"https://bsky.app"`

**Upstream bug:** `Array.isArray` (function reference) was always truthy, so single strings were treated as arrays. This fork correctly checks `Array.isArray(syndicateTo)`.

### Failed Target Handling
When a syndicator returns `null` or throws an error:
- Target is added to `failedTargets` array
- Post is still updated via Micropub
- `mp-syndicate-to` is replaced with `failedTargets` (not deleted)
- Next syndication run will retry failed targets

### Micropub Update Behavior
The Micropub update request structure:
```javascript
{
  action: "update",
  url: postUrl,
  delete: ["mp-syndicate-to"],  // Only if ALL targets succeeded
  replace: {
    "mp-syndicate-to": failedTargets,  // Only if some targets failed
    syndication: syndicatedUrls        // Always (appends to existing)
  }
}
```

**Important:** If `failedTargets` exists, `mp-syndicate-to` is replaced (not deleted). This allows retry on next run.

### Rate Limiting in Batch Mode
Batch mode waits 2 seconds between posts to avoid rate limits on external services (Mastodon, Bluesky, etc.). This is hardcoded and not configurable.

**Math:** For 100 posts, batch mode takes ~3.5 minutes (2s × 100 + processing time).

### Draft Posts are Skipped
Both `getPostData()` and `getAllPostData()` filter out drafts:
```javascript
"properties.post-status": { $ne: "draft" }
```

If you want to syndicate drafts, you must remove this filter.

### No Localization
This plugin has no `locales/` directory. All messages are hardcoded in English.

## API Reference

### POST /syndicate

Syndicate post(s) to external services.

**Authentication:**
- Bearer token (via header, body, or query)
- OR Netlify webhook signature

**Query Parameters:**
- `source_url` (string, optional) - Specific post URL to syndicate
- `redirect_uri` (string, optional) - Redirect after success (must start with `/`)
- `token` (string, optional) - Bearer token

**Request Body (JSON):**
```json
{
  "syndication": {
    "source_url": "https://example.com/posts/hello-world",
    "redirect_uri": "/posts"
  },
  "access_token": "YOUR_TOKEN"
}
```

**Response:**
- **Single Post:** `{ success, success_description, ... }`
- **Batch Mode:** `{ success, success_description, results: [...] }`
- **No Targets:** `{ success: "OK", success_description: "No syndication targets have been configured" }`
- **No Posts:** `{ success: "OK", success_description: "No posts awaiting syndication" }`

## Dependencies

```json
{
  "@indiekit/error": "^1.0.0-beta.25",
  "express": "^5.0.0",
  "jsonwebtoken": "^9.0.0"
}
```

## Common Use Cases

### 1. Netlify Webhook (Auto-Syndicate After Deploy)

**Netlify Build Hook:**
```
POST https://yoursite.com/syndicate
X-Webhook-Signature: <JWT>
```

**Netlify Webhook Configuration:**
- Event: Deploy succeeded
- URL: `https://yoursite.com/syndicate`
- Webhook secret: Set in Netlify and `WEBHOOK_SECRET` env var

### 2. Manual Trigger from Admin UI

```html
<form method="POST" action="/syndicate">
  <input type="hidden" name="syndication[source_url]" value="{{ post.url }}">
  <input type="hidden" name="syndication[redirect_uri]" value="/posts">
  <input type="hidden" name="access_token" value="{{ token }}">
  <button type="submit">Syndicate Now</button>
</form>
```

### 3. Cron Job (Batch Syndication)

```bash
#!/bin/bash
# Daily batch syndication at 9am
0 9 * * * curl -X POST https://yoursite.com/syndicate?token=YOUR_TOKEN
```

### 4. GitHub Actions (Post-Deploy Syndication)

```yaml
- name: Syndicate posts
  run: |
    curl -X POST https://yoursite.com/syndicate \
      -H "Authorization: Bearer ${{ secrets.INDIEKIT_TOKEN }}"
```

## Debugging

### Enable Console Logging
Batch mode logs each post result:
```
[syndication] Batch processing 5 post(s)
[syndication] Syndicated: https://example.com/posts/post-1 (2 target(s))
[syndication] Failed: https://example.com/posts/post-2 - 401 Unauthorized
[syndication] Processed 5 post(s): 4 succeeded, 1 failed
```

### Check Post State in MongoDB
```javascript
db.posts.findOne({ "properties.url": "https://example.com/posts/hello-world" })
```

Look for:
- `properties.mp-syndicate-to` - Pending targets
- `properties.syndication` - Completed syndications
- `properties.post-status` - Must not be "draft"

### Verify Syndicator Plugins
```javascript
publication.syndicationTargets.forEach(target => {
  console.log(target.info.uid);  // e.g., "https://bsky.app/@username"
});
```

### Test Token Extraction
```bash
# Query token
curl -X POST https://yoursite.com/syndicate?token=YOUR_TOKEN

# Body token
curl -X POST https://yoursite.com/syndicate \
  -H "Content-Type: application/json" \
  -d '{"access_token": "YOUR_TOKEN"}'
```

## Migration from Upstream

If migrating from `@indiekit/endpoint-syndicate`:

1. **Install this fork:**
   ```bash
   npm uninstall @indiekit/endpoint-syndicate
   npm install @rmdes/indiekit-endpoint-syndicate
   ```

2. **Update imports:**
   ```javascript
   // Before
   import SyndicateEndpoint from "@indiekit/endpoint-syndicate";

   // After
   import SyndicateEndpoint from "@rmdes/indiekit-endpoint-syndicate";
   ```

3. **No config changes needed** - API is 100% backwards compatible

4. **Benefits:**
   - Partial syndication now works correctly
   - Batch mode for mass syndication
   - Fixed `Array.isArray` bug

## License

MIT

## Author

Ricardo Mendes - https://rmendes.net

## Repository

https://github.com/rmdes/indiekit-endpoint-syndicate

## Upstream

Fork of [@indiekit/endpoint-syndicate](https://github.com/getindiekit/indiekit/tree/main/packages/endpoint-syndicate) by Paul Lloyd.
