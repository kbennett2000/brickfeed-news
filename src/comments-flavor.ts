/**
 * Comedy "flavor deck" for the parody comment stage (ADR-0029, amending ADR-0028).
 *
 * The bug this fixes: a brand-new opinion piece seeds its comment thread from a near-identical
 * prompt every time, and the persona block used to hand the model its punchlines by name — so
 * Sonnet reached for the same canonical gags (the raccoon diet, the lost tabby, the Constitution
 * mis-cite) on every empty-thread seed and all pieces opened identically.
 *
 * The fix: deal each piece a small, DIFFERENT hand of concrete comedy angles drawn from big banks,
 * and inject it into the prompt as fresh raw material plus an explicit "avoid the worn-out house
 * gags" instruction. The hand is a pure function of the piece id + current thread length, so:
 *  - two different pieces get different hands (divergence — the whole point),
 *  - the same piece re-run in the same state gets the same hand (deterministic + testable), and
 *  - a piece's hand ROTATES every grow pass (length changes), so a thread keeps getting new angles.
 *
 * No `Math.random` / `Date` — the deck derives entirely from `hashString` of persisted state, the
 * same doctrine as `finalizeReactions` in src/comments.ts. The deck shapes only the PROMPT
 * (generation input); it is never persisted, so re-renders stay byte-stable.
 *
 * Every entry here is authored INSIDE the HARD RULES in personas/_comments.md: nothing targets a
 * real person, no links/brands, all PG-13. The banks are the safe sandbox the model plays in.
 */
import { hashString } from "./render/format.js";

/**
 * Off-topic tangents (~1 in 3 comments should be one of these). Deliberately wide and specific so a
 * seed rarely repeats a theme — the retired raccoon diet and lost-tabby gags are POINTEDLY absent;
 * their replacements live here as many rotating options rather than one house favorite.
 */
export const OFF_TOPIC_THEMES: readonly string[] = [
  "a fad diet where they only eat foods that are beige, and they feel amazing",
  "the 'sunlight only' cleanse — they haven't eaten since Tuesday and are thriving",
  "a gas-station-taquito diet they swear is melting the weight off",
  "an MLM pitch for wholesale leggings, with a vague 'ask me about the starter kit'",
  "an MLM pitch for essential oils that cure whatever the article is about",
  "an MLM pitch for gutter guards, delivered as if it's urgent civic duty",
  "an MLM pitch for freeze-dried candy and a 'Founders Bundle' of supplements",
  "plugging their own podcast, 'Two Guys One Shed', with no link, just the name",
  "plugging a Facebook group for people who don't trust Tuesdays",
  "plugging their gospel-bluegrass cover band's upcoming church-parking-lot show",
  "a missing-pet notice for an emu named Gerald, last seen 'acting strange'",
  "a missing-pet notice for a 'very intelligent' goose that answers to whistling",
  "a missing-pet notice for a runaway pot-bellied pig named General",
  "a weather-truther complaint that the contrails are 'thicker lately'",
  "insisting the town tornado siren is doing something to people's thoughts",
  "dropping an unsolicited full crockpot recipe in the middle of the thread",
  "a copy-pasted chain-letter blessing that promises good fortune if you reply Amen",
  "a five-star review of a leaf blower that has nothing to do with anything",
  "confessing 'my nephew set up my account so bear with me' and replying to the wrong person",
  "a birds-aren't-real aside, treated as settled and obvious",
  "airing out a long-running feud with 'lot 14' at the RV park",
  "HOA drama about a neighbor's flag/mailbox/inflatable decoration",
  "complaining about the young people today and participation trophies",
  "asking if this is where you renew your car tags",
  "a rambling story about their knee surgery that never connects to the article",
  "selling a used above-ground pool, 'you haul', to whoever sees this first",
  "quoting their old high-school coach as if he were a great philosopher",
  "a rant about self-checkout machines being the real downfall of society",
  "defending a fast-food item that was discontinued years ago as a national treasure",
  "an update on their sourdough starter, which is named after a late relative",
];

