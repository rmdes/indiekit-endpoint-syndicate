import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import express from "express";

import { syndicateController } from "../lib/controllers/syndicate.js";

/**
 * Stand-in for the site being syndicated. Answers HEAD for the readiness
 * gate and POST for the Micropub update.
 * @returns {Promise<object>} Server handle, origin, and captured updates
 */
const startSite = async () => {
  const updates = [];
  const server = createServer((request, response) => {
    if (request.method === "POST") {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        updates.push(body);
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ success_description: "Post updated" }));
      });
      return;
    }
    response.writeHead(200).end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}`, updates };
};

/**
 * Minimal posts collection exposing the find().sort().toArray() chain
 * getAllPostData() uses.
 * @param {Array} docs - Documents to return
 * @returns {object} Collection stub
 */
const postsCollection = (docs) => ({
  find: () => ({ sort: () => ({ toArray: async () => docs }) }),
});

/**
 * Mount the real controller behind a real Express app.
 * @param {object} options - Test fixture options
 * @returns {Promise<object>} App server handle and its origin
 */
const startEndpoint = async ({ application, publication }) => {
  const app = express();
  app.locals.application = application;
  app.locals.publication = publication;
  app.post("/syndicate", syndicateController.post);

  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
};

test("two concurrent batch runs syndicate a post only once", async () => {
  const site = await startSite();
  const postUrl = `${site.origin}/notes/2026/09/02/abc12`;

  let syndicateCalls = 0;
  const target = {
    info: { uid: "https://bsky.app/profile/example.com" },
    options: { checked: true },
    async syndicate() {
      syndicateCalls++;
      // Slow enough that a second request arrives mid-flight, exactly as the
      // 2-minute poller and the Eleventy post-build hook do in production.
      await new Promise((resolve) => setTimeout(resolve, 300));
      return "https://bsky.app/profile/example.com/post/xyz789";
    },
  };

  const endpoint = await startEndpoint({
    application: {
      micropubEndpoint: `${site.origin}/micropub`,
      collections: new Map([
        [
          "posts",
          postsCollection([
            {
              properties: {
                url: postUrl,
                "mp-syndicate-to": [target.info.uid],
              },
            },
          ]),
        ],
      ]),
    },
    publication: { me: site.origin, syndicationTargets: [target] },
  });

  try {
    const fire = () =>
      fetch(`${endpoint.origin}/syndicate?token=test-token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });

    // Both in flight at once — neither has written back when the other starts.
    const [a, b] = await Promise.all([fire(), fire()]);

    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(
      syndicateCalls,
      1,
      `expected the post to syndicate once, got ${syndicateCalls}`,
    );
  } finally {
    endpoint.server.close();
    site.server.close();
  }
});
