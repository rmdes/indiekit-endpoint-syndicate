import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import express from "express";

import { syndicateController } from "../lib/controllers/syndicate.js";

/**
 * Stand-in for the site being syndicated.
 * @returns {Promise<object>} Server handle and origin
 */
const startSite = async () => {
  const server = createServer((request, response) => {
    if (request.method === "POST") {
      request.on("data", () => {});
      request.on("end", () => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ success_description: "Post updated" }));
      });
      return;
    }
    response.writeHead(200).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
};

/**
 * Mount the real controller behind a real Express app.
 * @param {object} locals - Application and publication locals
 * @returns {Promise<object>} Server handle and origin
 */
const startEndpoint = async ({ application, publication }) => {
  const app = express();
  app.locals.application = application;
  app.locals.publication = publication;
  app.post("/syndicate", syndicateController.post);
  // Swallow errors so a thrown batch returns a response instead of hanging.
  app.use((error, request, response, next) =>
    response.status(500).json({ error: error.message }),
  );

  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
};

test("the guard is released, so a later batch still runs", async () => {
  const site = await startSite();
  const postUrl = `${site.origin}/notes/2026/09/02/def34`;

  let syndicateCalls = 0;
  const target = {
    info: { uid: "https://bsky.app/profile/example.com" },
    options: { checked: true },
    async syndicate() {
      syndicateCalls++;
      return "https://bsky.app/profile/example.com/post/xyz789";
    },
  };

  const endpoint = await startEndpoint({
    application: {
      micropubEndpoint: `${site.origin}/micropub`,
      collections: new Map([
        [
          "posts",
          {
            find: () => ({
              sort: () => ({
                toArray: async () => [
                  {
                    properties: {
                      url: postUrl,
                      "mp-syndicate-to": [target.info.uid],
                    },
                  },
                ],
              }),
            }),
          },
        ],
      ]),
    },
    publication: { me: site.origin, syndicationTargets: [target] },
  });

  try {
    const fire = () =>
      fetch(`${endpoint.origin}/syndicate?token=test-token`, { method: "POST" });

    // Sequential, not concurrent — each must be allowed to run.
    await fire();
    await fire();

    assert.equal(
      syndicateCalls,
      2,
      `sequential batches must both run, got ${syndicateCalls}`,
    );
  } finally {
    endpoint.server.close();
    site.server.close();
  }
});

test("the guard is released when a batch throws", async () => {
  const site = await startSite();
  let explode = true;

  const target = {
    info: { uid: "https://bsky.app/profile/example.com" },
    options: { checked: true },
    async syndicate() {
      return "https://bsky.app/profile/example.com/post/xyz789";
    },
  };

  const endpoint = await startEndpoint({
    application: {
      micropubEndpoint: `${site.origin}/micropub`,
      collections: new Map([
        [
          "posts",
          {
            find: () => ({
              sort: () => ({
                toArray: async () => {
                  if (explode) throw new Error("database unavailable");
                  return [];
                },
              }),
            }),
          },
        ],
      ]),
    },
    publication: { me: site.origin, syndicationTargets: [target] },
  });

  try {
    const fire = () =>
      fetch(`${endpoint.origin}/syndicate?token=test-token`, { method: "POST" });

    await fire(); // throws inside batch mode
    explode = false;

    const body = await (await fire()).json();

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
