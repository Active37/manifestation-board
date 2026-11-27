export const reportReasons = [
  "offensive",
  "sexual",
  "harassment",
  "spam",
  "other",
] as const;

export const postCategories = [
  "academic",
  "career",
  "spiritual",
  "money",
  "fun/random",
] as const;

export type ReportReason = (typeof reportReasons)[number];
export type PostCategory = (typeof postCategories)[number];

export type NewPostInput = {
  display_name: string;
  body: string;
  category?: PostCategory | null;
  check_in_email?: string;
};

export type PostPatch = Partial<NewPostInput>;

export type CreatedPost = {
  id: string;
  display_name: string;
  body: string;
  category: PostCategory | null;
  created_at: string;
  edit_key: string;
};

export type PublicPost = {
  id: string;
  display_name: string;
  body: string;
  category: PostCategory | null;
  like_count: number;
  created_at: string;
};

export const feedSorts = [
  "shuffle",
  "newest",
  "most-liked-today",
  "most-liked-all-time",
] as const;

export type FeedSort = (typeof feedSorts)[number];

export type FeedQuery = {
  sort?: FeedSort;
  search?: string;
  cursor?: string;
};

export type FeedPage = {
  posts: PublicPost[];
  next_cursor: string | null;
};