// =============================================================================
// OpenNext configuration for Cloudflare Workers
// =============================================================================
//
// OpenNext is the adapter that turns a Next.js build into a Cloudflare
// Worker. This file picks the runtime overrides; everything else
// (routes, RSC, middleware) is handled automatically.
//
// Reference: https://opennext.js.org/cloudflare/get-started
// =============================================================================

import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default defineCloudflareConfig({
  // No overrides needed for our app. OpenNext's defaults:
  //   - Memory queue / cache for incremental cache (fine for our use)
  //   - Edge runtime for everything (fastest cold start)
  //
  // If we later want persistent ISR caching, swap incrementalCache to
  // an R2 or KV binding. Not needed at launch — we have no ISR pages.
});
