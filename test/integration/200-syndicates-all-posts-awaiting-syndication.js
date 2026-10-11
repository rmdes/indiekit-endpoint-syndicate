import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";

import { testDatabase } from "@indiekit-test/database";
import { mockAgent } from "@indiekit-test/mock-agent";
import { testServer } from "@indiekit-test/server";
import { testToken } from "@indiekit-test/token";
import { getGlobalDispatcher } from "@indiekit-test/undici";
import supertest from "supertest";

// Fork override of upstream's test. This fork gates syndication on the post
// being live: `syndicatePost` calls `isPostReady`, which GETs the post URL and
// HEADs any og:image the page declares, and skips the post otherwise. So the
// batch response reports counts ("Processed N post(s): …") rather than
// upstream's "Syndicated N posts", and upstream's version of this test fails on
// that string before it ever reaches its ordering assertion.
//
// That mattered: the ordering assertion was the one catching a real bug. Batch
// mode used a second copy of the query that sorted `published: -1`, so a
// backlog syndicated newest first and landed on the timeline in reverse. Both
// callers now share one oldest-first query, and the assertion below is what
// holds it there.
//
// `200-skips-posts-not-yet-built.js` covers the gate closed; here it is opened
// by replying to the post URL with a page that declares no og:image, so the
// readiness check passes on the GET alone.
await mockAgent("endpoint-syndicate");
getGlobalDispatcher()
  .get("https://website.example")
  .intercept({ path: /^\/notes\//, method: "GET" })
  .reply(200, "<!doctype html><html><head></head><body></body></html>", {
    headers: { "content-type": "text/html" },
  })
  .persist();

const { client, mongoServer, mongoUri } = await testDatabase();
const server = await testServer({
  application: { mongodbUrl: mongoUri },
  plugins: ["@indiekit/syndicator-mastodon"],
});
const request = supertest.agent(server);

describe("endpoint-syndicate POST /syndicate", () => {
  before(async () => {
    for (const name of ["foo", "bar"]) {
      await request
        .post("/micropub")
        .auth(testToken(), { type: "bearer" })
        .set("accept", "application/json")
        .send("h=entry")
        .send(`name=${name}`)
        .send("mp-syndicate-to=https://mastodon.example/@username");
    }
  });

  it("Syndicates every post awaiting syndication, oldest first", async () => {
    const result = await request
      .post("/syndicate")
      .query({ token: testToken() })
      .set("accept", "application/json");

    assert.equal(result.status, 200);
    assert.equal(
      result.body.success_description,
      "Processed 2 post(s): 2 succeeded, 0 failed, 0 not yet built",
    );
    assert.deepEqual(
      result.body.results.map((post) => post.url),
      [
        "https://website.example/notes/foo/",
        "https://website.example/notes/bar/",
      ],
    );
  });

  it("Has nothing left to syndicate afterwards", async () => {
    const result = await request
      .post("/syndicate")
      .query({ token: testToken() })
      .set("accept", "application/json");

    assert.equal(
      result.body.success_description,
      "No posts awaiting syndication",
    );
  });

  after(async () => {
    await client.close();
    await mongoServer.stop();
    server.close((error) => process.exit(error ? 1 : 0));
  });
});
