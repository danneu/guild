// A best effort attempt to represent db columns with typescript types
// Will extend as we go

export type DbUser = {
  id: number;
  slug: string;
  uname: string;
  email: string;
  email_verified: boolean;
  eflags: number;
  created_at: Date;
  updated_at: Date;
  bio_markup: string;
  bio_html: string;
  sig_html: string;
  sig: string;
  avatar_url: string;
  custom_title: string;
  is_nuked: boolean;
  digest: string; // should be bytea jeez
  posts_count: number;
  last_online_at: Date;
  role: string;
  hide_sigs: boolean;
  hide_avatars: boolean;
  is_ghost: boolean;
  is_grayscale: boolean;
  force_device_width: boolean;
  trophy_count: number;
  active_trophy_id: number | null;
  current_status_id: number | null;

  // Sometimes has nested fields
  nuked_by?: DbUser | void;
  approved_by?: DbUser | void;
};

export type DbNotification = {
  id: number;
  from_user_id: number;
  to_user_id: number;
};

export type DbConvo = {
  id: number;
  user_id: number;
  title: string;
  url: string;
  pms_count: number;
  created_at: Date;

  // Sometimes has nested fields
  user?: DbUser;
  participants?: DbUser[];
  pms?: DbPm[];
  latest_user?: DbUser;
  latest_pm?: DbPm;
};

export type DbPm = {
  id: number;
  convo_id: number;
  user_id: number;
  ip_address: string;
  markup: string;
  html: string;
  idx: number;
};

export type DbSession = {
  id: number;
  user_id: number;
  ip_address: string;
  user_agent: string;
  created_at: Date;
  updated_at: Date;
};

export type DbTopic = {
  id: number;
  title: string;
  user_id: number;
  forum_id: number;
  created_at: Date;
  is_roleplay: boolean;
  co_gm_ids: number[];
  join_status: "jump-in" | "apply" | "full" | null;
  is_hidden: boolean;
  is_closed: boolean;
  is_sticky: boolean;
  // Counter cache
  posts_count: number;
  ic_posts_count: number;
  ooc_posts_count: number;
  char_posts_count: number;
  // Moving
  moved_from_forum_id: number | null;
  moved_at: Date | null;
  latest_post_at: Date | null;

  latest_post_id: number | null;
  latest_ic_post_id: number | null;
  latest_ooc_post_id: number | null;
  latest_char_post_id: number | null;
};

export type DbVm = {
  id: number;
  from_user_id: number;
  to_user_id: number;
  markup: string;
  html: string;
  parent_vm_id: number | null;
};

export type DbTag = {
  id: number;
  name: string;
  tag_group_id: number;
};

export const DbRatingType = {
  like: "like",
  laugh: "laugh",
  thank: "thank",
} as const;

export type DbRatingType = (typeof DbRatingType)[keyof typeof DbRatingType];

export type DbRating = {
  id: number;
  from_user_id: number;
  from_user_uname: string;
  to_user_id: number;
  post_id: number;
  type: DbRatingType;
  created_at: Date;
};
