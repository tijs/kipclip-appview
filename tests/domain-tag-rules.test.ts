import { assertEquals } from "@std/assert";
import {
  hasDomainTagRule,
  suggestDomainTags,
  validateDomainTagRules,
} from "../shared/domain-tag-rules.ts";

Deno.test("domain rules suggest existing tags for exact hosts only", () => {
  const rules = [{ domain: "arxiv.org", tag: "research-paper" }];
  const available = ["Research-Paper", "other"];
  assertEquals(
    suggestDomainTags("https://ARXIV.org/pdf/1", rules, available, []),
    ["Research-Paper"],
  );
  assertEquals(
    suggestDomainTags("https://sub.arxiv.org/pdf/1", rules, available, []),
    [],
  );
  assertEquals(
    suggestDomainTags("https://arxiv.org.evil.test/", rules, available, []),
    [],
  );
  assertEquals(suggestDomainTags("not a URL", rules, available, []), []);
  assertEquals(suggestDomainTags("https://arxiv.org/", rules, [], []), []);
  assertEquals(
    suggestDomainTags("https://arxiv.org/", rules, available, [
      "research-paper",
    ]),
    [],
  );
  assertEquals(
    suggestDomainTags(
      "https://arxiv.org/",
      [...rules, ...rules],
      available,
      [],
    ),
    ["Research-Paper"],
  );
});

Deno.test("rule validation uses UTF-8 byte limits and rejects wildcards", () => {
  assertEquals(
    validateDomainTagRules([{ domain: "*.arxiv.org", tag: "paper" }]),
    false,
  );
  assertEquals(
    validateDomainTagRules([{ domain: "arxiv.org", tag: "é".repeat(32) }]),
    true,
  );
  assertEquals(
    validateDomainTagRules([{ domain: "arxiv.org", tag: "é".repeat(33) }]),
    false,
  );
});

Deno.test("domain rules match hostnames regardless of letter case", () => {
  for (const domain of ["youtube.com", "Youtube.com"]) {
    for (
      const url of [
        "https://youtube.com/watch?v=1",
        "https://Youtube.com/watch?v=1",
      ]
    ) {
      assertEquals(
        suggestDomainTags(url, [{ domain, tag: "video" }], ["video"], []),
        ["video"],
      );
    }
  }
  assertEquals(
    hasDomainTagRule([{ domain: "Youtube.com", tag: "Video" }], {
      domain: "youtube.com",
      tag: "video",
    }),
    true,
  );
});
