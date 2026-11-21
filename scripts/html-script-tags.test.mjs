import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scriptTags } from "./html-script-tags.mjs";

describe("scriptTags", () => {
  it("recognizes case-insensitive tags and end tags with whitespace and attributes", () => {
    assert.deepEqual(scriptTags('<SCRIPT>one</SCRIPT\t\n bar ><script type="application/json">two</script>')
      .map(([, attributes, body]) => [attributes.trim(), body]), [["", "one"], ['type="application/json"', "two"]]);
  });
});
