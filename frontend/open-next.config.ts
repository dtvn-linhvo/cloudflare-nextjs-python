import { defineCloudflareConfig } from "@opennextjs/cloudflare";

/**
 * Không khai incrementalCache: app này không dùng ISR (mọi API route là
 * force-dynamic, không có revalidate ở đâu), nên không cần R2 cache bucket.
 *
 * Template OpenNext mặc định bật r2IncrementalCache, và nó đòi một R2 binding
 * tên NEXT_INC_CACHE_R2_BUCKET — thiếu binding đó thì bước populate-cache lúc
 * deploy sẽ fail.
 */
export default defineCloudflareConfig();
