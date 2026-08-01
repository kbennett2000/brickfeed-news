import { describe, expect, it } from "vitest";
import {
  looksLikeMetaNarration,
  looksLikeRefusal,
  recoverLeadingTitleRegion,
  stripTitleDressing,
  stripWrappingFence,
} from "../src/sanitize.js";

describe("looksLikeRefusal", () => {
  it("matches genuine refusal leads", () => {
    expect(looksLikeRefusal("I can't help with that.")).toBe(true);
    expect(looksLikeRefusal("I'm sorry, but I cannot assist with this.")).toBe(true);
    expect(looksLikeRefusal("I'm unable to write that piece.")).toBe(true);
    expect(looksLikeRefusal("As an AI language model, I can't do that.")).toBe(true);
    expect(looksLikeRefusal("Unfortunately, I am unable to comply.")).toBe(true);
    expect(looksLikeRefusal("I must decline this request.")).toBe(true);
    expect(looksLikeRefusal("I won't write content like that.")).toBe(true);
    // Curly apostrophe variant.
    expect(looksLikeRefusal("I can’t help with that.")).toBe(true);
  });

  it("does NOT flag titles or bodies that merely start with a modal", () => {
    expect(looksLikeRefusal("I Can't Even")).toBe(false); // a title — no refusal object
    expect(looksLikeRefusal("I'm Sorry")).toBe(false); // a title — no ", but I …"
    expect(looksLikeRefusal("As American Politics Sours")).toBe(false);
    expect(looksLikeRefusal("The casserole was cold, and I cannot forgive it.")).toBe(false);
    expect(looksLikeRefusal("Sure Thing")).toBe(false);
  });
});

describe("looksLikeMetaNarration", () => {
  it("flags a short colon-less preamble SENTENCE about producing the piece", () => {
    // The 2026-08-01 leak: opens with a meta token, names a production noun/verb, ends with a
    // period — short enough to have masqueraded as a title but is pure meta-narration.
    expect(looksLikeMetaNarration("I'll write one reader-letter column for Priscilla now.")).toBe(
      true,
    );
    expect(looksLikeMetaNarration("I’ll write one reader-letter column for Priscilla now.")).toBe(
      true,
    ); // curly apostrophe
    expect(looksLikeMetaNarration("Sure, I will write the piece now!")).toBe(true);
    expect(looksLikeMetaNarration("Here is your column: enjoy.")).toBe(true);
  });

  it("does NOT flag legitimate titles (the false-positive guard)", () => {
    // Real titles that open with a stop word but do not END like a production sentence.
    expect(looksLikeMetaNarration("I'll Be There")).toBe(false); // no terminal period
    expect(looksLikeMetaNarration("Let Me Write You a Letter")).toBe(false); // production verb, no period
    expect(looksLikeMetaNarration("Okay Boomer")).toBe(false);
    expect(looksLikeMetaNarration("Sure Thing")).toBe(false);
    expect(looksLikeMetaNarration("The Dinner Party Question")).toBe(false);
    // A sentence-shaped line that isn't meta-narration (no opener token) is left alone.
    expect(looksLikeMetaNarration("The casserole was cold, and I never forgave it.")).toBe(false);
  });
});

describe("stripWrappingFence", () => {
  it("unwraps a whole-completion fence", () => {
    expect(stripWrappingFence("```\nThe Title\n\nBody.\n```")).toBe("The Title\n\nBody.");
    expect(stripWrappingFence("```markdown\nThe Title\n\nBody.\n```")).toBe("The Title\n\nBody.");
  });

  it("leaves un-fenced text and inline code spans untouched", () => {
    expect(stripWrappingFence("The Title\n\nBody with `inline` code.")).toBe(
      "The Title\n\nBody with `inline` code.",
    );
    // A fence that does not wrap the whole thing is not stripped.
    expect(stripWrappingFence("The Title\n\n```\nsnippet\n```\n\nmore")).toBe(
      "The Title\n\n```\nsnippet\n```\n\nmore",
    );
  });
});

describe("stripTitleDressing", () => {
  it("removes heading markers and matched wrapping emphasis/quotes only", () => {
    expect(stripTitleDressing("# The Title")).toBe("The Title");
    expect(stripTitleDressing("**Wisdom's Moat**")).toBe("Wisdom's Moat");
    expect(stripTitleDressing('"Quoted"')).toBe("Quoted");
    expect(stripTitleDressing("Stars * Among * Us")).toBe("Stars * Among * Us");
    expect(stripTitleDressing('"Unbalanced opener')).toBe('"Unbalanced opener');
  });
});

describe("recoverLeadingTitleRegion", () => {
  it("recovers the real title from the reported preamble + delimiter leak", () => {
    const leak =
      "I see the task: write one reader-letter column as Priscilla — advice in her " +
      "measured voice.\n\n---\n\n**Wisdom's Moat**\n\nDear Priscilla, the body.";
    expect(recoverLeadingTitleRegion(leak)).toBe("**Wisdom's Moat**\n\nDear Priscilla, the body.");
  });

  it("drops bare delimiters and strips label markers", () => {
    expect(recoverLeadingTitleRegion("---\n\n**Real Title**\n\nBody.")).toBe(
      "**Real Title**\n\nBody.",
    );
    expect(recoverLeadingTitleRegion("Title: The Real Title\n\nBody.")).toBe(
      "The Real Title\n\nBody.",
    );
    expect(recoverLeadingTitleRegion("Here is your column:\n\nThe Real Title\n\nBody.")).toBe(
      "The Real Title\n\nBody.",
    );
  });

  it("recovers the real title past a short colon-less preamble sentence (the 2026-08-01 leak)", () => {
    const leak =
      "I'll write one reader-letter column for Priscilla now.\n\n---\n\n" +
      "**The Dinner Party Question**\n\nDear Priscilla, the body.";
    expect(recoverLeadingTitleRegion(leak)).toBe(
      "**The Dinner Party Question**\n\nDear Priscilla, the body.",
    );
  });

  it("is conservative: never strips a legitimate leading title", () => {
    // Opens with a stop word but is a real short title — must be left alone.
    expect(recoverLeadingTitleRegion("Okay Boomer\n\nBody paragraph here.")).toBe(
      "Okay Boomer\n\nBody paragraph here.",
    );
    expect(recoverLeadingTitleRegion("The Title\n\nBody.")).toBe("The Title\n\nBody.");
    // All-junk input with no recoverable title is returned unchanged (caller fails closed).
    expect(recoverLeadingTitleRegion("---\n\n***")).toBe("---\n\n***");
  });
});
