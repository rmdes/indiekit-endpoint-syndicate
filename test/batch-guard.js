import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import express from "express";

import { syndicateController } from "../lib/controllers/syndicate.js";

const TARGET_UID = "https://bsky.app/profile/example.com";
const SYNDICATED_URL = "https://bsky.app/profile/example.com/post/xyz789";

/**
 * Listen on an ephemeral loopback port.
 * @param {object} server - HTTP server
 * @returns {Promise<string>} Origin the server is reachable on
 */
const listen = async (server) => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
};

/**
 * Stands in for the site being syndicated. One handler serves both roles:
 * the readiness gate only reads the status of its HEAD requests, and the
 * Micropub update only needs a 200 with a JSON body.
 * @returns {Promise<object>} Server handle and origin
 */
const startSite = async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ success_description: "Post updated" }));
  });
  return { server, origin: await listen(server) };
};

/**
 * Posts collection exposing the find().sort().toArray() chain that
 * getAllPostData() uses. Takes a thunk so a test can also make it throw.
 * @param {Function} toArray - Returns the documents, or throws
 * @returns {object} Collection stub
 */
const postsCollection = (toArray) => ({
  find: () => ({ sort: () => ({ toArray }) }),
});

/**
 * Syndication target that counts how many times it is asked to syndicate.
 * @param {number} [delayMs] - How long a syndication takes
 * @returns {object} Target and its call counter
 */
const countingTarget = (delayMs = 0) => {
  const calls = { count: 0 };
  return {
    calls,
    target: {
      info: { uid: TARGET_UID },
      options: { checked: true },
      async syndicate() {
        calls.count++;
        if (delayMs)
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        return SYNDICATED_URL;
      },
    },
  };
};

/**
 * Mount the real controller behind a real Express app.
 * @param {object} options - Fixture options
 * @returns {Promise<object>} Server handle, origin, and a request helper
 */
const startEndpoint = async ({ site, target, toArray }) => {
  const app = express();
  app.locals.application = {
    micropubEndpoint: `${site.origin}/micropub`,
    collections: new Map([["posts", postsCollection(toArray)]]),
  };
  app.locals.publication = { me: site.origin, syndicationTargets: [target] };
  app.post("/syndicate", syndicateController.post);
  // Swallow errors so a thrown batch returns a response instead of hanging.
  app.use((error, request, response, next) =>
    response.status(500).json({ error: error.message }),
  );

  const server = createServer(app);
  const origin = await listen(server);
  return {
    server,
    fire: () =>
      fetch(`${origin}/syndicate?token=test-token`, { method: "POST" }),
  };
};

/**
 * One pending post, ready to syndicate.
 * @param {string} origin - Site origin
 * @returns {Array} Post documents
 */
const onePendingPost = (origin) => [
  {
    properties: {
      url: `${origin}/notes/2026/09/02/abc12`,
      "mp-syndicate-to": [TARGET_UID],
    },
  },
];

test("two concurrent batch runs syndicate a post only once", async () => {
  const site = await startSite();
  // Slow enough that the second request arrives mid-flight, exactly as the
  // 2-minute poller and the Eleventy post-build hook do in production.
  const { target, calls } = countingTarget(300);
  const endpoint = await startEndpoint({
    site,
    target,
    toArray: async () => onePendingPost(site.origin),
  });

  try {
    const [a, b] = await Promise.all([endpoint.fire(), endpoint.fire()]);

    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(
      calls.count,
      1,
      `expected the post to syndicate once, got ${calls.count}`,
    );
  } finally {
    endpoint.server.close();
    site.server.close();
  }
});

test("the guard is released, so a later batch still runs", async () => {
  const site = await startSite();
  const { target, calls } = countingTarget();
  const endpoint = await startEndpoint({
    site,
    target,
    toArray: async () => onePendingPost(site.origin),
  });

  try {
    // Sequential, not concurrent — each must be allowed to run.
    await endpoint.fire();
    await endpoint.fire();

    assert.equal(
      calls.count,
      2,
      `sequential batches must both run, got ${calls.count}`,
    );
  } finally {
    endpoint.server.close();
    site.server.close();
  }
});

test("the guard is released when a batch throws", async () => {
  const site = await startSite();
  const { target } = countingTarget();
  let explode = true;
  const endpoint = await startEndpoint({
    site,
    target,
    toArray: async () => {
      if (explode) throw new Error("database unavailable");
      return [];
    },
  });

  try {
    await endpoint.fire(); // throws inside batch mode
    explode = false;

    const body = await (await endpoint.fire()).json();

    assert.notEqual(
      body.success_description,
      "Batch already in progress",
      "a thrown batch must not leave the guard stuck on",
    );
  } finally {
    endpoint.server.close();
    site.server.close();
  }
});
