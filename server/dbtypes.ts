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
  slug: string;
  forum_id: number;
  user_id: number;
  co_gm_ids: number[];
  banned_ids: number[];
  join_status: string;
};
