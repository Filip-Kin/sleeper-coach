import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

// Durable store for the PUBLIC retrospective blog. Append-only JSONL, one post
// per line. These posts are reader-facing (no login), so the generator is
// responsible for keeping forward-looking strategy OUT of the body.

const BLOG_PATH = process.env.BLOG_LOG ?? "/data/sleeper-coach/blog.jsonl";

export interface BlogPost {
  slug: string; // stable id used in the URL
  title: string;
  date: string; // ISO
  type: string; // draft | week | note
  body: string; // markdown-ish plain text
  /** Which NFL week a "week" post covers. This is the idempotency key for the
   *  automatic publisher: the daemon asks "is week 3 already posted" every 90
   *  seconds once the games end, and a title match would be too fragile. */
  week?: number;
}

// House style, enforced rather than requested: no em dashes anywhere in
// reader-facing text. The prompt asks for this too, but the last generated recap
// contained five of them, so the rule is applied deterministically at the one
// place every post has to pass through. A comma carries every case the model
// actually produces ("the cleanest pick of the night, an elite back").
function houseStyle(text: string): string {
  return text
    .replace(/\s*\u2014\s*/g, ", ")
    .replace(/,\s*,+/g, ",")   // an em dash next to existing punctuation
    .replace(/,\s*([.:;!?])/g, "$1");
}

export function addPost(p: BlogPost): void {
  mkdirSync(dirname(BLOG_PATH), { recursive: true });
  const clean: BlogPost = { ...p, title: houseStyle(p.title), body: houseStyle(p.body) };
  appendFileSync(BLOG_PATH, JSON.stringify(clean) + "\n");
}

// All posts, newest first.
export function allPosts(): BlogPost[] {
  if (!existsSync(BLOG_PATH)) return [];
  const posts = readFileSync(BLOG_PATH, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as BlogPost;
      } catch {
        return null;
      }
    })
    .filter((p): p is BlogPost => p !== null);
  return posts.reverse();
}

/** Has a review for this week already been published? The automatic publisher
 *  polls, so without this it would post a new review on every pass. */
export function hasWeekPost(week: number, posts: BlogPost[] = allPosts()): boolean {
  return posts.some((p) => p.type === "week" && p.week === week);
}
