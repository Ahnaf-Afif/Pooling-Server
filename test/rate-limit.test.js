import assert from "node:assert/strict";
import test from "node:test";

import RateBucket from "../src/models/RateBucket.js";
import { limitWrites } from "../src/rate-limit.js";

test("limits writes with a shared database counter", async () => {
  const original = RateBucket.findOneAndUpdate;
  const counts = new Map();
  RateBucket.findOneAndUpdate = async (filter, update, options) => {
    assert.equal(update.$inc.count, 1);
    assert.equal(options.upsert, true);
    const count = (counts.get(filter._id) || 0) + 1;
    counts.set(filter._id, count);
    return { count };
  };

  try {
    const request = { ip: "192.0.2.1" };
    const response = {
      headers: {},
      set(name, value) { this.headers[name] = value; return this; },
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    let allowed = 0;
    for (let index = 0; index < 31; index += 1) {
      await limitWrites(request, response, () => { allowed += 1; });
    }

    assert.equal(allowed, 30);
    assert.equal(response.statusCode, 429);
    assert.equal(response.headers["RateLimit-Remaining"], "0");
    assert.match(response.body.message, /Too many requests/);
    assert.equal(counts.size, 1);
  } finally {
    RateBucket.findOneAndUpdate = original;
  }
});