/**
 * On-topic argument tactics — how a commenter mangles THE ACTUAL COLUMN. The Constitution mis-cite
 * survives here (it's core to the genre) but as ONE option among many and with a rotating, invented
 * citation each time, so it stops being the same "Artical 4 Section 9" every thread.
 */
export const ARGUMENT_MOVES: readonly string[] = [
  "cite a founding document with a confidently WRONG number (a fresh amendment, article, or 'founders memo' each time) and invent a ruling that settles it",
  "proudly admit they did not read the article, then have the strongest opinion in the thread",
  "demand a source, and when someone gives one, ignore it and change the subject",
  "declare 'the REAL issue nobody is talking about' is something totally unrelated",
  "claim a cousin or uncle 'works in government / the industry' and secretly knows the truth",
  "nostalgia: 'back in [some year] this cost [tiny amount] and we were all just fine'",
  "announce 'this is exactly why I cancelled my subscription' (they were never subscribed)",
  "both-sides it into complete nonsense, then crown themselves the only reasonable one here",
  "blame the whole thing on a specific decade going wrong",
  "correct another commenter's spelling while misspelling a word worse in the same sentence",
  "reply with three caps-lock buzzwords and treat it as a complete argument",
  "tell the columnist to 'do your own research'",
  "open with 'I'm not political but' and immediately say something unhinged",
  "insist one thing that happened to their neighbor proves a nationwide trend",
  "compare it to a plot from a TV show as if that obviously settles the matter",
  "threaten to 'screenshot this' for a reason that never becomes clear",
];

/** Which handle recipe to foreground this thread — usernames are a main comedy vector. */
export const USERNAME_STYLES: readonly string[] = [
  "patriot / founding themes (1776, Betsy, Liberty, Sovereignty, Eagle, Freedom)",
  "military / tactical (Sgt, unit numbers, 'Squared_Away', badge-style number tails)",
  "wholesome grandparent (Nana_of_9, Papaw, brood counts like 'of_7', 'God bless' energy)",
  "aspirational nonsense (TruthHammer, WokeSlayer, FactsDontCare, RealTalk)",
  "deliberate misspellings baked into the handle (Patriott, Soverignty_Now, Consitutionalist88)",
  "casing chaos and number tails (ALLCAPS_MIKE, snakecase_deb, birth-year suffixes like _66)",
];

/** Which comment SHAPES to lean on this thread, so form varies as much as content. */
export const SHAPE_EMPHASIS: readonly string[] = [
  "terse drive-bys — one to three words ('Both.' / 'Anyway.' / 'Source?')",
  "one rambling multi-paragraph non-sequitur that loses its own thread halfway through",
  "ALL CAPS declarations that are certain about everything",
  "a tight back-and-forth feud between two commenters who reply to each other",
  "medium rants stuffed with confidently wrong 'facts'",
];

/**
 * The KEPT recurring cast (ADR-0029 retired RaccoonProtein_Deb, MoonlightAuntie, and 2nd-ID-7682 —
 * all burned out from repetition). These three come back only as an occasional cameo (see buildDeck),
 * so a regular is a reward for return readers, never the face that leads every thread.
 */
export const RECURRING_CAST: readonly string[] = [
  "rickp53 — cites founding documents with confident, invented numbers (vary which one each time)",
  "PapawBill_of_9 — wholesome grandpa, mildly unhelpful advice, signs off with 'God bless'",
  "eagle_screech_1776 — ALL CAPS, insists the REAL issue is something unrelated",
];

/**
 * The worn-out house gags to steer AWAY from, named in the prompt so the model stops defaulting to
 * them. These are the exact bits the owner flagged as formulaic (the seed of every thread to date).
 */
export const RETIRED_GAGS: readonly string[] = [
  "the raccoon-meat diet ('down 14 lbs since June')",
  "MoonlightAuntie's lost orange tabby near exit 14",
  "the 'go finish high school / write it in crayon' put-down",
];

