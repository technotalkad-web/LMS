export type NotificationEvent =
  | "account_creation"
  | "asset_assignment"
  | "asset_unassignment"
  | "asset_completion"
  | "asset_reminder"
  | "asset_update"
  | "custom_broadcast"
  | "path_assignment"
  | "path_unassignment"
  | "path_completion"
  | "password_reset";

export type NotificationContext = {
  learner_name?: string;
  learner_email?: string;
  course_name?: string;
  course_id?: string;
  path_name?: string;
  path_id?: string;
  login_id?: string;
  username?: string;
  password?: string;
  org_name?: string;
  direct_link?: string;
  portal_url?: string;
  due_date?: string;
  score?: string;
  otp_code?: string;
  otp_minutes?: string;
  [k: string]: string | undefined;
};

export type SmtpConfig = {
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_user: string | null;
  smtp_password: string | null;
  smtp_secure: boolean;
  from_email: string | null;
  from_name: string | null;
  reply_to: string | null;
};

export type NotificationSettings = SmtpConfig & {
  email_paused: boolean;
  event_paused: Record<string, boolean>;
  logo_url: string | null;
  brand_color: string | null;
  footer_text: string | null;
};

export type TemplateRow = {
  organization_id: string;
  event_type: NotificationEvent;
  subject: string;
  body_md: string;
  is_active: boolean;
  cta_label?: string | null;
};
