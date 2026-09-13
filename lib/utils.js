/**
 * Get post data for a single post
 * @param {object} postsCollection - Posts database collection
 * @param {string} url - URL of existing post (optional)
 * @returns {Promise<object>} Post data for given URL else oldest post awaiting syndication
 */
export const getPostData = async (postsCollection, url) => {
  if (url) {
    return postsCollection.findOne({
      "properties.url": url,
    });
  }

  // A post is awaiting syndication while `mp-syndicate-to` remains: it is
  // deleted once every target has returned a URL, and replaced with the
  // targets that failed otherwise. Posts already syndicated to some of their
  // targets are therefore still awaiting the rest, and `syndicateToTargets`
  // skips the ones already done. Oldest first, so a backlog is syndicated in
  // the order it was published.
  const items = await postsCollection
    .find({
      "properties.mp-syndicate-to": {
        $exists: true,
      },
      "properties.post-status": {
        $ne: "draft",
      },
    })
    .sort({ "properties.published": 1 })
    .limit(1)
    .toArray();

  return items[0];
};

/**
 * Get ALL posts awaiting syndication (batch mode)
 * @param {object} postsCollection - Posts database collection
 * @returns {Promise<Array>} Array of post data objects
 */
export const getAllPostData = async (postsCollection) => {
  const items = await postsCollection
    .find({
      "properties.mp-syndicate-to": {
        $exists: true,
      },
      // No syndication filter — let syndicateToTargets() handle dedup
      "properties.post-status": {
        $ne: "draft",
      },
    })

    .sort({ "properties.published": -1 })
    .toArray();

  return items;
};

/**
 * Check if target already returned a syndication URL
 * @param {Array} syndicatedUrls - Syndication URLs
 * @param {string} syndicateTo - Syndication target
 * @returns {boolean} Target returned a syndication URL
 */
export const hasSyndicationUrl = (syndicatedUrls, syndicateTo) => {
  return syndicatedUrls.some((url) => {
    // `syndication` is stored as given, so may hold values that aren’t URLs
    if (!URL.canParse(url)) {
      return false;
    }

    const { origin } = new URL(url);
    return syndicateTo.includes(origin);
  });
};

/**
 * Get syndication target for syndication URL
 * @param {Array} syndicationTargets - Publication syndication targets
 * @param {string} syndicateTo - Syndication URL
 * @returns {object|undefined} Publication syndication target
 */
export const getSyndicationTarget = (syndicationTargets, syndicateTo) => {
  return syndicationTargets.find((target) => {
    if (!target?.info?.uid) {
      return;
    }

    try {
      const targetOrigin = new URL(target.info.uid).origin;
      const syndicateToOrigin = new URL(syndicateTo).origin;
      return targetOrigin === syndicateToOrigin;
    } catch {
      // syndicateTo or target uid is not a valid URL
      return false;
    }
  });
};

/**
 * Syndicate URLs to configured syndication targets
 * @param {object} publication - Publication configuration
 * @param {object} properties - JF2 properties
 * @param {object} [options] - Options
 * @param {boolean} [options.force] - Force re-syndication (skip dedup check)
 * @returns {Promise<object>} Syndication target
 */