/** One thread's dealt hand of comedy angles. All fields are drawn from the banks above. */
export interface CommentDeck {
  /** Off-topic tangents to sprinkle in (~1 in 3 comments). */
  offTopic: string[];
  /** On-topic tactics for mangling the actual column. */
  argumentMoves: string[];
  /** The username recipe to foreground this thread. */
  usernameStyle: string;
  /** The comment shapes to lean on this thread. */
  shapeEmphasis: string;
  /** An optional recurring-cast cameo (≈1 in 3 threads), or null for an all-fresh cast. */
  cameo: string | null;
}

/**
 * Deal `k` DISTINCT items from `bank`, indexed deterministically by `hashString(`${salt}:${i}`)`.
 * Collisions linear-probe to the next free slot (k is always far smaller than a bank, so this is a
 * couple of steps at worst). Pure and reproducible: same salt + bank + k → same items in the same
 * order. `k` is clamped to the bank size so a caller can never loop forever.
 */
export function dealDeck(salt: string, bank: readonly string[], k: number): string[] {
  const take = Math.min(k, bank.length);
  const used = new Set<number>();
  const out: string[] = [];
  for (let i = 0; i < take; i++) {
    let idx = hashString(`${salt}:${i}`) % bank.length;
    while (used.has(idx)) idx = (idx + 1) % bank.length;
    used.add(idx);
    out.push(bank[idx]);
  }
  return out;
}

/**
 * Build one thread's comedy deck from the piece id + current thread length. The length term makes the
 * hand ROTATE on every grow pass (an empty thread seeds with one hand; the next pass, at a new length,
 * deals a different one), while keeping any single (piece, length) reproducible for tests and stable
 * re-renders. A recurring-cast cameo is gated to ≈1 in 3 threads so regulars stay occasional.
 */
export function buildDeck(pieceId: string, existingLength: number): CommentDeck {
  const base = `${pieceId}:${existingLength}`;
  return {
    offTopic: dealDeck(`${base}:offtopic`, OFF_TOPIC_THEMES, 3),
    argumentMoves: dealDeck(`${base}:argument`, ARGUMENT_MOVES, 2),
    usernameStyle: dealDeck(`${base}:username`, USERNAME_STYLES, 1)[0],
    shapeEmphasis: dealDeck(`${base}:shape`, SHAPE_EMPHASIS, 1)[0],
    cameo:
      hashString(`${base}:cameo`) % 3 === 0
        ? dealDeck(`${base}:cameopick`, RECURRING_CAST, 1)[0]
        : null,
  };
}

/**
 * Render a deck as the prompt block injected between the persona instructions and the task. Frames the
 * dealt angles as raw material to invent AROUND (not copy verbatim) and names the retired gags to
 * avoid — the two levers that break the formulaic openers.
 */
export function renderDeck(deck: CommentDeck): string {
  const lines = [
    "FRESH ANGLES FOR THIS THREAD — use these as raw material and invent NEW specifics around them; do NOT copy them verbatim:",
    `- Off-topic tangents to work in (about 1 in 3 comments): ${deck.offTopic.join("; ")}`,
    `- On-topic ways to mangle THIS column: ${deck.argumentMoves.join("; ")}`,
    `- Lean the usernames this thread toward: ${deck.usernameStyle}`,
    `- Emphasize these comment shapes this thread: ${deck.shapeEmphasis}`,
  ];
  if (deck.cameo) {
    lines.push(
      `- You MAY bring back ONE regular for a single comment if it fits naturally: ${deck.cameo}`,
    );
  } else {
    lines.push("- Use ALL-FRESH invented usernames this thread — no recurring regulars.");
  }
  lines.push(
    `AVOID falling back on the worn-out house gags: ${RETIRED_GAGS.join("; ")}. Invent fresh material instead.`,
  );
  return lines.join("\n");
}
