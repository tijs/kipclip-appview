import { assertEquals } from "@std/assert";
import {
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
