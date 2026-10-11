import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { testDatabase } from "@indiekit-test/database";
import { mockAgent } from "@indiekit-test/mock-agent";
import { testServer } from "@indiekit-test/server";
import { testToken } from "@indiekit-test/token";
import { getGlobalDispatcher } from "@indiekit-test/undici";
import jwt from "jsonwebtoken";
import supertest from "supertest";

// Fork override of upstream's test. A webhook with no source_url takes the
// batch path, so the response reports counts ("Processed N post(s): …") rather
// than upstream's "Syndicated 1 post", and the readiness gate applies. The post
// URL is replied to with a page declaring no og:image so the gate opens; see
// 200-skips-posts-not-yet-built.js for the closed case.
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
    process.env.SECRET = "secret";
    process.env.WEBHOOK_SECRET = "webhook-secret";

    await request
      .post("/micropub")
      .auth(testToken(), { type: "bearer" })
      .set("accept", "application/json")
      .send("h=entry")
      .send("name=foobar")
      .send("mp-syndicate-to=https://mastodon.example/@username");
  });

  it("Syndicates recent post (via Netlify webhook)", async () => {
    const sha256 = createHash("sha256").update("foo").digest("hex");
    const result = await request
      .post("/syndicate")
      .set("accept", "application/json")
      .set(
        "x-webhook-signature",
        jwt.sign({ iss: "netlify", sha256 }, process.env.WEBHOOK_SECRET),
      )
      .send({ url: "https://website.example" });

    assert.equal(result.status, 200);
    assert.equal(
      result.body.success_description,
      "Processed 1 post(s): 1 succeeded, 0 failed, 0 not yet built",
    );
    // Batch results carry the syndicated URLs per post, where upstream
    // reported a `success_description` sentence per post instead.
    assert.deepEqual(result.body.results, [
      {
        url: "https://website.example/notes/foobar/",
        success: true,
        syndicatedUrls: [
          "https://mastodon.example/@username/1234567890987654321",
        ],
      },
    ]);
  });

  after(async () => {
    await client.close();
    await mongoServer.stop();
    server.close((error) => process.exit(error ? 1 : 0));
  });
});
