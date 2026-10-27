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
 * Stands in for the site: an introspection endpoint that knows a few tokens,
 * and a Micropub endpoint (and readiness gate) that answers 200 to the rest.
 * @returns {Promise<object>} Server handle and origin
 */
const startSite = async () => {
  const site = {};
  const tokens = () => ({
    "update-token": { active: true, me: `${site.origin}/`, scope: "update" },
    "create-token": { active: true, me: site.origin, scope: "create media" },
    "other-me-token": {
      active: true,
      me: "https://attacker.example",
      scope: "update",
    },
  });

  site.server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    response.writeHead(200, { "content-type": "application/json" });

    if (request.url === "/introspect") {
      const token = new URLSearchParams(body).get("token");
      return response.end(
        JSON.stringify(tokens()[token] || { active: false }),
      );
    }

    response.end(JSON.stringify({ success_description: "Post updated" }));
  });
  site.origin = await listen(site.server);
  return site;
};

/**
 * Syndication target that counts how many times it is asked to syndicate.
 * @returns {object} Target and its call counter
 */
const countingTarget = () => {
  const calls = { count: 0 };
  return {
    calls,
    target: {
      info: { uid: TARGET_UID },
      options: { checked: true },
      async syndicate() {
        calls.count++;
        return SYNDICATED_URL;
      },
    },
  };
};

/**
 * Mount the real controller behind a real Express app.
 * @param {object} options - Fixture options
 * @param {object} options.site - Site fixture
 * @param {object} options.target - Syndication target
 * @param {Array} options.posts - Post documents
 * @returns {Promise<object>} Server handle and a request helper
 */
const startEndpoint = async ({ site, target, posts }) => {
  const app = express();
  // @ts-expect-error — a partial application is all the controller reads
  app.locals.application = {
    introspectionEndpoint: `${site.origin}/introspect`,
    micropubEndpoint: `${site.origin}/micropub`,
    collections: new Map([
      [
        "posts",
        {
          find: () => ({ sort: () => ({ toArray: async () => posts }) }),
          // Honours only the filters getPostData() sends, so the test
          // fails if the query stops excluding drafts.
          findOne: async (query) => {
            const excluded = query["properties.post-status"]?.$ne;
            return (
              posts.find(
                (post) =>
                  post.properties.url === query["properties.url"] &&
                  (!excluded || post.properties["post-status"] !== excluded),
              ) || null
            );
          },
        },
      ],
    ]),
  };
  // @ts-expect-error — likewise a partial publication
  app.locals.publication = { me: site.origin, syndicationTargets: [target] };
  app.use((request, response, next) => {
    response.locals.__ = (key) => key;
    next();
  });
  app.post("/syndicate", syndicateController.post);
  app.use((error, request, response, next) =>
    response.status(error.status || 500).json({ error: error.message }),
  );

  const server = createServer(app);
  const origin = await listen(server);
  return {
    server,
    fire: (query) =>
      fetch(`${origin}/syndicate?${new URLSearchParams(query)}`, {
        method: "POST",
        redirect: "manual",
      }),
  };
};

/**
 * Run a test against a fresh site and endpoint, closing both afterwards.
 * @param {Array} posts - Post documents, given the site origin
 * @param {(fixture: object) => Promise<void>} run - Test body
 * @returns {Promise<void>}
 */
const withEndpoint = async (posts, run) => {
  const site = await startSite();
  const { target, calls } = countingTarget();
  const endpoint = await startEndpoint({
    site,
    target,
    posts: posts(site.origin),
  });
  try {
    await run({ site, endpoint, calls });
  } finally {
    endpoint.server.close();
    site.server.close();
  }
};

const pendingPost = (origin, properties = {}) => ({
  properties: {
    url: `${origin}/notes/2026/10/27/abc12`,
    "mp-syndicate-to": [TARGET_UID],
    ...properties,
  },
});

for (const [name, query] of [
  ["batch mode", {}],
  ["single post mode", { source_url: "SOURCE" }],
]) {
  for (const [token, status] of [
    ["not-a-real-token", 401],
    ["create-token", 403],
    ["other-me-token", 403],
  ]) {
    test(`${name}: ${token} is rejected before any target is contacted`, () =>
      withEndpoint(
        (origin) => [pendingPost(origin)],
        async ({ site, endpoint, calls }) => {
          const response = await endpoint.fire({
            ...query,
            ...(query.source_url && {
              source_url: `${site.origin}/notes/2026/10/27/abc12`,
            }),
            token,
          });

          assert.equal(response.status, status);
          assert.equal(calls.count, 0, "target must not be contacted");
        },
      ));
  }
}

test("a request without a token is rejected", () =>
  withEndpoint(
    (origin) => [pendingPost(origin)],
    async ({ endpoint, calls }) => {
      const response = await endpoint.fire({});

      assert.equal(response.status, 400);
      assert.equal(calls.count, 0);
    },
  ));

test("an update-scoped token for this publication syndicates", () =>
  withEndpoint(
    (origin) => [pendingPost(origin)],
    async ({ site, endpoint, calls }) => {
      const response = await endpoint.fire({
        source_url: `${site.origin}/notes/2026/10/27/abc12`,
        token: "update-token",
      });

      assert.equal(response.status, 200);
      assert.equal(calls.count, 1);
    },
  ));

test("a draft named by source_url is not syndicated", () =>
  withEndpoint(
    (origin) => [pendingPost(origin, { "post-status": "draft" })],
    async ({ site, endpoint, calls }) => {
      const response = await endpoint.fire({
        source_url: `${site.origin}/notes/2026/10/27/abc12`,
        token: "update-token",
      });

      assert.equal(response.status, 200);
      assert.equal(calls.count, 0, "a draft must not be syndicated");
    },
  ));

for (const redirectUri of ["//attacker.example", "/\\attacker.example"]) {
  test(`redirect_uri ${redirectUri} is refused`, () =>
    withEndpoint(
      (origin) => [pendingPost(origin)],
      async ({ site, endpoint, calls }) => {
        const response = await endpoint.fire({
          source_url: `${site.origin}/notes/2026/10/27/abc12`,
          token: "update-token",
          redirect_uri: redirectUri,
        });

        assert.equal(response.status, 403);
        assert.equal(calls.count, 0, "refused before anything is syndicated");
      },
    ));
}

test("a local redirect_uri is followed", () =>
  withEndpoint(
    (origin) => [pendingPost(origin)],
    async ({ site, endpoint }) => {
      const response = await endpoint.fire({
        source_url: `${site.origin}/notes/2026/10/27/abc12`,
        token: "update-token",
        redirect_uri: "/posts/abc12",
      });

      assert.equal(response.status, 302);
      assert.match(response.headers.get("location"), /^\/posts\/abc12\?success=/);
    },
  ));
