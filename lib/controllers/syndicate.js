import { IndiekitError } from "@indiekit/error";

import { findBearerToken } from "../token.js";
import {
  getAllPostData,
  getPostData,
  isPostReady,
  syndicateToTargets,
} from "../utils.js";

/**
 * Delay helper for rate limiting between posts
 * @param {number} ms - Milliseconds to wait
 * @returns {Promise<void>}
 */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Guards batch mode against overlapping runs.
 *
 * A post stays selectable until its Micropub update lands at the end of a
 * batch, so a second trigger arriving mid-batch sees `mp-syndicate-to` still
 * set and syndicates it again. Both triggers — the poller and the Eleventy
 * post-build hook — reach the same process, so a module-level flag is enough.
 * Anything skipped is picked up by the next poll.
 *
 * Batch mode only: the single-post force path (source_url) is deliberately
 * unguarded so manual re-syndication always runs.
 *
 * ponytail: single-process guard. If Indiekit is ever run multi-process or
 * multi-container, replace with an atomic per-post claim (findOneAndUpdate
 * setting a claim timestamp, with a stale-claim timeout).
 */
const batch = { isRunning: false };

/**
 * Syndicate a single post and update it via Micropub
 * @param {object} options - Options
 * @param {object} options.application - Application config
 * @param {object} options.publication - Publication config
 * @param {object} options.postData - Post data from database
 * @param {string} options.bearerToken - Bearer token for Micropub
 * @param {boolean} [options.force] - Force re-syndication (skip dedup)
 * @returns {Promise<object>} Result object
 */
const syndicatePost = async ({
  application,
  publication,
  postData,
  bearerToken,
  force = false,
}) => {
  // Readiness gate: verify post and OG image are live before syndicating.
  // Skip check in force mode (manual re-syndication from UI/backlog script).
  // Photo posts skip OG check — Eleventy deliberately skips OG generation
  // for posts with photos (the photo itself serves as og:image in HTML).
  const meUrl =
    typeof publication.me === "string"
      ? publication.me
      : publication.me?.href || publication.me?.toString?.() || "";
  const hasPhotos =
    Array.isArray(postData.properties?.photo) &&
    postData.properties.photo.length > 0;
  if (!force && meUrl && postData.properties?.url) {
    console.log(
      `[syndication] Readiness gate: checking ${postData.properties.url} (me=${meUrl}, hasPhotos=${hasPhotos})`,
    );
    const readiness = hasPhotos
      ? await isPostReady(postData.properties.url, meUrl, { skipOg: true })
      : await isPostReady(postData.properties.url, meUrl);
    if (!readiness.ready) {
      console.log(
        `[syndication] Skipping ${postData.properties.url} — not yet built ` +
          `(post: ${readiness.postStatus}, og: ${readiness.ogStatus})`,
      );
      return { skipped: true, url: postData.properties.url, readiness };
    }
  }

  const { failedTargets, syndicatedUrls } = await syndicateToTargets(
    publication,
    postData.properties,
    { force },
  );

  // Update post with syndicated URL(s) and remaining syndication target(s)
  const micropubResponse = await fetch(application.micropubEndpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${bearerToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      action: "update",
      url: postData.properties.url,
      ...(!failedTargets && { delete: ["mp-syndicate-to"] }),
      replace: {
        ...(failedTargets && { "mp-syndicate-to": failedTargets }),
        ...(syndicatedUrls && { syndication: syndicatedUrls }),
      },
    }),
  });

  if (!micropubResponse.ok) {
    throw await IndiekitError.fromFetch(micropubResponse);
  }

  /**
  @type {object}
   */
  const body = await micropubResponse.json();

  return {
    url: postData.properties.url,
    body,
    failedTargets,
    syndicatedUrls,
  };
};

export const syndicateController = {
  async post(request, response, next) {
    try {
      const { application, publication } = request.app.locals;
      const bearerToken = findBearerToken(request);
      const sourceUrl =
        request.query.source_url || request.body?.syndication?.source_url;
      const redirectUri =
        request.query.redirect_uri || request.body?.syndication?.redirect_uri;

      const postsCollection = application?.collections?.get("posts");
      if (!postsCollection) {
        throw IndiekitError.notImplemented(
          response.locals.__("NotImplementedError.database"),
        );
      }

      // Get syndication targets
      const { syndicationTargets } = publication;
      if (syndicationTargets.length === 0) {
        return response.json({
          success: "OK",
          success_description: "No syndication targets have been configured",
        });
      }

      // --- Single post mode (when source_url is provided) ---
      if (sourceUrl) {
        const postData = await getPostData(postsCollection, sourceUrl);

        if (!postData) {
          return response.json({
            success: "OK",
            success_description: `No post record available for ${sourceUrl}`,
          });
        }

        const result = await syndicatePost({
          application,
          publication,
          postData,
          bearerToken,
          force: true,
        });

        // Include failed syndication targets in response
        if (result.failedTargets) {
          result.body.success_description +=
            ". The following target(s) did not return a URL: " +
            result.failedTargets.join(" ");
        }

        if (redirectUri && redirectUri.startsWith("/")) {
          const message = encodeURIComponent(result.body.success_description);
          return response.redirect(`${redirectUri}?success=${message}`);
        }

        return response.json(result.body);
      }

      // --- Batch mode (no source_url — process ALL pending posts) ---
      if (batch.isRunning) {
        console.log("[syndication] Batch already in progress, skipping");
        return response.json({
          success: "OK",
          success_description: "Batch already in progress",
        });
      }

      batch.isRunning = true;

      try {
        const allPostData = await getAllPostData(postsCollection);

        if (!allPostData || allPostData.length === 0) {
          return response.json({
            success: "OK",
            success_description: "No posts awaiting syndication",
          });
        }

        console.log(
          `[syndication] Batch processing ${allPostData.length} post(s)`,
        );

        const results = [];

        for (const [index, postData] of allPostData.entries()) {
          try {
            const result = await syndicatePost({
              application,
              publication,
              postData,
              bearerToken,
            });

            // Post was skipped (not yet built)
            if (result.skipped) {
              results.push({
                url: result.url,
                success: true,
                skipped: true,
                reason: `Not yet built (post: ${result.readiness.postStatus}, og: ${result.readiness.ogStatus})`,
              });
              continue;
            }

            results.push({
              url: result.url,
              success: true,
              syndicatedUrls: result.syndicatedUrls,
              ...(result.failedTargets && {
                failedTargets: result.failedTargets,
              }),
            });

            console.log(
              `[syndication] Syndicated: ${result.url} (${result.syndicatedUrls.length} target(s))`,
            );
          } catch (error) {
            results.push({
              url: postData.properties?.url,
              success: false,
              error: error.message,
            });

            console.error(
              `[syndication] Failed: ${postData.properties?.url} - ${error.message}`,
            );
          }

          // Rate limit delay between posts (2 seconds)
          if (index < allPostData.length - 1) {
            await delay(2000);
          }
        }

        const failed = results.filter((result) => !result.success).length;
        const skipped = results.filter((result) => result.skipped).length;
        const succeeded = results.length - failed - skipped;
        const description = `Processed ${allPostData.length} post(s): ${succeeded} succeeded, ${failed} failed, ${skipped} not yet built`;

        console.log(`[syndication] ${description}`);

        return response.json({
          success: "OK",
          success_description: description,
          results,
        });
      } finally {
        batch.isRunning = false;
      }
    } catch (error) {
      next(error);
    }
  },
};
