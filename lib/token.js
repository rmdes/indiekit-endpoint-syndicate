import process from "node:process";

import { IndiekitError } from "@indiekit/error";
import jwt from "jsonwebtoken";

export const findBearerToken = (request) => {
  if (request.headers?.["x-webhook-signature"] && request.body?.url) {
    const signature = request.headers["x-webhook-signature"];
    const verifiedToken = verifyToken(signature);
    const bearerToken = signToken(verifiedToken, request.body.url);
    return bearerToken;
  }

  if (request.body?.access_token) {
    const bearerToken = request.body.access_token;
    delete request.body.access_token;
    return bearerToken;
  }

  if (request.query?.token) {
    const bearerToken = request.query.token;
    return bearerToken;
  }

  throw IndiekitError.invalidRequest("No bearer token provided by request");
};

/**
 * Generate short-lived bearer token with update scope
 * @param {object} verifiedToken - JSON Web Token
 * @param {string} url - Publication URL
 * @returns {string} Signed JSON Web Token
 */
export const signToken = (verifiedToken, url) =>
  jwt.sign(
    {
      me: url,
      scope: "update",
    },
    process.env.SECRET,
    {
      expiresIn: "10m",
    },
  );

/**
 * Verify that token provided by signature was issued by Netlify
 * @param {string} signature - JSON Web Signature
 * @returns {object} JSON Web Token
 * @see {@link https://docs.netlify.com/site-deploys/notifications/#payload-signature}
 */
export const verifyToken = (signature) =>
  jwt.verify(signature, process.env.WEBHOOK_SECRET, {
    algorithms: ["HS256"],
    issuer: ["netlify"],
  });

/**
 * Normalise a URL so `https://example.com` and `https://example.com/` match
 * @param {string} url - URL
 * @returns {string} URL without trailing slash
 */
const canonicalUrl = (url) => new URL(String(url)).href.replace(/\/$/, "");

/**
 * Verify bearer token before anything is syndicated
 *
 * This route is public, so nothing upstream of the controller checks the
 * token. Syndication sends posts to third-party accounts using stored
 * credentials, so the token must be checked first: the Micropub update that
 * follows would reject a bad token only after the posts had gone out.
 * @param {object} options - Options
 * @param {string} options.introspectionEndpoint - Introspection endpoint
 * @param {string} options.me - Publication URL
 * @param {string} options.bearerToken - Bearer token
 * @param {Function} options.__ - Localisation function
 * @returns {Promise<object>} Verified token values
 * @see {@link https://www.rfc-editor.org/rfc/rfc7662#section-2.1}
 */
export const verifyBearerToken = async ({
  introspectionEndpoint,
  me,
  bearerToken,
  __,
}) => {
  // Send the token in the request body, never the URL
  const introspectionResponse = await fetch(introspectionEndpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ token: bearerToken }),
  });

  if (!introspectionResponse.ok) {
    throw await IndiekitError.fromFetch(introspectionResponse);
  }

  const tokenValues = await introspectionResponse.json();

  if (!tokenValues.active || !tokenValues.me) {
    throw IndiekitError.unauthorized(__("UnauthorizedError.invalidToken"));
  }

  if (canonicalUrl(tokenValues.me) !== canonicalUrl(me)) {
    throw IndiekitError.forbidden(__("ForbiddenError.invalidMe"));
  }

  // Match whole scope values: `update` must not be satisfied by `undelete`
  const scopes = String(tokenValues.scope || "").split(/\s+/);
  if (!scopes.includes("update")) {
    throw IndiekitError.insufficientScope(
      __("ForbiddenError.insufficientScope"),
    );
  }

  return tokenValues;
};