export const syndicateToTargets = async (
  publication,
  properties,
  { force = false } = {},
) => {
  const { syndicationTargets } = publication;
  let syndicateTo = properties["mp-syndicate-to"];

  // In force mode with no mp-syndicate-to, re-syndicate only to targets that
  // were previously used (matched by origin against existing syndication URLs).
  // This prevents re-syndication from sending to ALL targets when the user
  // clicks "Syndicate" on an already-syndicated post.
  if (!syndicateTo && force) {
    const existingSyndication = properties.syndication || [];
    if (existingSyndication.length > 0) {
      // Extract origins from existing syndication URLs and match against targets
      const existingOrigins = new Set(
        existingSyndication.flatMap((url) => {
          try {
            return [new URL(url).origin];
          } catch {
            return [];
          }
        }),
      );
      syndicateTo = syndicationTargets
        .filter((t) => {
          try {
            return (
              t?.info?.uid && existingOrigins.has(new URL(t.info.uid).origin)
            );
          } catch {
            return false;
          }
        })
        .map((t) => t.info.uid);
    } else {
      // Fall back to targets marked as checked by default
      syndicateTo = syndicationTargets
        .filter((t) => t?.options?.checked)
        .map((t) => t.info.uid);
    }
  }

  // BUG FIX: Was `Array.isArray` (always truthy, it's a function reference)
  // Now correctly passes syndicateTo as the argument
  const syndicateToUrls = Array.isArray(syndicateTo)
    ? syndicateTo
    : syndicateTo
      ? [syndicateTo]
      : [];

  // In force mode, remove old syndication URLs for targets being re-syndicated
  // but keep URLs for other targets (e.g. keep Mastodon URL when re-syndicating Bluesky)
  let syndicatedUrls = [...(properties.syndication || [])];
  if (force) {
    syndicatedUrls = syndicatedUrls.filter((existingUrl) => {
      try {
        const existingOrigin = new URL(existingUrl).origin;
        // Keep URL if its origin doesn't match any target being re-syndicated
        return !syndicateToUrls.some((targetUrl) => {
          try {
            return targetUrl.includes(existingOrigin);
          } catch {
            return false;
          }
        });
      } catch {
        return true;
      }
    });
  }
  const failedTargets = [];

  console.info(
    `[syndication] syndicateToTargets:`,
    JSON.stringify({
      syndicateToUrls,
      configuredTargets: syndicationTargets.map((t) => t.info?.uid),
      postUrl: properties.url,
    }),
  );

  for (const url of syndicateToUrls) {
    const target = getSyndicationTarget(syndicationTargets, url);
    const alreadySyndicated = !force && hasSyndicationUrl(syndicatedUrls, url);

    console.info(
      `[syndication] Target ${url}: found=${!!target}, alreadySyndicated=${alreadySyndicated}`,
    );

    if (target && !alreadySyndicated) {
      try {
        const syndicatedUrl = await target.syndicate(properties, publication);

        if (syndicatedUrl) {
          // Add syndicated URL to list of syndicated URLs
          syndicatedUrls.push(syndicatedUrl);
        } else {
          // Add failed syndication target to list of failed targets
          failedTargets.push(target.info.uid);
        }
      } catch (error) {
        // Add failed syndication target to list of failed targets
        failedTargets.push(target.info.uid);
        console.error(error);
      }
    }
  }

  return {
    ...(failedTargets.length > 0 && { failedTargets }),
    syndicatedUrls,
  };
};


/**
 * HEAD a URL and report its status, 0 on network error or timeout
 * @param {string} url - URL to check
 * @returns {Promise<number>} HTTP status
 */
const headCheck = async (url) => {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return response.status;
  } catch {
    return 0;
  }
};

/**
 * GET a page and return its status plus the og:image it declares.
 * @param {string} url - Page URL
 * @returns {Promise<{status: number, ogImage: string|undefined}>}
 */
const fetchOgImage = async (url) => {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(url, { redirect: "follow", signal: controller.signal });
    clearTimeout(timeoutId);
    if (response.status !== 200) return { status: response.status };
    const html = await response.text();
    const match = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/);
    return { status: 200, ogImage: match?.[1] };
  } catch {
    return { status: 0 };
  }
};

/**
 * Check if a post and its OG card are live on the public site.
 *
 * Reads the og:image the POST ITSELF declares rather than re-deriving its
 * filename. The removed helper's own docstring said "Matches Eleventy theme's
 * ogSlug filter logic" — a hand-copied convention from another repo, and on
 * 2026-09-13 that convention changed: the theme added the post type to the
 * cache key so a like and a reply sharing a basename stop colliding. This gate
 * kept asking for the old type-less name, got 404 for cards that were
 * demonstrably live, and silently blocked syndication for every new post.
 *
 * Reading the page removes the coupling: whatever the page says its card is, we
 * check that. It also makes `skipOg` unnecessary in principle — a photo post
 * declares its photo as og:image and that HEADs the same way — though the flag
 * is kept for callers that still pass it.
 *
 * Costs one GET instead of one HEAD, for posts awaiting syndication only.
 * @param {string} postUrl - Full public URL of the post
 * @param {string} me - Publication URL (no longer used to build the card URL; kept for the signature)
 * @param {object} [options] - Options
 * @param {boolean} [options.skipOg] - Don't wait on any og:image
 * @returns {Promise<{ready: boolean, postStatus: number, ogStatus: number}>}
 */
export async function isPostReady(postUrl, me, options = {}) {
  const { skipOg = false } = options;
  const { status: postStatus, ogImage } = await fetchOgImage(postUrl);

  if (postStatus !== 200) {
    return { ready: false, postStatus, ogStatus: 0 };
  }
  // No card declared (or explicitly skipped) → nothing to wait for.
  if (skipOg || !ogImage) {
    return { ready: true, postStatus, ogStatus: 200 };
  }

  const ogStatus = await headCheck(ogImage);
  return { ready: ogStatus === 200, postStatus, ogStatus };
}

