/**
 * Get post data for a single post
 * @param {object} postsCollection - Posts database collection
 * @param {string} url - URL of existing post (optional)
 * @returns {Promise<object>} Post data for given URL else most recent pending post
 */
export const getPostData = async (postsCollection, url) => {
  let postData = {};

  if (url) {
    // Get item in database with matching URL
    postData = await postsCollection.findOne({
      "properties.url": url,
    });
  } else {
    // Get most recent published post awaiting syndication
    const items = await postsCollection
      .find({
        "properties.mp-syndicate-to": {
          $exists: true,
        },
        // BUG FIX: Removed "properties.syndication": { $exists: false }
        // That filter skipped partially syndicated posts (e.g., posted to
        // Mastodon but not yet to Bluesky). syndicateToTargets() already
        // calls hasSyndicationUrl() to skip completed targets.
        "properties.post-status": {
          $ne: "draft",
        },
      })
      // eslint-disable-next-line unicorn/no-array-sort
      .sort({ "properties.published": -1 })
      .limit(1)
      .toArray();
    postData = items[0];
  }

  return postData;
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
    // eslint-disable-next-line unicorn/no-array-sort
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

    const targetOrigin = new URL(target.info.uid).origin;
    const syndicateToOrigin = new URL(syndicateTo).origin;
    return targetOrigin === syndicateToOrigin;
  });
};

/**
 * Syndicate URLs to configured syndication targets
 * @param {object} publication - Publication configuration
 * @param {object} properties - JF2 properties
 * @returns {Promise<object>} Syndication target
 */
export const syndicateToTargets = async (publication, properties) => {
  const { syndicationTargets } = publication;
  const syndicateTo = properties["mp-syndicate-to"];
  // BUG FIX: Was `Array.isArray` (always truthy, it's a function reference)
  // Now correctly passes syndicateTo as the argument
  const syndicateToUrls = Array.isArray(syndicateTo)
    ? syndicateTo
    : [syndicateTo];
  const syndicatedUrls = properties.syndication || [];
  const failedTargets = [];

  for (const url of syndicateToUrls) {
    const target = getSyndicationTarget(syndicationTargets, url);
    const alreadySyndicated = hasSyndicationUrl(syndicatedUrls, url);

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
        console.error(error.message);
      }
    }
  }

  return {
    ...(failedTargets.length > 0 && { failedTargets }),
    syndicatedUrls,
  };
};
