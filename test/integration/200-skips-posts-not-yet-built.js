import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";

import { testDatabase } from "@indiekit-test/database";
import { mockAgent } from "@indiekit-test/mock-agent";
import { testServer } from "@indiekit-test/server";
import { testToken } from "@indiekit-test/token";
import supertest from "supertest";

// Fork-only. The readiness gate is the reason this fork exists in its current
// shape: syndicating a post before the static site has rebuilt gives followers
// a link that 404s, and a card that never loads. `isPostReady` GETs the post
// URL first and reports the post as skipped when it is not yet live.
//
// No intercept is added for https://website.example here, and the mock agent
// disables net connect, so the readiness GET fails and the gate stays closed —
// which is precisely the unbuilt case. A gate that silently stopped opening
// would block all syndication, so its sibling
// (200-syndicates-all-posts-awaiting-syndication.js) asserts the open case.
await mockAgent("endpoint-syndicate");
const { client, mongoServer, mongoUri } = await testDatabase();
const server = await testServer({
  application: { mongodbUrl: mongoUri },
  plugins: ["@indiekit/syndicator-mastodon"],
});
const request = supertest.agent(server);

describe("endpoint-syndicate POST /syndicate (post not yet built)", () => {
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

  it("Skips posts that are not live yet, rather than syndicating them", async () => {
    const result = await request
      .post("/syndicate")
      .query({ token: testToken() })
      .set("accept", "application/json");

    assert.equal(result.status, 200);
    assert.equal(
      result.body.success_description,
      "Processed 2 post(s): 0 succeeded, 0 failed, 2 not yet built",
    );
    assert.deepEqual(
      result.body.results.map((post) => post.skipped),
      [true, true],
    );
  });

  it("Leaves them awaiting syndication, so a later run retries them", async () => {
    const result = await request
      .post("/syndicate")
      .query({ token: testToken() })
      .set("accept", "application/json");

    assert.equal(
      result.body.success_description,
      "Processed 2 post(s): 0 succeeded, 0 failed, 2 not yet built",
    );
  });

  after(async () => {
    await client.close();
    await mongoServer.stop();
    server.close((error) => process.exit(error ? 1 : 0));
  });
});
